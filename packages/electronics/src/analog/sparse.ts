/**
 * Sparse LU factorisation for MNA systems.
 *
 * Right-looking Gaussian elimination on row maps with MARKOWITZ pivot selection (minimise
 * (r−1)(c−1) fill-in) subject to THRESHOLD partial pivoting (|pivot| ≥ u · max |column|,
 * u = 0.1) — the classic strategy of sparse circuit solvers. MNA matrices need pivoting:
 * voltage-source branch rows have zero diagonals.
 *
 * The factors are kept, so a matrix that does not change (a linear circuit at a fixed
 * timestep) is factored once and re-solved for every new right-hand side.
 */
export class SparseMatrix {
  readonly rows: Map<number, number>[];
  constructor(readonly n: number) {
    this.rows = Array.from({ length: n }, () => new Map<number, number>());
  }
  add(i: number, j: number, v: number): void {
    if (i < 0 || j < 0 || v === 0) return;
    const r = this.rows[i]!;
    r.set(j, (r.get(j) ?? 0) + v);
  }
  get(i: number, j: number): number {
    return this.rows[i]?.get(j) ?? 0;
  }
  clone(): SparseMatrix {
    const m = new SparseMatrix(this.n);
    this.rows.forEach((r, i) => r.forEach((v, j) => m.rows[i]!.set(j, v)));
    return m;
  }
  get nnz(): number {
    return this.rows.reduce((s, r) => s + r.size, 0);
  }
  /** y = A·x */
  multiply(x: Float64Array): Float64Array {
    const y = new Float64Array(this.n);
    this.rows.forEach((r, i) => {
      let s = 0;
      r.forEach((v, j) => (s += v * x[j]!));
      y[i] = s;
    });
    return y;
  }
}

export interface LUFactors {
  n: number;
  /** Elimination operations in order: row r −= f · row p. */
  ops: Float64Array; // triples (r, p, f) packed
  opCount: number;
  pivRow: Int32Array;
  pivCol: Int32Array;
  /** U rows (by pivot step): column indices and values, including the pivot. */
  uCols: Int32Array[];
  uVals: Float64Array[];
  fill: number;
}

export type FactorResult = { ok: true; lu: LUFactors } | { ok: false; singularColumn: number; step: number };

const PIVOT_THRESHOLD = 0.1;

export function factor(A: SparseMatrix, absTiny = 1e-300): FactorResult {
  const n = A.n;
  const rows = A.rows.map((r) => new Map(r));
  const cols: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  let scale = 0;
  rows.forEach((r, i) =>
    r.forEach((v, j) => {
      if (v !== 0) cols[j]!.add(i);
      scale = Math.max(scale, Math.abs(v));
    }),
  );
  const tiny = Math.max(absTiny, scale * 1e-14);
  const rowActive = new Uint8Array(n).fill(1);
  const colActive = new Uint8Array(n).fill(1);
  const ops: number[] = [];
  const pivRow = new Int32Array(n);
  const pivCol = new Int32Array(n);
  const uCols: Int32Array[] = [];
  const uVals: Float64Array[] = [];
  const nnz0 = A.nnz;
  let nnz = nnz0;

  for (let k = 0; k < n; k++) {
    // Markowitz search over active columns (ties broken by magnitude).
    let best = -1;
    let bestRow = -1;
    let bestCost = Infinity;
    let bestMag = 0;
    let anyCol = -1;
    for (let c = 0; c < n; c++) {
      if (!colActive[c]) continue;
      if (anyCol < 0) anyCol = c;
      const cs = cols[c]!;
      if (cs.size === 0) continue;
      let colMax = 0;
      for (const r of cs) colMax = Math.max(colMax, Math.abs(rows[r]!.get(c) ?? 0));
      if (colMax <= tiny) continue;
      const cc = cs.size - 1;
      for (const r of cs) {
        const v = Math.abs(rows[r]!.get(c) ?? 0);
        if (v < PIVOT_THRESHOLD * colMax || v <= tiny) continue;
        const cost = (rows[r]!.size - 1) * cc;
        if (cost < bestCost || (cost === bestCost && v > bestMag)) {
          best = c;
          bestRow = r;
          bestCost = cost;
          bestMag = v;
        }
      }
      if (bestCost === 0) break;
    }
    if (best < 0) return { ok: false, singularColumn: anyCol, step: k };
    const pr = bestRow;
    const pc = best;
    const prow = rows[pr]!;
    const pv = prow.get(pc)!;
    // Eliminate column pc from the other active rows.
    for (const r of [...cols[pc]!]) {
      if (r === pr) continue;
      const row = rows[r]!;
      const f = row.get(pc)! / pv;
      row.delete(pc);
      nnz--;
      for (const [c, v] of prow) {
        if (c === pc) continue;
        const old = row.get(c);
        if (old === undefined) {
          row.set(c, -f * v);
          cols[c]!.add(r);
          nnz++;
        } else row.set(c, old - f * v);
      }
      ops.push(r, pr, f);
    }
    // Record U row and retire the pivot row/column.
    const ucs = new Int32Array(prow.size);
    const uvs = new Float64Array(prow.size);
    let i = 0;
    for (const [c, v] of prow) {
      ucs[i] = c;
      uvs[i] = v;
      i++;
      cols[c]!.delete(pr);
    }
    cols[pc]!.clear();
    uCols.push(ucs);
    uVals.push(uvs);
    pivRow[k] = pr;
    pivCol[k] = pc;
    rowActive[pr] = 0;
    colActive[pc] = 0;
  }
  return {
    ok: true,
    lu: {
      n,
      ops: Float64Array.from(ops),
      opCount: ops.length / 3,
      pivRow,
      pivCol,
      uCols,
      uVals,
      fill: Math.max(0, nnz - nnz0),
    },
  };
}

/** Solve A·x = b with stored factors. */
export function solveLU(lu: LUFactors, b: Float64Array): Float64Array {
  const y = Float64Array.from(b);
  const ops = lu.ops;
  for (let i = 0; i < lu.opCount; i++) {
    const r = ops[3 * i]!;
    const p = ops[3 * i + 1]!;
    y[r] = y[r]! - ops[3 * i + 2]! * y[p]!;
  }
  const x = new Float64Array(lu.n);
  for (let k = lu.n - 1; k >= 0; k--) {
    const pr = lu.pivRow[k]!;
    const pc = lu.pivCol[k]!;
    const cs = lu.uCols[k]!;
    const vs = lu.uVals[k]!;
    let s = y[pr]!;
    let diag = 0;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i]!;
      if (c === pc) diag = vs[i]!;
      else s -= vs[i]! * x[c]!;
    }
    x[pc] = s / diag;
  }
  return x;
}
