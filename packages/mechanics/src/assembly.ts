import { evaluate, getDefinition, type ComponentInterface } from '@forge/components';
import {
  compose,
  decompose,
  MATE_COORDINATES,
  type AssemblyConstraint,
  type AssemblyReport,
  type AssemblySolveResult,
  type FrameRef,
  type Mat4,
  type Mate,
  type NodeTransform,
  type RelationshipReport,
  type SceneGraph,
  type SceneNode,
} from '@forge/engineering-core';
import { maxAbs, normalEquations, norm, rankAndNullspace, solve, type Vec } from './linalg';
import { evaluatePart } from './part';
import {
  cross,
  defaultXRef,
  dot,
  frame,
  inv,
  len3,
  logRot,
  mul,
  origin,
  ROT_X_PI,
  rotVec,
  rotZ,
  sub,
  translation,
  zAxis,
  type V3,
} from './pose';

/**
 * Kinematic assembly solver (supported subset, documented in docs/CONSTRAINT_SOLVER.md).
 *
 * 1. Bodies = direct children of the assembly. Grounded bodies are roots; if none is
 *    grounded, the first related body is an IMPLICIT reference (reported).
 * 2. A breadth-first spanning tree over unsuppressed mates places every reachable body
 *    EXACTLY from its parent: pose(B) = pose(A) · F_A · J(q) · R_z(offset) · Flip · F_B⁻¹.
 * 3. Mates that close a loop and DRIVING constraints become residual equations, solved
 *    by damped least squares (Levenberg–Marquardt) over the non-held joint coordinates
 *    (and 6 pose parameters of each floating sub-tree root), with joint limits enforced
 *    by projection. Bodies unreachable from any root and in no relationship are left free.
 * 4. Mobility = (#unknowns) − rank(J) and redundancy = (#independent equations) − rank(J),
 *    from the numerical rank of the residual Jacobian at the solution (JᵀJ eigenvalues).
 *    Status: conflicting if max|residual| > 1e-7 after solving; else over-constrained if
 *    redundancy > 0; else under-constrained if mobility > 0; else fully constrained.
 *
 * This is geometric (kinematic) solving only: no masses, forces, inertia or dynamics.
 */
export const RESIDUAL_TOLERANCE = 1e-7; // metres / radians
const FD_STEP = 1e-7;
const MAX_ITERATIONS = 100;

type Body = SceneNode;
type RefResolver = (nodeId: string, ref: FrameRef) => Mat4 | string;

/** Equations each relationship contributes when used as a closure (nominal count). */
const CLOSURE_EQUATIONS: Record<Mate['type'], number> = {
  fixed: 6,
  revolute: 5,
  prismatic: 5,
  cylindrical: 4,
  ball: 3,
  planar: 3,
};
const CONSTRAINT_EQUATIONS: Record<AssemblyConstraint['type'], number> = {
  distance: 1,
  angle: 1,
  concentric: 4,
  coincident: 3,
  parallel: 2,
  perpendicular: 1,
};

/** Joint motion J(q) followed by the mate's fixed offset and alignment flip. */
export function mateMotion(m: Pick<Mate, 'type' | 'alignment' | 'offsetRad'>, q: readonly number[]): Mat4 {
  let J: Mat4;
  switch (m.type) {
    case 'fixed':
      J = translation(0, 0, 0);
      break;
    case 'revolute':
      J = rotZ(q[0]!);
      break;
    case 'prismatic':
      J = translation(0, 0, q[0]!);
      break;
    case 'cylindrical':
      J = mul(translation(0, 0, q[1]!), rotZ(q[0]!));
      break;
    case 'ball':
      J = rotVec(q);
      break;
    case 'planar':
      J = mul(translation(q[0]!, q[1]!, 0), rotZ(q[2]!));
      break;
  }
  return mul(J, rotZ(m.offsetRad), m.alignment === 'opposed' ? ROT_X_PI : translation(0, 0, 0));
}

/** Residual of a mate used as a closure, given both world frames (A then B·Flip⁻¹·R_z(−offset)). */
function closureResidual(m: Mate, FA: Mat4, FB: Mat4): number[] {
  // Relative transform from A's frame to B's frame with the fixed offset/flip removed.
  const R = mul(
    inv(FA),
    FB,
    inv(mul(rotZ(m.offsetRad), m.alignment === 'opposed' ? ROT_X_PI : translation(0, 0, 0))),
  );
  const t = origin(R);
  const z = zAxis(R);
  const axisErr = cross(z, [0, 0, 1]);
  switch (m.type) {
    case 'fixed':
      return [...t, ...logRot(R)];
    case 'revolute':
      return [...t, ...axisErr];
    case 'prismatic':
      return [t[0], t[1], ...logRot(R)];
    case 'cylindrical':
      return [t[0], t[1], ...axisErr];
    case 'ball':
      return [...t];
    case 'planar':
      return [t[2], ...axisErr];
  }
}

function constraintResidual(c: AssemblyConstraint, FA: Mat4, FB: Mat4): number[] {
  const pa = origin(FA);
  const pb = origin(FB);
  const za = zAxis(FA);
  const zb = zAxis(FB);
  switch (c.type) {
    case 'distance':
      return [len3(sub(pb, pa)) - (c.value ?? 0)];
    case 'angle':
      return [Math.acos(Math.max(-1, Math.min(1, dot(za, zb)))) - (c.value ?? 0)];
    case 'coincident':
      return sub(pb, pa);
    case 'parallel':
      return cross(za, zb);
    case 'perpendicular':
      return [dot(za, zb)];
    case 'concentric': {
      const d = sub(pb, pa);
      return [...cross(za, zb), ...cross(za, d)];
    }
  }
}

export function makeRefResolver(graph: SceneGraph): RefResolver {
  const cache = new Map<string, ComponentInterface[] | string>();
  const interfacesOf = (n: SceneNode): ComponentInterface[] | string => {
    const hit = cache.get(n.id);
    if (hit) return hit;
    let r: ComponentInterface[] | string;
    if (n.kind === 'component-instance' && n.component) {
      const def = getDefinition(n.definitionId);
      r = def
        ? evaluate(def, n.component.parameters, n.component.materialId).interfaces
        : `"${n.name}" references a component definition that is not in this library.`;
    } else if (n.kind === 'part') {
      const p = evaluatePart(n.features);
      r = p.ok ? p.geometry.interfaces : `"${n.name}": ${p.message}`;
    } else r = `"${n.name}" (${n.kind}) declares no interfaces; use a frame reference.`;
    cache.set(n.id, r);
    return r;
  };
  return (nodeId, ref) => {
    const n = graph.nodes[nodeId];
    if (!n) return `Body "${nodeId}" does not exist.`;
    if (ref.kind === 'frame') return frame(ref.origin, ref.axis, ref.xRef);
    const list = interfacesOf(n);
    if (typeof list === 'string') return list;
    const i = list.find((x) => x.id === ref.interfaceId);
    if (!i)
      return `"${n.name}" has no interface "${ref.interfaceId}" (it may have been removed by a parameter change).`;
    return frame(i.position, i.direction, defaultXRef(i.direction));
  };
}

const poseOf = (t: NodeTransform): Mat4 => compose(t);
function toTransform(m: Mat4): NodeTransform {
  const { trs } = decompose(m);
  const q = trs.rotation;
  const n = Math.hypot(...q);
  return {
    position: trs.position.map((v) => (Math.abs(v) < 1e-15 ? 0 : v)) as V3,
    rotation: q.map((v) => v / n) as NodeTransform['rotation'],
    scale: [1, 1, 1],
  };
}

export function solveAssembly(
  graph: SceneGraph,
  assemblyId: string,
  held: readonly string[] = [],
): AssemblySolveResult {
  const asm = graph.nodes[assemblyId];
  if (!asm || asm.kind !== 'assembly')
    return { ok: false, code: 'invalid-reference', message: `"${assemblyId}" is not an assembly.` };
  const mech = asm.mechanical;
  const bodies = asm.childIds.map((id) => graph.nodes[id]!).filter(Boolean) as Body[];
  const bodyIds = new Set(bodies.map((b) => b.id));
  const mates = mech.mates.filter((m) => !m.suppressed);
  const refFrame = makeRefResolver(graph);
  const messages: string[] = [];

  // Resolve every reference frame once (body-local).
  const local = new Map<string, Mat4>();
  const refKey = (nodeId: string, ref: FrameRef) => `${nodeId}|${JSON.stringify(ref)}`;
  for (const r of [...mates, ...mech.constraints])
    for (const end of [r.a, r.b]) {
      if (!bodyIds.has(end.nodeId))
        return {
          ok: false,
          code: 'invalid-reference',
          message: `${r.name}: "${end.nodeId}" is not a body of this assembly.`,
        };
      const f = refFrame(end.nodeId, end.ref);
      if (typeof f === 'string') return { ok: false, code: 'invalid-reference', message: `${r.name}: ${f}` };
      local.set(refKey(end.nodeId, end.ref), f);
    }

  // Spanning forest.
  const related = new Set<string>();
  for (const r of [...mates, ...mech.constraints]) related.add(r.a.nodeId).add(r.b.nodeId);
  const grounded = mech.grounded.filter((g) => bodyIds.has(g));
  const roots: { id: string; floating: boolean }[] = grounded.map((id) => ({ id, floating: false }));
  const implicitGround = grounded.length === 0 && related.size > 0;
  const parentEdge = new Map<string, { mate: Mate; forward: boolean }>(); // child → mate (forward: child is b)
  const order: string[] = [];
  const visited = new Set<string>();
  const treeMates = new Set<string>();
  const bfs = (start: string) => {
    visited.add(start);
    order.push(start);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const m of mates) {
        if (treeMates.has(m.id)) continue;
        const other = m.a.nodeId === cur ? m.b.nodeId : m.b.nodeId === cur ? m.a.nodeId : null;
        if (!other || visited.has(other)) continue;
        visited.add(other);
        treeMates.add(m.id);
        parentEdge.set(other, { mate: m, forward: m.a.nodeId === cur });
        order.push(other);
        queue.push(other);
      }
    }
  };
  for (const r of roots) bfs(r.id);
  for (const b of bodies) {
    if (visited.has(b.id) || !related.has(b.id)) continue;
    // First related body becomes the reference when nothing is grounded; other islands float.
    roots.push({ id: b.id, floating: !(implicitGround && roots.length === 0) });
    bfs(b.id);
  }
  const freeBodies = bodies.filter((b) => !related.has(b.id) && !grounded.includes(b.id)).map((b) => b.id);

  // Unknowns: non-held tree coordinates + 6 per floating root.
  type Var = { kind: 'coord'; mate: Mate; k: number } | { kind: 'float'; root: string; k: number };
  const heldSet = new Set(held);
  const allVars: Var[] = [];
  for (const id of order) {
    const e = parentEdge.get(id);
    if (e) MATE_COORDINATES[e.mate.type].forEach((_, k) => allVars.push({ kind: 'coord', mate: e.mate, k }));
  }
  for (const r of roots)
    if (r.floating) for (let k = 0; k < 6; k++) allVars.push({ kind: 'float', root: r.id, k });
  const coords = new Map(mates.map((m) => [m.id, [...m.coordinates]]));
  const floatParams = new Map(roots.filter((r) => r.floating).map((r) => [r.id, [0, 0, 0, 0, 0, 0]]));
  const base = new Map(bodies.map((b) => [b.id, poseOf(b.transform)]));

  const apply = (x: Vec, vars: Var[]) =>
    vars.forEach((v, i) => {
      if (v.kind === 'coord') coords.get(v.mate.id)![v.k] = x[i]!;
      else floatParams.get(v.root)![v.k] = x[i]!;
    });
  const read = (vars: Var[]) =>
    vars.map((v) => (v.kind === 'coord' ? coords.get(v.mate.id)![v.k]! : floatParams.get(v.root)![v.k]!));
  const clamp = (x: Vec, vars: Var[]) =>
    x.map((xi, i) => {
      const v = vars[i]!;
      if (v.kind !== 'coord') return xi;
      const l = v.mate.limits[v.k];
      return l ? Math.min(l.max, Math.max(l.min, xi)) : xi;
    });

  const poses = () => {
    const P = new Map<string, Mat4>();
    for (const r of roots) {
      const f = floatParams.get(r.id);
      P.set(
        r.id,
        f ? mul(base.get(r.id)!, translation(f[0]!, f[1]!, f[2]!), rotVec(f.slice(3))) : base.get(r.id)!,
      );
    }
    for (const id of order) {
      const e = parentEdge.get(id);
      if (!e) continue;
      const m = e.mate;
      const M = mateMotion(m, coords.get(m.id)!);
      const FA = local.get(refKey(m.a.nodeId, m.a.ref))!;
      const FB = local.get(refKey(m.b.nodeId, m.b.ref))!;
      if (e.forward) P.set(m.b.nodeId, mul(P.get(m.a.nodeId)!, FA, M, inv(FB)));
      else P.set(m.a.nodeId, mul(P.get(m.b.nodeId)!, FB, inv(M), inv(FA)));
    }
    for (const b of bodies) if (!P.has(b.id)) P.set(b.id, base.get(b.id)!);
    return P;
  };

  const closures = mates.filter((m) => !treeMates.has(m.id));
  const driving = mech.constraints.filter((c) => c.driving);
  const worldFrame = (P: Map<string, Mat4>, nodeId: string, ref: FrameRef) =>
    mul(P.get(nodeId)!, local.get(refKey(nodeId, ref))!);
  const residuals = (P: Map<string, Mat4>) => {
    const out: number[] = [];
    for (const m of closures)
      out.push(...closureResidual(m, worldFrame(P, m.a.nodeId, m.a.ref), worldFrame(P, m.b.nodeId, m.b.ref)));
    for (const c of driving)
      out.push(
        ...constraintResidual(c, worldFrame(P, c.a.nodeId, c.a.ref), worldFrame(P, c.b.nodeId, c.b.ref)),
      );
    return out;
  };
  const jacobian = (vars: Var[]) => {
    const x0 = read(vars);
    const J: number[][] = [];
    const m = residuals(poses()).length;
    for (let i = 0; i < m; i++) J.push(Array<number>(vars.length).fill(0));
    vars.forEach((_, j) => {
      const xp = [...x0];
      const xm = [...x0];
      xp[j]! += FD_STEP;
      xm[j]! -= FD_STEP;
      apply(xp, vars);
      const rp = residuals(poses());
      apply(xm, vars);
      const rm = residuals(poses());
      for (let i = 0; i < m; i++) J[i]![j] = (rp[i]! - rm[i]!) / (2 * FD_STEP);
    });
    apply(x0, vars);
    return J;
  };

  // Levenberg–Marquardt over the non-held unknowns.
  const vars = allVars.filter((v) => v.kind !== 'coord' || !heldSet.has(v.mate.id));
  let iterations = 0;
  let r = residuals(poses());
  if (vars.length > 0 && r.length > 0 && maxAbs(r) > RESIDUAL_TOLERANCE * 0.01) {
    let lambda = 1e-3;
    let x = read(vars);
    for (; iterations < MAX_ITERATIONS && maxAbs(r) > RESIDUAL_TOLERANCE * 0.01; iterations++) {
      const J = jacobian(vars);
      const { A, g } = normalEquations(J, r, vars.length);
      for (let i = 0; i < vars.length; i++) A[i]![i]! += lambda * (A[i]![i]! + 1e-9);
      const step = solve(
        A,
        g.map((v) => -v),
      );
      if (!step) break;
      const xn = clamp(
        x.map((xi, i) => xi + step[i]!),
        vars,
      );
      apply(xn, vars);
      const rn = residuals(poses());
      if (norm(rn) < norm(r)) {
        x = xn;
        r = rn;
        lambda = Math.max(lambda / 3, 1e-12);
      } else {
        apply(x, vars);
        lambda *= 4;
        if (lambda > 1e10) break;
      }
      if (norm(step) < 1e-15) break;
    }
  }
  const P = poses();
  const maxResidual = r.length ? maxAbs(r) : 0;

  // DOF analysis over ALL unknowns (held coordinates are still mechanically free).
  const Jall = jacobian(allVars);
  const { rank, nullspace } = rankAndNullspace(Jall, allVars.length);
  const mobility = allVars.length - rank;
  const nominal =
    closures.reduce((s, m) => s + CLOSURE_EQUATIONS[m.type], 0) +
    driving.reduce((s, c) => s + CONSTRAINT_EQUATIONS[c.type], 0);
  const redundancy = Math.max(0, nominal - rank);
  const freeIndex = (v: Var) => {
    const j = allVars.indexOf(v);
    return nullspace.some((ns) => Math.abs(ns[j]!) > 1e-4);
  };

  const relationships: RelationshipReport[] = [
    ...mates.map((m): RelationshipReport => {
      const inTree = treeMates.has(m.id);
      const res = inTree
        ? 0
        : maxAbs(closureResidual(m, worldFrame(P, m.a.nodeId, m.a.ref), worldFrame(P, m.b.nodeId, m.b.ref)));
      return {
        id: m.id,
        kind: 'mate',
        type: m.type,
        jointDof: 6 - CLOSURE_EQUATIONS[m.type],
        role: inTree ? 'tree' : 'closure',
        residual: res,
        satisfied: res <= RESIDUAL_TOLERANCE,
        freeCoordinates: MATE_COORDINATES[m.type].map((_, k) => {
          const v = allVars.find((x) => x.kind === 'coord' && x.mate.id === m.id && x.k === k);
          return v ? freeIndex(v) : false;
        }),
      };
    }),
    ...mech.constraints.map((c): RelationshipReport => {
      const res = maxAbs(
        constraintResidual(c, worldFrame(P, c.a.nodeId, c.a.ref), worldFrame(P, c.b.nodeId, c.b.ref)),
      );
      return {
        id: c.id,
        kind: 'constraint',
        type: c.type,
        jointDof: null,
        role: c.driving ? 'driving' : 'check',
        residual: res,
        satisfied: res <= RESIDUAL_TOLERANCE,
        freeCoordinates: [],
      };
    }),
  ];
  const conflicting = maxResidual > RESIDUAL_TOLERANCE;
  if (conflicting)
    for (const rel of relationships)
      if (!rel.satisfied && rel.role !== 'check')
        messages.push(
          `${rel.type} ${rel.id} cannot be satisfied (residual ${rel.residual.toExponential(2)}).`,
        );
  if (implicitGround)
    messages.push('No body is grounded: the first related body is used as the fixed reference.');
  const status: AssemblyReport['status'] =
    bodies.length === 0
      ? 'empty'
      : conflicting
        ? 'conflicting'
        : redundancy > 0
          ? 'over-constrained'
          : mobility > 0 || freeBodies.length > 0
            ? 'under-constrained'
            : 'fully-constrained';
  const report: AssemblyReport = {
    assemblyId,
    status,
    mobility: mobility + 6 * freeBodies.length,
    redundancy,
    maxResidual,
    grounded,
    implicitGround,
    freeBodies,
    relationships,
    messages,
    iterations,
  };
  if (conflicting)
    return {
      ok: false,
      code: 'constraint-conflict',
      message: `The relationships cannot all be satisfied: ${messages.filter((x) => !x.startsWith('No body')).join(' ')}`,
      report,
    };

  const transforms: Record<string, NodeTransform> = {};
  for (const b of bodies) {
    if (!related.has(b.id) || grounded.includes(b.id) || (implicitGround && roots[0]?.id === b.id)) continue;
    transforms[b.id] = toTransform(P.get(b.id)!);
  }
  const coordinates: Record<string, number[]> = {};
  for (const m of mates) coordinates[m.id] = coords.get(m.id)!.map((v) => (Math.abs(v) < 1e-15 ? 0 : v));
  return { ok: true, transforms, coordinates, report };
}
