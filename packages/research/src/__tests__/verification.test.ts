import { createRoboticArmSimulationSample, loadRapier, type Rapier } from '@forge/physics';
import { beforeAll, describe, expect, it } from 'vitest';
import { ResearchEngine } from '../engine';
import { executeRun } from '../runner';
import { Campaign } from '../scheduler';
import type { Dataset, Experiment } from '../schemas';
import { MemoryRunDataStore } from '../store';
import { convergenceExperiment, createRcStudyProject, rcSweepExperiment } from '../templates';
import {
  calibrate,
  convergenceStudy,
  datasetRecord,
  errorMetrics,
  parseDatasetCsv,
  referenceComparison,
  replayConsistency,
  validationRecord,
  validationStatus,
} from '../verification';
import { mulberry32, normal } from '../random';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});
const at = new Date('2026-11-22T00:00:00Z');
const env = { now: () => at, yieldNow: async () => undefined };

async function runTemplate(
  p: Parameters<typeof rcSweepExperiment>[0],
  draft: ReturnType<typeof rcSweepExperiment>,
) {
  const eng = ResearchEngine.empty(p.id, () => at);
  const r = eng.execute({ type: 'experiment.create', payload: { experiment: draft } });
  if (!r.ok) throw new Error(r.error);
  const store = new MemoryRunDataStore();
  const res = await new Campaign(eng, store, p, draft.id, R, { env }).run();
  return { eng, store, res, e: eng.experiment(draft.id)! };
}

describe('numerical verification', () => {
  it('Experiment D: the RC sweep reproduces the analytical time constant τ = RC', async () => {
    const p = createRcStudyProject(at);
    const { eng, res } = await runTemplate(p, rcSweepExperiment(p));
    expect(res).toMatchObject({ completed: 9, failed: 0 });
    const cmp = referenceComparison(
      eng.runsOf('exp-d-rc'),
      'tau',
      (r) => (r.config.variables.R as number) * (r.config.variables.C as number) * 1e-6,
      'τ = R·C',
    );
    expect(cmp.rows).toHaveLength(9);
    expect(cmp.maxRelError!).toBeLessThan(0.005);
    expect(replayConsistency(eng.runsOf('exp-d-rc'), 'tau').maxSpread).toBe(0);
  });

  it('Experiment E: successive timestep refinement of the arm trajectory is assessed, with cost and drift', async () => {
    const p = createRoboticArmSimulationSample(at);
    const { eng, store, res } = await runTemplate(p, convergenceExperiment(p) as never);
    expect(res.completed).toBe(4);
    const c = await convergenceStudy(
      eng.runsOf('exp-e-convergence'),
      store,
      'j-shoulder.q',
      'dt',
      1e-3,
      'drift',
    );
    if ('error' in c) throw new Error(c.error);
    expect(c.levels.map((l) => Math.round(l.parameter * 100) / 100)).toEqual([16.67, 8.33, 4.17, 2.08]);
    expect(c.differences).toHaveLength(3);
    expect(c.observedOrders).toHaveLength(2);
    expect(['converging', 'not-converging', 'stalled']).toContain(c.verdict);
    expect(c.levels.every((l) => l.drift !== null)).toBe(true);
    // Finer steps cost more wall time.
    expect(c.levels[3]!.wallMs).toBeGreaterThan(c.levels[0]!.wallMs);
    // Two levels are not enough to claim anything.
    const two = await convergenceStudy(
      eng.runsOf('exp-e-convergence').slice(0, 2),
      store,
      'j-shoulder.q',
      'dt',
      1e-3,
    );
    expect(!('error' in two) && two.verdict).toBe('insufficient-levels');
  });
});

describe('empirical data, calibration and validation (kept separate)', () => {
  it('CSV import validates units, timestamps and missing values', () => {
    const ok = parseDatasetCsv('t [ms],V [V]\n0,0\n1,1.2\n2,\n3,NA\n');
    expect(ok).toMatchObject({ ok: true, rows: 4 });
    expect(ok.warnings[0]).toMatch(/2 missing/);
    expect(Number.isNaN(ok.values[1]![2]!)).toBe(true);
    expect(parseDatasetCsv('t [s],x [furlong]\n0,1\n').errors[0]).toMatch(/unknown unit/);
    expect(parseDatasetCsv('t [s],x [m]\n0,1\n0,2\n').errors[0]).toMatch(/strictly increasing/);
    expect(parseDatasetCsv('x [m]\n1\n').errors[0]).toMatch(/No time column/);
    expect(parseDatasetCsv('t [s],x [m]\n0,abc\n').errors[0]).toMatch(/not a number/);
  });

  it('recovers a known capacitance from independently generated (synthetic, labelled) data; R and C together are not identifiable', async () => {
    const p = createRcStudyProject(at);
    const eng = ResearchEngine.empty(p.id, () => at);
    const draft = rcSweepExperiment(p);
    eng.execute({
      type: 'experiment.create',
      payload: {
        experiment: {
          ...draft,
          design: { ...draft.design, kind: 'single' },
          protocol: { ...draft.protocol, durationS: 0.01, sampleRateHz: 20_000, recordSignals: ['V(VC)'] },
        },
      },
    });
    const e = eng.experiment('exp-d-rc')! as Experiment;
    // Reference data: the model at C = 1.5 µF plus seeded Gaussian noise (σ = 5 mV). Synthetic.
    const truth = await executeRun(
      p,
      e,
      { id: 't', label: 'truth', values: { R: 1000, C: 1.5 } },
      { conditionId: 't', replicate: 0, seed: 1 },
      { R, ...env },
    );
    const v = truth.data!.signals.find((s) => s.key === 'V(VC)')!;
    const rnd = mulberry32(99);
    const rows = Array.from(v.t)
      .filter((_, i) => i % 10 === 0)
      .map((t) => `${t},${(Array.from(v.v)[Array.from(v.t).indexOf(t)]! + 0.005 * normal(rnd)).toFixed(6)}`);
    const parsed = parseDatasetCsv(['t [s],V [V]', ...rows].join('\n'));
    expect(parsed.ok).toBe(true);
    const ds = datasetRecord(
      'ds-cal',
      'Synthetic RC charge (C = 1.5 µF)',
      'csv',
      parsed,
      {
        origin: 'Generated by the FORGE RC model for a calibration test',
        instrument: 'none',
        collectedAt: '',
        operator: '',
        notes: '',
        synthetic: true,
      },
      at,
    );
    const cal = await calibrate({
      project: p,
      experiment: e,
      R,
      parameters: [{ variableId: 'C', lower: 0.1, upper: 10 }],
      dataset: ds.record,
      data: ds.data,
      mapping: [{ column: 'V', signal: 'V(VC)' }],
      id: 'cal-1',
      now: at,
    });
    if ('error' in cal) throw new Error(cal.error);
    expect(cal.fitted.C).toBeCloseTo(1.5, 1);
    expect(Math.abs(cal.fitted.C! - 1.5) / 1.5).toBeLessThan(0.01);
    expect(cal.record.parameters[0]!.nominal).toBe(1); // nominal kept, project untouched
    expect(cal.record.residual.rmse).toBeLessThan(0.008);
    expect(eng.recordCalibration(cal.record).ok).toBe(true);
    // Fitting R and C from a charging curve: only τ = RC is identifiable.
    const both = await calibrate({
      project: p,
      experiment: e,
      R,
      parameters: [
        { variableId: 'R', lower: 100, upper: 1e5 },
        { variableId: 'C', lower: 0.1, upper: 10 },
      ],
      dataset: ds.record,
      data: ds.data,
      mapping: [{ column: 'V', signal: 'V(VC)' }],
      id: 'cal-2',
      maxIterations: 8,
      now: at,
    });
    if ('error' in both) throw new Error(both.error);
    expect(both.record.identifiability.join(' ')).toMatch(/not identifiable|strongly correlated/);

    // Validation: the calibration dataset cannot validate its own fit; synthetic data never "validate".
    const run = truth.record;
    const m = errorMetrics(ds.data.signals[0]!, v, 0.01);
    if ('error' in m) throw new Error(m.error);
    const v1 = validationRecord({
      id: 'val-1',
      experimentId: e.id,
      dataset: ds.record,
      run,
      mapping: [{ column: 'V', signal: 'V(VC)' }],
      metrics: [m],
      acceptance: { metric: 'rmse', threshold: 0.01 },
      calibrations: eng.document.calibrations,
      operatingRange: 'RC charging, 0–10 ms',
      now: at,
    });
    expect(v1).toMatchObject({ independent: false, status: 'not-independent' });
    const other: Dataset = { ...ds.record, id: 'ds-val' };
    const v2 = validationRecord({
      id: 'val-2',
      experimentId: e.id,
      dataset: other,
      run,
      mapping: [{ column: 'V', signal: 'V(VC)' }],
      metrics: [m],
      acceptance: { metric: 'rmse', threshold: 0.01 },
      calibrations: eng.document.calibrations,
      operatingRange: 'RC charging, 0–10 ms',
      now: at,
    });
    expect(v2).toMatchObject({ independent: true, status: 'synthetic-only' });
    expect(validationStatus([v1, v2], e.id)).toMatch(/Not empirically validated/);
    // Status logic only (fixture flagged as measured to exercise the branch; not presented as data).
    const measured: Dataset = {
      ...other,
      id: 'ds-logic',
      provenance: { ...other.provenance, synthetic: false, origin: 'unit-test fixture for status logic' },
    };
    const v3 = validationRecord({
      id: 'val-3',
      experimentId: e.id,
      dataset: measured,
      run,
      mapping: [{ column: 'V', signal: 'V(VC)' }],
      metrics: [m],
      acceptance: { metric: 'rmse', threshold: 0.01 },
      calibrations: eng.document.calibrations,
      operatingRange: 'RC charging, 0–10 ms',
      now: at,
    });
    expect(v3.status).toBe('agrees');
    expect(validationStatus([v3], e.id)).toMatch(/Not validated outside these conditions/);
  });
});
