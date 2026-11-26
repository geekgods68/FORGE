import { readFileSync } from 'node:fs';
import { CoSimulation, physicsPortOf, UnoRuntime } from '@forge/electronics';
import { loadRapier, PhysicsSession, simulationOf } from '@forge/physics';
import { validationRecord, type Dataset, type RunRecord } from '@forge/research';
import { describe, expect, it } from 'vitest';
import {
  ACTUATION_POLICY,
  DEFAULT_SCENARIO,
  requestActuation,
  SyntheticAdapter,
  syntheticStream,
  type SyntheticScenario,
} from '../adapters';
import { compare, observedSignal } from '../compare';
import { designate, type EvidenceInput } from '../designation';
import { TELEMETRY_SKETCH } from '../firmware';
import { toModel, validateMappings } from '../mapping';
import { TelemetryPipeline, valueAt } from '../pipeline';
import { checksum, encode, LineSplitter, MAX_LINE, parseLine } from '../protocol';
import { Recorder, recordingToDataset, replay, verifyRecording, type Recording } from '../recording';
import { createVeyrisTwinProject, veyrisArmTwin } from '../sample';
import { emptyTwinDocument, parseTwinDocument, upsertTwin } from '../store';

const AT = new Date('2026-11-26T00:00:00Z');
const scenario = (
  patch: Omit<Partial<SyntheticScenario>, 'faults'> & { faults?: Partial<SyntheticScenario['faults']> } = {},
): SyntheticScenario => ({
  ...DEFAULT_SCENARIO,
  ...patch,
  faults: { ...DEFAULT_SCENARIO.faults, ...(patch.faults ?? {}) },
});
function run(sc: SyntheticScenario, opts = {}) {
  const s = syntheticStream(sc);
  const p = new TelemetryPipeline(0, opts);
  const rec = new Recorder(0, {
    id: 'rec-1',
    twinId: 'twin-veyris-arm',
    adapter: 'synthetic',
    synthetic: true,
    startedAt: AT.toISOString(),
  });
  const ev = [
    ...s.transport.map((t) => ({
      h: t.hostMs,
      f: () => (p.setTransport(t.open, t.hostMs), rec.state(t.open, t.hostMs)),
    })),
    ...s.lines.map((l) => ({
      h: l.hostMs,
      f: () => (p.ingestLine(l.line, l.hostMs), rec.line(l.line, l.hostMs)),
    })),
  ].sort((a, b) => a.h - b.h);
  for (const e of ev) e.f();
  p.flush(Infinity);
  return { s, p, recording: rec.finish(p) };
}

describe('telemetry protocol v1', () => {
  it('round-trips every message type and rejects corrupted or malformed lines', () => {
    const msgs = [
      { type: 'hello', version: 1, deviceId: 'VEYRIS-ARM-01', firmware: 'fw', firmwareVersion: '1.0.0' },
      { type: 'channel', id: 'd', kind: 'measured', unit: 'mm', label: 'distance' },
      { type: 'data', seq: 65535, ms: 4294967295, values: { d: 123, a: null, x: -1.5e-3 } },
      { type: 'status', seq: 2, ms: 10, code: 'ok', detail: 'overruns=0' },
      { type: 'error', seq: 3, ms: 11, code: 'no-echo', detail: '' },
    ] as const;
    for (const m of msgs) expect(parseLine(encode(m as never))).toEqual({ ok: true, message: m });
    const good = encode({ type: 'data', seq: 1, ms: 2, values: { d: 5 } });
    expect(parseLine(good.replace('d=5', 'd=6')).ok).toBe(false); // checksum
    expect(parseLine(`${good}\r`).ok).toBe(true);
    const bad = (body: string) =>
      parseLine(`@${body}*${checksum(body).toString(16).toUpperCase().padStart(2, '0')}`);
    expect(bad('D,70000,1,d=1')).toMatchObject({ ok: false });
    expect(bad('D,1,1,D=1')).toMatchObject({ ok: false, reason: expect.stringMatching(/channel id/) });
    expect(bad('D,1,1,d=1,d=2')).toMatchObject({ ok: false, reason: expect.stringMatching(/duplicate/) });
    expect(bad('D,1,1,d=abc')).toMatchObject({ ok: false });
    expect(bad('H,2,x,y,z')).toMatchObject({ ok: false, reason: expect.stringMatching(/version 2/) });
    expect(bad('X,1')).toMatchObject({ ok: false });
    expect(parseLine('@' + 'D,1,1,d=1'.padEnd(MAX_LINE, '0') + '*00').ok).toBe(false);
    expect(parseLine('@D,1,1,d=1é*00').ok).toBe(false);
    const sp = new LineSplitter();
    const got: string[] = [];
    sp.push(`${good}\n${'x'.repeat(500)}\n${good}`, (l) => got.push(l));
    sp.push('\n', (l) => got.push(l));
    expect(got).toEqual([good, good]);
    expect(sp.overlong).toBe(1);
  });
});

describe('example firmware (same source for the bench and FORGE)', () => {
  it('is identical to the .ino file, compiles for the UNO subset and never reads serial input', () => {
    const ino = readFileSync(
      new URL('../../../../hardware/arduino/forge_telemetry/forge_telemetry.ino', import.meta.url),
      'utf8',
    );
    expect(ino).toBe(TELEMETRY_SKETCH);
    expect(UnoRuntime.check(TELEMETRY_SKETCH).errors).toEqual([]);
    expect(TELEMETRY_SKETCH).not.toMatch(/Serial\.(read|available|parse|peek)/);
  });

  it('runs on FORGE’s virtual UNO against the simulated arm: telemetry decodes and matches the co-simulation', async () => {
    const project = createVeyrisTwinProject(AT);
    const R = await loadRapier();
    const root = project.scene.nodes[project.scene.rootId]!;
    if (root.kind !== 'root') throw new Error('root');
    const session = PhysicsSession.fromScene(R, project.scene, simulationOf(project.scene)!);
    const cs = new CoSimulation(root.electrical!, {
      physics: physicsPortOf(session, project.scene),
      scene: project.scene,
    });
    cs.start();
    cs.advanceTo(3e9);
    const mcu = cs.mcus[0]!;
    expect(mcu.state).not.toBe('error');
    const p = new TelemetryPipeline(0);
    p.setTransport(true, 0);
    const sp = new LineSplitter();
    for (const c of mcu.serial) sp.push(c.text, (l) => p.ingestLine(l, c.t / 1e6));
    p.flush(Infinity);
    expect(p.stats.invalid).toEqual({});
    expect(p.device).toEqual({
      deviceId: 'VEYRIS-ARM-01',
      firmware: 'forge-ultrasonic-servo',
      firmwareVersion: '1.0.0',
    });
    expect([...p.channels.values()].map((c) => [c.id, c.kind, c.unit])).toEqual([
      ['d', 'measured', 'mm'],
      ['a', 'commanded', 'deg'],
    ]);
    const d = p.series.get('d')!;
    expect(d.t.length).toBeGreaterThanOrEqual(55); // 20 Hz for 3 s
    expect(p.stats.missingMessages).toBe(0);
    // Distances agree with the co-simulation's sensor model (firmware rounds to whole mm).
    const reported = cs.recorder.series('US1.reported')!;
    const twin = veyrisArmTwin(project, AT);
    expect(validateMappings(twin, project, p.channels).filter((x) => x.severity === 'error')).toEqual([]);
    const lastD = p.latest('d', 3000)!.value;
    const lastSim = reported.v[reported.v.length - 1]!;
    expect(Math.abs(lastD / 1000 - lastSim)).toBeLessThan(0.0015);
    // The commanded angle maps onto the servo's joint target exactly as the co-simulation decodes it.
    const target = cs.recorder.series('SV4.target')!;
    const aModel = toModel(twin.channels[1]!, p.latest('a', 3000)!.value);
    expect(Math.abs(aModel - target.v[target.v.length - 1]!)).toBeLessThan((2 * Math.PI) / 180);
    session.dispose();
  }, 60_000);
});

describe('ingestion pipeline (deterministic synthetic telemetry)', () => {
  it('normal connection: every sample, no gaps, live link, exact clock', () => {
    const { s, p } = run(scenario());
    expect(p.series.get('d')!.t).toHaveLength(s.truth.length);
    expect(p.stats.missingMessages).toBe(0);
    // Device millis() are integers (±0.5 ms): over 10 s the drift resolution is a few tens of ppm.
    expect(Math.abs(p.clock.driftPpm)).toBeLessThan(60);
    expect(p.linkState(s.lines.at(-1)!.hostMs + 10)).toBe('live');
    expect(p.linkState(s.lines.at(-1)!.hostMs + 1000)).toBe('stale');
  });

  it('missing, duplicated, out-of-order and corrupted packets are counted, never invented', () => {
    const sc = scenario({
      seed: 7,
      faults: { dropRate: 0.05, duplicateRate: 0.05, reorderRate: 0.1, corruptRate: 0.03 },
    });
    const { s, p } = run(sc);
    const d = p.series.get('d')!;
    expect(new Set(d.seq).size).toBe(d.seq.length); // no duplicates
    expect([...d.t].sort((a, b) => a - b)).toEqual(d.t); // time order
    expect(p.stats.duplicates).toBeGreaterThan(0);
    expect(p.stats.reordered).toBeGreaterThan(0);
    expect(p.stats.invalid['checksum mismatch']).toBeGreaterThan(0);
    // Every sent data message is either received (once) or counted missing.
    expect(d.t.length + p.stats.missingMessages).toBe(s.truth.length);
    expect(d.quality.every((q) => q === 'ok' || q === 'late')).toBe(true);
  });

  it('missing echoes are missing samples plus device errors (not zeros)', () => {
    const { p } = run(scenario({ seed: 3, faults: { noEchoRate: 0.2 } }));
    const d = p.series.get('d')!;
    const missing = d.v.filter((x) => Number.isNaN(x)).length;
    expect(missing).toBeGreaterThan(10);
    expect(p.stats.missingValues).toBe(missing);
    expect(p.stats.deviceErrors['no-echo']).toBe(missing);
    expect(d.v.some((x) => x === 0)).toBe(false);
    // Interpolation never bridges a missing sample beyond maxGap.
    const iMissing = d.v.findIndex((x) => Number.isNaN(x));
    expect(valueAt(d, d.t[iMissing]!, 'hold', 0.001)).toBeNull();
  });

  it('disconnection, reconnection and stale (stalled) telemetry are detected', () => {
    const { p } = run(scenario({ durationS: 10, faults: { disconnects: [[3, 4]], stalls: [[6, 7.5]] } }));
    expect(p.events.filter((e) => e.kind === 'disconnected').length).toBe(1);
    expect(p.events.filter((e) => e.kind === 'connected').length).toBe(2);
    const r2 = replay(
      run(scenario({ durationS: 10, faults: { disconnects: [[3, 4]], stalls: [[6, 7.5]] } })).recording,
      {},
      3500,
    );
    expect(r2.linkState(3500)).toBe('disconnected');
    const r3 = replay(run(scenario({ durationS: 10, faults: { stalls: [[6, 7.5]] } })).recording, {}, 7000);
    expect(r3.linkState(7000)).toBe('stale');
    expect(r3.linkState(6020)).toBe('live');
  });

  it('estimates clock offset and drift (100 ppm) and the transport latency', () => {
    const { p } = run(
      scenario({ durationS: 20, driftPpm: 100, clockOffsetMs: 1234, latencyMs: 8, jitterMs: 3 }),
    );
    // 400-message window (20 s), 1 ms device resolution: drift within ±30 ppm of 100.
    expect(Math.abs(p.clock.driftPpm - 100)).toBeLessThan(30);
    expect(p.clock.latencyP95Ms).toBeLessThan(8);
    // Sample times follow the DEVICE clock mapped to the host: spacing varies only by the
    // device's 1 ms tick, not by the ±3 ms transport jitter.
    const t = p.series.get('d')!.t;
    const dt = t.slice(1).map((x, i) => x - t[i]!);
    expect(Math.max(...dt) - Math.min(...dt)).toBeLessThanOrEqual(0.0010002);
  });

  it('handles 16-bit sequence and device-clock wrap-around and device restarts', () => {
    const p = new TelemetryPipeline(0);
    p.setTransport(true, 0);
    p.ingestLine(encode({ type: 'channel', id: 'd', kind: 'measured', unit: 'mm', label: 'd' }), 0);
    for (let k = 0; k < 10; k++)
      p.ingestLine(
        encode({ type: 'data', seq: (65530 + k) % 65536, ms: (4294967290 + k * 50) >>> 0, values: { d: k } }),
        k * 50,
      );
    p.flush(Infinity);
    expect(p.series.get('d')!.v).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(p.stats.missingMessages).toBe(0);
    // Re-sending an already received (wrapped) sequence number is a duplicate, not new data.
    p.ingestLine(encode({ type: 'data', seq: 0, ms: 10, values: { d: 99 } }), 600);
    expect(p.stats.duplicates).toBe(1);
    // A real restart: after a long run, sequence AND device clock start again from zero.
    const q = new TelemetryPipeline(0);
    q.setTransport(true, 0);
    q.ingestLine(encode({ type: 'channel', id: 'd', kind: 'measured', unit: 'mm', label: 'd' }), 0);
    for (let k = 0; k < 30; k++)
      q.ingestLine(encode({ type: 'data', seq: 5000 + k, ms: 600_000 + k * 50, values: { d: k } }), k * 50);
    for (let k = 0; k < 5; k++)
      q.ingestLine(encode({ type: 'data', seq: k, ms: 20 + k * 50, values: { d: 100 + k } }), 2000 + k * 50);
    q.flush(Infinity);
    expect(q.stats.epochs).toBe(1);
    expect(q.stats.duplicates).toBe(0);
    expect(q.events.some((e) => e.kind === 'device-restart')).toBe(true);
    const v = q.series.get('d')!.v;
    expect(v.slice(-5)).toEqual([100, 101, 102, 103, 104]); // new epoch after the old one
    expect(v).toHaveLength(35);
  });
});

describe('recordings and replay', () => {
  it('replays bit-identically and detects tampering', () => {
    const { p, recording } = run(
      scenario({ seed: 11, faults: { dropRate: 0.05, reorderRate: 0.1, noEchoRate: 0.05 } }),
    );
    expect(recording.synthetic).toBe(true);
    expect(verifyRecording(recording)).toBe(true);
    const again = replay(recording);
    expect([...again.series.entries()]).toEqual([...p.series.entries()]);
    expect(again.stats).toEqual(p.stats);
    const tampered: Recording = {
      ...recording,
      lines: recording.lines.map((l, i) => (i === 10 ? [l[0], l[1].replace('d=', 'd=9')] : l)),
    };
    expect(verifyRecording(tampered)).toBe(false);
    const relabelled = { ...recording, synthetic: false };
    expect(verifyRecording(relabelled)).toBe(false);
  });

  it('becomes a Phase 7 dataset that stays labelled synthetic; validation against it is synthetic-only', () => {
    const project = createVeyrisTwinProject(AT);
    const twin = veyrisArmTwin(project, AT);
    const { recording } = run(scenario());
    const ds = recordingToDataset(recording, twin, 'ds-1', AT);
    if ('error' in ds) throw new Error(ds.error);
    expect(ds.record.provenance.synthetic).toBe(true);
    expect(ds.record.columns.map((c) => [c.name, c.unit])).toEqual([
      ['t', 's'],
      ['d', 'm'],
    ]); // commanded "a" excluded
    const run0 = { id: 'run-1', experimentId: 'exp' } as unknown as RunRecord;
    const v = validationRecord({
      id: 'val-1',
      experimentId: 'exp',
      dataset: ds.record as Dataset,
      run: run0,
      mapping: [{ column: 'd', signal: 'US1.reported' }],
      metrics: [],
      acceptance: { metric: 'rmse', threshold: 1 },
      calibrations: [],
      operatingRange: 'bench',
    });
    expect(v.status).toBe('synthetic-only');
  });
});

describe('simulation versus observation', () => {
  it('residuals, metrics and the lag that best aligns the timelines', () => {
    const sc = scenario({ durationS: 10, distance: { ...DEFAULT_SCENARIO.distance, noiseMm: 2 } });
    const { s, p } = run(sc);
    const twin = veyrisArmTwin(createVeyrisTwinProject(AT), AT);
    const obs = observedSignal(p.series.get('d')!, twin.channels[0]!);
    // "Simulation": the true distance delayed by 0.12 s (a model with a lag).
    const t = s.truth.map((x) => x.tS + 0.12);
    const sim = {
      key: 'US1.reported',
      unit: 'm',
      t: Float64Array.from(t),
      v: Float64Array.from(s.truth.map((x) => x.distanceMm / 1000)),
      source: 'test',
    };
    const c = compare(obs, sim, { lagRangeS: 0.3, lagStepS: 0.01 });
    if ('error' in c) throw new Error(c.error);
    expect(Math.abs(c.lag.bestS - 0.12)).toBeLessThanOrEqual(0.02);
    expect(c.lag.rmseAtBest).toBeLessThan(c.lag.rmseAtZero);
    expect(c.metrics.rmse).toBeGreaterThan(0.002);
    expect(c.residuals.t.length).toBe(c.metrics.n);
  });

  it('a wrong unit is caught by mapping validation; a wrong scale is exposed by the residuals', () => {
    const project = createVeyrisTwinProject(AT);
    const twin = veyrisArmTwin(project, AT);
    const declared = new Map([
      ['d', { id: 'd', kind: 'measured' as const, unit: 'mm', label: 'd' }],
      ['a', { id: 'a', kind: 'commanded' as const, unit: 'deg', label: 'a' }],
    ]);
    const bad = (patch: Partial<(typeof twin.channels)[number]>, ch = 0) => {
      const t2 = { ...twin, channels: twin.channels.map((c, i) => (i === ch ? { ...c, ...patch } : c)) };
      return validateMappings(t2, project, declared)
        .filter((x) => x.severity === 'error')
        .map((x) => x.message);
    };
    expect(bad({ modelUnit: 'rad' })).toEqual(
      expect.arrayContaining([expect.stringMatching(/different dimensions/)]),
    );
    expect(bad({ deviceUnit: 'cm' })).toEqual(
      expect.arrayContaining([expect.stringMatching(/declares unit "mm"/)]),
    );
    expect(bad({ kind: 'measured' }, 1)).toEqual(
      expect.arrayContaining([expect.stringMatching(/declares this channel commanded/)]),
    );
    expect(bad({ target: { kind: 'joint', mateId: 'nope' } }, 1)).toEqual(
      expect.arrayContaining([expect.stringMatching(/does not exist/)]),
    );
    expect(bad({ target: { kind: 'sensor', partId: 'SV4', quantity: 'distance' } })).toEqual(
      expect.arrayContaining([expect.stringMatching(/not a distance sensor/)]),
    );
    // Device reports cm while declaring mm: units validate, but the comparison shows a 10× error.
    const { s, p } = run(scenario({ faults: { wrongUnit: true } }));
    const obs = observedSignal(p.series.get('d')!, twin.channels[0]!);
    const sim = {
      key: 'x',
      unit: 'm',
      t: Float64Array.from(s.truth.map((x) => x.tS)),
      v: Float64Array.from(s.truth.map((x) => x.distanceMm / 1000)),
      source: 't',
    };
    const c = compare(obs, sim);
    if ('error' in c) throw new Error(c.error);
    expect(c.metrics.bias).toBeGreaterThan(0.15); // simulated − observed ≈ 0.9 × distance
  });
});

describe('designation, actuation boundary and persistence', () => {
  const base = (): EvidenceInput => {
    const project = createVeyrisTwinProject(AT);
    return {
      hasModel: true,
      hasSimulation: true,
      twin: veyrisArmTwin(project, AT),
      recordings: [],
      sync: {},
      datasets: [],
      calibrations: [],
      validations: [],
    };
  };
  it('synthetic telemetry never raises the designation above "simulated system"', () => {
    const e = base();
    const { recording } = run(scenario());
    e.recordings = [recording];
    e.twin = { ...e.twin, evidence: { ...e.twin.evidence, recordings: [recording.id] } };
    const d = designate(e);
    expect(d.level).toBe('simulated-system');
    expect(d.evidence.join(' ')).toMatch(/synthetic.*not evidence/);
    expect(d.missing[0]).toMatch(/physical device/);
  });
  it('requires sync, calibration and INDEPENDENT validation for each further level', () => {
    const e = base();
    const real = { ...run(scenario()).recording, synthetic: false, id: 'rec-real' };
    e.recordings = [real];
    e.twin = { ...e.twin, evidence: { ...e.twin.evidence, recordings: ['rec-real'] } };
    e.sync = { 'rec-real': { latencyP95Ms: 120, missingFraction: 0 } };
    expect(designate(e).level).toBe('telemetry-connected');
    e.sync = { 'rec-real': { latencyP95Ms: 10, missingFraction: 0.001 } };
    expect(designate(e).level).toBe('synchronised');
    const ds = (id: string) =>
      ({
        id,
        provenance: { origin: 'FORGE twin recording rec-real', synthetic: false },
      }) as unknown as Dataset;
    e.datasets = [ds('ds-a'), ds('ds-b')];
    e.calibrations = [{ id: 'c1', datasetId: 'ds-a' } as never];
    expect(designate(e).level).toBe('calibrated');
    e.validations = [{ id: 'v1', status: 'agrees', datasetId: 'ds-a' } as never];
    expect(designate(e).level).toBe('calibrated'); // same data as the calibration: not independent
    e.validations.push({ id: 'v2', status: 'agrees', datasetId: 'ds-b' } as never);
    expect(designate(e).level).toBe('empirically-validated');
  });
  it('physical actuation cannot be requested: no command message, no write path, refusal', () => {
    expect(requestActuation({ requester: 'vci', target: 'j-wrist', value: 1 })).toEqual({
      granted: false,
      reason: ACTUATION_POLICY.reason,
    });
    const a = new SyntheticAdapter(DEFAULT_SCENARIO, { now: () => 0, after: () => undefined });
    expect(a.canActuate).toBe(false);
    for (const k of ['write', 'send', 'command', 'actuate']) expect(k in a).toBe(false);
    expect(parseLine(`@K,1*${checksum('K,1').toString(16).toUpperCase().padStart(2, '0')}`).ok).toBe(false);
  });
  it('twin documents are validated, versioned and bound to their project', () => {
    const project = createVeyrisTwinProject(AT);
    let doc = emptyTwinDocument(project.id);
    const t = veyrisArmTwin(project, AT);
    let r = upsertTwin(doc, t, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    doc = r.doc;
    r = upsertTwin(doc, { ...t, name: 'renamed' }, AT);
    expect(r.ok && r.doc.twins[0]!.revision).toBe(2);
    expect(upsertTwin(doc, { ...t, staleAfterMs: 1 }).ok).toBe(false);
    expect(parseTwinDocument(JSON.stringify(doc), 'other-project').ok).toBe(false);
    expect(parseTwinDocument(JSON.stringify(doc), project.id).ok).toBe(true);
  });
});
