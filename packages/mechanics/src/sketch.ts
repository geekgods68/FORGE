import type { SketchConstraint, SketchEntity, SketchSolveResult } from '@forge/engineering-core';
import { maxAbs, normalEquations, norm, rankAndNullspace, solve } from './linalg';

/**
 * 2D sketch constraint solver (kept separate from assembly constraints).
 * Variables: every point's (x, y) and every circle's radius. Constraints become
 * residual equations solved by damped least squares; DOF = #variables − rank(J).
 * Supported: horizontal, vertical, coincident, parallel, perpendicular, equal, distance
 * (point–point or line length), radius, diameter, angle (signed, line → line), fixed.
 * Arcs carry an implicit equal-radius condition (|start−c| = |end−c|).
 */
export const SKETCH_TOLERANCE = 1e-9; // metres / radians

type Pt = Extract<SketchEntity, { kind: 'point' }>;
type Line = Extract<SketchEntity, { kind: 'line' }>;

export function solveSketch(
  entitiesIn: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
): SketchSolveResult {
  const entities = entitiesIn.map((e) => ({ ...e })) as SketchEntity[];
  const byId = new Map(entities.map((e) => [e.id, e]));
  const fail = (message: string): SketchSolveResult => ({
    ok: false,
    entities: entitiesIn as SketchEntity[],
    status: 'conflicting',
    dof: 0,
    message,
  });
  // Referential checks.
  for (const e of entities) {
    const need =
      e.kind === 'line'
        ? [e.p1, e.p2]
        : e.kind === 'circle'
          ? [e.center]
          : e.kind === 'arc'
            ? [e.center, e.start, e.end]
            : [];
    for (const id of need)
      if (byId.get(id)?.kind !== 'point')
        return fail(`Entity ${e.id} references "${id}", which is not a point.`);
    if (e.kind === 'line' && e.p1 === e.p2) return fail(`Line ${e.id} has the same start and end point.`);
  }
  const expect = (c: SketchConstraint, kinds: string[][]) => {
    if (
      !kinds.some((ks) => ks.length === c.refs.length && ks.every((k, i) => byId.get(c.refs[i]!)?.kind === k))
    )
      return `Constraint ${c.id} (${c.type}) needs ${kinds.map((k) => k.join(' + ')).join(' or ')}.`;
    if (
      (['distance', 'radius', 'diameter', 'angle'] as string[]).includes(c.type) &&
      (c.value === null || !Number.isFinite(c.value))
    )
      return `Constraint ${c.id} (${c.type}) needs a value.`;
    if ((c.type === 'distance' || c.type === 'radius' || c.type === 'diameter') && c.value! <= 0)
      return `Constraint ${c.id}: dimensions must be positive.`;
    if (c.type === 'fixed' && (c.value === null || c.value2 === null))
      return `Constraint ${c.id} (fixed) needs x and y.`;
    return null;
  };
  const SHAPES: Record<SketchConstraint['type'], string[][]> = {
    horizontal: [['line']],
    vertical: [['line']],
    coincident: [['point', 'point']],
    parallel: [['line', 'line']],
    perpendicular: [['line', 'line']],
    equal: [
      ['line', 'line'],
      ['circle', 'circle'],
    ],
    distance: [['point', 'point'], ['line']],
    radius: [['circle'], ['arc']],
    diameter: [['circle'], ['arc']],
    angle: [['line', 'line']],
    fixed: [['point']],
  };
  for (const c of constraints) {
    const p = expect(c, SHAPES[c.type]);
    if (p) return fail(p);
  }

  // Variables.
  type V = { e: SketchEntity; k: 'x' | 'y' | 'r' };
  const vars: V[] = [];
  for (const e of entities) {
    if (e.kind === 'point') vars.push({ e, k: 'x' }, { e, k: 'y' });
    if (e.kind === 'circle') vars.push({ e, k: 'r' });
  }
  const get = (v: V) => (v.e as unknown as Record<string, number>)[v.k]!;
  const set = (v: V, x: number) => void ((v.e as unknown as Record<string, number>)[v.k] = x);
  const read = () => vars.map(get);
  const write = (x: number[]) => vars.forEach((v, i) => set(v, x[i]!));
  const P = (id: string) => byId.get(id) as Pt;
  const L = (id: string) => byId.get(id) as Line;
  const dir = (l: Line) => [P(l.p2).x - P(l.p1).x, P(l.p2).y - P(l.p1).y] as const;
  const radius = (id: string) => {
    const e = byId.get(id)!;
    if (e.kind === 'circle') return e.r;
    const a = e as Extract<SketchEntity, { kind: 'arc' }>;
    return Math.hypot(P(a.start).x - P(a.center).x, P(a.start).y - P(a.center).y);
  };
  const residuals = () => {
    const r: number[] = [];
    for (const e of entities)
      if (e.kind === 'arc')
        r.push(
          Math.hypot(P(e.start).x - P(e.center).x, P(e.start).y - P(e.center).y) -
            Math.hypot(P(e.end).x - P(e.center).x, P(e.end).y - P(e.center).y),
        );
    for (const c of constraints) {
      const [a, b] = c.refs as [string, string];
      switch (c.type) {
        case 'horizontal':
          r.push(dir(L(a))[1]);
          break;
        case 'vertical':
          r.push(dir(L(a))[0]);
          break;
        case 'coincident':
          r.push(P(a).x - P(b).x, P(a).y - P(b).y);
          break;
        case 'parallel':
        case 'perpendicular': {
          const [ux, uy] = dir(L(a));
          const [vx, vy] = dir(L(b));
          const n = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
          r.push(c.type === 'parallel' ? (ux * vy - uy * vx) / n : (ux * vx + uy * vy) / n);
          break;
        }
        case 'equal':
          r.push(
            byId.get(a)!.kind === 'line'
              ? Math.hypot(...dir(L(a))) - Math.hypot(...dir(L(b)))
              : radius(a) - radius(b),
          );
          break;
        case 'distance':
          r.push(
            (c.refs.length === 2 ? Math.hypot(P(a).x - P(b).x, P(a).y - P(b).y) : Math.hypot(...dir(L(a)))) -
              c.value!,
          );
          break;
        case 'radius':
          r.push(radius(a) - c.value!);
          break;
        case 'diameter':
          r.push(2 * radius(a) - c.value!);
          break;
        case 'angle': {
          const [ux, uy] = dir(L(a));
          const [vx, vy] = dir(L(b));
          let d = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) - c.value!;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          r.push(d);
          break;
        }
        case 'fixed':
          r.push(P(a).x - c.value!, P(a).y - c.value2!);
          break;
      }
    }
    return r;
  };
  const jac = () => {
    const x0 = read();
    const m = residuals().length;
    const J = Array.from({ length: m }, () => Array<number>(vars.length).fill(0));
    const h = 1e-8;
    vars.forEach((v, j) => {
      set(v, x0[j]! + h);
      const rp = residuals();
      set(v, x0[j]! - h);
      const rm = residuals();
      set(v, x0[j]!);
      for (let i = 0; i < m; i++) J[i]![j] = (rp[i]! - rm[i]!) / (2 * h);
    });
    return J;
  };
  let r = residuals();
  let lambda = 1e-3;
  for (let it = 0; it < 200 && r.length && maxAbs(r) > SKETCH_TOLERANCE * 0.01; it++) {
    const x = read();
    const { A, g } = normalEquations(jac(), r, vars.length);
    for (let i = 0; i < vars.length; i++) A[i]![i]! += lambda * (A[i]![i]! + 1e-12);
    const step = solve(
      A,
      g.map((v) => -v),
    );
    if (!step) break;
    write(x.map((xi, i) => xi + step[i]!));
    if (entities.some((e) => e.kind === 'circle' && e.r <= 0)) {
      write(x);
      lambda *= 4;
      continue;
    }
    const rn = residuals();
    if (norm(rn) < norm(r)) {
      r = rn;
      lambda = Math.max(lambda / 3, 1e-14);
    } else {
      write(x);
      lambda *= 4;
      if (lambda > 1e12) break;
    }
  }
  const residual = r.length ? maxAbs(r) : 0;
  const { rank } = rankAndNullspace(jac(), vars.length);
  const dof = vars.length - rank;
  const equations = r.length;
  if (residual > SKETCH_TOLERANCE * 10)
    return {
      ok: false,
      entities: entitiesIn as SketchEntity[],
      status: 'conflicting',
      dof,
      message: `Conflicting sketch constraints (residual ${residual.toExponential(2)}): nothing was changed.`,
    };
  const status: SketchSolveResult['status'] =
    equations > rank ? 'over-constrained' : dof > 0 ? 'under-constrained' : 'fully-constrained';
  return { ok: true, entities, status, dof };
}

/** Rectangle helper: 4 points + 4 lines + horizontal/vertical constraints (ids prefixed). */
export function rectangleEntities(
  prefix: string,
  x: number,
  y: number,
  w: number,
  h: number,
): { entities: SketchEntity[]; constraints: SketchConstraint[] } {
  const p = (i: number, px: number, py: number): SketchEntity => ({
    id: `${prefix}-p${i}`,
    kind: 'point',
    x: px,
    y: py,
  });
  const l = (i: number, a: number, b: number): SketchEntity => ({
    id: `${prefix}-l${i}`,
    kind: 'line',
    p1: `${prefix}-p${a}`,
    p2: `${prefix}-p${b}`,
  });
  const c = (id: string, type: SketchConstraint['type'], refs: string[]): SketchConstraint => ({
    id: `${prefix}-${id}`,
    type,
    refs,
    value: null,
    value2: null,
  });
  return {
    entities: [
      p(0, x, y),
      p(1, x + w, y),
      p(2, x + w, y + h),
      p(3, x, y + h),
      l(0, 0, 1),
      l(1, 1, 2),
      l(2, 2, 3),
      l(3, 3, 0),
    ],
    constraints: [
      c('h0', 'horizontal', [`${prefix}-l0`]),
      c('h2', 'horizontal', [`${prefix}-l2`]),
      c('v1', 'vertical', [`${prefix}-l1`]),
      c('v3', 'vertical', [`${prefix}-l3`]),
    ],
  };
}
