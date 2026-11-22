import type { Logic } from '@forge/electronics';

export interface Lane {
  name: string;
  /** Transition times (ns) and the level from each time on (oldest first). */
  t: number[];
  level: Logic[];
}

/** Pulse statistics measured from recorded transitions inside [t0, t1] (ns). */
export function laneStats(l: Lane, t0: number, t1: number) {
  const rises: number[] = [];
  const falls: number[] = [];
  let high = 0;
  for (let i = 0; i < l.t.length; i++) {
    const a = Math.max(l.t[i]!, t0);
    const b = Math.min(l.t[i + 1] ?? t1, t1);
    if (l.level[i] === '1' && b > a) high += b - a;
    if (i > 0 && l.t[i]! >= t0 && l.t[i]! <= t1) {
      if (l.level[i - 1] === '0' && l.level[i] === '1') rises.push(l.t[i]!);
      if (l.level[i - 1] === '1' && l.level[i] === '0') falls.push(l.t[i]!);
    }
  }
  const lastRise = rises[rises.length - 1];
  const fallAfter = lastRise === undefined ? undefined : falls.find((f) => f > lastRise);
  const prevRise = rises.length > 1 ? rises[rises.length - 2] : undefined;
  const pulseRise = fallAfter !== undefined ? lastRise : prevRise;
  const pulseFall = pulseRise === undefined ? undefined : falls.find((f) => f > pulseRise);
  return {
    /** Width of the most recent complete HIGH pulse (ns). */
    lastHighNs: pulseRise !== undefined && pulseFall !== undefined ? pulseFall - pulseRise : null,
    periodNs: rises.length > 1 ? (rises[rises.length - 1]! - rises[0]!) / (rises.length - 1) : null,
    duty: t1 > t0 ? high / (t1 - t0) : null,
    edges: rises.length + falls.length,
  };
}
