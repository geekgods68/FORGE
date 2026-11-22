import type { Experiment, ParamValue, RunRecord } from './schemas';
import {
  describe,
  effectSize,
  finiteOnly,
  histogram,
  ols,
  pairedT,
  permutationTest,
  quantile,
  welchT,
  wilson,
  type Inference,
} from './stats';

/**
 * Analyses over RECORDED run outcomes (no simulation). Only COMPLETED runs contribute; failed,
 * cancelled and invalid runs are counted and listed, never imputed.
 */
const completed = (runs: RunRecord[]) => runs.filter((r) => r.state === 'COMPLETED');
const valueOf = (r: RunRecord, m: string) => r.outcomes[m]?.value ?? null;

export interface ConditionSummary {
  conditionId: string;
  label: string;
  values: Record<string, ParamValue>;
  runs: number;
  excluded: number;
  stats: ReturnType<typeof describe>;
  unit: string;
  identicalReplicates: boolean;
}

export function summarize(runs: RunRecord[], measurementId: string): ConditionSummary[] {
  const by = new Map<string, RunRecord[]>();
  for (const r of runs) by.set(r.conditionId, [...(by.get(r.conditionId) ?? []), r]);
  return [...by.entries()].map(([id, rs]) => {
    const ok = completed(rs);
    const vals = ok.map((r) => valueOf(r, measurementId));
    const st = describe(vals);
    return {
      conditionId: id,
      label: rs[0]!.conditionLabel,
      values: rs[0]!.config.variables,
      runs: ok.length,
      excluded: rs.length - ok.length + st.excluded,
      stats: st,
      unit: ok.find((r) => r.outcomes[measurementId])?.outcomes[measurementId]!.unit ?? '',
      identicalReplicates: st.n > 1 && st.sd === 0,
    };
  });
}

/** Configuration differences between two runs (what actually changed). */
export function configDiff(a: RunRecord, b: RunRecord) {
  const diffs: { field: string; a: string; b: string }[] = [];
  const str = (v: unknown) => (typeof v === 'number' ? String(Number(v.toPrecision(8))) : JSON.stringify(v));
  const keys = new Set([...Object.keys(a.config.variables), ...Object.keys(b.config.variables)]);
  for (const k of keys)
    if (str(a.config.variables[k]) !== str(b.config.variables[k]))
      diffs.push({ field: `variable ${k}`, a: str(a.config.variables[k]), b: str(b.config.variables[k]) });
  const ap = new Map(a.config.applied.map((x) => [x.target, x.value]));
  const bp = new Map(b.config.applied.map((x) => [x.target, x.value]));
  const varDiffs = diffs.length;
  for (const k of new Set([...ap.keys(), ...bp.keys()]))
    if (str(ap.get(k)) !== str(bp.get(k)) && varDiffs === 0)
      diffs.push({ field: `parameter ${k}`, a: str(ap.get(k)), b: str(bp.get(k)) });
  for (const f of ['durationS', 'warmupS', 'sampleRateHz', 'seed'] as const)
    if (a.config[f] !== b.config[f]) diffs.push({ field: f, a: str(a.config[f]), b: str(b.config[f]) });
  if (str(a.config.solver) !== str(b.config.solver))
    diffs.push({ field: 'solver settings', a: str(a.config.solver), b: str(b.config.solver) });
  if (a.model.fingerprint !== b.model.fingerprint)
    diffs.push({
      field: 'base model fingerprint',
      a: a.model.fingerprint.slice(0, 12),
      b: b.model.fingerprint.slice(0, 12),
    });
  if (str(a.model.firmware) !== str(b.model.firmware))
    diffs.push({
      field: 'firmware',
      a: str(a.model.firmware.map((f) => `${f.id}@${f.revision}`)),
      b: str(b.model.firmware.map((f) => `${f.id}@${f.revision}`)),
    });
  if (str(a.versions) !== str(b.versions))
    diffs.push({ field: 'software versions', a: str(a.versions), b: str(b.versions) });
  if (a.experimentRevision !== b.experimentRevision)
    diffs.push({
      field: 'experiment revision',
      a: String(a.experimentRevision),
      b: String(b.experimentRevision),
    });
  const causal = diffs.filter((d) => d.field !== 'seed');
  const warning =
    causal.length > 1
      ? `${causal.length} things differ between these runs; a difference in outcome cannot be attributed to any single one of them.`
      : null;
  return { diffs, warning };
}

export interface Comparison {
  measurementId: string;
  unit: string;
  reference: ConditionSummary;
  comparison: ConditionSummary;
  differenceOfMeans: number;
  differenceOfMedians: number;
  relativeChange: number | null;
  inference: Inference | null;
  effect: ReturnType<typeof effectSize>;
  permutation: ReturnType<typeof permutationTest>;
  notes: string[];
}

/** Controlled comparison of two conditions. Paired when both have the same seeds per replicate. */
export function compareConditions(
  runs: RunRecord[],
  measurementId: string,
  refId: string,
  cmpId: string,
  opts: { test?: 'auto' | 'none' } = {},
): Comparison | null {
  const sums = summarize(runs, measurementId);
  const ref = sums.find((s) => s.conditionId === refId);
  const cmp = sums.find((s) => s.conditionId === cmpId);
  if (!ref || !cmp) return null;
  const a = completed(runs.filter((r) => r.conditionId === refId)).sort((x, y) => x.replicate - y.replicate);
  const b = completed(runs.filter((r) => r.conditionId === cmpId)).sort((x, y) => x.replicate - y.replicate);
  const av = a.map((r) => valueOf(r, measurementId) ?? NaN);
  const bv = b.map((r) => valueOf(r, measurementId) ?? NaN);
  const notes = [
    'Statistical significance is not engineering significance: judge the size of the difference against the application.',
    'Each run is one observation; samples within a run are not independent replications.',
  ];
  const paired =
    a.length === b.length && a.length > 0 && a.every((r, i) => r.config.seed === b[i]!.config.seed);
  let inference: Inference | null = null;
  if (opts.test !== 'none') {
    if (ref.identicalReplicates && cmp.identicalReplicates)
      notes.push(
        'Both conditions are deterministic (identical replicates): the difference is exact for this model and no test applies; replication does not measure real-world uncertainty.',
      );
    else if (a.length >= 2 && b.length >= 2) inference = paired ? pairedT(av, bv) : welchT(av, bv);
    else notes.push('Fewer than two completed runs per condition: no interval or test.');
  }
  if (a.length < 5 || b.length < 5)
    notes.push('Small samples: intervals and p-values are imprecise; do not overclaim.');
  return {
    measurementId,
    unit: ref.unit,
    reference: ref,
    comparison: cmp,
    differenceOfMeans: cmp.stats.mean - ref.stats.mean,
    differenceOfMedians: cmp.stats.median - ref.stats.median,
    relativeChange:
      ref.stats.mean !== 0 && Number.isFinite(ref.stats.mean)
        ? (cmp.stats.mean - ref.stats.mean) / Math.abs(ref.stats.mean)
        : null,
    inference,
    effect: effectSize(av, bv),
    permutation:
      a.length >= 2 && b.length >= 2 && !(ref.identicalReplicates && cmp.identicalReplicates)
        ? permutationTest(av, bv, { permutations: 4999, seed: 1 })
        : null,
    notes,
  };
}

export function rankConditions(runs: RunRecord[], measurementId: string, better: 'lower' | 'higher') {
  return summarize(runs, measurementId)
    .filter((s) => s.runs > 0 && Number.isFinite(s.stats.mean))
    .sort((x, y) => (better === 'lower' ? x.stats.mean - y.stats.mean : y.stats.mean - x.stats.mean));
}

// -- sensitivity -----------------------------------------------------------------------------
export interface SensitivityResult {
  method: string;
  measurementId: string;
  baseline: { values: Record<string, ParamValue>; value: number | null };
  evaluations: number;
  parameters: {
    variableId: string;
    name: string;
    unit: string;
    range: [number, number];
    curve: { x: number; y: number | null }[];
    /** Local derivative at the baseline (finite difference between neighbouring levels). */
    derivative: number | null;
    /** (x₀ / y₀) · ∂y/∂x — dimensionless elasticity. */
    elasticity: number | null;
    /** Output change across the variable's range, divided by the output range across all parameters. */
    normalizedSwing: number | null;
  }[];
  limitations: string[];
}

/** One-at-a-time sensitivity from an OAT (or grid) experiment's recorded runs. */
export function oatSensitivity(e: Experiment, runs: RunRecord[], measurementId: string): SensitivityResult {
  const ok = completed(runs);
  const indep = e.variables.filter((v) => v.role === 'independent' && typeof v.default === 'number');
  const mean = (rs: RunRecord[]) => {
    const v = finiteOnly(rs.map((r) => valueOf(r, measurementId)));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const isBaseline = (r: RunRecord) => indep.every((v) => r.config.variables[v.id] === v.default);
  const base = mean(ok.filter(isBaseline));
  const params = indep.map((v) => {
    const others = indep.filter((o) => o.id !== v.id);
    const xs = new Map<number, RunRecord[]>();
    for (const r of ok) {
      if (!others.every((o) => r.config.variables[o.id] === o.default)) continue;
      const x = r.config.variables[v.id] as number;
      xs.set(x, [...(xs.get(x) ?? []), r]);
    }
    const curve = [...xs.entries()].sort((a, b) => a[0] - b[0]).map(([x, rs]) => ({ x, y: mean(rs) }));
    const x0 = v.default as number;
    const i = curve.findIndex((c) => c.x === x0);
    let derivative: number | null = null;
    const lo = curve[i - 1] ?? curve[i];
    const hi = curve[i + 1] ?? curve[i];
    if (i >= 0 && lo && hi && hi.x !== lo.x && lo.y !== null && hi.y !== null)
      derivative = (hi.y - lo.y) / (hi.x - lo.x);
    const ys = finiteOnly(curve.map((c) => c.y));
    return {
      variableId: v.id,
      name: v.name,
      unit: v.unit,
      range: [Math.min(...curve.map((c) => c.x)), Math.max(...curve.map((c) => c.x))] as [number, number],
      curve,
      derivative,
      elasticity: derivative !== null && base !== null && base !== 0 ? (x0 / base) * derivative : null,
      normalizedSwing: ys.length > 1 ? Math.max(...ys) - Math.min(...ys) : null,
    };
  });
  const totalSwing = params.reduce((s, p) => s + (p.normalizedSwing ?? 0), 0);
  for (const p of params)
    p.normalizedSwing = p.normalizedSwing !== null && totalSwing > 0 ? p.normalizedSwing / totalSwing : null;
  return {
    method: 'one-at-a-time (local finite differences around the baseline; swing across each range)',
    measurementId,
    baseline: { values: Object.fromEntries(indep.map((v) => [v.id, v.default])), value: base },
    evaluations: ok.length,
    parameters: params,
    limitations: [
      'One-at-a-time variation does not reveal interactions between parameters.',
      'Local derivatives describe the model near the baseline only.',
      'Sensitivity describes this model; it is not evidence about the physical system.',
    ],
  };
}

/** Two-variable response surface (grid) with the 2×2 corner interaction contrast. */
export function interactionGrid(runs: RunRecord[], measurementId: string, va: string, vb: string) {
  const ok = completed(runs);
  const xs = [...new Set(ok.map((r) => r.config.variables[va] as number))].sort((a, b) => a - b);
  const ys = [...new Set(ok.map((r) => r.config.variables[vb] as number))].sort((a, b) => a - b);
  const cell = (x: number, y: number) => {
    const v = finiteOnly(
      ok
        .filter((r) => r.config.variables[va] === x && r.config.variables[vb] === y)
        .map((r) => valueOf(r, measurementId)),
    );
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const z = ys.map((y) => xs.map((x) => cell(x, y)));
  const c = (i: number, j: number) => z[j]?.[i] ?? null;
  const ll = c(0, 0);
  const hl = c(xs.length - 1, 0);
  const lh = c(0, ys.length - 1);
  const hh = c(xs.length - 1, ys.length - 1);
  const interaction = [ll, hl, lh, hh].every((v) => v !== null) ? hh! - hl! - lh! + ll! : null;
  return {
    x: xs,
    y: ys,
    z,
    interaction,
    note: 'Interaction contrast f(hi,hi) − f(hi,lo) − f(lo,hi) + f(lo,lo) at the grid corners; 0 means additive effects there.',
  };
}

/** Standardised regression coefficients from random / LHS samples. */
export function regressionSensitivity(e: Experiment, runs: RunRecord[], measurementId: string) {
  const ok = completed(runs);
  const vars = e.variables.filter(
    (v) =>
      (v.role === 'independent' || v.distribution) &&
      ok.every((r) => typeof r.config.variables[v.id] === 'number'),
  );
  const X = ok.map((r) => vars.map((v) => r.config.variables[v.id] as number));
  const y = ok.map((r) => valueOf(r, measurementId) ?? NaN);
  const sd = (a: number[]) => describe(a).sd;
  const fit = ols(X, y);
  if ('error' in fit) return { error: fit.error };
  const sy = sd(y);
  return {
    method: 'standardised regression coefficients (OLS on the sampled runs)',
    r2: fit.r2,
    evaluations: ok.length,
    coefficients: vars.map((v, i) => ({
      variableId: v.id,
      name: v.name,
      src: (fit.coefficients[i + 1]! * sd(X.map((r) => r[i]!))) / sy,
      pValue: fit.pValues[i + 1]!,
    })),
    residuals: fit.residuals,
    note:
      fit.r2 < 0.7
        ? `R² = ${fit.r2.toFixed(2)}: the response is not well described by a linear model; coefficients are only indicative.`
        : 'Linear approximation over the sampled ranges.',
  };
}

// -- uncertainty ----------------------------------------------------------------------------
export function uncertaintySummary(
  runs: RunRecord[],
  measurementId: string,
  failure?: { op: '>' | '<'; value: number },
) {
  const all = runs.length;
  const ok = completed(runs);
  const xs = finiteOnly(ok.map((r) => valueOf(r, measurementId)));
  const s = [...xs].sort((a, b) => a - b);
  const d = describe(xs);
  const checkpoints = [0.25, 0.5, 0.75, 1].map((f) => Math.max(1, Math.round(f * xs.length)));
  const convergence = checkpoints.map((k) => {
    const sub = xs.slice(0, k);
    const dd = describe(sub);
    return {
      n: k,
      mean: dd.mean,
      standardError: k > 1 ? dd.sd / Math.sqrt(k) : null,
      p95: quantile(
        [...sub].sort((a, b) => a - b),
        0.95,
      ),
    };
  });
  const k = failure
    ? xs.filter((x) => (failure.op === '>' ? x > failure.value : x < failure.value)).length
    : 0;
  const half = convergence[1]!;
  const fin = convergence[3]!;
  return {
    samples: xs.length,
    failedRuns: all - ok.length,
    stats: d,
    quantiles: { p05: quantile(s, 0.05), p50: quantile(s, 0.5), p95: quantile(s, 0.95) },
    histogram: histogram(xs),
    convergence,
    meanChangeHalfToFull:
      Number.isFinite(half.mean) && fin.mean !== 0
        ? Math.abs(fin.mean - half.mean) / Math.abs(fin.mean)
        : null,
    exceedance: failure
      ? {
          criterion: `${measurementId} ${failure.op} ${failure.value}`,
          count: k,
          frequency: xs.length ? k / xs.length : null,
          wilson95: wilson(k, xs.length),
        }
      : null,
    statement:
      'Distribution of the model output under the stated input distributions. A simulated exceedance frequency is NOT an empirically validated real-world failure probability: it depends on the model and its assumed inputs.',
  };
}
