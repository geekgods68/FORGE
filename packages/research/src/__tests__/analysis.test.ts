import { createRoboticArmSimulationSample, loadRapier, type Rapier } from '@forge/physics';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  compareConditions,
  configDiff,
  oatSensitivity,
  regressionSensitivity,
  summarize,
  uncertaintySummary,
} from '../analysis';
import { ResearchEngine } from '../engine';
import { Campaign } from '../scheduler';
import {
  bootstrapCI,
  describe as desc,
  ols,
  pairedT,
  pearson,
  permutationTest,
  quantile,
  spearman,
  tCdf,
  tQuantile,
  welchT,
  wilson,
} from '../stats';
import { MemoryRunDataStore } from '../store';
import { armExperiment, measurement, variable } from './fixtures';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});
const at = new Date('2026-11-22T00:00:00Z');

// Student (1908) sleep data as distributed with R (datasets::sleep).
const g1 = [0.7, -1.6, -0.2, -1.2, -0.1, 3.4, 3.7, 0.8, 0.0, 2.0];
const g2 = [1.9, 0.8, 1.1, 0.1, -0.1, 4.4, 5.5, 1.6, 4.6, 3.4];
// Anscombe's quartet, data set I.
const ax = [10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5];
const ay = [8.04, 6.95, 7.58, 8.81, 8.33, 9.96, 7.24, 4.26, 10.84, 4.82, 5.68];

describe('statistics against published reference results', () => {
  it('t distribution matches R (qt, pt)', () => {
    expect(tQuantile(0.975, 10)).toBeCloseTo(2.228138852, 7);
    expect(tQuantile(0.995, 30)).toBeCloseTo(2.749995654, 7);
    expect(tCdf(2, 5)).toBeCloseTo(0.9490302605, 8);
  });
  it("Welch and paired t-tests match R's t.test on the sleep data", () => {
    const w = welchT(g1, g2);
    expect(w.statistic!).toBeCloseTo(1.8608, 4);
    expect(w.df!).toBeCloseTo(17.776, 3);
    expect(w.pValue!).toBeCloseTo(0.07939, 5);
    expect(w.ci![0]).toBeCloseTo(-0.2054832, 6);
    expect(w.ci![1]).toBeCloseTo(3.3654832, 6);
    const p = pairedT(g1, g2);
    expect(p.statistic!).toBeCloseTo(4.0621, 4);
    expect(p.pValue!).toBeCloseTo(0.002833, 6);
    expect(p.ci![0]).toBeCloseTo(0.7001142, 6);
    expect(p.ci![1]).toBeCloseTo(2.4598858, 6);
  });
  it("OLS matches R's lm on Anscombe I; collinear predictors are refused", () => {
    const f = ols(
      ax.map((x) => [x]),
      ay,
    );
    if ('error' in f) throw new Error(f.error);
    expect(f.coefficients[0]!).toBeCloseTo(3.0001, 4);
    expect(f.coefficients[1]!).toBeCloseTo(0.5001, 4);
    expect(f.r2).toBeCloseTo(0.6665, 4);
    expect(f.standardErrors[1]!).toBeCloseTo(0.1179, 4);
    expect(f.pValues[1]!).toBeCloseTo(0.00217, 5);
    expect(pearson(ax, ay)!.r).toBeCloseTo(0.8164, 4);
    expect(
      'error' in
        ols(
          ax.map((x) => [x, 2 * x]),
          ay,
        ),
    ).toBe(true);
    // Multivariable: y = 1 + 2a − 3b exactly.
    const X = [
      [0, 1],
      [1, 0],
      [2, 3],
      [3, 1],
      [4, 4],
    ];
    const m = ols(
      X,
      X.map(([a, b]) => 1 + 2 * a! - 3 * b!),
    );
    if ('error' in m) throw new Error(m.error);
    m.coefficients.forEach((c, i) => expect(c).toBeCloseTo([1, 2, -3][i]!, 10));
  });
  it('descriptives, quantiles (type 7), missing values, rank correlation, Wilson interval', () => {
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.25)).toBe(3.25);
    const d = desc([1, 2, null, 3, NaN, 4]);
    expect(d).toMatchObject({ n: 4, excluded: 2, mean: 2.5, median: 2.5 });
    expect(d.variance).toBeCloseTo(5 / 3, 12);
    expect(spearman([1, 2, 3, 4], [1, 8, 27, 64])!.rho).toBe(1);
    expect(pearson([1, 2, 3, 4], [1, 8, 27, 64])!.r).toBeLessThan(1);
    const w = wilson(0, 10)!;
    expect(w[0]).toBe(0);
    expect(w[1]).toBeCloseTo(0.2775, 3);
  });
  it('bootstrap and permutation are seeded and reproducible', () => {
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
    const b1 = bootstrapCI(g2, mean, { seed: 9 })!;
    expect(bootstrapCI(g2, mean, { seed: 9 })).toEqual(b1);
    expect(b1.ci[0]).toBeLessThan(2.33);
    expect(b1.ci[1]).toBeGreaterThan(2.33);
    const p = permutationTest(g1, g2, { permutations: 20_000, seed: 2 })!;
    expect(p.pValue).toBeGreaterThan(0.05); // close to Welch's 0.079 for these data
    expect(p.pValue).toBeLessThan(0.12);
  });
});

async function armRuns(patch: Parameters<typeof armExperiment>[1]) {
  const p = createRoboticArmSimulationSample(at);
  const eng = ResearchEngine.empty(p.id, () => at);
  const r = eng.execute({ type: 'experiment.create', payload: { experiment: armExperiment(p, patch) } });
  if (!r.ok) throw new Error(r.error);
  const res = await new Campaign(eng, new MemoryRunDataStore(), p, (patch?.id as string) ?? 'payload', R, {
    env: { now: () => at, yieldNow: async () => undefined },
  }).run();
  return { eng, res, e: eng.experiment((patch?.id as string) ?? 'payload')! };
}

describe('analyses on recorded arm runs', () => {
  it('deterministic replicates are flagged; comparisons report exact differences without tests', async () => {
    const { eng } = await armRuns({
      design: {
        kind: 'oat',
        replicates: 2,
        samples: 1,
        baseSeed: 1,
        pairedSeeds: true,
        randomizeOrder: false,
      },
    });
    const runs = eng.runsOf('payload');
    const s = summarize(runs, 'effortRms');
    expect(s.every((c) => c.identicalReplicates)).toBe(true);
    const c = compareConditions(runs, 'effortRms', s[0]!.conditionId, s[2]!.conditionId)!;
    expect(c.differenceOfMeans).toBeGreaterThan(0);
    expect(c.inference).toBeNull();
    expect(c.notes.join(' ')).toMatch(/deterministic/);
    const d = configDiff(
      runs.find((r) => r.conditionId === s[0]!.conditionId)!,
      runs.find((r) => r.conditionId === s[2]!.conditionId)!,
    );
    expect(d.diffs.map((x) => x.field)).toEqual(['variable mass']);
    expect(d.warning).toBeNull();
  });

  it('one-at-a-time sensitivity: response curve, local derivative and elasticity', async () => {
    const { eng, e } = await armRuns({
      variables: [
        variable({
          id: 'mass',
          name: 'Payload mass',
          unit: 'kg',
          target: 'physics.payload.payload-ee.massKg',
          min: 0,
          max: 1,
          default: 0.2,
          levels: [0, 0.2, 0.4],
        }),
        variable({
          id: 'bw',
          name: 'Bandwidth',
          unit: 'Hz',
          target: 'physics.joint.j-shoulder.bandwidthHz',
          min: 1,
          max: 20,
          default: 4,
          levels: [2, 4, 8],
        }),
        variable({
          id: 'target',
          name: 'Shoulder target',
          role: 'controlled',
          type: 'angle',
          unit: 'deg',
          target: 'physics.joint.j-shoulder.target',
          default: 20,
        }),
      ],
    });
    const s = oatSensitivity(e, eng.runsOf('payload'), 'effortRms');
    expect(s.evaluations).toBe(5);
    const mass = s.parameters.find((x) => x.variableId === 'mass')!;
    expect(mass.curve.map((c) => c.x)).toEqual([0, 0.2, 0.4]);
    expect(mass.derivative!).toBeGreaterThan(0);
    expect(mass.elasticity).not.toBeNull();
    expect(s.limitations.join(' ')).toMatch(/interactions/);
  });

  it('Monte Carlo: output distribution, exceedance frequency with interval, convergence indicators', async () => {
    const { eng, e } = await armRuns({
      id: 'mc',
      variables: [
        variable({
          id: 'mass',
          name: 'Payload mass',
          role: 'nuisance',
          unit: 'kg',
          target: 'physics.payload.payload-ee.massKg',
          min: 0,
          max: 1,
          default: 0.2,
          distribution: { kind: 'bounded-normal', mean: 0.2, sd: 0.1, min: 0, max: 1 },
        }),
        variable({
          id: 'target',
          name: 'Shoulder target',
          role: 'controlled',
          type: 'angle',
          unit: 'deg',
          target: 'physics.joint.j-shoulder.target',
          default: 20,
        }),
      ],
      measurements: [
        measurement({
          id: 'effortRms',
          source: { kind: 'signal', signal: 'j-shoulder.effort' },
          reduction: 'rms',
        }),
      ],
      design: {
        kind: 'monte-carlo',
        replicates: 1,
        samples: 16,
        baseSeed: 5,
        pairedSeeds: false,
        randomizeOrder: false,
      },
    });
    const runs = eng.runsOf('mc');
    expect(runs).toHaveLength(16);
    const u = uncertaintySummary(runs, 'effortRms', { op: '>', value: 0.3 });
    expect(u.samples).toBe(16);
    expect(u.quantiles.p05).toBeLessThanOrEqual(u.quantiles.p95);
    expect(u.convergence.map((c) => c.n)).toEqual([4, 8, 12, 16]);
    expect(u.exceedance!.wilson95).not.toBeNull();
    expect(u.statement).toMatch(/NOT an empirically validated/);
    // Inputs actually reached the model: effort varies with the sampled masses.
    expect(u.stats.sd).toBeGreaterThan(0);
    const reg = regressionSensitivity(e, runs, 'effortRms');
    expect('error' in reg).toBe(false);
    if (!('error' in reg)) expect(reg.coefficients[0]!.src).toBeGreaterThan(0.5);
  });
});
