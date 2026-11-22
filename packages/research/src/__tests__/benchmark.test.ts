import { writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { createRoboticArmSimulationSample, loadRapier, type Rapier } from '@forge/physics';
import type { Project } from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { signalCatalog } from '../catalog';
import { compareConditions, regressionSensitivity, summarize } from '../analysis';
import { DEFAULT_BUDGET, generatePlan } from '../design';
import { ResearchEngine, serializeResearch, verifyIntegrity } from '../engine';
import { simulationOfScene } from '../params';
import { Campaign } from '../scheduler';
import { encodeRunData, MemoryRunDataStore } from '../store';
import {
  armPayloadExperiment,
  controllerComparisonExperiment,
  createRcStudyProject,
  createUltrasonicStudyProject,
  rcSweepExperiment,
  sensorNoiseExperiment,
  type ExperimentDraft,
} from '../templates';

/**
 * Research benchmark (opt-in: FORGE_BENCH=1; docs/PERFORMANCE_BASELINE.md, Phase 7).
 * Small, real campaigns on the Phase 5/6 models; every figure is measured, nothing is estimated.
 * Kept short on purpose: the development machine is memory- and disk-constrained.
 */
const RUN = process.env.FORGE_BENCH === '1';
const at = new Date('2026-11-22T00:00:00Z');
const now = () => performance.now();
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const heapMB = () => +(process.memoryUsage().heapUsed / 1048576).toFixed(1);
const ms = (x: number) => +x.toFixed(1);

async function campaign(R: Rapier, project: Project, draft: ExperimentDraft, label: string) {
  const engine = ResearchEngine.empty(project.id, () => at);
  const store = new MemoryRunDataStore();
  const ok = engine.execute({ type: 'experiment.create', payload: { experiment: draft } });
  if (!ok.ok) throw new Error(`${label}: ${ok.error}`);
  const e = engine.experiment(draft.id)!;
  const t0 = now();
  const plan = generatePlan(e, { stepS: simulationOfScene(project.scene)?.solver.timestepS ?? null });
  const planMs = now() - t0;
  if (plan.errors.length) throw new Error(`${label}: ${plan.errors.join(' ')}`);
  gc();
  const heap0 = heapMB();
  const t1 = now();
  const c = new Campaign(engine, store, project, draft.id, R, {
    budget: { ...DEFAULT_BUDGET, maxRuns: 500 },
  });
  const p = await c.run();
  const wall = now() - t1;
  const runs = engine.runsOf(draft.id);
  const simWall = runs.reduce((s, r) => s + r.wallMs, 0);
  const m = draft.measurements[0]!.id;
  const t2 = now();
  const sums = summarize(runs, m);
  const conds = sums.map((s) => s.conditionId);
  if (conds.length >= 2) compareConditions(runs, m, conds[0]!, conds[conds.length - 1]!);
  regressionSensitivity(e, runs, m);
  const analysisMs = now() - t2;
  const t3 = now();
  const intact = runs.every((r) => verifyIntegrity(r));
  const integrityMs = now() - t3;
  // Raw data at rest is the encoded (base64 Float64) form the browser store and exports use.
  let encoded = 0;
  for (const r of runs)
    if (r.data) encoded += JSON.stringify(encodeRunData((await store.get(r.data.key))!)).length;
  const docBytes = serializeResearch(engine.document).length;
  // Recovery: a second campaign over the same records re-verifies and reuses every completed run.
  const t4 = now();
  const again = await new Campaign(engine, store, project, draft.id, R, {
    budget: { ...DEFAULT_BUDGET, maxRuns: 500 },
  }).run();
  const resumeMs = now() - t4;
  gc();
  return {
    label,
    design: `${e.design.kind}, ${plan.runs.length} runs`,
    completed: p.completed,
    failed: p.failed,
    errors: [...new Set(runs.map((r) => r.error).filter(Boolean))].slice(0, 3),
    planMs: +planMs.toFixed(2),
    wallMs: ms(wall),
    runsPerS: +((p.completed / wall) * 1000).toFixed(2),
    simulationShare: +(simWall / wall).toFixed(3),
    schedulingOverheadMsPerRun: +((wall - simWall) / Math.max(1, runs.length)).toFixed(2),
    analysisMs: ms(analysisMs),
    integrityCheckMs: +integrityMs.toFixed(2),
    integrityOk: intact,
    rawDataBytes: encoded,
    researchDocBytes: docBytes,
    heapGrowthMB: +(heapMB() - heap0).toFixed(1),
    resume: { reused: again.reused, simulated: again.completed, wallMs: ms(resumeMs) },
  };
}

describe.skipIf(!RUN)('research benchmark', () => {
  it('measures campaign throughput, overheads, analysis, storage and recovery', async () => {
    const R = await loadRapier();
    const rc = createRcStudyProject(at);
    const results: Record<string, unknown> = {
      when: new Date().toISOString(),
      machine: {
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        memGB: +(totalmem() / 2 ** 30).toFixed(1),
        node: process.version,
        gcExposed: typeof (globalThis as { gc?: unknown }).gc === 'function',
      },
      note: 'Single runs, Node; indicative, not guarantees. Browser figures are in phase7-browser-benchmarks.json.',
    };
    const rcRandom = (n: number): ExperimentDraft => {
      const d = rcSweepExperiment(rc);
      return {
        ...d,
        id: `rc-random-${n}`,
        variables: d.variables.map((v) =>
          v.id === 'R'
            ? { ...v, levels: [], min: 500, max: 5000 } // random design: uniform over [min, max]
            : { ...v, role: 'controlled' as const, levels: [] },
        ),
        protocol: { ...d.protocol, durationS: 0.02, sampleRateHz: 20_000 },
        design: { ...d.design, kind: 'random', samples: n, replicates: 1 },
      };
    };
    const rows = [];
    // 1. 10 / 50 / 100-run experiments (RC transient, random R; 10,000 solver steps per run).
    for (const n of [10, 50, 100])
      rows.push(await campaign(R, rc, rcRandom(n), `RC random sample, ${n} runs`));
    // 2. Two-variable sweep (5 × 5 grid of R × C).
    const grid = rcSweepExperiment(rc);
    rows.push(
      await campaign(
        R,
        rc,
        {
          ...grid,
          id: 'rc-grid-5x5',
          variables: grid.variables.map((v) =>
            v.id === 'R'
              ? { ...v, levels: [470, 1000, 2200, 3300, 4700] }
              : { ...v, levels: [0.22, 0.47, 1, 1.5, 2.2] },
          ),
        },
        'RC 2-variable grid 5 × 5',
      ),
    );
    // 3. Paired stochastic experiment (two threshold controllers under the same noise seeds,
    //    co-simulation) and the replicated sensor-noise study.
    const us = createUltrasonicStudyProject(at);
    rows.push(
      await campaign(
        R,
        us,
        controllerComparisonExperiment(us),
        'Ultrasonic controllers (paired seeds, co-sim)',
      ),
    );
    rows.push(
      await campaign(R, us, sensorNoiseExperiment(us), 'Ultrasonic sensor-noise study (replicated, co-sim)'),
    );
    // 4. Arm payload experiment (Phase 5 physics).
    const arm = createRoboticArmSimulationSample(at);
    rows.push(await campaign(R, arm, armPayloadExperiment(arm), 'Arm payload study (physics)'));
    // 5. Telemetry-heavy: the arm payload study recording 64 signals (the protocol maximum) (physics telemetry
    //    is recorded once per physics step, so a higher requested rate cannot add samples).
    const heavy = armPayloadExperiment(arm);
    const all = signalCatalog(arm, 'physics', R)
      .map((c) => c.key)
      .slice(0, 64); // schema maximum
    rows.push({
      ...(await campaign(
        R,
        arm,
        { ...heavy, id: 'arm-heavy', protocol: { ...heavy.protocol, recordSignals: all } },
        `Arm payload study, ${all.length} signals recorded (protocol maximum)`,
      )),
      signalsRecorded: all.length,
    });
    results.campaigns = rows;
    for (const r of rows) {
      expect(r.errors, r.label).toEqual([]);
      expect(r.failed).toBe(0);
      expect(r.integrityOk).toBe(true);
      expect(r.resume.simulated).toBe(0);
    }
    writeFileSync(
      new URL('../../../../docs/archive/phase7-research-benchmarks.json', import.meta.url),
      JSON.stringify(results, null, 2) + '\n',
    );
    console.log(JSON.stringify(results, null, 2));
  }, 900_000);
});
