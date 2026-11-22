import { deriveSeed, mulberry32, normal, RNG_ID } from './random';
import type { Distribution, Experiment, ParamValue, Variable } from './schemas';

/**
 * Experimental designs → concrete conditions and runs. Sizes are computed BEFORE anything is
 * enumerated, so an exhaustive grid over many variables is refused (with the count) instead of
 * silently scheduling millions of runs.
 */
export interface Condition {
  id: string;
  label: string;
  /** Values (in each variable's unit) for every variable that is set in this condition. */
  values: Record<string, ParamValue>;
}
export interface PlannedRun {
  conditionId: string;
  replicate: number;
  seed: number;
}
export interface Budget {
  maxRuns: number;
  maxStepsPerRun: number;
  maxSamplesPerRun: number;
  maxWallMsPerRun: number;
  maxStorageBytes: number;
  /** Only sequential execution is supported on the development machine. */
  maxConcurrent: 1;
  /** Stop large campaigns when free disk falls below this (bytes); checked where measurable. */
  minFreeDiskBytes: number;
}
export const DEFAULT_BUDGET: Budget = {
  maxRuns: 200,
  maxStepsPerRun: 200_000,
  maxSamplesPerRun: 50_000,
  maxWallMsPerRun: 120_000,
  maxStorageBytes: 64 * 1024 * 1024,
  maxConcurrent: 1,
  minFreeDiskBytes: 8 * 1024 ** 3,
};
export interface Plan {
  conditions: Condition[];
  runs: PlannedRun[];
  rng: string;
  method: string;
  estimate: {
    runs: number;
    conditions: number;
    replicates: number;
    stepsPerRun: number;
    totalSteps: number;
    samplesPerRun: number;
    bytesPerRun: number;
    totalBytes: number;
  };
  warnings: string[];
  errors: string[];
}

const indep = (e: Experiment) => e.variables.filter((v) => v.role === 'independent');
const fixedValues = (e: Experiment, except: Set<string>) =>
  Object.fromEntries(
    e.variables.filter((v) => !except.has(v.id) && v.role !== 'dependent').map((v) => [v.id, v.default]),
  );
const fmt = (v: ParamValue) => (typeof v === 'number' ? Number(v.toPrecision(6)).toString() : String(v));
const levelsOf = (v: Variable): ParamValue[] => (v.levels.length ? v.levels : [v.default]);

export function sampleDistribution(d: Distribution, rand: () => number): number {
  switch (d.kind) {
    case 'fixed':
      return d.value;
    case 'uniform':
      return d.min + (d.max - d.min) * rand();
    case 'normal':
      return d.mean + d.sd * normal(rand);
    case 'bounded-normal':
      for (let i = 0; i < 1000; i++) {
        const x = d.mean + d.sd * normal(rand);
        if (x >= d.min && x <= d.max) return x;
      }
      return Math.min(d.max, Math.max(d.min, d.mean));
    case 'empirical':
      return d.values[Math.floor(rand() * d.values.length)]!;
  }
}

export function generatePlan(e: Experiment, ctx: { stepS: number | null; budget?: Budget }): Plan {
  const budget = ctx.budget ?? DEFAULT_BUDGET;
  const d = e.design;
  const warnings: string[] = [];
  const errors: string[] = [];
  const iv = indep(e);
  const rand = mulberry32(deriveSeed(d.baseSeed, 'design'));
  const conditions: Condition[] = [];
  const reps = d.kind === 'single' ? 1 : d.replicates;
  const add = (values: Record<string, ParamValue>, label: string) =>
    conditions.push({
      id: `c${conditions.length}`,
      label,
      values: { ...fixedValues(e, new Set(Object.keys(values))), ...values },
    });
  // Size first (no enumeration).
  let count = 1;
  if (d.kind === 'grid' || d.kind === 'paired') count = iv.reduce((n, v) => n * levelsOf(v).length, 1);
  else if (d.kind === 'oat')
    count = 1 + iv.reduce((n, v) => n + levelsOf(v).filter((l) => l !== v.default).length, 0);
  else if (d.kind === 'random' || d.kind === 'lhs' || d.kind === 'monte-carlo') count = d.samples;
  const total = count * reps;
  if ((d.kind === 'grid' || d.kind === 'paired' || d.kind === 'oat') && iv.length === 0)
    errors.push('This design needs at least one independent variable.');
  if (d.kind === 'monte-carlo' && !e.variables.some((v) => v.distribution && v.distribution.kind !== 'fixed'))
    errors.push('Monte Carlo needs at least one variable with an uncertainty distribution.');
  if (total > budget.maxRuns)
    errors.push(
      `The plan has ${total.toLocaleString()} runs (${count.toLocaleString()} conditions × ${reps} replicates), above the budget of ${budget.maxRuns}. Reduce levels/samples/replicates, use sampling (random or Latin hypercube), or raise the budget explicitly.`,
    );
  if (!errors.length) {
    switch (d.kind) {
      case 'single':
      case 'replicates':
        add({}, 'baseline');
        break;
      case 'oat':
        add({}, 'baseline');
        for (const v of iv)
          for (const l of levelsOf(v)) if (l !== v.default) add({ [v.id]: l }, `${v.name} = ${fmt(l)}`);
        break;
      case 'grid':
      case 'paired': {
        let combos: Record<string, ParamValue>[] = [{}];
        for (const v of iv) combos = combos.flatMap((c) => levelsOf(v).map((l) => ({ ...c, [v.id]: l })));
        for (const c of combos) add(c, iv.map((v) => `${v.name} = ${fmt(c[v.id]!)}`).join(', '));
        break;
      }
      case 'random':
        for (let k = 0; k < d.samples; k++) {
          const values: Record<string, ParamValue> = {};
          for (const v of iv) {
            if (
              typeof v.default === 'number' &&
              v.min !== null &&
              v.max !== null &&
              (v.type === 'continuous' ||
                v.type === 'angle' ||
                v.type === 'integer' ||
                v.type === 'controller')
            ) {
              const x = v.min + (v.max - v.min) * rand();
              values[v.id] = v.type === 'integer' ? Math.round(x) : x;
            } else values[v.id] = levelsOf(v)[Math.floor(rand() * levelsOf(v).length)]!;
          }
          add(values, `sample ${k + 1}`);
        }
        break;
      case 'lhs': {
        const cont = iv.filter((v) => typeof v.default === 'number' && v.min !== null && v.max !== null);
        if (cont.length < iv.length)
          warnings.push(
            'Latin hypercube applies to bounded numeric variables; the others stay at their defaults.',
          );
        const perms = cont.map(() => {
          const p = Array.from({ length: d.samples }, (_, i) => i);
          for (let i = p.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [p[i], p[j]] = [p[j]!, p[i]!];
          }
          return p;
        });
        for (let k = 0; k < d.samples; k++) {
          const values: Record<string, ParamValue> = {};
          cont.forEach((v, j) => {
            const x = v.min! + ((perms[j]![k]! + rand()) / d.samples) * (v.max! - v.min!);
            values[v.id] = v.type === 'integer' ? Math.round(x) : x;
          });
          add(values, `LHS ${k + 1}`);
        }
        break;
      }
      case 'monte-carlo':
        for (let k = 0; k < d.samples; k++) {
          const values: Record<string, ParamValue> = {};
          for (const v of e.variables)
            if (v.distribution) values[v.id] = sampleDistribution(v.distribution, rand);
          add(values, `MC ${k + 1}`);
        }
        break;
    }
  }
  const paired = d.kind === 'paired' || d.pairedSeeds;
  let runs: PlannedRun[] = conditions.flatMap((c) =>
    Array.from({ length: reps }, (_, r) => ({
      conditionId: c.id,
      replicate: r,
      seed: paired ? deriveSeed(d.baseSeed, 'replicate', r) : deriveSeed(d.baseSeed, c.id, r),
    })),
  );
  if (d.randomizeOrder) {
    const r2 = mulberry32(deriveSeed(d.baseSeed, 'order'));
    runs = runs
      .map((x) => ({ x, k: r2() }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.x);
  }
  const stepsPerRun = ctx.stepS ? Math.ceil(e.protocol.durationS / ctx.stepS) : 0;
  const samplesPerRun = Math.ceil(e.protocol.durationS * e.protocol.sampleRateHz) + 1;
  const signals = e.measurements.length + e.protocol.recordSignals.length;
  const bytesPerRun = samplesPerRun * Math.max(1, signals) * 16 + 4096;
  if (stepsPerRun > budget.maxStepsPerRun)
    errors.push(
      `Each run needs ${stepsPerRun.toLocaleString()} steps, above the budget of ${budget.maxStepsPerRun.toLocaleString()}.`,
    );
  if (samplesPerRun > budget.maxSamplesPerRun)
    errors.push(
      `Each run records ${samplesPerRun.toLocaleString()} samples per signal, above the budget of ${budget.maxSamplesPerRun.toLocaleString()}. Lower the sample rate.`,
    );
  if (bytesPerRun * runs.length > budget.maxStorageBytes)
    errors.push(
      `Estimated raw data ${((bytesPerRun * runs.length) / 1e6).toFixed(1)} MB exceeds the storage budget of ${(budget.maxStorageBytes / 1e6).toFixed(0)} MB.`,
    );
  const deterministicModel =
    e.protocol.model.kind !== 'cosim' || !e.variables.some((v) => /noiseStdM/.test(v.target));
  if (reps > 1 && deterministicModel && d.kind !== 'monte-carlo')
    warnings.push(
      'Replicates of a deterministic model produce identical results; replication alone does not estimate real-world uncertainty (use input distributions or stochastic sensor noise).',
    );
  return {
    conditions,
    runs,
    rng: RNG_ID,
    method: d.kind,
    estimate: {
      runs: runs.length,
      conditions: conditions.length,
      replicates: reps,
      stepsPerRun,
      totalSteps: stepsPerRun * runs.length,
      samplesPerRun,
      bytesPerRun,
      totalBytes: bytesPerRun * runs.length,
    },
    warnings,
    errors,
  };
}
