import { createUltrasonicServoSample } from '@forge/electronics';
import { createRoboticArmSimulationSample, loadRapier, type Rapier } from '@forge/physics';
import { beforeAll, describe, expect, it } from 'vitest';
import { signalCatalog } from '../catalog';
import { ResearchEngine } from '../engine';
import { exportExperiment, parseExperimentExport } from '../exchange';
import { computeOutcome, interpolate, type Signal } from '../measure';
import { modelFingerprint } from '../params';
import { Campaign } from '../scheduler';
import type { Experiment, Measurement } from '../schemas';
import { loadVerified, MemoryRunDataStore } from '../store';
import { validateExperiment } from '../validate';
import { armExperiment, measurement, variable } from './fixtures';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});
const at = new Date('2026-11-22T00:00:00Z');
const sig = (key: string, unit: string, t: number[], v: number[], hold = false): Signal => ({
  key,
  unit,
  t: Float64Array.from(t),
  v: Float64Array.from(v),
  source: 'test',
  hold,
});
const M = (p: Partial<Measurement> & Pick<Measurement, 'reduction'>): Measurement =>
  measurement({ id: 'm', source: { kind: 'signal', signal: 'x' }, ...p });
const map = (...s: Signal[]) => new Map(s.map((x) => [x.key, x]));

describe('measurement integrity', () => {
  it('missing samples are excluded and counted — never zero; all-missing gives null', () => {
    const x = sig('x', 'm', [0, 1, 2, 3], [1, NaN, 3, Infinity]);
    const o = computeOutcome(M({ reduction: 'max' }), map(x));
    expect(o).toMatchObject({ value: 3, status: 'partial', samples: 2, missing: 2 });
    expect(computeOutcome(M({ reduction: 'min' }), map(x)).value).toBe(1); // not 0
    const all = computeOutcome(M({ reduction: 'mean' }), map(sig('x', 'm', [0, 1], [NaN, NaN])));
    expect(all).toMatchObject({ value: null, status: 'missing' });
    expect(
      computeOutcome(M({ reduction: 'mean', source: { kind: 'signal', signal: 'nope' } }), map(x)).status,
    ).toBe('missing');
  });

  it('time integrals, RMS, settling and overshoot match analytical values', () => {
    // x(t) = 1 − e^(−t/τ)·cos(ωt) sampled finely: compare with closed forms.
    const t = Array.from({ length: 20001 }, (_, i) => i * 1e-3);
    const ramp = sig(
      'x',
      'rad',
      t,
      t.map((s) => s),
    ); // ∫|t| dt over [0, 20] = 200
    expect(computeOutcome(M({ reduction: 'iae' }), map(ramp)).value!).toBeCloseTo(200, 6);
    expect(computeOutcome(M({ reduction: 'iae' }), map(ramp)).unit).toBe('rad·s');
    expect(computeOutcome(M({ reduction: 'rms' }), map(ramp)).value!).toBeCloseTo(20 / Math.sqrt(3), 4);
    const tau = 1;
    const step = sig(
      'x',
      'm',
      t,
      t.map((s) => 1 - Math.exp(-s / tau)),
    );
    // 2 % settling of a first-order step: t = τ·ln(50) = 3.912 s (to the sample grid).
    expect(computeOutcome(M({ reduction: 'settling-time' }), map(step)).value!).toBeCloseTo(
      Math.log(50 * (1 - Math.exp(-20))),
      2,
    );
    const z = 0.2;
    const wn = 3;
    const wd = wn * Math.sqrt(1 - z * z);
    const osc = sig(
      'x',
      'm',
      t,
      t.map(
        (s) => 1 - Math.exp(-z * wn * s) * (Math.cos(wd * s) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * s)),
      ),
    );
    expect(computeOutcome(M({ reduction: 'overshoot' }), map(osc)).value!).toBeCloseTo(
      Math.exp((-z * Math.PI) / Math.sqrt(1 - z * z)),
      3,
    );
  });

  it('derived signals: dimensional check, interpolation is counted, windows respected', () => {
    const q = sig('q', 'rad', [0, 1, 2], [0, 1, 2]);
    const tgt = sig('tg', 'rad', [0, 0.5, 1.5, 2], [1, 1, 1, 1]);
    const m = M({
      reduction: 'max',
      source: { kind: 'derived', expression: 'abs(q - tg)', aliases: { q: 'q', tg: 'tg' } },
    });
    const o = computeOutcome(m, map(q, tgt));
    expect(o.value).toBe(1);
    expect(o.unit).toBe('rad');
    expect(o.warnings.join()).toMatch(/1 interpolated/);
    const eff = sig('e', 'N·m', [0, 1, 2], [1, 1, 1]);
    const bad = computeOutcome(
      M({ reduction: 'max', source: { kind: 'derived', expression: 'q + e', aliases: { q: 'q', e: 'e' } } }),
      map(q, eff),
    );
    expect(bad.status).toBe('missing');
    expect(bad.warnings[0]).toMatch(/Cannot add/);
    expect(
      computeOutcome(
        M({ reduction: 'final', window: { fromS: 0, toS: 1 } }),
        map(sig('x', 'm', [0, 1, 2], [5, 6, 7])),
      ).value,
    ).toBe(6);
    expect(interpolate({ t: [0, 1], v: [0, 10] }, 2)).toBeNaN(); // no extrapolation
  });

  it('event signals: exact frequency, duty and pulse width from transitions', () => {
    // 50 Hz, 1.5 ms pulses (a servo frame) for 0.1 s.
    const t: number[] = [];
    const v: number[] = [];
    for (let k = 0; k < 5; k++) {
      t.push(k * 0.02, k * 0.02 + 0.0015);
      v.push(1, 0);
    }
    t.push(0.1);
    v.push(0);
    const s = sig('x', '', t, v, true);
    expect(computeOutcome(M({ reduction: 'frequency' }), map(s)).value!).toBeCloseTo(50, 9);
    expect(computeOutcome(M({ reduction: 'pulse-width' }), map(s)).value!).toBeCloseTo(0.0015, 12);
    expect(computeOutcome(M({ reduction: 'duty-cycle' }), map(s)).value!).toBeCloseTo(0.075, 12);
  });
});

describe('unified catalogue and validation', () => {
  it('lists mechanical, electrical, sensor, controller and exact logic signals', () => {
    const arm = signalCatalog(createRoboticArmSimulationSample(at), 'physics', R).map((s) => s.key);
    expect(arm).toEqual(
      expect.arrayContaining(['j-shoulder.q', 'j-shoulder.effort', 'j-shoulder.drift', 'j-shoulder.target']),
    );
    const us = signalCatalog(createUltrasonicServoSample(at), 'cosim', R);
    expect(us.map((s) => s.key)).toEqual(
      expect.arrayContaining([
        'US1.reported',
        'SV1.pulse',
        'SV1.q',
        'j-gauge.q',
        'logic:ECHO',
        'logic:SERVO_PWM',
      ]),
    );
    expect(us.find((s) => s.key === 'logic:ECHO')!.event).toBe(true);
  });

  it('rejects variables and measurements that do not exist in, or do not affect, the selected model', () => {
    const p = createRoboticArmSimulationSample(at);
    const e = {
      ...armExperiment(p),
      schemaVersion: 1 as const,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      revision: 1,
    } as Experiment;
    e.variables.push(variable({ id: 'bogus', target: 'physics.joint.j-elbow.colour' }));
    e.variables.push(variable({ id: 'v2', target: 'physics.payload.payload-ee.massKg', unit: 'V' }));
    e.measurements.push(
      measurement({ id: 'nosig', source: { kind: 'signal', signal: 'US1.reported' }, reduction: 'mean' }),
    );
    const r = validateExperiment(e, p, signalCatalog(p, 'physics', R));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/not a parameter of this model/);
    expect(r.errors.join('\n')).toMatch(/cannot be converted/);
    expect(r.errors.join('\n')).toMatch(/not recorded by physics runs/);
    const good = {
      ...armExperiment(p),
      schemaVersion: 1 as const,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      revision: 1,
    } as Experiment;
    expect(validateExperiment(good, p, signalCatalog(p, 'physics', R))).toMatchObject({ ok: true });
  });
});

describe('result storage and exchange', () => {
  it('exports and re-imports an experiment with raw data; missing or altered data are reported', async () => {
    const p = createRoboticArmSimulationSample(at);
    const eng = ResearchEngine.empty(p.id, () => at);
    eng.execute({ type: 'experiment.create', payload: { experiment: armExperiment(p) } });
    const store = new MemoryRunDataStore();
    await new Campaign(eng, store, p, 'payload', R, {
      env: { now: () => at, yieldNow: async () => undefined },
    }).run();
    const bundle = await exportExperiment(eng.document, 'payload', store);
    const text = JSON.stringify(bundle);
    const back = parseExperimentExport(text);
    expect(back.ok && back.dataProblems).toEqual([]);
    expect(back.ok && back.data.size).toBe(3);
    expect(back.ok && back.bundle.runs[0]!.model.fingerprint).toBe(modelFingerprint(p));
    // Tampered record → refused.
    const t2 = JSON.parse(text);
    t2.runs[0].outcomes.effort.value = 0;
    expect(parseExperimentExport(JSON.stringify(t2))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Integrity/),
    });
    // Raw data deleted from the store → recoverable "missing" state, not a silent report.
    const r0 = eng.runsOf('payload')[0]!;
    await store.delete(r0.data!.key);
    expect(await loadVerified(store, r0.data!)).toEqual({ ok: false, reason: 'missing' });
    const partial = await exportExperiment(eng.document, 'payload', store);
    expect(partial.missingData).toEqual([r0.id]);
  });
});
