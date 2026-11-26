import { errorMetrics, type ErrorMetrics, type Signal } from '@forge/research';
import { toModel } from './mapping';
import type { Series } from './pipeline';
import type { ChannelMapping } from './schemas';

/**
 * Simulation-versus-observation comparison on one timeline. Observed samples are converted
 * to model units; the simulated signal is interpolated at the OBSERVED times (never the
 * reverse), missing observations are excluded and counted, and a lag search reports the
 * time shift that minimises the RMS residual (a synchronisation diagnostic, not applied
 * silently).
 */
export interface Comparison {
  metrics: ErrorMetrics;
  residuals: { t: number[]; observed: number[]; simulated: number[]; residual: number[] };
  missingObserved: number;
  outsideSimulation: number;
  lag: { bestS: number; rmseAtBest: number; rmseAtZero: number; searchedS: [number, number] };
  unit: string;
}

export function observedSignal(s: Series, m: ChannelMapping): Signal {
  const t: number[] = [];
  const v: number[] = [];
  s.t.forEach((x, i) => {
    t.push(x);
    v.push(Number.isFinite(s.v[i]!) ? toModel(m, s.v[i]!) : NaN);
  });
  return {
    key: m.channel,
    unit: m.modelUnit,
    t: Float64Array.from(t),
    v: Float64Array.from(v),
    source: `observed ${m.channel} (${m.kind})`,
  };
}

function interp(sim: Signal, t: number): number {
  const n = sim.t.length;
  if (!n || t < sim.t[0]! || t > sim.t[n - 1]!) return NaN;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sim.t[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const a = sim.t[hi]! === sim.t[lo]! ? 0 : (t - sim.t[lo]!) / (sim.t[hi]! - sim.t[lo]!);
  return sim.v[lo]! + a * (sim.v[hi]! - sim.v[lo]!);
}

export function compare(
  observed: Signal,
  sim: Signal,
  opts: { lagRangeS?: number; lagStepS?: number } = {},
): Comparison | { error: string } {
  const m = errorMetrics(observed, sim, null);
  if ('error' in m) return m;
  const r = {
    t: [] as number[],
    observed: [] as number[],
    simulated: [] as number[],
    residual: [] as number[],
  };
  let missing = 0;
  let outside = 0;
  for (let i = 0; i < observed.t.length; i++) {
    const y = observed.v[i]!;
    if (!Number.isFinite(y)) {
      missing++;
      continue;
    }
    const s = interp(sim, observed.t[i]!);
    if (!Number.isFinite(s)) {
      outside++;
      continue;
    }
    r.t.push(observed.t[i]!);
    r.observed.push(y);
    r.simulated.push(s);
    r.residual.push(s - y);
  }
  const range = opts.lagRangeS ?? 0.5;
  const step = opts.lagStepS ?? 0.01;
  const rmse = (lag: number) => {
    let s2 = 0;
    let n = 0;
    for (let i = 0; i < observed.t.length; i++) {
      const y = observed.v[i]!;
      const s = interp(sim, observed.t[i]! + lag);
      if (Number.isFinite(y) && Number.isFinite(s)) {
        s2 += (s - y) ** 2;
        n++;
      }
    }
    return n ? Math.sqrt(s2 / n) : Infinity;
  };
  let best = 0;
  let bestR = rmse(0);
  for (let lag = -range; lag <= range + 1e-12; lag += step) {
    const e = rmse(lag);
    if (e < bestR - 1e-15) {
      bestR = e;
      best = lag;
    }
  }
  return {
    metrics: m,
    residuals: r,
    missingObserved: missing,
    outsideSimulation: outside,
    lag: {
      bestS: Number(best.toFixed(6)),
      rmseAtBest: bestR,
      rmseAtZero: rmse(0),
      searchedS: [-range, range],
    },
    unit: observed.unit,
  };
}
