import { sha256 } from './hash';

/**
 * Seeded pseudo-random numbers for experiment design and uncertainty sampling.
 * Generator: Mulberry32 (32-bit state), recorded as RNG_ID in every plan. Deterministic for a
 * given seed in any conforming JavaScript engine (integer arithmetic only).
 */
export const RNG_ID = 'mulberry32 v1';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive a 31-bit seed from a base seed and labels (SHA-256; stable and independent streams). */
export function deriveSeed(base: number, ...labels: (string | number)[]): number {
  const h = sha256(`${base}|${labels.join('|')}`);
  return parseInt(h.slice(0, 8), 16) & 0x7fffffff || 1;
}

/** Standard normal (Box–Muller). */
export function normal(rand: () => number): number {
  const u = Math.max(1e-300, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
