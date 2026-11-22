import type { Waveform } from '@forge/engineering-core';

/** Value of an independent-source waveform at time t (s). */
export function waveValue(w: Waveform, t: number): number {
  switch (w.kind) {
    case 'dc':
      return w.value;
    case 'step':
      return t < w.atS ? w.v0 : w.v1;
    case 'pulse': {
      if (t < w.delayS) return w.v1;
      const tp = (t - w.delayS) % w.periodS;
      if (tp < w.riseS) return w.v1 + ((w.v2 - w.v1) * tp) / w.riseS;
      if (tp < w.riseS + w.widthS) return w.v2;
      if (tp < w.riseS + w.widthS + w.fallS)
        return w.v2 + ((w.v1 - w.v2) * (tp - w.riseS - w.widthS)) / w.fallS;
      return w.v1;
    }
    case 'sine':
      if (t < w.delayS) return w.offset + w.amplitude * Math.sin((w.phaseDeg * Math.PI) / 180);
      return (
        w.offset +
        w.amplitude * Math.sin(2 * Math.PI * w.frequencyHz * (t - w.delayS) + (w.phaseDeg * Math.PI) / 180)
      );
    case 'pwl': {
      const p = w.points;
      if (t <= p[0]![0]) return p[0]![1];
      for (let i = 1; i < p.length; i++) {
        const [t1, v1] = p[i]!;
        if (t <= t1) {
          const [t0, v0] = p[i - 1]!;
          return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
        }
      }
      return p[p.length - 1]![1];
    }
  }
}

/** Times in (0, stop] where the waveform has a corner or jump (transient breakpoints). */
export function waveBreakpoints(w: Waveform, stop: number, max = 100_000): number[] {
  const out: number[] = [];
  switch (w.kind) {
    case 'step':
      if (w.atS > 0 && w.atS <= stop) out.push(w.atS);
      break;
    case 'pulse': {
      const corners = [0, w.riseS, w.riseS + w.widthS, w.riseS + w.widthS + w.fallS];
      for (let k = 0; out.length < max; k++) {
        const base = w.delayS + k * w.periodS;
        if (base > stop) break;
        for (const c of corners) if (base + c > 0 && base + c <= stop) out.push(base + c);
      }
      break;
    }
    case 'sine':
      if (w.delayS > 0 && w.delayS <= stop) out.push(w.delayS);
      break;
    case 'pwl':
      for (const [t] of w.points) if (t > 0 && t <= stop) out.push(t);
      break;
    case 'dc':
      break;
  }
  return out;
}
