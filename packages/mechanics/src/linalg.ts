/**
 * Small dense linear algebra for the solvers (n ≲ a few hundred unknowns).
 * Deterministic: no randomisation, fixed iteration orders.
 */
export type Vec = number[];
export type Matrix = number[][];

export const zeros = (r: number, c: number): Matrix =>
  Array.from({ length: r }, () => Array<number>(c).fill(0));
export const norm = (v: readonly number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
export const maxAbs = (v: readonly number[]) => v.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

/** JᵀJ and Jᵀr for an m×n Jacobian. */
export function normalEquations(J: Matrix, r: Vec, n: number): { A: Matrix; g: Vec } {
  const A = zeros(n, n);
  const g = Array<number>(n).fill(0);
  for (let i = 0; i < J.length; i++) {
    const row = J[i]!;
    for (let a = 0; a < n; a++) {
      const ra = row[a]!;
      if (ra === 0) continue;
      g[a]! += ra * r[i]!;
      for (let b = a; b < n; b++) A[a]![b]! += ra * row[b]!;
    }
  }
  for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a]![b] = A[b]![a]!;
  return { A, g };
}

/** Solve A x = b by Gaussian elimination with partial pivoting. Returns null if singular. */
export function solve(Ain: Matrix, bin: Vec): Vec | null {
  const n = bin.length;
  const A = Ain.map((r) => [...r]);
  const b = [...bin];
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(A[i]![k]!) > Math.abs(A[p]![k]!)) p = i;
    if (Math.abs(A[p]![k]!) < 1e-300) return null;
    [A[k], A[p]] = [A[p]!, A[k]!];
    [b[k], b[p]] = [b[p]!, b[k]!];
    for (let i = k + 1; i < n; i++) {
      const f = A[i]![k]! / A[k]![k]!;
      if (f === 0) continue;
      for (let j = k; j < n; j++) A[i]![j]! -= f * A[k]![j]!;
      b[i]! -= f * b[k]!;
    }
  }
  const x = Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let j = i + 1; j < n; j++) s -= A[i]![j]! * x[j]!;
    x[i] = s / A[i]![i]!;
  }
  return x;
}

/** Symmetric eigen-decomposition by cyclic Jacobi rotations: values + column eigenvectors. */
export function symmetricEigen(Ain: Matrix, maxSweeps = 100): { values: Vec; vectors: Matrix } {
  const n = Ain.length;
  const A = Ain.map((r) => [...r]);
  const V = zeros(n, n);
  for (let i = 0; i < n; i++) V[i]![i] = 1;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p]![q]! ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = A[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (A[q]![q]! - A[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k]![p]!;
          const akq = A[k]![q]!;
          A[k]![p] = c * akp - s * akq;
          A[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p]![k]!;
          const aqk = A[q]![k]!;
          A[p]![k] = c * apk - s * aqk;
          A[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k]![p]!;
          const vkq = V[k]![q]!;
          V[k]![p] = c * vkp - s * vkq;
          V[k]![q] = s * vkp + c * vkq;
        }
      }
  }
  return { values: A.map((r, i) => r[i]!), vectors: V };
}

/**
 * Numerical rank of J from the eigenvalues of JᵀJ (σ² = λ). Relative threshold on σ:
 * σ > tol·σ_max (tol = 1e-6) and absolute σ > 1e-9. Returns rank and null-space basis.
 */
export function rankAndNullspace(J: Matrix, n: number): { rank: number; nullspace: Vec[] } {
  if (n === 0) return { rank: 0, nullspace: [] };
  const { A } = normalEquations(J, Array<number>(J.length).fill(0), n);
  const { values, vectors } = symmetricEigen(A);
  const sigma = values.map((v) => Math.sqrt(Math.max(v, 0)));
  const smax = Math.max(...sigma, 0);
  const keep = sigma.map((s) => s > Math.max(1e-9, 1e-6 * smax));
  const nullspace: Vec[] = [];
  keep.forEach((k, j) => {
    if (!k) nullspace.push(vectors.map((row) => row[j]!));
  });
  return { rank: keep.filter(Boolean).length, nullspace };
}
