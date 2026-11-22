import type { Solid } from '@forge/components';

/**
 * Rigid-body mass properties from FORGE's portable solids (closed-form, per solid), the
 * parallel-axis theorem and a symmetric 3×3 eigen-solver for principal axes.
 *
 * Conventions: Mat3 is ROW-major (9 numbers); `inertia` is the inertia tensor about the
 * body's centre of mass, expressed in the stated frame's axes (kg·m²).
 *
 * Validity: the formulas are exact for the solid shapes; the RESULT is approximate
 * whenever the inputs are (handbook densities, envelope models, uniform-density
 * assumption for published/user masses) — see docs/CAD_PHYSICS_BRIDGE.md.
 */
export type V3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface MassProps {
  massKg: number;
  /** Centre of mass in the frame of interest (m). */
  com: V3;
  /** Inertia tensor about the COM, frame axes (kg·m²). */
  inertia: Mat3;
}

export const ZERO3: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
export const diag3 = (a: number, b: number, c: number): Mat3 => [a, 0, 0, 0, b, 0, 0, 0, c];
export const mat3Mul = (a: Mat3, b: Mat3): Mat3 => {
  const r = [...ZERO3] as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return r;
};
export const transpose3 = (a: Mat3): Mat3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
const add3 = (a: Mat3, b: Mat3): Mat3 => a.map((v, i) => v + b[i]!) as Mat3;
const scale3 = (a: Mat3, k: number): Mat3 => a.map((v) => v * k) as Mat3;
export const mulVec3 = (a: Mat3, v: V3): V3 => [
  a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
  a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
  a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
];

/** Rotate an inertia tensor: R I Rᵀ (R maps source axes to target axes). */
export const rotateInertia = (I: Mat3, R: Mat3): Mat3 => mat3Mul(mat3Mul(R, I), transpose3(R));

/** Parallel-axis term m(|d|²E − d dᵀ) for a COM offset d. */
function steiner(m: number, d: V3): Mat3 {
  const d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  return [
    m * (d2 - d[0] * d[0]),
    -m * d[0] * d[1],
    -m * d[0] * d[2],
    -m * d[1] * d[0],
    m * (d2 - d[1] * d[1]),
    -m * d[1] * d[2],
    -m * d[2] * d[0],
    -m * d[2] * d[1],
    m * (d2 - d[2] * d[2]),
  ];
}

/** Combine bodies expressed in one frame. Zero total mass → null. */
export function combine(parts: readonly MassProps[]): MassProps | null {
  const m = parts.reduce((s, p) => s + p.massKg, 0);
  if (!(m > 0)) return null;
  const com: V3 = [0, 0, 0];
  for (const p of parts) for (let k = 0; k < 3; k++) com[k]! += (p.com[k]! * p.massKg) / m;
  let I = ZERO3;
  for (const p of parts) {
    const d: V3 = [p.com[0] - com[0], p.com[1] - com[1], p.com[2] - com[2]];
    I = add3(I, add3(p.inertia, steiner(p.massKg, d)));
  }
  return { massKg: m, com, inertia: I };
}

/** Express mass properties in another frame: x' = R x + t. */
export function transformMass(p: MassProps, R: Mat3, t: V3): MassProps {
  const c = mulVec3(R, p.com);
  return {
    massKg: p.massKg,
    com: [c[0] + t[0], c[1] + t[1], c[2] + t[2]],
    inertia: rotateInertia(p.inertia, R),
  };
}

export const pointMass = (massKg: number, at: V3): MassProps => ({ massKg, com: at, inertia: ZERO3 });

// -- closed-form solids ---------------------------------------------------------------

const axisIndex = { x: 0, y: 1, z: 2 } as const;
function axial(Iax: number, Iperp: number, axis: 'x' | 'y' | 'z'): Mat3 {
  const v: V3 = [Iperp, Iperp, Iperp];
  v[axisIndex[axis]] = Iax;
  return diag3(...v);
}

/** Second moments of a polygon (u, v) about its plane origin, sign-normalised (∫dA, ∫u, ∫v, ∫u², ∫v², ∫uv). */
function polyMoments(pts: readonly [number, number][]) {
  let A = 0,
    Su = 0,
    Sv = 0,
    Suu = 0,
    Svv = 0,
    Suv = 0;
  for (let i = 0; i < pts.length; i++) {
    const [u0, v0] = pts[i]!;
    const [u1, v1] = pts[(i + 1) % pts.length]!;
    const c = u0 * v1 - u1 * v0;
    A += c / 2;
    Su += ((u0 + u1) * c) / 6;
    Sv += ((v0 + v1) * c) / 6;
    Suu += ((u0 * u0 + u0 * u1 + u1 * u1) * c) / 12;
    Svv += ((v0 * v0 + v0 * v1 + v1 * v1) * c) / 12;
    Suv += ((u0 * v1 + 2 * u0 * v0 + 2 * u1 * v1 + u1 * v0) * c) / 24;
  }
  const s = A < 0 ? -1 : 1;
  return { A: A * s, Su: Su * s, Sv: Sv * s, Suu: Suu * s, Svv: Svv * s, Suv: Suv * s };
}

/** Mass properties of one solid of uniform density (component frame). */
export function solidMass(s: Solid, density: number): MassProps {
  switch (s.type) {
    case 'box': {
      const [a, b, c] = s.size;
      const m = density * a * b * c;
      const I = diag3((m * (b * b + c * c)) / 12, (m * (a * a + c * c)) / 12, (m * (a * a + b * b)) / 12);
      const y = s.yaw ?? 0;
      const R: Mat3 = [Math.cos(y), 0, Math.sin(y), 0, 1, 0, -Math.sin(y), 0, Math.cos(y)];
      return { massKg: m, com: [...s.at], inertia: rotateInertia(I, R) };
    }
    case 'cylinder': {
      const m = density * Math.PI * s.r * s.r * s.h;
      return {
        massKg: m,
        com: [...s.at],
        inertia: axial((m * s.r * s.r) / 2, (m * (3 * s.r * s.r + s.h * s.h)) / 12, s.axis),
      };
    }
    case 'tube': {
      const m = density * Math.PI * (s.ro * s.ro - s.ri * s.ri) * s.h;
      const r2 = s.ro * s.ro + s.ri * s.ri;
      return {
        massKg: m,
        com: [...s.at],
        inertia: axial((m * r2) / 2, (m * (3 * r2 + s.h * s.h)) / 12, s.axis),
      };
    }
    case 'sphere': {
      const m = density * (4 / 3) * Math.PI * s.r ** 3;
      const i = 0.4 * m * s.r * s.r;
      return { massKg: m, com: [...s.at], inertia: diag3(i, i, i) };
    }
    case 'prism': {
      const outer = polyMoments(s.outline);
      const holes = (s.holes ?? []).map(polyMoments);
      const sum = (k: keyof typeof outer) => outer[k] - holes.reduce((t, h) => t + h[k], 0);
      const d = s.depth;
      const A = sum('A');
      const m = density * A * d;
      // Second moments about the solid's own origin (`at`), in (u, v, w) with w along the axis.
      const Cuu = density * d * sum('Suu');
      const Cvv = density * d * sum('Svv');
      const Cww = (density * A * d * d * d) / 12;
      const Cuv = density * d * sum('Suv');
      const cu = sum('Su') / A;
      const cv = sum('Sv') / A;
      // Map (u, v, w) → (x, y, z) per the outline convention of the axis.
      const idx = s.axis === 'z' ? [0, 1, 2] : s.axis === 'x' ? [2, 1, 0] : [0, 2, 1]; // u, v, w → x index
      const C = [...ZERO3] as Mat3;
      const set = (i: number, j: number, v: number) => {
        C[idx[i]! * 3 + idx[j]!] = v;
        C[idx[j]! * 3 + idx[i]!] = v;
      };
      set(0, 0, Cuu);
      set(1, 1, Cvv);
      set(2, 2, Cww);
      set(0, 1, Cuv);
      const local: V3 = [0, 0, 0];
      local[idx[0]!] = cu;
      local[idx[1]!] = cv;
      // Inertia about `at`, then shifted to the COM.
      const tr = C[0] + C[4] + C[8];
      const Jo = add3(diag3(tr, tr, tr), scale3(C, -1));
      const J = add3(Jo, scale3(steiner(m, local), -1));
      return { massKg: m, com: [s.at[0] + local[0], s.at[1] + local[1], s.at[2] + local[2]], inertia: J };
    }
  }
}

// -- principal axes (cyclic Jacobi, symmetric 3×3) ---------------------------------------

export function eigenSym3(I: Mat3): { values: V3; vectors: Mat3 } {
  const a = [...I];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[1]!) + Math.abs(a[2]!) + Math.abs(a[5]!);
    if (off < 1e-30 + 1e-15 * (Math.abs(a[0]!) + Math.abs(a[4]!) + Math.abs(a[8]!))) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p * 3 + q]!;
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (a[q * 3 + q]! - a[p * 3 + p]!) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p]!;
        const akq = a[k * 3 + q]!;
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k]!;
        const aqk = a[q * 3 + k]!;
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p]!;
        const vkq = v[k * 3 + q]!;
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  // Columns of v are eigenvectors; make it a proper rotation (det +1).
  const det =
    v[0]! * (v[4]! * v[8]! - v[5]! * v[7]!) -
    v[1]! * (v[3]! * v[8]! - v[5]! * v[6]!) +
    v[2]! * (v[3]! * v[7]! - v[4]! * v[6]!);
  if (det < 0) for (let k = 0; k < 3; k++) v[k * 3 + 2] = -v[k * 3 + 2]!;
  return { values: [a[0]!, a[4]!, a[8]!], vectors: v as Mat3 };
}

/** Quaternion [x, y, z, w] of a proper rotation matrix (row-major). */
export function quatFromMat3(m: Mat3): [number, number, number, number] {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const n = Math.hypot(...q);
  return q.map((x) => x / n) as [number, number, number, number];
}

/** Rotation part (row-major Mat3) of a column-major Mat4. */
export const rotationOf = (m: readonly number[]): Mat3 => [
  m[0]!,
  m[4]!,
  m[8]!,
  m[1]!,
  m[5]!,
  m[9]!,
  m[2]!,
  m[6]!,
  m[10]!,
];
