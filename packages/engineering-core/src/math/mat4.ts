import type { Quat, Vec3 } from '../transform';

/**
 * Minimal 4×4 affine matrix math (column-major, like three.js / glTF), used for
 * world transforms in the engineering scene graph without depending on three.
 * All values are float64 JavaScript numbers.
 */
export type Mat4 = number[]; // length 16, column-major

export interface TRS {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

export const IDENTITY_MAT4: readonly number[] = Object.freeze([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

export function compose({ position: p, rotation: q, scale: s }: TRS): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2;
  const yy = y * y2,
    yz = y * z2,
    zz = z * z2;
  const wx = w * x2,
    wy = w * y2,
    wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    p[0],
    p[1],
    p[2],
    1,
  ];
}

export function multiply(a: readonly number[], b: readonly number[]): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = v;
    }
  }
  return out;
}

/** Inverse of an affine matrix; returns null if singular. */
export function invert(m: readonly number[]): Mat4 | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as number[] as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const b00 = a00 * a11 - a01 * a10,
    b01 = a00 * a12 - a02 * a10,
    b02 = a00 * a13 - a03 * a10,
    b03 = a01 * a12 - a02 * a11,
    b04 = a01 * a13 - a03 * a11,
    b05 = a02 * a13 - a03 * a12,
    b06 = a20 * a31 - a21 * a30,
    b07 = a20 * a32 - a22 * a30,
    b08 = a20 * a33 - a23 * a30,
    b09 = a21 * a32 - a22 * a31,
    b10 = a21 * a33 - a23 * a31,
    b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

/**
 * Decompose into position/rotation/scale. A matrix containing shear (e.g. a rotated
 * child under a non-uniformly scaled parent) cannot be represented as TRS; callers
 * must check `exact` before relying on the result.
 */
export function decompose(m: readonly number[]): { trs: TRS; exact: boolean } {
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  const det =
    m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) -
    m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) +
    m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!);
  if (det < 0) sx = -sx;
  const r = [
    m[0]! / sx,
    m[1]! / sx,
    m[2]! / sx,
    m[4]! / sy,
    m[5]! / sy,
    m[6]! / sy,
    m[8]! / sz,
    m[9]! / sz,
    m[10]! / sz,
  ] as [number, number, number, number, number, number, number, number, number];
  // Rotation matrix (column-major r00=r[0], r10=r[1], r20=r[2], r01=r[3] …) → quaternion.
  const [m11, m21, m31, m12, m22, m32, m13, m23, m33] = r;
  const trace = m11 + m22 + m33;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
  }
  const n = Math.hypot(...q);
  q = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]]; // canonical hemisphere
  const trs: TRS = { position: [m[12]!, m[13]!, m[14]!], rotation: q, scale: [sx, sy, sz] };
  const back = compose(trs);
  const scaleRef = Math.max(1, ...m.slice(0, 12).map(Math.abs));
  const exact = back.every((v, i) => Math.abs(v - m[i]!) <= 1e-9 * scaleRef);
  return { trs, exact };
}

export function transformPoint(m: readonly number[], p: Vec3): Vec3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}
