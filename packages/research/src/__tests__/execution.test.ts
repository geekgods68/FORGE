import { createUltrasonicServoSample } from '@forge/electronics';
import type { Project } from '@forge/engineering-core';
import { createRoboticArmSimulationSample, loadRapier, type Rapier } from '@forge/physics';
import { beforeAll, describe, expect, it } from 'vitest';
import { generatePlan } from '../design';
import { checkHistory, ResearchEngine, verifyIntegrity } from '../engine';
import { modelFingerprint } from '../params';
import { Campaign } from '../scheduler';
import type { Experiment } from '../schemas';
import { loadVerified, MemoryRunDataStore } from '../store';
import { armExperiment, measurement, variable } from './fixtures';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});
const at = new Date('2026-11-22T00:00:00Z');
const now = () => at;
const yieldNow = async () => undefined;

function setup(patch: Partial<Experiment> = {}, project = createRoboticArmSimulationSample(at)) {
  const eng = ResearchEngine.empty(project.id, now);
  const r = eng.execute({
    type: 'experiment.create',
    payload: { experiment: armExperiment(project, patch) },
  });
  if (!r.ok) throw new Error(r.error);
  return { eng, project, store: new MemoryRunDataStore() };
}

describe('designs', () => {
  it('refuses an exhaustive grid that exceeds the budget, with its size, before enumerating', () => {
    const p = createRoboticArmSimulationSample(at);
    const e = {
      ...armExperiment(p),
      schemaVersion: 1 as const,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      revision: 1,
    } as Experiment;
    e.variables = Array.from({ length: 20 }, (_, i) =>
      variable({ id: `v${i}`, target: 'physics.gravity.y', levels: [1, 2, 3] }),
    );
    e.design = { ...e.design, kind: 'grid' };
    const plan = generatePlan(e, { stepS: 1 / 120 });
    expect(plan.runs).toHaveLength(0);
    expect(plan.errors[0]).toMatch(/3,486,784,401 runs/);
  });

  it('Latin hypercube puts exactly one sample in each stratum of each variable', () => {
    const p = createRoboticArmSimulationSample(at);
    const e = {
      ...armExperiment(p),
      schemaVersion: 1 as const,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      revision: 1,
    } as Experiment;
    e.variables = [
      variable({ id: 'a', target: 'physics.gravity.y', min: 0, max: 10 }),
      variable({ id: 'b', target: 'physics.gravity.y', min: -1, max: 1 }),
    ];
    e.design = { ...e.design, kind: 'lhs', samples: 8 };
    const plan = generatePlan(e, { stepS: null });
    for (const [id, lo, hi] of [
      ['a', 0, 10],
      ['b', -1, 1],
    ] as const) {
      const strata = plan.conditions
        .map((c) => Math.floor((((c.values[id] as number) - lo) / (hi - lo)) * 8))
        .sort((x, y) => x - y);
      expect(strata).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }
  });
});

describe('campaign execution on the Phase 5 arm', () => {
  it('runs a one-factor-at-a-time payload sweep; records are complete, immutable and traceable', async () => {
    const { eng, project, store } = setup();
    const c = new Campaign(eng, store, project, 'payload', R, { env: { now, yieldNow } });
    expect(c.plan.conditions.map((x) => x.label)).toEqual([
      'baseline',
      'Payload mass = 0.3',
      'Payload mass = 0.6',
    ]);
    const res = await c.run();
    expect(res).toMatchObject({ phase: 'completed', completed: 3, failed: 0 });
    const runs = eng.runsOf('payload');
    for (const r of runs) {
      expect(r.state).toBe('COMPLETED');
      expect(checkHistory(r.history)).toBeNull();
      expect(verifyIntegrity(r)).toBe(true);
      expect(r.model.fingerprint).toBe(modelFingerprint(project));
      expect(r.versions.physics).toMatch(/rapier3d-compat 0\.19/);
      expect(r.config.applied.find((a) => a.target === 'physics.joint.j-shoulder.target')!.value).toBeCloseTo(
        Math.PI / 6,
        12,
      );
      expect((await loadVerified(store, r.data!)).ok).toBe(true);
    }
    // Physics answers the question: more payload → more (RMS) shoulder effort; with payload
    // the peak reaches the cited 0.922 N·m effort limit (saturation), so the peak stops rising.
    const rms = runs.map((r) => r.outcomes.effortRms!.value!);
    expect(rms[1]!).toBeGreaterThan(rms[0]!);
    expect(rms[2]!).toBeGreaterThan(rms[1]!);
    expect(runs[2]!.outcomes.effort!.value!).toBeCloseTo(0.92183, 4);
    expect(runs[0]!.outcomes.err!.unit).toBe('rad');
    expect(runs[0]!.outcomes.effort!.unit).toBe('N·m');
  });

  it('resuming reuses identical completed runs instead of re-simulating; a changed model is rerun', async () => {
    const { eng, project, store } = setup();
    await new Campaign(eng, store, project, 'payload', R, { env: { now, yieldNow } }).run();
    const again = await new Campaign(eng, store, project, 'payload', R, { env: { now, yieldNow } }).run();
    expect(again).toMatchObject({ reused: 3, completed: 0 });
    expect(eng.runsOf('payload')).toHaveLength(3);
    const changed = JSON.parse(JSON.stringify(project)) as Project;
    const root = changed.scene.nodes[changed.scene.rootId]!;
    if (root.kind === 'root') root.simulation!.joints[0]!.damping = 0.01;
    const third = await new Campaign(eng, store, changed, 'payload', R, { env: { now, yieldNow } }).run();
    expect(third.completed).toBe(3);
  });

  it('cancellation keeps completed runs; an invalid condition does not destroy the others', async () => {
    const { eng, project, store } = setup({});
    // mass −1 kg is allowed by the experiment's own range but refused by the model.
    eng.execute({
      type: 'experiment.defineVariable',
      payload: {
        experimentId: 'payload',
        variable: variable({
          id: 'mass',
          name: 'Payload mass',
          unit: 'kg',
          target: 'physics.payload.payload-ee.massKg',
          min: -1,
          max: 2,
          default: 0,
          levels: [0, -1, 0.6],
        }),
      },
    });
    const c = new Campaign(eng, store, project, 'payload', R, { env: { now, yieldNow } });
    const res = await c.run();
    expect(res.completed).toBe(2);
    expect(res.failed).toBe(1);
    const bad = eng.runsOf('payload').find((r) => r.state === 'INVALID')!;
    expect(bad.error).toMatch(/outside the supported range/);
    const { eng: e2, project: p2, store: s2 } = setup();
    const c2 = new Campaign(e2, s2, p2, 'payload', R, {
      env: { now, yieldNow },
      onProgress: (pr) => {
        if (pr.done === 1) c2.cancel();
      },
    });
    const r2 = await c2.run();
    expect(r2.phase).toBe('cancelled');
    expect(e2.runsOf('payload').filter((r) => r.state === 'COMPLETED')).toHaveLength(1);
  });

  it('runs use the snapshot taken when the campaign was created', async () => {
    const { eng, project: frozen, store } = setup();
    const project = structuredClone(frozen);
    const c = new Campaign(eng, store, project, 'payload', R, { env: { now, yieldNow } });
    const fp = modelFingerprint(project);
    const root = project.scene.nodes[project.scene.rootId]!;
    if (root.kind === 'root') (root.simulation!.payloads[0] as { massKg: number }).massKg = 5; // edit the source after scheduling
    await c.run();
    expect(eng.runsOf('payload').every((r) => r.model.fingerprint === fp)).toBe(true);
  });
});

describe('electronics experiments', () => {
  it('co-simulation runs record seeds; paired seeds give identical noise across conditions', async () => {
    const p = createUltrasonicServoSample(at);
    const eng = ResearchEngine.empty(p.id, now);
    const e = armExperiment(p, {
      id: 'noise',
      variables: [
        variable({
          id: 'noise',
          name: 'Sensor noise',
          unit: 'mm',
          target: 'electrical.part.US1.noiseStdM',
          min: 0,
          max: 50,
          default: 5,
          levels: [5],
        }),
        variable({
          id: 'far',
          name: 'FAR_CM',
          role: 'independent',
          target: 'firmware.fw-gauge.const.FAR_CM',
          default: 50,
          levels: [50, 80],
        }),
      ],
      measurements: [
        measurement({ id: 'dist', source: { kind: 'signal', signal: 'US1.reported' }, reduction: 'mean' }),
        measurement({ id: 'distsd', source: { kind: 'signal', signal: 'US1.reported' }, reduction: 'std' }),
      ],
      design: {
        kind: 'paired',
        replicates: 2,
        samples: 1,
        baseSeed: 3,
        pairedSeeds: true,
        randomizeOrder: false,
      },
    });
    e.protocol = {
      ...e.protocol,
      model: { ...e.protocol.model, kind: 'cosim' },
      durationS: 1,
      sampleRateHz: 60,
    };
    expect(eng.execute({ type: 'experiment.create', payload: { experiment: e } }).ok).toBe(true);
    const c = new Campaign(eng, new MemoryRunDataStore(), p, 'noise', R, { env: { now, yieldNow } });
    const res = await c.run();
    expect(res).toMatchObject({ completed: 4, failed: 0 });
    const runs = eng.runsOf('noise');
    const byRep = (rep: number) => runs.filter((r) => r.replicate === rep);
    // Same replicate → same seed in both conditions (paired streams); different replicates differ.
    expect(new Set(byRep(0).map((r) => r.config.seed)).size).toBe(1);
    expect(byRep(0)[0]!.config.seed).not.toBe(byRep(1)[0]!.config.seed);
    // The sensor-noise sequence depends only on the seed: identical distance statistics within a pair.
    expect(byRep(0)[0]!.outcomes.dist!.value).toBe(byRep(0)[1]!.outcomes.dist!.value);
    expect(byRep(0)[0]!.outcomes.dist!.value).not.toBe(byRep(1)[0]!.outcomes.dist!.value);
    expect(runs[0]!.outcomes.distsd!.value!).toBeGreaterThan(0.002);
    expect(runs[0]!.versions.cosim).toBe('forge-cosim 1');
  });
});
