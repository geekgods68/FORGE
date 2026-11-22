import { PROJECT_SCHEMA_VERSION, type Project } from '@forge/engineering-core';
import { analogCircuitOf, COSIM_VERSION, CoSimulation, physicsPortOf } from '@forge/electronics';
import { PhysicsSession, type Rapier } from '@forge/physics';
import type { Condition, PlannedRun } from './design';
import { integrityOf } from './engine';
import { hashOfSeries, hashOfValue, sha256 } from './hash';
import { computeOutcome, type Signal } from './measure';
import { applyValues, electricalOfScene, modelFingerprint, simulationOfScene } from './params';
import { RNG_ID } from './random';
import {
  RESEARCH_SCHEMA_VERSION,
  type Experiment,
  type Outcome,
  type ParamValue,
  type RunRecord,
  type RunState,
} from './schemas';

/**
 * Executes ONE planned run on an immutable snapshot of the project, through the existing
 * simulation interfaces (Phase 5 PhysicsSession, Phase 6 CoSimulation / analog solver) and
 * their own clocks — the research layer adds no clock. Execution is chunked and awaits between
 * chunks, so it never depends on (or blocks) the display frame rate.
 */
export const RESEARCH_ENGINE_VERSION = 'forge-research 1';

export interface RunData {
  signals: Signal[];
}

export interface RunEnv {
  R: Rapier;
  now?: () => Date;
  /** Yield to the host between chunks (default: a macrotask). */
  yieldNow?: () => Promise<void>;
  isCancelled?: () => boolean;
  maxWallMs?: number;
  maxSamplesPerRun?: number;
  newId?: () => string;
}

const wall = (): number =>
  (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();
const defaultYield = () =>
  new Promise<void>((r) =>
    (globalThis as unknown as { setTimeout(f: () => void, ms: number): unknown }).setTimeout(r, 0),
  );
let counter = 0;
const defaultId = () => `run-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function versionsOf(R: Rapier): Record<string, string> {
  return {
    research: RESEARCH_ENGINE_VERSION,
    researchSchema: String(RESEARCH_SCHEMA_VERSION),
    projectSchema: String(PROJECT_SCHEMA_VERSION),
    physics: `rapier3d-compat ${R.version()}`,
    cosim: COSIM_VERSION,
    circuit: 'forge-mna 1',
    firmwareRuntime: 'forge-arduino-subset 1 (Level 2)',
    rng: RNG_ID,
  };
}

/** Values to apply for a condition: every variable except dependent ones, in its own unit. */
export function valuesFor(e: Experiment, c: Condition) {
  return e.variables
    .filter((v) => v.role !== 'dependent' && c.values[v.id] !== undefined)
    .map((v) => ({ target: v.target, value: c.values[v.id]!, unit: v.unit }));
}

/** Hash identifying a run configuration (used for duplicate detection and safe reuse). */
export function configHashOf(input: unknown): string {
  return hashOfValue(input);
}

export async function executeRun(
  base: Project,
  e: Experiment,
  cond: Condition,
  planned: PlannedRun,
  env: RunEnv,
  retryOf: string | null = null,
  /** Called with the configuration hash BEFORE any simulation work: return a record to reuse it. */
  reuse?: (configHash: string) => RunRecord | undefined,
): Promise<{ record: RunRecord; data: RunData | null; reused?: boolean }> {
  const now = env.now ?? (() => new Date());
  const history: RunRecord['history'] = [];
  const mark = (state: RunState, note = '') => history.push({ state, at: now().toISOString(), note });
  mark('CREATED');
  const values = valuesFor(e, cond);
  const kind = e.protocol.model.kind;
  const app = applyValues(base, values);
  let project = app.project;
  const warnings: string[] = [];
  const t0 = wall();
  const finish = (
    state: RunState,
    extra: Partial<RunRecord> & { data?: RunRecord['data'] },
    dataOut: RunData | null,
  ) => {
    mark(state, extra.error ?? '');
    const el = electricalOfScene(project.scene);
    const rec: RunRecord = {
      id: (env.newId ?? defaultId)(),
      experimentId: e.id,
      experimentRevision: e.revision,
      conditionId: cond.id,
      conditionLabel: cond.label,
      replicate: planned.replicate,
      state,
      history,
      config,
      configHash,
      model: {
        kind,
        projectId: base.id,
        projectRevision: base.revision,
        fingerprint: modelFingerprint(base),
        runModelFingerprint: modelFingerprint(project),
        firmware: el?.firmware.map((f) => ({ id: f.id, revision: f.revision, hash: sha256(f.source) })) ?? [],
      },
      versions: versionsOf(env.R),
      startedAt: history.find((h) => h.state === 'RUNNING')?.at ?? null,
      completedAt: now().toISOString(),
      wallMs: wall() - t0,
      simulatedS: extra.simulatedS ?? 0,
      steps: extra.steps ?? 0,
      outcomes: extra.outcomes ?? {},
      warnings: [...warnings, ...(extra.warnings ?? [])].slice(0, 100),
      error: extra.error ?? null,
      data: extra.data ?? null,
      retryOf,
      integrityHash: '',
    };
    rec.integrityHash = integrityOf(rec);
    return { record: rec, data: dataOut };
  };
  // Seed: written into the run's copy where the model uses one (sensor noise).
  if (app.ok && kind !== 'physics' && electricalOfScene(project.scene)) {
    const seeded = applySeed(project, planned.seed);
    if (seeded) project = seeded;
  }
  const sim = simulationOfScene(project.scene);
  const el = electricalOfScene(project.scene);
  const solver: Record<string, unknown> = {
    ...(sim && kind !== 'circuit' ? { physics: sim.solver, gravity: sim.gravity } : {}),
    ...(el && kind !== 'physics'
      ? {
          circuit: el.settings.solver,
          transient: el.settings.transient,
          cosim: {
            opCostNs: el.settings.cosim.opCostNs,
            ambientC: el.settings.cosim.ambientC,
            seed: el.settings.cosim.seed,
          },
        }
      : {}),
  };
  const measurements = e.measurements;
  const config: RunRecord['config'] = {
    variables: Object.fromEntries(Object.entries(cond.values)) as Record<string, ParamValue>,
    applied: app.applied,
    durationS: e.protocol.durationS,
    warmupS: e.protocol.warmupS,
    sampleRateHz: e.protocol.sampleRateHz,
    seed: planned.seed,
    rng: RNG_ID,
    measurements,
    solver,
  };
  const configHash = configHashOf({
    experimentId: e.id,
    conditionId: cond.id,
    replicate: planned.replicate,
    config,
    model: modelFingerprint(project),
    runtime: app.runtime,
    versions: versionsOf(env.R),
  });
  const prior = reuse?.(configHash);
  if (prior) return { record: prior, data: null, reused: true };
  if (!app.ok) return finish('INVALID', { error: app.errors.join(' ') }, null);
  if (kind !== 'circuit' && !sim && kind === 'physics')
    return finish('INVALID', { error: 'The model has no physics setup.' }, null);
  if ((kind === 'cosim' || kind === 'circuit') && !el)
    return finish('INVALID', { error: 'The model has no circuit.' }, null);
  mark('VALIDATED');
  mark('QUEUED');
  mark('RUNNING');
  const yieldNow = env.yieldNow ?? defaultYield;
  const maxWall = env.maxWallMs ?? 120_000;
  const keep = new Set<string>([
    ...e.protocol.recordSignals,
    ...measurements.flatMap((m) =>
      m.source.kind === 'signal' ? [m.source.signal] : Object.values(m.source.aliases),
    ),
    ...e.protocol.stopConditions.map((s) => s.signal),
  ]);
  const maxSamples = Math.min(env.maxSamplesPerRun ?? 50_000, 200_000);
  const rate = e.protocol.sampleRateHz;
  const samplesNeeded = Math.min(maxSamples, Math.ceil(e.protocol.durationS * rate) + 10);
  let simulatedS = 0;
  let steps = 0;
  const signals: Signal[] = [];
  try {
    if (kind === 'circuit') {
      const c = analogCircuitOf(el!);
      const res = c.transient(e.protocol.durationS, el!.settings.transient.stepS, {
        maxPoints: samplesNeeded,
      });
      if (!res.ok)
        return finish(
          'FAILED',
          { error: `Circuit solver: ${res.diagnostics.map((d) => d.message).join(' ')}` },
          null,
        );
      steps = res.steps;
      simulatedS = res.t[res.t.length - 1] ?? 0;
      warnings.push(...res.warnings.map((w) => w.message));
      const t = Float64Array.from(res.t);
      c.netlist.nets.forEach((n) => {
        const key = `V(${n.name})`;
        if (keep.has(key))
          signals.push({
            key,
            unit: 'V',
            t,
            v: Float64Array.from(res.v[n.index]!),
            source: 'circuit transient (MNA)',
          });
      });
      for (const [k, arr] of res.i) {
        const key = `I(${k})`;
        if (keep.has(key))
          signals.push({ key, unit: 'A', t, v: Float64Array.from(arr), source: 'circuit transient (MNA)' });
      }
    } else {
      const def = sim
        ? {
            ...sim,
            recording: {
              sampleRateHz: Math.min(1000, rate),
              maxSamples: Math.max(100, Math.min(200_000, samplesNeeded)),
            },
          }
        : null;
      if (kind === 'physics' && !def)
        return finish('INVALID', { error: 'The model has no physics setup.' }, null);
      if (rate > 1000 && def) warnings.push('Physics telemetry records at most 1000 Hz.');
      const session = def ? PhysicsSession.fromScene(env.R, project.scene, def) : null;
      if (session && !session.ok)
        return finish(
          'FAILED',
          {
            error: `Physics model: ${session.model.issues
              .filter((i) => i.severity === 'error')
              .map((i) => i.message)
              .join(' ')}`,
          },
          null,
        );
      const port = session ? physicsPortOf(session, project.scene) : null;
      for (const a of app.runtime) {
        if (!port) return finish('INVALID', { error: 'Runtime inputs need a physics setup.' }, null);
        const m = port.nodeMatrix(a.nodeId);
        if (!m) return finish('INVALID', { error: `Node ${a.nodeId} not found.` }, null);
        const r = port.moveNode(a.nodeId, [m[12]!, m[13]!, a.value]);
        if (!r.ok) return finish('INVALID', { error: `Cannot move ${a.nodeId}: ${r.error}` }, null);
      }
      let cs: CoSimulation | null = null;
      if (kind === 'cosim') {
        const elDef = {
          ...el!,
          settings: {
            ...el!.settings,
            cosim: {
              ...el!.settings.cosim,
              recording: {
                ...el!.settings.cosim.recording,
                sampleRateHz: rate,
                maxSamples: Math.max(100, Math.min(200_000, samplesNeeded)),
              },
            },
          },
        };
        cs = new CoSimulation(elDef, { physics: port, scene: project.scene, now });
        cs.start();
      }
      const h = session?.definition.solver.timestepS ?? 0.001;
      const totalSteps = Math.round(e.protocol.durationS / h);
      const endNs = Math.round(e.protocol.durationS * 1e9);
      const stopHit = () => {
        for (const sc of e.protocol.stopConditions) {
          const s = cs?.recorder.series(sc.signal) ?? (session ? seriesOf(session, sc.signal) : null);
          const last = s?.v[s.v.length - 1];
          if (
            last !== undefined &&
            Number.isFinite(last) &&
            (sc.op === '>' ? last > sc.value : last < sc.value)
          )
            return `stop condition ${sc.signal} ${sc.op} ${sc.value}`;
        }
        return null;
      };
      let stopped: string | null = null;
      while (!stopped) {
        const c0 = wall();
        if (cs) {
          const target = Math.min(endNs, cs.now + 100_000_000);
          cs.advanceTo(target);
          if (cs.fault)
            return finish(
              'FAILED',
              { error: `Co-simulation: ${cs.fault}`, simulatedS: cs.now / 1e9, steps: cs.k },
              null,
            );
          simulatedS = cs.now / 1e9;
          steps = cs.k;
          if (cs.now >= endNs) break;
        } else if (session) {
          const n = Math.min(120, totalSteps - steps);
          const done = session.step(n);
          steps += done;
          simulatedS = session.time;
          if (session.state === 'faulted' || done < n)
            return finish(
              'FAILED',
              { error: `Physics: ${session.fault ?? 'stopped'}`, simulatedS, steps },
              null,
            );
          if (steps >= totalSteps) break;
        }
        stopped = stopHit();
        if (env.isCancelled?.())
          return finish('CANCELLED', { error: 'Cancelled by the user.', simulatedS, steps }, null);
        if (wall() - t0 > maxWall)
          return finish(
            'INTERRUPTED',
            { error: `Exceeded the ${maxWall} ms wall-clock budget for one run.`, simulatedS, steps },
            null,
          );
        if (wall() - c0 >= 0) await yieldNow();
      }
      if (stopped) warnings.push(`Stopped early: ${stopped}.`);
      const mcu = cs?.mcus.find((m) => m.state === 'error');
      if (mcu)
        return finish(
          'FAILED',
          {
            error: `Firmware: ${mcu.events
              .filter((x) => x.kind === 'error')
              .map((x) => x.message)
              .join(' ')}`,
            simulatedS,
            steps,
          },
          null,
        );
      if (session?.telemetry && session.telemetry.dropped)
        warnings.push(`${session.telemetry.dropped} physics telemetry samples dropped (buffer).`);
      for (const key of keep) {
        const ch = cs?.recorder.channels.find((c) => c.key === key);
        if (ch && cs) {
          const s = cs.recorder.series(key)!;
          signals.push({
            key,
            unit: ch.unit === 'µs' ? 'µs' : ch.unit,
            t: Float64Array.from(s.t),
            v: Float64Array.from(s.v),
            source: `co-simulation (${ch.kind})`,
          });
          continue;
        }
        const pch = session?.telemetry.channels.find((c) => c.key === key);
        if (pch && session) {
          const s = session.telemetry.series(key);
          signals.push({
            key,
            unit: pch.unit === '0/1' ? '' : pch.unit,
            t: Float64Array.from(s.t),
            v: Float64Array.from(s.v),
            source: `physics (${pch.kind})`,
          });
        }
      }
      cs?.dispose();
      session?.dispose();
    }
  } catch (err) {
    return finish(
      'FAILED',
      { error: `Run error: ${err instanceof Error ? err.message : String(err)}`, simulatedS, steps },
      null,
    );
  }
  const map = new Map(signals.map((s) => [s.key, s]));
  const outcomes: Record<string, Outcome> = {};
  const failures: string[] = [];
  for (const m of measurements) {
    const mm = { ...m, window: { fromS: Math.max(m.window.fromS, e.protocol.warmupS), toS: m.window.toS } };
    const o = computeOutcome(mm, map);
    outcomes[m.id] = o;
    if (m.required && o.value === null) failures.push(`${m.name}: ${o.warnings.join(' ') || 'unavailable'}`);
  }
  const hash = signals.length
    ? hashOfSeries(
        Float64Array.from(signals.flatMap((s) => Array.from(s.t))),
        signals.map((s) => s.v),
      )
    : sha256('');
  const bytes = signals.reduce((n, s) => n + s.t.byteLength + s.v.byteLength, 0);
  const data: RunRecord['data'] = {
    key: `${e.id}/${cond.id}/r${planned.replicate}/${configHash.slice(0, 12)}`,
    hash,
    bytes,
    samples: signals.reduce((n, s) => Math.max(n, s.t.length), 0),
    signals: signals.map((s) => ({ key: s.key, unit: s.unit })),
  };
  if (failures.length)
    return finish(
      'FAILED',
      {
        error: `Required measurement unavailable: ${failures.join('; ')}`,
        simulatedS,
        steps,
        outcomes,
        data,
      },
      { signals },
    );
  return finish('COMPLETED', { simulatedS, steps, outcomes, data }, { signals });
}

function seriesOf(session: PhysicsSession, key: string) {
  return session.telemetry.channels.some((c) => c.key === key) ? session.telemetry.series(key) : null;
}

function applySeed(p: Project, seed: number): Project | null {
  const root = p.scene.nodes[p.scene.rootId];
  if (root?.kind !== 'root' || !root.electrical) return null;
  const copy = JSON.parse(JSON.stringify(p)) as Project;
  const r = copy.scene.nodes[copy.scene.rootId]!;
  if (r.kind === 'root' && r.electrical) r.electrical.settings.cosim.seed = seed;
  return copy;
}
