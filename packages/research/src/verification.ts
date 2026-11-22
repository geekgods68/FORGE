import type { Project } from '@forge/engineering-core';
import type { Rapier } from '@forge/physics';
import { integrityOf } from './engine';
import { hashOfSeries } from './hash';
import { interpolate, type Signal } from './measure';
import { executeRun } from './runner';
import type { CalibrationRecord, Dataset, Experiment, RunRecord, ValidationRecord } from './schemas';
import { invert } from './stats';
import { loadVerified, type RunDataStore } from './store';
import { conversion } from './units';

/**
 * Numerical VERIFICATION (does the code solve its equations?), CALIBRATION (fitting parameters
 * to reference observations) and empirical VALIDATION (agreement with independent real
 * measurements) — kept strictly apart (docs/VALIDATION_FRAMEWORK.md).
 */

// -- numerical verification -----------------------------------------------------------------
export interface ConvergenceResult {
  signal: string;
  levels: { runId: string; parameter: number; wallMs: number; drift: number | null }[];
  differences: { between: [number, number]; rms: number; max: number }[];
  observedOrders: (number | null)[];
  verdict: 'converging' | 'not-converging' | 'stalled' | 'insufficient-levels';
  threshold: number;
  explanation: string;
}

/**
 * Successive-refinement study: runs ordered from coarse to fine by a numerical parameter; each
 * trajectory is interpolated onto the coarsest run's timestamps (common span), and the RMS of
 * consecutive differences is compared. Needs at least three levels: two similar values do not
 * demonstrate convergence.
 */
export async function convergenceStudy(
  runs: RunRecord[],
  store: RunDataStore,
  signal: string,
  variableId: string,
  threshold: number,
  driftMeasurement?: string,
): Promise<ConvergenceResult | { error: string }> {
  const ok = runs
    .filter((r) => r.state === 'COMPLETED' && typeof r.config.variables[variableId] === 'number')
    .sort((a, b) => (b.config.variables[variableId] as number) - (a.config.variables[variableId] as number));
  const series: Signal[] = [];
  for (const r of ok) {
    if (!r.data) return { error: `Run ${r.id} has no recorded data.` };
    const d = await loadVerified(store, r.data);
    if (!d.ok) return { error: `Raw data of run ${r.id} is ${d.reason}.` };
    const s = d.data.signals.find((x) => x.key === signal);
    if (!s) return { error: `Run ${r.id} did not record ${signal}.` };
    series.push(s);
  }
  const levels = ok.map((r) => ({
    runId: r.id,
    parameter: r.config.variables[variableId] as number,
    wallMs: r.wallMs,
    drift: driftMeasurement ? (r.outcomes[driftMeasurement]?.value ?? null) : null,
  }));
  if (series.length < 3)
    return {
      signal,
      levels,
      differences: [],
      observedOrders: [],
      verdict: 'insufficient-levels',
      threshold,
      explanation:
        'At least three refinement levels are needed: two similar results do not show convergence.',
    };
  const base = series[0]!;
  const tEnd = Math.min(...series.map((s) => s.t[s.t.length - 1]!));
  const grid = Array.from(base.t).filter((t) => t <= tEnd);
  const at = (s: Signal) => grid.map((t) => interpolate(s, t));
  const differences: ConvergenceResult['differences'] = [];
  for (let k = 0; k + 1 < series.length; k++) {
    const a = at(series[k]!);
    const b = at(series[k + 1]!);
    const d = a.map((x, i) => x - b[i]!).filter(Number.isFinite);
    differences.push({
      between: [levels[k]!.parameter, levels[k + 1]!.parameter] as [number, number],
      rms: Math.sqrt(d.reduce((s, x) => s + x * x, 0) / Math.max(1, d.length)),
      max: Math.max(0, ...d.map(Math.abs)),
    });
  }
  const observedOrders = differences.slice(1).map((d, i) => {
    const prev = differences[i]!;
    const ratio = prev.between[0] / prev.between[1];
    return d.rms > 0 && prev.rms > 0 ? Math.log(prev.rms / d.rms) / Math.log(ratio) : null;
  });
  const decreasing = differences.every((d, i) => i === 0 || d.rms <= differences[i - 1]!.rms * 1.05);
  const last = differences[differences.length - 1]!.rms;
  const verdict = decreasing && last <= threshold ? 'converging' : decreasing ? 'not-converging' : 'stalled';
  return {
    signal,
    levels,
    differences,
    observedOrders,
    verdict,
    threshold,
    explanation:
      verdict === 'converging'
        ? `Differences decrease under refinement and the finest difference (${last.toExponential(2)}) is below the threshold ${threshold}. This is evidence of numerical convergence for this case only.`
        : verdict === 'stalled'
          ? 'Differences do not decrease monotonically: refinement has reached solver tolerance or a non-smooth event (e.g. saturation, contact); results are not converged in the usual sense.'
          : `Differences decrease but the finest difference (${last.toExponential(2)}) is above the threshold ${threshold}: refine further before relying on the result.`,
  };
}

/** Compare outcomes with an analytical reference function of each run's configuration. */
export function referenceComparison(
  runs: RunRecord[],
  measurementId: string,
  reference: (r: RunRecord) => number,
  label: string,
) {
  const rows = runs
    .filter((r) => r.state === 'COMPLETED')
    .map((r) => {
      const x = r.outcomes[measurementId]?.value ?? null;
      const ref = reference(r);
      return {
        runId: r.id,
        condition: r.conditionLabel,
        measured: x,
        reference: ref,
        absError: x === null ? null : Math.abs(x - ref),
        relError: x === null || ref === 0 ? null : Math.abs(x - ref) / Math.abs(ref),
      };
    });
  const rel = rows.map((r) => r.relError).filter((x): x is number => x !== null);
  return {
    reference: label,
    rows,
    maxRelError: rel.length ? Math.max(...rel) : null,
    note: 'Numerical verification against an analytical solution — not empirical validation.',
  };
}

/** Exact replay check: replicates of a deterministic configuration must agree bit for bit here. */
export function replayConsistency(runs: RunRecord[], measurementId: string) {
  const groups = new Map<string, number[]>();
  for (const r of runs)
    if (r.state === 'COMPLETED')
      groups.set(`${r.configHash}`, [
        ...(groups.get(r.configHash) ?? []),
        r.outcomes[measurementId]?.value ?? NaN,
      ]);
  let maxSpread = 0;
  for (const v of groups.values())
    if (v.length > 1) maxSpread = Math.max(maxSpread, Math.max(...v) - Math.min(...v));
  return {
    groups: groups.size,
    maxSpread,
    note: 'Identical results under identical configurations demonstrate deterministic replay in THIS environment (same build, engine and platform); cross-platform bitwise reproducibility is not claimed.',
  };
}

// -- empirical datasets ---------------------------------------------------------------------
export const MAX_DATASET_BYTES = 5 * 1024 * 1024;
export interface ParsedDataset {
  ok: boolean;
  errors: string[];
  warnings: string[];
  timeColumn: string | null;
  columns: { name: string; unit: string; uncertainty: number | null }[];
  rows: number;
  values: Float64Array[];
}

/** CSV: header `name [unit]` (or `name (unit)`), comma-separated numbers; empty/NA/NaN = missing. */
export function parseDatasetCsv(
  text: string,
  opts: { uncertainty?: Record<string, number> } = {},
): ParsedDataset {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (text.length > MAX_DATASET_BYTES)
    return {
      ok: false,
      errors: [`File too large (> ${MAX_DATASET_BYTES / 1e6} MB).`],
      warnings,
      timeColumn: null,
      columns: [],
      rows: 0,
      values: [],
    };
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (lines.length < 2)
    return {
      ok: false,
      errors: ['Need a header row and at least one data row.'],
      warnings,
      timeColumn: null,
      columns: [],
      rows: 0,
      values: [],
    };
  if (lines.length > 200_001) errors.push('Too many rows (200,000 max).');
  const header = lines[0]!.split(',').map((h) => h.trim());
  const columns = header.map((h) => {
    const m = /^(.*?)\s*[[(]([^\])]*)[\])]\s*$/.exec(h);
    const name = (m ? m[1]! : h).trim();
    const unit = (m ? m[2]! : '').trim();
    if (unit && conversion(unit, unit) === null && unit !== '°C')
      errors.push(`Column "${name}": unknown unit "${unit}".`);
    return { name, unit, uncertainty: opts.uncertainty?.[name] ?? null };
  });
  const values = columns.map(() => new Float64Array(lines.length - 1));
  let missing = 0;
  lines.slice(1).forEach((line, i) => {
    const cells = line.split(',');
    if (cells.length !== columns.length)
      errors.push(`Row ${i + 2}: ${cells.length} cells, expected ${columns.length}.`);
    columns.forEach((_, j) => {
      const c = (cells[j] ?? '').trim();
      if (c === '' || /^(na|nan|null)$/i.test(c)) {
        values[j]![i] = NaN;
        missing++;
      } else {
        const x = Number(c);
        if (!Number.isFinite(x))
          errors.push(`Row ${i + 2}, column "${columns[j]!.name}": "${c.slice(0, 20)}" is not a number.`);
        values[j]![i] = x;
      }
    });
  });
  const ti = columns.findIndex((c) => /^(t|time)$/i.test(c.name));
  if (ti < 0) errors.push('No time column (name it "t" or "time" with a unit, e.g. "t [s]").');
  else {
    if (!columns[ti]!.unit) errors.push('The time column needs a unit (e.g. "t [s]").');
    const t = values[ti]!;
    for (let i = 1; i < t.length; i++)
      if (!(t[i]! > t[i - 1]!)) {
        errors.push(`Timestamps must be strictly increasing (row ${i + 2}).`);
        break;
      }
    if (t.some((x) => !Number.isFinite(x))) errors.push('Timestamps cannot be missing.');
  }
  if (missing) warnings.push(`${missing} missing value(s) kept as missing (not zero).`);
  return {
    ok: errors.length === 0,
    errors: errors.slice(0, 20),
    warnings,
    timeColumn: ti >= 0 ? columns[ti]!.name : null,
    columns,
    rows: lines.length - 1,
    values,
  };
}

/** JSON: { columns: [{name, unit, uncertainty?}], rows: number[][] } (null = missing). */
export function parseDatasetJson(text: string): ParsedDataset {
  if (text.length > MAX_DATASET_BYTES)
    return {
      ok: false,
      errors: ['File too large.'],
      warnings: [],
      timeColumn: null,
      columns: [],
      rows: 0,
      values: [],
    };
  try {
    const d = JSON.parse(text) as {
      columns?: { name: string; unit: string; uncertainty?: number }[];
      rows?: (number | null)[][];
    };
    if (!Array.isArray(d.columns) || !Array.isArray(d.rows))
      throw new Error('needs "columns" and "rows" arrays');
    const csv = [
      d.columns.map((c) => `${c.name} [${c.unit}]`).join(','),
      ...d.rows.map((r) => r.map((x) => (x === null ? '' : String(x))).join(',')),
    ].join('\n');
    const unc = Object.fromEntries(
      d.columns.filter((c) => typeof c.uncertainty === 'number').map((c) => [c.name, c.uncertainty!]),
    );
    return parseDatasetCsv(csv, { uncertainty: unc });
  } catch (e) {
    return {
      ok: false,
      errors: [`Invalid JSON dataset: ${e instanceof Error ? e.message : String(e)}`],
      warnings: [],
      timeColumn: null,
      columns: [],
      rows: 0,
      values: [],
    };
  }
}

/** Dataset record + its values as RunData-like signals for the data store. */
export function datasetRecord(
  id: string,
  name: string,
  format: Dataset['format'],
  parsed: ParsedDataset,
  provenance: Dataset['provenance'],
  now = new Date(),
) {
  const ti = parsed.columns.findIndex((c) => c.name === parsed.timeColumn);
  const tUnit = parsed.columns[ti]!.unit;
  const tf = conversion(tUnit, 's') ?? 1;
  const t = Float64Array.from(parsed.values[ti]!, (x) => x * tf);
  const signals = parsed.columns
    .map((c, j) => ({ key: c.name, unit: c.unit, t, v: parsed.values[j]!, source: `dataset ${name}` }))
    .filter((_, j) => j !== ti);
  const rec: Dataset = {
    id,
    name,
    format,
    provenance,
    timeColumn: parsed.timeColumn,
    columns: parsed.columns,
    rows: parsed.rows,
    dataKey: `dataset:${id}`,
    hash: hashOfSeries(
      Float64Array.from(signals.flatMap((s) => Array.from(s.t))),
      signals.map((s) => s.v),
    ),
    importedAt: now.toISOString(),
    warnings: parsed.warnings,
  };
  return { record: rec, data: { signals } };
}

export interface ErrorMetrics {
  column: string;
  signal: string;
  unit: string;
  n: number;
  mae: number;
  rmse: number;
  maxAbs: number;
  bias: number;
  withinUncertainty: number | null;
}

/** Model output interpolated at the observation times (within the simulated span only). */
export function errorMetrics(
  obs: Signal,
  sim: Signal,
  uncertainty: number | null,
): ErrorMetrics | { error: string } {
  const f = obs.unit === sim.unit ? 1 : conversion(sim.unit, obs.unit);
  if (f === null)
    return { error: `Units differ in dimension: dataset "${obs.unit}" vs simulation "${sim.unit}".` };
  const e: number[] = [];
  for (let i = 0; i < obs.t.length; i++) {
    const y = obs.v[i]!;
    const s = interpolate(sim, obs.t[i]!) * f;
    if (Number.isFinite(y) && Number.isFinite(s)) e.push(s - y);
  }
  if (!e.length) return { error: 'No overlapping valid samples between the dataset and the run.' };
  return {
    column: obs.key,
    signal: sim.key,
    unit: obs.unit,
    n: e.length,
    mae: e.reduce((a, b) => a + Math.abs(b), 0) / e.length,
    rmse: Math.sqrt(e.reduce((a, b) => a + b * b, 0) / e.length),
    maxAbs: Math.max(...e.map(Math.abs)),
    bias: e.reduce((a, b) => a + b, 0) / e.length,
    withinUncertainty:
      uncertainty === null ? null : e.filter((x) => Math.abs(x) <= uncertainty).length / e.length,
  };
}

export function validationRecord(args: {
  id: string;
  experimentId: string;
  dataset: Dataset;
  run: RunRecord;
  mapping: { column: string; signal: string }[];
  metrics: ErrorMetrics[];
  acceptance: ValidationRecord['acceptance'];
  calibrations: CalibrationRecord[];
  operatingRange: string;
  now?: Date;
}): ValidationRecord {
  const usedForCalibration = args.calibrations.some(
    (c) => c.experimentId === args.experimentId && c.datasetId === args.dataset.id,
  );
  const synthetic = args.dataset.provenance.synthetic;
  let status: ValidationRecord['status'] = 'not-assessed';
  if (usedForCalibration) status = 'not-independent';
  else if (synthetic) status = 'synthetic-only';
  else if (args.acceptance)
    status = args.metrics.every((m) => m[args.acceptance!.metric] <= args.acceptance!.threshold)
      ? 'agrees'
      : 'disagrees';
  const rec: ValidationRecord = {
    id: args.id,
    experimentId: args.experimentId,
    datasetId: args.dataset.id,
    runId: args.run.id,
    mapping: args.mapping,
    metrics: args.metrics,
    acceptance: args.acceptance,
    independent: !usedForCalibration,
    synthetic,
    status,
    operatingRange: args.operatingRange,
    createdAt: (args.now ?? new Date()).toISOString(),
    integrityHash: '',
  };
  rec.integrityHash = integrityOf(rec);
  return rec;
}

/** Validation status of an experiment's model — never a universal accuracy claim. */
export function validationStatus(validations: ValidationRecord[], experimentId: string): string {
  const v = validations.filter((x) => x.experimentId === experimentId);
  const real = v.filter((x) => x.status === 'agrees');
  if (!real.length)
    return v.some((x) => x.status === 'disagrees')
      ? 'Disagrees with independent measured data (see the validation records).'
      : 'Not empirically validated: no independent, measured (non-synthetic) dataset agrees with this model under stated criteria.';
  return `Agrees with ${real.length} independent measured dataset(s) within the stated criteria, for: ${[...new Set(real.map((x) => x.operatingRange))].join('; ')}. Not validated outside these conditions.`;
}

// -- calibration ----------------------------------------------------------------------------
export interface CalibrationInput {
  project: Project;
  experiment: Experiment;
  R: Rapier;
  parameters: { variableId: string; lower: number; upper: number }[];
  dataset: Dataset;
  data: { signals: Signal[] };
  mapping: { column: string; signal: string }[];
  maxIterations?: number;
  tolerance?: number;
  id: string;
  now?: Date;
}

/**
 * Bounded nonlinear least squares (Levenberg–Marquardt with a forward-difference Jacobian and
 * projection onto the bounds). Each objective evaluation is a full simulation run of the
 * experiment's model with the candidate parameters. The project is never modified: fitted
 * values are recorded next to the nominal ones.
 */
export async function calibrate(
  input: CalibrationInput,
): Promise<{ record: CalibrationRecord; fitted: Record<string, number> } | { error: string }> {
  const { experiment: e, parameters } = input;
  const vars = parameters.map((p) => e.variables.find((x) => x.id === p.variableId));
  if (vars.some((x) => !x)) return { error: 'Unknown calibration variable.' };
  if (input.mapping.some((mp) => !input.data.signals.some((s) => s.key === mp.column)))
    return { error: 'Mapped dataset column not found.' };
  const nominal = vars.map((x) => x!.default as number);
  const lo = parameters.map((p) => p.lower);
  const hi = parameters.map((p) => p.upper);
  const clamp = (x: number[]) => x.map((v, i) => Math.min(hi[i]!, Math.max(lo[i]!, v)));
  const signalsNeeded = input.mapping.map((mp) => mp.signal);
  const exp: Experiment = {
    ...e,
    measurements: [],
    protocol: { ...e.protocol, recordSignals: [...new Set([...e.protocol.recordSignals, ...signalsNeeded])] },
  };
  let evaluations = 0;
  const residuals = async (x: number[]): Promise<number[] | null> => {
    evaluations++;
    const values = Object.fromEntries(
      e.variables.filter((vv) => vv.role !== 'dependent').map((vv) => [vv.id, vv.default]),
    );
    parameters.forEach((p, i) => (values[p.variableId] = x[i]!));
    const res = await executeRun(
      input.project,
      exp,
      { id: 'calibration', label: 'calibration', values },
      { conditionId: 'calibration', replicate: evaluations, seed: e.design.baseSeed },
      { R: input.R, yieldNow: async () => undefined },
    );
    if (res.record.state !== 'COMPLETED' || !res.data) return null;
    const out: number[] = [];
    for (const mp of input.mapping) {
      const obs = input.data.signals.find((s) => s.key === mp.column)!;
      const sim = res.data.signals.find((s) => s.key === mp.signal);
      if (!sim) return null;
      const f = obs.unit === sim.unit ? 1 : conversion(sim.unit, obs.unit);
      if (f === null) return null;
      for (let i = 0; i < obs.t.length; i++) {
        const y = obs.v[i]!;
        const s = interpolate(sim, obs.t[i]!) * f;
        if (Number.isFinite(y) && Number.isFinite(s)) out.push(s - y);
      }
    }
    return out;
  };
  const ss = (r: number[]) => r.reduce((a, b) => a + b * b, 0);
  let x = clamp(nominal);
  let r = await residuals(x);
  if (!r || !r.length)
    return { error: 'The model could not be evaluated at the nominal parameters, or no samples overlap.' };
  let lambda = 1e-3;
  const maxIt = input.maxIterations ?? 30;
  const tol = input.tolerance ?? 1e-8;
  let iterations = 0;
  let converged = false;
  let J: number[][] = [];
  for (; iterations < maxIt; iterations++) {
    // Forward-difference Jacobian (relative step, scaled by the bounds).
    J = r.map(() => new Array<number>(x.length).fill(0));
    for (let j = 0; j < x.length; j++) {
      const h = Math.max(1e-6 * (hi[j]! - lo[j]!), 1e-4 * Math.abs(x[j]!));
      const xj = [...x];
      xj[j] = x[j]! + h > hi[j]! ? x[j]! - h : x[j]! + h;
      const rj = await residuals(xj);
      if (!rj || rj.length !== r.length) return { error: 'Model evaluation failed during the Jacobian.' };
      for (let i = 0; i < r.length; i++) J[i]![j] = (rj[i]! - r[i]!) / (xj[j]! - x[j]!);
    }
    const JtJ = x.map((_, a) => x.map((__, b) => J.reduce((s, row) => s + row[a]! * row[b]!, 0)));
    const Jtr = x.map((_, a) => J.reduce((s, row, i) => s + row[a]! * r![i]!, 0));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => v + (a === b ? lambda * Math.max(v, 1e-300) : 0)));
      const inv = invert(A);
      if (!inv) {
        lambda *= 10;
        continue;
      }
      const step = inv.map((row) => -row.reduce((s, v, b) => s + v * Jtr[b]!, 0));
      const xn = clamp(x.map((v, i) => v + step[i]!));
      const rn = await residuals(xn);
      if (rn && rn.length === r.length && ss(rn) < ss(r)) {
        const rel = Math.abs(ss(r) - ss(rn)) / Math.max(1e-300, ss(r));
        const stepRel = Math.max(...xn.map((v, i) => Math.abs(v - x[i]!) / Math.max(1e-12, hi[i]! - lo[i]!)));
        x = xn;
        r = rn;
        lambda = Math.max(1e-12, lambda / 10);
        improved = true;
        if (rel < tol || stepRel < tol) converged = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) {
      converged = true; // no descent direction within the trust region: a (local) minimum
      break;
    }
    if (converged) break;
  }
  const n = r.length;
  const p = x.length;
  const sigma2 = ss(r) / Math.max(1, n - p);
  const JtJ = x.map((_, a) => x.map((__, b) => J.reduce((s, row) => s + row[a]! * row[b]!, 0)));
  const cov = invert(JtJ);
  const identifiability: string[] = [];
  const correlations: (number | null)[][] = x.map((_, a) =>
    x.map((__, b) => (cov ? cov[a]![b]! / Math.sqrt(Math.abs(cov[a]![a]! * cov[b]![b]!)) : null)),
  );
  if (!cov)
    identifiability.push(
      'The information matrix is singular: the parameters are not identifiable from these data (several combinations fit equally well).',
    );
  else
    for (let a = 0; a < p; a++)
      for (let b = a + 1; b < p; b++)
        if (Math.abs(correlations[a]![b]!) > 0.95)
          identifiability.push(
            `${vars[a]!.name} and ${vars[b]!.name} are strongly correlated (ρ = ${correlations[a]![b]!.toFixed(3)}): the data constrain their combination, not each separately.`,
          );
  x.forEach((v, i) => {
    if (Math.abs(v - lo[i]!) < 1e-9 * (hi[i]! - lo[i]!) || Math.abs(v - hi[i]!) < 1e-9 * (hi[i]! - lo[i]!))
      identifiability.push(
        `${vars[i]!.name} ended at a bound: the optimum may lie outside the allowed range.`,
      );
  });
  const absR = r.map(Math.abs);
  const rec: CalibrationRecord = {
    id: input.id,
    experimentId: e.id,
    datasetId: input.dataset.id,
    parameters: parameters.map((pp, i) => ({
      variableId: pp.variableId,
      target: vars[i]!.target,
      unit: vars[i]!.unit,
      nominal: nominal[i]!,
      fitted: x[i]!,
      lower: lo[i]!,
      upper: hi[i]!,
      standardError: cov ? Math.sqrt(Math.max(0, sigma2 * cov[i]![i]!)) : null,
      atBound: identifiability.some((w) => w.startsWith(vars[i]!.name) && w.includes('bound')),
    })),
    mapping: input.mapping,
    objective: 'sum of squared residuals (model − observation) at the observation times',
    optimizer: {
      method: 'Levenberg–Marquardt, forward-difference Jacobian, bound projection',
      maxIterations: maxIt,
      tolerance: tol,
    },
    iterations,
    evaluations,
    converged,
    residual: {
      rmse: Math.sqrt(ss(r) / n),
      mae: absR.reduce((a, b) => a + b, 0) / n,
      maxAbs: Math.max(...absR),
      n,
    },
    correlations,
    identifiability,
    createdAt: (input.now ?? new Date()).toISOString(),
    integrityHash: '',
  };
  rec.integrityHash = integrityOf(rec);
  return { record: rec, fitted: Object.fromEntries(parameters.map((pp, i) => [pp.variableId, x[i]!])) };
}
