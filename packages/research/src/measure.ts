import { evalExpr, parseExpr } from './expr';
import type { Measurement, Outcome } from './schemas';
import { formatDims, parseUnit, sameDims } from './units';

/**
 * Measurements over recorded signals. Integrity rules (docs/SCIENTIFIC_MEASUREMENTS.md):
 *  - a missing or non-finite sample is MISSING — never zero; it is excluded and counted;
 *  - no valid sample → value null, status "missing";
 *  - derived signals align every alias to the FIRST alias's recorded timestamps by linear
 *    interpolation (never extrapolation); interpolated samples are counted and reported;
 *  - time integrals use the trapezoidal rule on the recorded timestamps;
 *  - units come from the signals; derived units are checked dimensionally.
 */
export interface Signal {
  key: string;
  unit: string;
  t: Float64Array;
  v: Float64Array;
  source: string;
  /** Piecewise-constant (event) signal: values hold until the next timestamp. */
  hold?: boolean;
}

export interface Series {
  t: Float64Array;
  v: Float64Array;
  unit: string;
  method: string;
  interpolated: number;
  hold?: boolean;
}

/** Linear interpolation of s at time x; NaN outside the recorded range or across a missing sample. */
export function interpolate(s: { t: ArrayLike<number>; v: ArrayLike<number> }, x: number): number {
  const t = s.t;
  const n = t.length;
  if (!n || x < t[0]! || x > t[n - 1]!) return NaN;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t[m]! <= x) lo = m;
    else hi = m;
  }
  if (t[lo] === x) return s.v[lo]!;
  if (t[hi] === x) return s.v[hi]!;
  const a = s.v[lo]!;
  const b = s.v[hi]!;
  return a + ((b - a) * (x - t[lo]!)) / (t[hi]! - t[lo]!);
}

/** Value at time x: the recorded sample if one exists at x, else held (event signals) or interpolated. */
export function sampleAt(s: Signal, x: number): { v: number; exact: boolean } {
  const t = s.t;
  let lo = 0;
  let hi = t.length - 1;
  if (hi < 0 || x < t[0]! || x > t[hi]!) return { v: NaN, exact: false };
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t[m]! <= x) lo = m;
    else hi = m;
  }
  if (t[lo] === x) return { v: s.v[lo]!, exact: true };
  if (t[hi] === x) return { v: s.v[hi]!, exact: true };
  return { v: s.hold ? s.v[lo]! : interpolate(s, x), exact: false };
}

export function resolveSeries(m: Measurement, signals: Map<string, Signal>): Series | { error: string } {
  if (m.source.kind === 'signal') {
    const s = signals.get(m.source.signal);
    if (!s) return { error: `Signal "${m.source.signal}" was not recorded.` };
    return {
      t: s.t,
      v: s.v,
      unit: s.unit,
      method: `recorded signal ${s.key} (${s.source})`,
      interpolated: 0,
      hold: !!s.hold,
    };
  }
  const aliases = m.source.aliases;
  const units: Record<string, string> = {};
  for (const [a, key] of Object.entries(aliases)) {
    const s = signals.get(key);
    if (!s) return { error: `Signal "${key}" (alias ${a}) was not recorded.` };
    units[a] = s.unit;
  }
  let parsed;
  try {
    parsed = parseExpr(m.source.expression, units);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const names = parsed.signals;
  if (!names.length) return { error: 'A derived measurement must reference at least one signal.' };
  const base = signals.get(aliases[names[0]!]!)!;
  let interpolated = 0;
  const v = new Float64Array(base.t.length);
  for (let i = 0; i < base.t.length; i++) {
    const x = base.t[i]!;
    v[i] = evalExpr(parsed.ast, (name) => {
      const s = signals.get(aliases[name]!)!;
      if (s === base) return base.v[i]!;
      const r = sampleAt(s, x);
      if (!r.exact) interpolated++;
      return r.v;
    });
  }
  // Prefer a named unit when the dimensions equal the first signal's unit.
  const u0 = parseUnit(base.unit);
  const unit = u0 && sameDims(u0.dims, parsed.dims) ? base.unit : formatDims(parsed.dims);
  return {
    t: base.t,
    v,
    unit,
    method: `derived: ${m.source.expression}${interpolated ? `; ${interpolated} value(s) interpolated (linear; held for event signals) onto ${base.key}'s timestamps` : ''}`,
    interpolated,
  };
}

const timesUnit = (u: string) => (u === '' || u === '1' ? 's' : `${u}·s`);

export function computeOutcome(m: Measurement, signals: Map<string, Signal>): Outcome {
  const r = resolveSeries(m, signals);
  if ('error' in r)
    return {
      value: null,
      unit: '',
      status: 'missing',
      samples: 0,
      missing: 0,
      method: m.reduction,
      warnings: [r.error],
    };
  const from = m.window.fromS;
  const to = m.window.toS ?? Infinity;
  const t: number[] = [];
  const v: number[] = [];
  let missing = 0;
  let inWindow = 0;
  for (let i = 0; i < r.t.length; i++) {
    const ti = r.t[i]!;
    if (ti < from - 1e-12 || ti > to + 1e-12) continue;
    inWindow++;
    const x = r.v[i]!;
    if (Number.isFinite(x)) {
      t.push(ti);
      v.push(x);
    } else missing++;
  }
  const warnings: string[] = [];
  if (r.interpolated) warnings.push(`${r.interpolated} interpolated value(s) (not recorded samples).`);
  if (missing) warnings.push(`${missing} missing or non-finite sample(s) excluded (not treated as zero).`);
  const out = (value: number | null, unit: string, extra = ''): Outcome => ({
    value: value !== null && Number.isFinite(value) ? value : null,
    unit,
    status:
      value === null || !Number.isFinite(value)
        ? v.length
          ? 'partial'
          : 'missing'
        : missing
          ? 'partial'
          : 'ok',
    samples: v.length,
    missing,
    method: `${m.reduction} over [${from}, ${m.window.toS ?? 'end'}] s of ${r.method}${extra}`,
    warnings,
  });
  if (!v.length) {
    warnings.push(inWindow ? 'Every sample in the window is missing.' : 'No samples in the analysis window.');
    return out(null, r.unit);
  }
  const n = v.length;
  // Event (hold) signals integrate as steps; sampled signals by the trapezoidal rule.
  const hold = 'hold' in r && r.hold;
  const trap = (f: (x: number) => number) => {
    let s = 0;
    for (let i = 1; i < n; i++)
      s += (hold ? f(v[i - 1]!) : (f(v[i - 1]!) + f(v[i]!)) / 2) * (t[i]! - t[i - 1]!);
    return s;
  };
  const edges = () => {
    const rises: number[] = [];
    const falls: number[] = [];
    for (let i = 1; i < n; i++) {
      if (v[i - 1]! < 0.5 && v[i]! >= 0.5) rises.push(t[i]!);
      if (v[i - 1]! >= 0.5 && v[i]! < 0.5) falls.push(t[i]!);
    }
    return { rises, falls };
  };
  const span = t[n - 1]! - t[0]!;
  const thr = m.params.threshold;
  const needThr = () => {
    if (thr === undefined) {
      warnings.push('This reduction needs a threshold.');
      return true;
    }
    return false;
  };
  switch (m.reduction) {
    case 'max':
      return out(Math.max(...v), r.unit);
    case 'min':
      return out(Math.min(...v), r.unit);
    case 'mean':
      return out(n === 1 ? v[0]! : trap((x) => x) / span, r.unit, ' (time-weighted, trapezoidal)');
    case 'rms':
      return out(
        n === 1 ? Math.abs(v[0]!) : Math.sqrt(trap((x) => x * x) / span),
        r.unit,
        ' (time-weighted)',
      );
    case 'std': {
      if (n < 2) {
        warnings.push('Standard deviation needs at least two samples.');
        return out(null, r.unit);
      }
      const mu = v.reduce((a, b) => a + b, 0) / n;
      return out(Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1)), r.unit, ' (sample, n − 1)');
    }
    case 'final':
      return out(v[n - 1]!, r.unit);
    case 'initial':
      return out(v[0]!, r.unit);
    case 'range':
      return out(Math.max(...v) - Math.min(...v), r.unit);
    case 'peak-abs':
      return out(Math.max(...v.map(Math.abs)), r.unit);
    case 'iae':
      return out(trap(Math.abs), timesUnit(r.unit), ' (trapezoidal ∫|x| dt)');
    case 'settling-time': {
      const fin = v[n - 1]!;
      const step = fin - v[0]!;
      const band = m.params.bandAbsolute ?? (m.params.bandFraction ?? 0.02) * Math.abs(step);
      if (!(band > 0)) {
        warnings.push('No step in the window: settling time is undefined.');
        return out(null, 's');
      }
      let last = -1;
      for (let i = 0; i < n; i++) if (Math.abs(v[i]! - fin) > band) last = i;
      if (last === n - 1) {
        warnings.push('Did not settle within the window.');
        return out(null, 's');
      }
      // The window must show the signal staying inside the band for a while.
      const settled = last < 0 ? t[0]! : t[last + 1]!;
      if (t[n - 1]! - settled < 0.1 * span)
        warnings.push('Settled only near the end of the window: the final value may not be steady.');
      return out(settled - t[0]!, 's', ` (band ±${band.toPrecision(3)} ${r.unit} around the final value)`);
    }
    case 'overshoot': {
      const fin = v[n - 1]!;
      const step = fin - v[0]!;
      if (Math.abs(step) < 1e-12) {
        warnings.push('No step: overshoot is undefined.');
        return out(null, '');
      }
      const peak = step > 0 ? Math.max(...v) : Math.min(...v);
      return out(Math.max(0, (peak - fin) / step), '', ' (fraction of the step)');
    }
    case 'time-above': {
      if (needThr()) return out(null, 's');
      let s = 0;
      for (let i = 1; i < n; i++) if (v[i - 1]! > thr!) s += t[i]! - t[i - 1]!;
      return out(s, 's', ` (sample-and-hold, threshold ${thr} ${r.unit})`);
    }
    case 'count-above':
      if (needThr()) return out(null, 'count');
      return out(v.filter((x) => x > thr!).length, 'count', ` (samples above ${thr} ${r.unit})`);
    case 'crossings': {
      if (needThr()) return out(null, 'count');
      let c = 0;
      for (let i = 1; i < n; i++) if (v[i - 1]! > thr! !== v[i]! > thr!) c++;
      return out(c, 'count', ` (threshold ${thr} ${r.unit})`);
    }
    case 'frequency': {
      const { rises } = edges();
      if (rises.length < 2) {
        warnings.push('Fewer than two rising edges in the window.');
        return out(null, 'Hz');
      }
      return out(
        (rises.length - 1) / (rises[rises.length - 1]! - rises[0]!),
        'Hz',
        ' (rising edges of a 0/1 signal)',
      );
    }
    case 'duty-cycle':
      if (span <= 0) return out(null, '');
      return out(trap((x) => (x >= 0.5 ? 1 : 0)) / span, '', ' (time fraction HIGH)');
    case 'pulse-width': {
      const { rises, falls } = edges();
      const w: number[] = [];
      for (const r0 of rises) {
        const f = falls.find((x) => x > r0);
        if (f !== undefined) w.push(f - r0);
      }
      if (!w.length) {
        warnings.push('No complete HIGH pulse in the window.');
        return out(null, 's');
      }
      return out(w.reduce((a, b) => a + b, 0) / w.length, 's', ` (mean of ${w.length} complete HIGH pulses)`);
    }
    case 'change-count': {
      let c = 0;
      for (let i = 1; i < n; i++) if (v[i] !== v[i - 1]) c++;
      return out(c, 'count', ' (changes between consecutive samples)');
    }
  }
}
