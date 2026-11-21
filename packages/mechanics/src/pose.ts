import { invert, multiply, type Mat4 } from '@forge/engineering-core';

/** Rigid poses as column-major 4×4 matrices (same convention as @forge/engineering-core). */
export type V3 = [number, number, number];
export const I4 = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const mul = (...ms: readonly Mat4[]): Mat4 => ms.reduce((a, b) => multiply(a, b), I4());
export const inv = (m: Mat4): Mat4 => invert(m)!;

export const translation = (x: number, y: number, z: number): Mat4 => [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  x,
  y,
  z,
  1,
];
export function rotZ(a: number): Mat4 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
export const ROT_X_PI: Mat4 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

/** Rotation from a rotation vector (axis × angle), Rodrigues' formula. */
export function rotVec(r: readonly number[]): Mat4 {
  const th = Math.hypot(r[0]!, r[1]!, r[2]!);
  if (th < 1e-15) return I4();
  const [x, y, z] = [r[0]! / th, r[1]! / th, r[2]! / th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y + s * z,
    t * x * z - s * y,
    0,
    t * x * y - s * z,
    t * y * y + c,
    t * y * z + s * x,
    0,
    t * x * z + s * y,
    t * y * z - s * x,
    t * z * z + c,
    0,
    0,
    0,
    0,
    1,
  ];
}

/** Rotation vector (log map) of a pose's rotation part. */
export function logRot(m: Mat4): V3 {
  const tr = m[0]! + m[5]! + m[10]!;
  const cos = Math.min(1, Math.max(-1, (tr - 1) / 2));
  const th = Math.acos(cos);
  const v: V3 = [m[6]! - m[9]!, m[8]! - m[2]!, m[1]! - m[4]!];
  if (th < 1e-9) return [v[0] / 2, v[1] / 2, v[2] / 2];
  if (Math.PI - th < 1e-6) {
    // Near π: axis from the diagonal.
    const x = Math.sqrt(Math.max(0, (m[0]! + 1) / 2));
    const y = Math.sqrt(Math.max(0, (m[5]! + 1) / 2)) * (m[4]! >= 0 ? 1 : -1);
    const z = Math.sqrt(Math.max(0, (m[10]! + 1) / 2)) * (m[8]! >= 0 ? 1 : -1);
    return [x * th, y * th, z * th];
  }
  const k = th / (2 * Math.sin(th));
  return [v[0] * k, v[1] * k, v[2] * k];
}

export const col = (m: Mat4, c: 0 | 1 | 2 | 3): V3 => [m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!];
export const origin = (m: Mat4): V3 => col(m, 3);
export const zAxis = (m: Mat4): V3 => col(m, 2);
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: V3): V3 => scale(a, 1 / len3(a));
export function transformPoint(m: Mat4, p: V3): V3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}
export function transformDir(m: Mat4, d: V3): V3 {
  return [
    m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2],
    m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2],
    m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2],
  ];
}

/** Frame matrix from origin, z-axis and an x reference (orthonormalised). */
export function frame(o: V3, axis: V3, xRef: V3): Mat4 {
  const z = normalize(axis);
  const x = normalize(sub(xRef, scale(z, dot(xRef, z))));
  const y = cross(z, x);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1];
}

/** Deterministic x reference perpendicular to an axis (for interfaces that declare only a direction). */
export function defaultXRef(axis: V3): V3 {
  const z = normalize(axis);
  const seed: V3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(sub(seed, scale(z, dot(seed, z))));
}
