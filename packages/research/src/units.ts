/**
 * Units with dimensional analysis. Dimensions are exponent vectors over
 * [m, kg, s, A, K, rad] — radians are kept as their own dimension so that an angle is never
 * silently added to an effort or a length. Each unit has a scale to SI.
 */
export type Dims = readonly [number, number, number, number, number, number];
export interface Unit {
  dims: Dims;
  scale: number;
}
const D = (m = 0, kg = 0, s = 0, a = 0, k = 0, rad = 0): Dims => [m, kg, s, a, k, rad];
const BASE: Record<string, Unit> = {
  '': { dims: D(), scale: 1 },
  '1': { dims: D(), scale: 1 },
  '-': { dims: D(), scale: 1 },
  '0/1': { dims: D(), scale: 1 },
  count: { dims: D(), scale: 1 },
  '%': { dims: D(), scale: 0.01 },
  m: { dims: D(1), scale: 1 },
  cm: { dims: D(1), scale: 0.01 },
  mm: { dims: D(1), scale: 0.001 },
  kg: { dims: D(0, 1), scale: 1 },
  g: { dims: D(0, 1), scale: 0.001 },
  s: { dims: D(0, 0, 1), scale: 1 },
  ms: { dims: D(0, 0, 1), scale: 1e-3 },
  µs: { dims: D(0, 0, 1), scale: 1e-6 },
  us: { dims: D(0, 0, 1), scale: 1e-6 },
  ns: { dims: D(0, 0, 1), scale: 1e-9 },
  Hz: { dims: D(0, 0, -1), scale: 1 },
  A: { dims: D(0, 0, 0, 1), scale: 1 },
  mA: { dims: D(0, 0, 0, 1), scale: 1e-3 },
  K: { dims: D(0, 0, 0, 0, 1), scale: 1 },
  rad: { dims: D(0, 0, 0, 0, 0, 1), scale: 1 },
  deg: { dims: D(0, 0, 0, 0, 0, 1), scale: Math.PI / 180 },
  '°': { dims: D(0, 0, 0, 0, 0, 1), scale: Math.PI / 180 },
  N: { dims: D(1, 1, -2), scale: 1 },
  J: { dims: D(2, 1, -2), scale: 1 },
  W: { dims: D(2, 1, -3), scale: 1 },
  V: { dims: D(2, 1, -3, -1), scale: 1 },
  mV: { dims: D(2, 1, -3, -1), scale: 1e-3 },
  Ω: { dims: D(2, 1, -3, -2), scale: 1 },
  F: { dims: D(-2, -1, 4, 2), scale: 1 },
  mF: { dims: D(-2, -1, 4, 2), scale: 1e-3 },
  µF: { dims: D(-2, -1, 4, 2), scale: 1e-6 },
  uF: { dims: D(-2, -1, 4, 2), scale: 1e-6 },
  nF: { dims: D(-2, -1, 4, 2), scale: 1e-9 },
  pF: { dims: D(-2, -1, 4, 2), scale: 1e-12 },
  kΩ: { dims: D(2, 1, -3, -2), scale: 1e3 },
  MΩ: { dims: D(2, 1, -3, -2), scale: 1e6 },
  mH: { dims: D(2, 1, -2, -2), scale: 1e-3 },
  µH: { dims: D(2, 1, -2, -2), scale: 1e-6 },
  kHz: { dims: D(0, 0, -1), scale: 1e3 },
  H: { dims: D(2, 1, -2, -2), scale: 1 },
};
const SUP: Record<string, string> = { '²': '2', '³': '3', '⁻': '-', '¹': '1' };

/** Parse a unit string such as "N·m", "rad/s", "m/s²", "kg·m^2". Null if unknown. */
export function parseUnit(text: string): Unit | null {
  const t = text.trim();
  if (t in BASE) return BASE[t]!;
  const norm = t
    .replace(/[²³⁻¹]/g, (c) => `^${SUP[c]}`)
    .replace(/\^\^/g, '^')
    .replace(/\s+/g, '');
  const [num, ...dens] = norm.split('/');
  if (dens.length > 1) return null;
  let dims = [0, 0, 0, 0, 0, 0];
  let scale = 1;
  const apply = (part: string, sign: number) => {
    for (const f of part.split(/[·*.]/)) {
      if (!f || f === '1') continue;
      const m = /^(.+?)(?:\^(-?\d+))?$/.exec(f);
      if (!m) return false;
      const u = BASE[m[1]!];
      if (!u) return false;
      const e = Number(m[2] ?? 1) * sign;
      dims = dims.map((x, i) => x + u.dims[i]! * e);
      scale *= u.scale ** e;
    }
    return true;
  };
  if (!apply(num!, 1) || (dens[0] !== undefined && !apply(dens[0], -1))) return null;
  return { dims: dims as unknown as Dims, scale };
}

export const sameDims = (a: Dims, b: Dims) => a.every((x, i) => Math.abs(x - b[i]!) < 1e-9);
export const mulDims = (a: Dims, b: Dims, sign = 1): Dims =>
  a.map((x, i) => x + sign * b[i]!) as unknown as Dims;
export const powDims = (a: Dims, p: number): Dims => a.map((x) => x * p) as unknown as Dims;
export const isDimensionless = (a: Dims) => a.every((x) => Math.abs(x) < 1e-9);

/** Human-readable SI form of dimensions, e.g. "kg·m²·s⁻²". */
export function formatDims(d: Dims): string {
  const names = ['m', 'kg', 's', 'A', 'K', 'rad'];
  const sup = (n: number) =>
    n === 1
      ? ''
      : String(n)
          .replace(/-/g, '⁻')
          .replace(/2/g, '²')
          .replace(/3/g, '³')
          .replace(/[0-9]/g, (c) => `^${c}`);
  const parts = d
    .map((x, i) => (Math.abs(x) < 1e-9 ? '' : `${names[i]}${sup(Math.round(x * 1000) / 1000)}`))
    .filter(Boolean);
  return parts.length ? parts.join('·') : '1';
}

/** Factor converting a value in unit `from` to unit `to` (must have the same dimensions). */
export function conversion(from: string, to: string): number | null {
  const a = parseUnit(from);
  const b = parseUnit(to);
  if (!a || !b || !sameDims(a.dims, b.dims)) return null;
  return a.scale / b.scale;
}
