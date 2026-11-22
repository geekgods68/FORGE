import { describe, expect, it } from 'vitest';
import { factor, solveLU, SparseMatrix } from '../analog/sparse';
import { ANALOG_VALIDATION_CASES } from '../validation/analog';

describe('sparse LU', () => {
  it('solves random sparse systems with zero diagonals (MNA-like) to machine precision', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (const n of [5, 40, 300]) {
      const A = new SparseMatrix(n);
      for (let i = 0; i < n; i++) {
        if (i % 7 !== 3) A.add(i, i, 4 + rnd()); // some zero diagonals
        A.add(i, (i + 1) % n, rnd());
        A.add((i + 1) % n, i, rnd());
        A.add(i, (i * 13 + 5) % n, rnd());
      }
      const x = Float64Array.from({ length: n }, () => rnd());
      const b = A.multiply(x);
      const f = factor(A);
      expect(f.ok).toBe(true);
      if (!f.ok) return;
      const y = solveLU(f.lu, b);
      const err = Math.max(...y.map((v, i) => Math.abs(v - x[i]!)));
      expect(err).toBeLessThan(1e-9);
    }
  });

  it('reports a singular matrix with the undetermined column', () => {
    const A = new SparseMatrix(3);
    A.add(0, 0, 1);
    A.add(1, 1, 1);
    A.add(1, 2, 1); // column 2 and row 2 empty
    const f = factor(A);
    expect(f.ok).toBe(false);
  });
});

describe('analog numerical validation', () => {
  for (const c of ANALOG_VALIDATION_CASES)
    it(c.name, () => {
      const r = c();
      const failed = r.metrics
        .filter((m) => !m.pass)
        .map(
          (m) =>
            `${m.name}: measured ${m.measured}, reference ${m.reference}, error ${m.error} > ${m.tolerance}`,
        );
      expect(failed).toEqual([]);
      expect(r.pass).toBe(true);
    });
});
