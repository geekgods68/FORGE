import { createRoboticArmSimulationSample, loadRapier, type Rapier } from '@forge/physics';
import { beforeAll, describe, expect, it } from 'vitest';
import { ResearchApi } from '../api';
import { ResearchEngine } from '../engine';
import { parseExperimentExport } from '../exchange';
import { generateReport, hypothesisAssessment, outcomesCsv } from '../report';
import { Campaign } from '../scheduler';
import { MemoryRunDataStore } from '../store';
import {
  armPayloadExperiment,
  controllerComparisonExperiment,
  createUltrasonicStudyProject,
} from '../templates';
import { armExperiment } from './fixtures';

/** Programmatic research API and report generation over a real (small) arm campaign. */
let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});
const at = new Date('2026-11-22T00:00:00Z');

function api() {
  const project = createRoboticArmSimulationSample(at);
  const engine = ResearchEngine.empty(project.id, () => at);
  const store = new MemoryRunDataStore();
  return {
    api: new ResearchApi(
      engine,
      store,
      () => project,
      async () => R,
    ),
    engine,
    store,
    project,
  };
}

describe('ResearchApi + report', () => {
  it('creates, validates, runs, compares, reports and exports an experiment', async () => {
    const { api: a, engine, store, project } = api();
    const base = armExperiment(project);
    const draft = {
      ...base,
      variables: base.variables.map((v) => (v.id === 'mass' ? { ...v, levels: [0, 0.3, 0.6] } : v)),
      protocol: { ...base.protocol, durationS: 0.8 },
      hypothesis: {
        statement: 'RMS shoulder effort increases with payload mass.',
        relationship: 'increase' as const,
        independentVariable: 'mass',
        outcome: 'effortRms',
        referenceCondition: '',
        comparisonCondition: '',
        criterion: '',
      },
    };
    expect(a.create(draft).ok).toBe(true);
    const plan = a.createRunPlan(draft.id)!;
    expect(plan.errors).toEqual([]);
    expect(plan.runs.length).toBe(3);
    const v = await a.validate(draft.id);
    expect(v?.ok).toBe(true);

    const res = await a.run(draft.id);
    expect(res.ok).toBe(true);
    expect(a.getStatus()?.phase).toBe('completed');
    const runs = a.getResults(draft.id);
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.state === 'COMPLETED')).toBe(true);

    // Comparison and summaries come from the recorded outcomes only.
    const [c0, , c2] = [...new Set(runs.map((r) => r.conditionId))];
    const cmp = a.compare(draft.id, 'effortRms', c0!, c2!);
    expect(cmp!.differenceOfMeans).toBeGreaterThan(0);
    expect(cmp!.inference).toBeNull(); // n = 1 per condition: no inferential claim
    const summary = a.analyze(draft.id, 'effortRms', 'summary') as { stats: { n: number } }[];
    expect(summary.every((s) => s.stats.n === 1)).toBe(true);

    // Hypothesis assessment is restrained: model-only support, never proof.
    const h = hypothesisAssessment(engine.experiment(draft.id)!, runs);
    expect(h).toContain('consistent with the predicted increase');
    expect(h).toContain('does not prove it');

    const rep = a.report(draft.id);
    for (const s of [
      '1. Research question',
      '4. Assumptions',
      '8. Results',
      '11. Validation status',
      '15. Reproduction',
    ])
      expect(rep.markdown).toContain(s);
    expect(rep.json.incomplete).toBe(false);
    expect((rep.json.runs as unknown[]).length).toBe(3);
    // Missing raw data is declared, never silently presented as complete.
    const inc = generateReport(engine.document, draft.id, { missingData: [runs[0]!.id] });
    expect(inc.markdown).toContain('**Incomplete:**');
    expect(inc.json.incomplete).toBe(true);

    const csv = outcomesCsv(engine.experiment(draft.id)!, runs).trim().split('\n');
    expect(csv).toHaveLength(5); // comment line + header + 3 runs
    expect(csv[0]).toMatch(/^# FORGE experiment outcomes/);
    expect(csv[1]).toContain('var:mass');
    expect(csv[1]).toContain('effortRms [N·m]');

    // Export → import round trip, with raw data verified against recorded hashes.
    const bundle = await a.export(draft.id);
    const back = parseExperimentExport(JSON.stringify(bundle));
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.bundle.runs.map((r) => r.integrityHash)).toEqual(runs.map((r) => r.integrityHash));
      expect(back.data.size).toBe(3);
      expect(back.dataProblems).toEqual([]);
    }
    expect(store).toBeDefined();
  }, 120_000);

  it('refuses invalid experiments and unknown ids without running anything', async () => {
    const { api: a, engine, project } = api();
    const base = armExperiment(project);
    const bad = {
      ...base,
      id: 'bad',
      variables: [{ ...base.variables[0]!, target: 'physics.payload.nope.massKg' }],
    };
    expect(a.create(bad).ok).toBe(true);
    const v = await a.validate('bad');
    expect(v?.ok).toBe(false);
    const r = await a.run('bad');
    expect(r.ok).toBe(false);
    expect(engine.runsOf('bad')).toHaveLength(0);
    expect(await a.validate('missing')).toBeNull();
    expect(a.createRunPlan('missing')).toBeNull();
  });

  it('assesses hypotheses only on the conditions that vary the hypothesis variable', async () => {
    // A: OAT over payload, shoulder target and effort limit. The other variables' sweeps sit at the
    // baseline payload and must not be mixed into the payload trend.
    const arm = createRoboticArmSimulationSample(at);
    const a = ResearchEngine.empty(arm.id, () => at);
    a.execute({ type: 'experiment.create', payload: { experiment: armPayloadExperiment(arm) } });
    await new Campaign(a, new MemoryRunDataStore(), arm, 'exp-a-payload', R).run();
    const ea = a.experiment('exp-a-payload')!;
    expect(hypothesisAssessment(ea, a.runsOf(ea.id))).toContain('consistent with the predicted increase');
    // C: categorical controller choice; direction is taken along the declared level order.
    const us = createUltrasonicStudyProject(at);
    const c = ResearchEngine.empty(us.id, () => at);
    c.execute({ type: 'experiment.create', payload: { experiment: controllerComparisonExperiment(us) } });
    await new Campaign(c, new MemoryRunDataStore(), us, 'exp-c-controllers', R).run();
    const ec = c.experiment('exp-c-controllers')!;
    const hc = hypothesisAssessment(ec, c.runsOf(ec.id));
    expect(hc).toContain('consistent with the predicted decrease');
    expect(hc).toContain('fw-responsive → fw-conservative');
  }, 120_000);
});
