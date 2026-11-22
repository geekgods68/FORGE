import { mulberry32 } from './random';

/**
 * Statistics (docs/STATISTICAL_ANALYSIS.md). Inputs are filtered to finite values and the number
 * removed is reported. Every inferential result carries its assumptions. Nothing here decides
 * engineering significance.
 */
export const finiteOnly = (xs: readonly (number | null | undefined)[]) =>
  xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

/** Quantile, Hyndman–Fan type 7 (R's default). */
export function quantile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  return (
    sorted[lo]! + (h - lo) * ((sorted[Math.min(lo + 1, sorted.length - 1)] ?? sorted[lo]!) - sorted[lo]!)
  );
}

export interface Descriptive {
  n: number;
  excluded: number;
  mean: number;
  median: number;
  variance: number;
  sd: number;
  min: number;
  max: number;
  q1: number;
  q3: number;
  p05: number;
  p95: number;
}
export function describe(raw: readonly (number | null | undefined)[]): Descriptive {
  const xs = finiteOnly(raw);
  const n = xs.length;
  const s = [...xs].sort((a, b) => a - b);
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : NaN;
  // Two-pass variance (numerically stable for nearly constant data).
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : NaN;
  return {
    n,
    excluded: raw.length - n,
    mean,
    median: quantile(s, 0.5),
    variance,
    sd: Math.sqrt(variance),
    min: s[0] ?? NaN,
    max: s[n - 1] ?? NaN,
    q1: quantile(s, 0.25),
    q3: quantile(s, 0.75),
    p05: quantile(s, 0.05),
    p95: quantile(s, 0.95),
  };
}

// -- distributions --------------------------------------------------------------------------
export function lnGamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < 8; i++) a += g[i]! / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function betacf(a: number, b: number, x: number): number {
  const EPS = 3e-16;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
/** Regularised incomplete beta I_x(a, b). */
export function ibeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Student t CDF. */
export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const tail = 0.5 * ibeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}
/** Student t quantile (bisection on the CDF; |error| < 1e-10). */
export function tQuantile(p: number, df: number): number {
  let lo = -1e4;
  let hi = 1e4;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

export interface Inference {
  method: string;
  estimate: number;
  ci: [number, number] | null;
  level: number;
  statistic: number | null;
  df: number | null;
  pValue: number | null;
  n: number[];
  assumptions: string[];
  notes: string[];
}

export function meanCI(raw: readonly number[], level = 0.95): Inference {
  const d = describe(raw);
  const notes: string[] = [];
  if (d.n < 2)
    return {
      method: 'mean with t interval',
      estimate: d.mean,
      ci: null,
      level,
      statistic: null,
      df: null,
      pValue: null,
      n: [d.n],
      assumptions: [],
      notes: ['At least two values are needed for an interval.'],
    };
  if (d.sd === 0)
    notes.push(
      'All values are identical: the interval has zero width; this reflects a deterministic model, not certainty about the real system.',
    );
  const half = tQuantile(1 - (1 - level) / 2, d.n - 1) * (d.sd / Math.sqrt(d.n));
  return {
    method: 'mean with Student-t interval',
    estimate: d.mean,
    ci: [d.mean - half, d.mean + half],
    level,
    statistic: null,
    df: d.n - 1,
    pValue: null,
    n: [d.n],
    assumptions: [
      'Independent observations (separate runs, not samples within one run).',
      'Approximately normal sampling distribution of the mean.',
    ],
    notes,
  };
}

export function welchT(a0: readonly number[], b0: readonly number[], level = 0.95): Inference {
  const a = describe(a0);
  const b = describe(b0);
  const base = {
    method: "Welch's two-sample t-test (difference of means b − a)",
    level,
    n: [a.n, b.n],
    assumptions: [
      'Independent runs in each group.',
      'Approximately normal group means; variances may differ.',
    ],
  };
  const diff = b.mean - a.mean;
  if (a.n < 2 || b.n < 2)
    return {
      ...base,
      estimate: diff,
      ci: null,
      statistic: null,
      df: null,
      pValue: null,
      notes: ['Each group needs at least two runs.'],
    };
  const va = a.variance / a.n;
  const vb = b.variance / b.n;
  if (va + vb === 0)
    return {
      ...base,
      estimate: diff,
      ci: [diff, diff],
      statistic: null,
      df: null,
      pValue: null,
      notes: [
        'Zero variance in both groups (deterministic model): a t-test is not meaningful; the difference is exact for the model.',
      ],
    };
  const se = Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1));
  const t = diff / se;
  const q = tQuantile(1 - (1 - level) / 2, df);
  return {
    ...base,
    estimate: diff,
    ci: [diff - q * se, diff + q * se],
    statistic: t,
    df,
    pValue: 2 * (1 - tCdf(Math.abs(t), df)),
    notes: [],
  };
}

export function pairedT(a0: readonly number[], b0: readonly number[], level = 0.95): Inference {
  const d: number[] = [];
  for (let i = 0; i < Math.min(a0.length, b0.length); i++)
    if (Number.isFinite(a0[i]!) && Number.isFinite(b0[i]!)) d.push(b0[i]! - a0[i]!);
  const s = describe(d);
  const base = {
    method: 'paired t-test (mean of b − a over matched pairs)',
    level,
    n: [s.n],
    assumptions: [
      'Pairs share relevant conditions (e.g. the same seed).',
      'Approximately normal mean difference.',
    ],
  };
  if (s.n < 2)
    return {
      ...base,
      estimate: s.mean,
      ci: null,
      statistic: null,
      df: null,
      pValue: null,
      notes: ['At least two pairs are needed.'],
    };
  if (s.sd === 0)
    return {
      ...base,
      estimate: s.mean,
      ci: [s.mean, s.mean],
      statistic: null,
      df: null,
      pValue: null,
      notes: [
        'Identical differences in every pair (deterministic model): the difference is exact for the model; a test is not meaningful.',
      ],
    };
  const se = s.sd / Math.sqrt(s.n);
  const t = s.mean / se;
  const q = tQuantile(1 - (1 - level) / 2, s.n - 1);
  return {
    ...base,
    estimate: s.mean,
    ci: [s.mean - q * se, s.mean + q * se],
    statistic: t,
    df: s.n - 1,
    pValue: 2 * (1 - tCdf(Math.abs(t), s.n - 1)),
    notes: [],
  };
}

/** Cohen's d (pooled SD) and Hedges' g (small-sample corrected). */
export function effectSize(a0: readonly number[], b0: readonly number[]) {
  const a = describe(a0);
  const b = describe(b0);
  if (a.n < 2 || b.n < 2) return null;
  const sp = Math.sqrt(((a.n - 1) * a.variance + (b.n - 1) * b.variance) / (a.n + b.n - 2));
  if (sp === 0) return null;
  const d = (b.mean - a.mean) / sp;
  const J = 1 - 3 / (4 * (a.n + b.n) - 9);
  return { cohensD: d, hedgesG: d * J };
}

/** Percentile bootstrap interval for a statistic (seeded; reproducible). */
export function bootstrapCI(
  raw: readonly number[],
  stat: (xs: number[]) => number,
  opts: { resamples?: number; level?: number; seed?: number } = {},
) {
  const xs = finiteOnly(raw);
  const B = opts.resamples ?? 2000;
  const level = opts.level ?? 0.95;
  const r = mulberry32(opts.seed ?? 1);
  if (xs.length < 2) return null;
  const vals: number[] = [];
  for (let b = 0; b < B; b++) {
    const s = Array.from({ length: xs.length }, () => xs[Math.floor(r() * xs.length)]!);
    vals.push(stat(s));
  }
  vals.sort((x, y) => x - y);
  return {
    estimate: stat(xs),
    ci: [quantile(vals, (1 - level) / 2), quantile(vals, 1 - (1 - level) / 2)] as [number, number],
    resamples: B,
    level,
    method: 'percentile bootstrap',
    seed: opts.seed ?? 1,
  };
}

/** Two-sided permutation test of the difference in means (seeded Monte Carlo). */
export function permutationTest(
  a0: readonly number[],
  b0: readonly number[],
  opts: { permutations?: number; seed?: number } = {},
) {
  const a = finiteOnly(a0);
  const b = finiteOnly(b0);
  if (a.length < 2 || b.length < 2) return null;
  const P = opts.permutations ?? 10_000;
  const r = mulberry32(opts.seed ?? 1);
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const obs = Math.abs(mean(b) - mean(a));
  const pool = [...a, ...b];
  let extreme = 0;
  for (let k = 0; k < P; k++) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    if (Math.abs(mean(pool.slice(a.length)) - mean(pool.slice(0, a.length))) >= obs - 1e-12) extreme++;
  }
  return {
    observed: mean(b) - mean(a),
    pValue: (extreme + 1) / (P + 1),
    permutations: P,
    seed: opts.seed ?? 1,
    method: 'two-sided permutation test (difference in means)',
    assumptions: ['Exchangeability of runs under the null hypothesis.'],
  };
}

export function pearson(x0: readonly number[], y0: readonly number[]) {
  const pairs = x0
    .map((x, i) => [x, y0[i]!] as const)
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  if (n < 3) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  const t = r * Math.sqrt((n - 2) / Math.max(1e-300, 1 - r * r));
  return {
    r,
    n,
    pValue: 2 * (1 - tCdf(Math.abs(t), n - 2)),
    note: 'Correlation describes association in these runs; it does not establish causation.',
  };
}
const ranks = (xs: readonly number[]) => {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
};
export function spearman(x: readonly number[], y: readonly number[]) {
  const p = pearson(ranks(x), ranks(y));
  return p ? { rho: p.r, n: p.n, note: 'Rank correlation (ties averaged).' } : null;
}

export interface Regression {
  coefficients: number[];
  standardErrors: number[];
  r2: number;
  residuals: number[];
  fitted: number[];
  n: number;
  p: number;
  sigma: number;
  pValues: number[];
}
/** Ordinary least squares y = Xβ (+ intercept), solved by Gaussian elimination with pivoting on XᵀX. */
export function ols(
  X0: readonly (readonly number[])[],
  y0: readonly number[],
  intercept = true,
): Regression | { error: string } {
  const rows: number[][] = [];
  const y: number[] = [];
  X0.forEach((r, i) => {
    if (r.every(Number.isFinite) && Number.isFinite(y0[i]!)) {
      rows.push(intercept ? [1, ...r] : [...r]);
      y.push(y0[i]!);
    }
  });
  const n = rows.length;
  const p = rows[0]?.length ?? 0;
  if (n <= p) return { error: `Need more observations (${n}) than coefficients (${p}).` };
  const A = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => rows.reduce((s, r) => s + r[i]! * r[j]!, 0)),
  );
  const b = Array.from({ length: p }, (_, i) => rows.reduce((s, r, k) => s + r[i]! * y[k]!, 0));
  const inv = invert(A);
  if (!inv)
    return {
      error: 'The predictors are collinear (XᵀX is singular): the coefficients are not identifiable.',
    };
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * b[j]!, 0));
  const fitted = rows.map((r) => r.reduce((s, v, j) => s + v * beta[j]!, 0));
  const residuals = y.map((v, i) => v - fitted[i]!);
  const sse = residuals.reduce((s, r) => s + r * r, 0);
  const my = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - my) ** 2, 0);
  const sigma2 = sse / (n - p);
  const se = inv.map((row, i) => Math.sqrt(Math.max(0, sigma2 * row[i]!)));
  return {
    coefficients: beta,
    standardErrors: se,
    r2: sst === 0 ? NaN : 1 - sse / sst,
    residuals,
    fitted,
    n,
    p,
    sigma: Math.sqrt(sigma2),
    pValues: beta.map((v, i) => (se[i]! > 0 ? 2 * (1 - tCdf(Math.abs(v / se[i]!), n - p)) : NaN)),
  };
}
export function invert(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  const scale = Math.max(1e-300, ...A.flat().map(Math.abs));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (Math.abs(M[piv]![c]!) < 1e-12 * scale) return null;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    const d = M[c]![c]!;
    for (let j = 0; j < 2 * n; j++) M[c]![j]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f) for (let j = 0; j < 2 * n; j++) M[r]![j] = M[r]![j]! - f * M[c]![j]!;
    }
  }
  return M.map((r) => r.slice(n));
}

/** Wilson score interval for a binomial proportion. */
export function wilson(k: number, n: number, level = 0.95): [number, number] | null {
  if (n === 0) return null;
  const z = -tQuantile((1 - level) / 2, 1e6);
  const ph = k / n;
  const den = 1 + (z * z) / n;
  const c = (ph + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export function histogram(raw: readonly number[], bins = 12) {
  const xs = finiteOnly(raw);
  if (!xs.length) return { edges: [], counts: [] };
  let lo = Math.min(...xs);
  let hi = Math.max(...xs);
  if (hi === lo) {
    lo -= 0.5;
    hi += 0.5;
  }
  const w = (hi - lo) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const x of xs) counts[Math.min(bins - 1, Math.floor((x - lo) / w))]!++;
  return { edges: Array.from({ length: bins + 1 }, (_, i) => lo + i * w), counts };
}
