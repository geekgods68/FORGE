import { convertMate, drivingRelations } from '../mechanics';
import { identityNodeTransform } from '../project/create';
import { descendantsOf, isEffectivelyLocked, localTransformFor, worldMatrix } from '../scene/graph';
import {
  MATE_COORDINATES,
  NodeTransformSchema,
  type AssemblyConstraint,
  type Feature,
  type Mate,
  type Mechanical,
  type NodeTransform,
  type Profile,
  type SceneNode,
} from '../scene/schemas';
import { CommandError, type GraphTransaction } from '../scene/transaction';
import { quatNormalize } from '../transform';
import type { HandlerContext } from './handlers';
import type { MechanicalCommandType, PayloadOf } from './schemas';

/**
 * Phase 4 handlers: assemblies (hierarchy + mechanical relationships), joints, sketches,
 * feature-based parts and imported-model placement. Every command that changes a
 * relationship RE-SOLVES the assembly inside the same transaction and writes the
 * solver's body transforms, so the result is atomic and undoable; a conflicting or
 * unsupported request is rejected and nothing changes.
 */
type AssemblyNode = Extract<SceneNode, { kind: 'assembly' }>;
type SketchNode = Extract<SceneNode, { kind: 'sketch' }>;
type PartNode = Extract<SceneNode, { kind: 'part' }>;
type MHandler<K extends MechanicalCommandType> = (
  tx: GraphTransaction,
  payload: PayloadOf<K>,
  ctx: HandlerContext,
) => string[];

const BODY_KINDS = new Set([
  'component-instance',
  'part',
  'model-instance',
  'primitive',
  'assembly',
  'group',
]);

function checkTransform(t: NodeTransform): NodeTransform {
  const r = NodeTransformSchema.safeParse({ ...t, rotation: quatNormalize(t.rotation) });
  if (!r.success)
    throw new CommandError('invalid-transform', r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}

export function getAssembly(tx: GraphTransaction, id: string): AssemblyNode {
  const n = tx.get(id);
  if (n.kind !== 'assembly') throw new CommandError('invalid-operation', `"${n.name}" is not an assembly.`);
  return n;
}

function assertAssemblyEditable(tx: GraphTransaction, a: AssemblyNode) {
  if (isEffectivelyLocked(tx.graph, a.id))
    throw new CommandError('locked', `Assembly "${a.name}" is locked.`);
}

/** Relationships of `assembly` that reference `nodeId`. */
export function relationsOf(a: AssemblyNode, nodeId: string): (Mate | AssemblyConstraint)[] {
  return [...a.mechanical.mates, ...a.mechanical.constraints].filter(
    (r) => r.a.nodeId === nodeId || r.b.nodeId === nodeId,
  );
}

/** Is `nodeId` a body whose placement is driven by its parent assembly's relationships? */
export function isSolverDriven(tx: GraphTransaction, nodeId: string): boolean {
  const n = tx.find(nodeId);
  const parent = n?.parentId ? tx.find(n.parentId) : undefined;
  if (!n || parent?.kind !== 'assembly') return false;
  if (parent.mechanical.grounded.includes(nodeId)) return false;
  return drivingRelations(parent.mechanical).some((r) => r.a.nodeId === nodeId || r.b.nodeId === nodeId);
}

/**
 * Re-solve an assembly and write the result (body transforms + updated joint
 * coordinates). Throws CommandError on conflict/unsupported so the transaction aborts.
 */
export function resolveAssembly(
  tx: GraphTransaction,
  ctx: HandlerContext,
  assemblyId: string,
  held: string[] = [],
): void {
  const a = getAssembly(tx, assemblyId);
  const m = a.mechanical;
  if (m.mates.length === 0 && m.constraints.length === 0) return;
  if (!ctx.mechanics)
    throw new CommandError('unsupported', 'No mechanical solver is available to this engine.');
  const r = ctx.mechanics.solveAssembly(tx.graph, assemblyId, held);
  if (!r.ok)
    throw new CommandError(
      r.code === 'constraint-conflict'
        ? 'constraint-conflict'
        : r.code === 'unsupported'
          ? 'unsupported'
          : 'invalid-operation',
      r.message,
    );
  for (const [id, t] of Object.entries(r.transforms)) {
    const n = tx.get(id);
    const next = checkTransform(t);
    if (JSON.stringify(next) !== JSON.stringify(n.transform)) tx.put({ ...n, transform: next });
  }
  const cur = getAssembly(tx, assemblyId);
  const mates = cur.mechanical.mates.map((mt) =>
    r.coordinates[mt.id] ? { ...mt, coordinates: r.coordinates[mt.id]! } : mt,
  );
  if (JSON.stringify(mates) !== JSON.stringify(cur.mechanical.mates))
    tx.put({ ...cur, mechanical: { ...cur.mechanical, mates } });
}

/** Re-solve the assembly that owns `nodeId`, if any (after its geometry/parameters changed). */
export function resolveOwner(tx: GraphTransaction, ctx: HandlerContext, nodeId: string) {
  const n = tx.find(nodeId);
  const parent = n?.parentId ? tx.find(n.parentId) : undefined;
  if (parent?.kind === 'assembly' && relationsOf(parent, nodeId).length > 0)
    resolveAssembly(tx, ctx, parent.id);
}

function putMechanical(tx: GraphTransaction, a: AssemblyNode, mechanical: Mechanical) {
  tx.put({ ...getAssembly(tx, a.id), mechanical });
}

function assertBody(tx: GraphTransaction, a: AssemblyNode, nodeId: string) {
  const n = tx.find(nodeId);
  if (!n) throw new CommandError('not-found', `Node "${nodeId}" does not exist.`);
  if (n.parentId !== a.id || !BODY_KINDS.has(n.kind))
    throw new CommandError(
      'invalid-operation',
      `"${n.name}" is not a body directly inside assembly "${a.name}". Insert it first.`,
    );
  if (n.transform.scale.some((v) => Math.abs(v - 1) > 1e-12))
    throw new CommandError('unsupported', `"${n.name}" is scaled; mates require unit-scale bodies.`);
}

function reparentKeepWorld(tx: GraphTransaction, nodeId: string, parentId: string) {
  const node = tx.get(nodeId);
  const r = localTransformFor(tx.graph, worldMatrix(tx.graph, nodeId), parentId);
  if (!r.ok) throw new CommandError('unrepresentable-transform', r.reason);
  const old = tx.get(node.parentId!);
  tx.put({ ...old, childIds: old.childIds.filter((c) => c !== nodeId) });
  tx.put({ ...tx.get(nodeId), parentId, transform: checkTransform(r.transform) });
  const p = tx.get(parentId);
  tx.put({ ...p, childIds: [...p.childIds, nodeId] });
}

// ----------------------------------------------------------------- sketches & parts

function sketchOf(tx: GraphTransaction, id: string): SketchNode {
  const n = tx.get(id);
  if (n.kind !== 'sketch') throw new CommandError('invalid-operation', `"${n.name}" is not a sketch.`);
  if (isEffectivelyLocked(tx.graph, id)) throw new CommandError('locked', `"${n.name}" is locked.`);
  return n;
}
function partOf(tx: GraphTransaction, id: string): PartNode {
  const n = tx.get(id);
  if (n.kind !== 'part') throw new CommandError('invalid-operation', `"${n.name}" is not a parametric part.`);
  if (isEffectivelyLocked(tx.graph, id)) throw new CommandError('locked', `"${n.name}" is locked.`);
  return n;
}

function solveSketchInto(
  tx: GraphTransaction,
  ctx: HandlerContext,
  s: SketchNode,
  next: Pick<SketchNode, 'entities' | 'constraints'>,
) {
  if (!ctx.mechanics) throw new CommandError('unsupported', 'No sketch solver is available to this engine.');
  const r = ctx.mechanics.solveSketch(next.entities, next.constraints);
  if (!r.ok || r.status === 'conflicting')
    throw new CommandError(
      'constraint-conflict',
      r.message ?? 'The sketch constraints conflict; nothing was changed.',
    );
  tx.put({ ...s, entities: r.entities, constraints: next.constraints });
}

/** Closed outer loop of a sketch → profile (circles and closed line loops; first loop wins). */
export function sketchProfile(s: SketchNode): Profile | null {
  const pts = new Map(
    s.entities
      .filter((e) => e.kind === 'point')
      .map((e) => [e.id, e as Extract<typeof e, { kind: 'point' }>]),
  );
  const circle = s.entities.find((e) => e.kind === 'circle');
  const lines = s.entities.filter((e) => e.kind === 'line') as Extract<
    SketchNode['entities'][number],
    { kind: 'line' }
  >[];
  if (lines.length >= 3) {
    // Walk the loop from the first line.
    const order: string[] = [lines[0]!.p1, lines[0]!.p2];
    const used = new Set([lines[0]!.id]);
    while (order.length <= lines.length) {
      const last = order.at(-1)!;
      const next = lines.find((l) => !used.has(l.id) && (l.p1 === last || l.p2 === last));
      if (!next) break;
      used.add(next.id);
      order.push(next.p1 === last ? next.p2 : next.p1);
    }
    if (order.at(-1) === order[0] && used.size === lines.length) {
      const outer = order.slice(0, -1).map((id) => [pts.get(id)!.x, pts.get(id)!.y] as [number, number]);
      return { outer, holes: [] };
    }
  }
  if (circle && circle.kind === 'circle') {
    const c = pts.get(circle.center)!;
    const outer = Array.from(
      { length: 48 },
      (_, i) =>
        [
          c.x + circle.r * Math.cos((2 * Math.PI * i) / 48),
          c.y + circle.r * Math.sin((2 * Math.PI * i) / 48),
        ] as [number, number],
    );
    return { outer, holes: [] };
  }
  return null;
}

function addFeature(tx: GraphTransaction, ctx: HandlerContext, partId: string, f: Feature): string[] {
  const p = partOf(tx, partId);
  if (p.features.some((x) => x.id === f.id))
    throw new CommandError('duplicate-id', `Feature id "${f.id}" already exists in "${p.name}".`);
  const features = [...p.features, f];
  checkPart(ctx, features);
  tx.put({ ...p, features });
  resolveOwner(tx, ctx, partId);
  return [partId];
}
function checkPart(ctx: HandlerContext, features: Feature[]) {
  if (!ctx.mechanics)
    throw new CommandError('unsupported', 'No geometry kernel is available to this engine.');
  const c = ctx.mechanics.checkPart(features);
  if (!c.ok)
    throw new CommandError(
      'invalid-geometry',
      c.message ?? 'Invalid geometry; the previous valid state was kept.',
    );
}

/** distance ≥ 0 (m), 0 ≤ angle ≤ π (rad); value-less types take no value. */
function checkConstraintValue(type: AssemblyConstraint['type'], value: number | null | undefined) {
  const needsValue = type === 'distance' || type === 'angle';
  if (needsValue && (value === undefined || value === null))
    throw new CommandError('invalid-command', `A ${type} constraint needs a value.`);
  if (type === 'distance' && value! < 0)
    throw new CommandError('invalid-command', 'A distance cannot be negative.');
  if (type === 'angle' && (value! < 0 || value! > Math.PI + 1e-12))
    throw new CommandError('invalid-command', 'An angle constraint must be between 0° and 180°.');
}

// ----------------------------------------------------------------- handlers

export const MECHANICAL_HANDLERS: { [K in MechanicalCommandType]: MHandler<K> } = {
  'assembly.create'(tx, { id: givenId, name, parentId, transform, nodeIds }, ctx) {
    const parent = parentId ?? (nodeIds[0] ? tx.get(nodeIds[0]).parentId! : tx.rootId);
    tx.get(parent);
    if (isEffectivelyLocked(tx.graph, parent))
      throw new CommandError('locked', 'The target parent is locked.');
    const id = givenId ?? ctx.newId();
    if (tx.find(id)) throw new CommandError('duplicate-id', `A node with id "${id}" already exists.`);
    const node: AssemblyNode = {
      id,
      kind: 'assembly',
      name: name ?? 'Assembly',
      parentId: parent,
      childIds: [],
      transform: checkTransform({ ...identityNodeTransform(), ...transform }),
      visible: true,
      locked: false,
      metadata: {},
      mechanical: { grounded: [], mates: [], constraints: [] },
    };
    tx.put(node);
    const p = tx.get(parent);
    tx.put({ ...p, childIds: [...p.childIds, id] });
    for (const n of nodeIds) {
      if (n === tx.rootId || n === id)
        throw new CommandError('protected', 'The scene root cannot join an assembly.');
      const owner = tx.get(tx.get(n).parentId!);
      if (owner.kind === 'assembly' && relationsOf(owner, n).length)
        throw new CommandError(
          'invalid-operation',
          `"${tx.get(n).name}" is constrained in "${owner.name}"; delete its mates first.`,
        );
      reparentKeepWorld(tx, n, id);
    }
    return [id, ...nodeIds];
  },

  'assembly.insertComponent'(tx, { assemblyId, nodeId }) {
    const a = getAssembly(tx, assemblyId);
    assertAssemblyEditable(tx, a);
    const n = tx.get(nodeId);
    if (nodeId === assemblyId || descendantsOf(tx.graph, nodeId).includes(assemblyId))
      throw new CommandError('cycle', 'An assembly cannot contain itself.');
    if (n.parentId === assemblyId) return [];
    const owner = tx.get(n.parentId!);
    if (owner.kind === 'assembly' && relationsOf(owner, nodeId).length)
      throw new CommandError(
        'invalid-operation',
        `"${n.name}" is constrained in "${owner.name}"; delete its mates first.`,
      );
    reparentKeepWorld(tx, nodeId, assemblyId);
    return [nodeId, assemblyId];
  },

  'assembly.removeComponent'(tx, { assemblyId, nodeId }) {
    const a = getAssembly(tx, assemblyId);
    assertAssemblyEditable(tx, a);
    if (tx.get(nodeId).parentId !== assemblyId)
      throw new CommandError('invalid-operation', 'That node is not a member of this assembly.');
    const rel = relationsOf(a, nodeId);
    if (rel.length)
      throw new CommandError(
        'invalid-operation',
        `Remove its relationships first: ${rel.map((r) => r.name).join(', ')}.`,
      );
    putMechanical(tx, a, { ...a.mechanical, grounded: a.mechanical.grounded.filter((g) => g !== nodeId) });
    reparentKeepWorld(tx, nodeId, a.parentId!);
    return [nodeId, assemblyId];
  },

  'assembly.ground'(tx, { assemblyId, nodeId, grounded }, ctx) {
    const a = getAssembly(tx, assemblyId);
    assertAssemblyEditable(tx, a);
    assertBody(tx, a, nodeId);
    const set = new Set(a.mechanical.grounded);
    if (grounded) set.add(nodeId);
    else set.delete(nodeId);
    putMechanical(tx, a, {
      ...a.mechanical,
      grounded: a.mechanical.grounded
        .filter((g) => set.has(g))
        .concat(grounded && !a.mechanical.grounded.includes(nodeId) ? [nodeId] : []),
    });
    resolveAssembly(tx, ctx, assemblyId);
    return [assemblyId];
  },

  'assembly.mate.create'(tx, { assemblyId, mate: input }, ctx) {
    const a = getAssembly(tx, assemblyId);
    assertAssemblyEditable(tx, a);
    assertBody(tx, a, input.a.nodeId);
    assertBody(tx, a, input.b.nodeId);
    if (input.a.nodeId === input.b.nodeId)
      throw new CommandError('invalid-operation', 'A mate needs two different bodies.');
    const n = MATE_COORDINATES[input.type].length;
    const id = input.id ?? ctx.newId();
    const mate: Mate = {
      id,
      name:
        input.name ??
        `${input.type[0]!.toUpperCase()}${input.type.slice(1)} ${a.mechanical.mates.length + 1}`,
      type: input.type,
      a: input.a,
      b: input.b,
      alignment: input.alignment ?? 'opposed',
      offsetRad: input.offsetRad ?? 0,
      coordinates: input.coordinates ?? Array(n).fill(0),
      home: input.home ?? input.coordinates ?? Array(n).fill(0),
      limits: input.limits ?? Array(n).fill(null),
      suppressed: false,
    };
    if (mate.coordinates.length !== n || mate.home.length !== n || mate.limits.length !== n)
      throw new CommandError('invalid-command', `${input.type} mates have ${n} coordinate(s).`);
    if (a.mechanical.mates.some((x) => x.id === id) || a.mechanical.constraints.some((x) => x.id === id))
      throw new CommandError('duplicate-id', `Relationship id "${id}" already exists.`);
    putMechanical(tx, a, { ...a.mechanical, mates: [...a.mechanical.mates, mate] });
    resolveAssembly(
      tx,
      ctx,
      assemblyId,
      a.mechanical.mates.map((m) => m.id),
    );
    return [assemblyId, input.a.nodeId, input.b.nodeId];
  },

  'assembly.mate.update'(tx, { assemblyId, mateId, patch }, ctx) {
    const a = getAssembly(tx, assemblyId);
    assertAssemblyEditable(tx, a);
    const m = a.mechanical.mates.find((x) => x.id === mateId);
    if (!m) throw new CommandError('not-found', `Mate "${mateId}" not found.`);
    let base: Mate = m;
    if (patch.type && patch.type !== m.type) {
      const c = convertMate(m, patch.type);
      if (!c.ok) throw new CommandError('unsupported', c.message);
      base = { ...m, type: patch.type, coordinates: c.coordinates, home: c.home, limits: c.limits };
    }
    const { type: _type, ...rest } = patch;
    const next: Mate = { ...base, ...rest } as Mate;
    const n = MATE_COORDINATES[next.type].length;
    if (next.limits.length !== n || next.home.length !== n)
      throw new CommandError('invalid-command', `${next.type} mates have ${n} coordinate(s).`);
    next.limits.forEach((l, i) => {
      if (l && (next.coordinates[i]! < l.min - 1e-12 || next.coordinates[i]! > l.max + 1e-12))
        throw new CommandError(
          'out-of-limits',
          `The current coordinate is outside the new limits; move the joint first.`,
        );
      if (l && (next.home[i]! < l.min - 1e-12 || next.home[i]! > l.max + 1e-12))
        throw new CommandError('out-of-limits', `The home position is outside the joint limits.`);
    });
    putMechanical(tx, a, {
      ...a.mechanical,
      mates: a.mechanical.mates.map((x) => (x.id === mateId ? next : x)),
    });
    resolveAssembly(
      tx,
      ctx,
      assemblyId,
      a.mechanical.mates.filter((x) => x.id !== mateId).map((x) => x.id),
    );
    return [assemblyId];
  },

  'assembly.mate.delete'(tx, { assemblyId, mateId }, ctx) {
    const a = getAssembly(tx, assemblyId);
    assertAssemblyEditable(tx, a);
    if (!a.mechanical.mates.some((x) => x.id === mateId))
      throw new CommandError('not-found', `Mate "${mateId}" not found.`);
    putMechanical(tx, a, { ...a.mechanical, mates: a.mechanical.mates.filter((x) => x.id !== mateId) });
    resolveAssembly(
      tx,
      ctx,
      assemblyId,
      a.mechanical.mates.map((m) => m.id),
    );
    return [assemblyId];
  },

  'assembly.joint.setPosition'(tx, { assemblyId, mateId, coordinates }, ctx) {
    const a = getAssembly(tx, assemblyId);
    assertAssemblyEditable(tx, a);
    const m = a.mechanical.mates.find((x) => x.id === mateId);
    if (!m) throw new CommandError('not-found', `Mate "${mateId}" not found.`);
    if (coordinates.length !== m.coordinates.length)
      throw new CommandError(
        'invalid-command',
        `${m.type} mates have ${m.coordinates.length} coordinate(s).`,
      );
    coordinates.forEach((v, i) => {
      const l = m.limits[i];
      if (l && (v < l.min - 1e-12 || v > l.max + 1e-12))
        throw new CommandError(
          'out-of-limits',
          `${m.name}: ${v.toFixed(6)} is outside its limit [${l.min.toFixed(6)}, ${l.max.toFixed(6)}].`,
        );
    });
    putMechanical(tx, a, {
      ...a.mechanical,
      mates: a.mechanical.mates.map((x) => (x.id === mateId ? { ...x, coordinates } : x)),
    });
    resolveAssembly(tx, ctx, assemblyId, [mateId]);
    return [assemblyId];
  },

  'assembly.joint.home'(tx, { assemblyId }, ctx) {
    const a = getAssembly(tx, assemblyId);
    assertAssemblyEditable(tx, a);
    putMechanical(tx, a, {
      ...a.mechanical,
      mates: a.mechanical.mates.map((x) => ({ ...x, coordinates: [...x.home] })),
    });
    resolveAssembly(
      tx,
      ctx,
      assemblyId,
      a.mechanical.mates.map((m) => m.id),
    );
    return [assemblyId];
  },

  'assembly.constraint.add'(tx, { assemblyId, constraint: input }, ctx) {
    const a = getAssembly(tx, assemblyId);
    assertAssemblyEditable(tx, a);
    assertBody(tx, a, input.a.nodeId);
    assertBody(tx, a, input.b.nodeId);
    const id = input.id ?? ctx.newId();
    if ([...a.mechanical.mates, ...a.mechanical.constraints].some((x) => x.id === id))
      throw new CommandError('duplicate-id', `Relationship id "${id}" already exists.`);
    const needsValue = input.type === 'distance' || input.type === 'angle';
    checkConstraintValue(input.type, input.value);
    const c: AssemblyConstraint = {
      id,
      name: input.name ?? `${input.type} ${a.mechanical.constraints.length + 1}`,
      type: input.type,
      a: input.a,
      b: input.b,
      value: needsValue ? input.value! : null,
      driving: input.driving ?? true,
    };
    putMechanical(tx, a, { ...a.mechanical, constraints: [...a.mechanical.constraints, c] });
    resolveAssembly(tx, ctx, assemblyId);
    return [assemblyId];
  },

  'assembly.constraint.update'(tx, { assemblyId, constraintId, patch }, ctx) {
    const a = getAssembly(tx, assemblyId);
    assertAssemblyEditable(tx, a);
    const c = a.mechanical.constraints.find((x) => x.id === constraintId);
    if (!c) throw new CommandError('not-found', `Constraint "${constraintId}" not found.`);
    const next: AssemblyConstraint = {
      ...c,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.a ? { a: patch.a } : {}),
      ...(patch.b ? { b: patch.b } : {}),
      ...(patch.driving !== undefined ? { driving: patch.driving } : {}),
      ...(patch.value !== undefined ? { value: patch.value } : {}),
    };
    assertBody(tx, a, next.a.nodeId);
    assertBody(tx, a, next.b.nodeId);
    if (next.a.nodeId === next.b.nodeId)
      throw new CommandError('invalid-operation', 'A constraint needs two different bodies.');
    checkConstraintValue(next.type, next.value);
    putMechanical(tx, a, {
      ...a.mechanical,
      constraints: a.mechanical.constraints.map((x) => (x.id === constraintId ? next : x)),
    });
    resolveAssembly(tx, ctx, assemblyId);
    return [assemblyId];
  },

  'assembly.constraint.delete'(tx, { assemblyId, constraintId }, ctx) {
    const a = getAssembly(tx, assemblyId);
    assertAssemblyEditable(tx, a);
    if (!a.mechanical.constraints.some((x) => x.id === constraintId))
      throw new CommandError('not-found', `Constraint "${constraintId}" not found.`);
    putMechanical(tx, a, {
      ...a.mechanical,
      constraints: a.mechanical.constraints.filter((x) => x.id !== constraintId),
    });
    resolveAssembly(
      tx,
      ctx,
      assemblyId,
      a.mechanical.mates.map((m) => m.id),
    );
    return [assemblyId];
  },

  // Implemented in handlers.ts (shares the scene.component.configure logic).
  'component.parameters.update'() {
    throw new CommandError('invalid-operation', 'dispatched elsewhere');
  },

  'sketch.create'(tx, { id: givenId, name, parentId, transform, entities, constraints }, ctx) {
    const parent = parentId ?? tx.rootId;
    tx.get(parent);
    const id = givenId ?? ctx.newId();
    if (tx.find(id)) throw new CommandError('duplicate-id', `A node with id "${id}" already exists.`);
    const node: SketchNode = {
      id,
      kind: 'sketch',
      name: name ?? 'Sketch',
      parentId: parent,
      childIds: [],
      transform: checkTransform({ ...identityNodeTransform(), ...transform }),
      visible: true,
      locked: false,
      metadata: {},
      entities: [],
      constraints: [],
    };
    tx.put(node);
    const p = tx.get(parent);
    tx.put({ ...p, childIds: [...p.childIds, id] });
    if ((entities?.length ?? 0) + (constraints?.length ?? 0) > 0)
      solveSketchInto(tx, ctx, node, { entities: entities ?? [], constraints: constraints ?? [] });
    return [id];
  },

  'sketch.entity.add'(tx, { sketchId, entities }, ctx) {
    const s = sketchOf(tx, sketchId);
    const ids = new Set(s.entities.map((e) => e.id));
    for (const e of entities) {
      if (ids.has(e.id)) throw new CommandError('duplicate-id', `Sketch entity "${e.id}" already exists.`);
      ids.add(e.id);
    }
    solveSketchInto(tx, ctx, s, { entities: [...s.entities, ...entities], constraints: s.constraints });
    return [sketchId];
  },

  'sketch.constraint.add'(tx, { sketchId, constraint }, ctx) {
    const s = sketchOf(tx, sketchId);
    const c = { ...constraint, id: constraint.id ?? ctx.newId() };
    if (s.constraints.some((x) => x.id === c.id))
      throw new CommandError('duplicate-id', `Sketch constraint "${c.id}" already exists.`);
    solveSketchInto(tx, ctx, s, { entities: s.entities, constraints: [...s.constraints, c] });
    return [sketchId];
  },

  'sketch.constraint.delete'(tx, { sketchId, constraintId }, ctx) {
    const s = sketchOf(tx, sketchId);
    if (!s.constraints.some((x) => x.id === constraintId))
      throw new CommandError('not-found', `Sketch constraint "${constraintId}" not found.`);
    solveSketchInto(tx, ctx, s, {
      entities: s.entities,
      constraints: s.constraints.filter((x) => x.id !== constraintId),
    });
    return [sketchId];
  },

  'part.create'(
    tx,
    { id: givenId, name, parentId, transform, materialId, profile, fromSketchId, depth },
    ctx,
  ) {
    const parent = parentId ?? tx.rootId;
    tx.get(parent);
    let prof = profile;
    if (fromSketchId) {
      const s = tx.get(fromSketchId);
      if (s.kind !== 'sketch') throw new CommandError('invalid-operation', 'fromSketchId is not a sketch.');
      prof = sketchProfile(s) ?? undefined;
      if (!prof)
        throw new CommandError(
          'invalid-geometry',
          'The sketch has no closed profile (a closed line loop or a circle).',
        );
    }
    if (!prof) throw new CommandError('invalid-command', 'A profile or a sketch is required.');
    const id = givenId ?? ctx.newId();
    if (tx.find(id)) throw new CommandError('duplicate-id', `A node with id "${id}" already exists.`);
    const features: Feature[] = [
      { id: `${id}-base`, type: 'extrude', profile: prof, depth, sourceSketchId: fromSketchId ?? null },
    ];
    checkPart(ctx, features);
    const node: PartNode = {
      id,
      kind: 'part',
      name: name ?? 'Part',
      parentId: parent,
      childIds: [],
      transform: checkTransform({ ...identityNodeTransform(), ...transform }),
      visible: true,
      locked: false,
      metadata: {},
      materialId: materialId ?? null,
      features,
    };
    tx.put(node);
    const p = tx.get(parent);
    tx.put({ ...p, childIds: [...p.childIds, id] });
    return [id];
  },

  'geometry.hole.create'(tx, { partId, id, center, diameter, depth }, ctx) {
    return addFeature(tx, ctx, partId, { id: id ?? ctx.newId(), type: 'hole', center, diameter, depth });
  },
  'geometry.cut.create'(tx, { partId, id, profile, depth }, ctx) {
    return addFeature(tx, ctx, partId, { id: id ?? ctx.newId(), type: 'cut', profile, depth });
  },
  'geometry.boolean.create'(tx, { partId, id, op, profile }, ctx) {
    return addFeature(tx, ctx, partId, { id: id ?? ctx.newId(), type: 'boolean', op, profile });
  },
  'geometry.pattern.create'(tx, payload, ctx) {
    const fid = payload.id ?? ctx.newId();
    return addFeature(
      tx,
      ctx,
      payload.partId,
      payload.kind === 'rect'
        ? {
            id: fid,
            type: 'pattern-rect',
            target: payload.target,
            countU: payload.countU,
            countV: payload.countV,
            spacingU: payload.spacingU,
            spacingV: payload.spacingV,
          }
        : {
            id: fid,
            type: 'pattern-circ',
            target: payload.target,
            count: payload.count,
            center: payload.center,
            totalAngle: payload.totalAngle,
          },
    );
  },
  'geometry.mirror.create'(tx, { partId, id, target, axis, offset }, ctx) {
    return addFeature(tx, ctx, partId, { id: id ?? ctx.newId(), type: 'mirror', target, axis, offset });
  },
  'geometry.feature.update'(tx, { partId, feature }, ctx) {
    const p = partOf(tx, partId);
    const i = p.features.findIndex((f) => f.id === feature.id);
    if (i < 0) throw new CommandError('not-found', `Feature "${feature.id}" not found.`);
    if (p.features[i]!.type !== feature.type)
      throw new CommandError('invalid-operation', 'A feature cannot change type.');
    const features = p.features.map((f, k) => (k === i ? feature : f));
    checkPart(ctx, features);
    tx.put({ ...p, features });
    resolveOwner(tx, ctx, partId);
    return [partId];
  },
  'geometry.feature.delete'(tx, { partId, featureId }, ctx) {
    const p = partOf(tx, partId);
    const f = p.features.find((x) => x.id === featureId);
    if (!f) throw new CommandError('not-found', `Feature "${featureId}" not found.`);
    if (f.type === 'extrude' && p.features.indexOf(f) === 0)
      throw new CommandError('invalid-operation', 'The base extrusion cannot be deleted.');
    const dependants = p.features.filter((x) => 'target' in x && x.target === featureId);
    if (dependants.length)
      throw new CommandError(
        'invalid-operation',
        `Delete the features that use it first: ${dependants.map((d) => d.id).join(', ')}.`,
      );
    const features = p.features.filter((x) => x.id !== featureId);
    checkPart(ctx, features);
    tx.put({ ...p, features });
    resolveOwner(tx, ctx, partId);
    return [partId];
  },

  'model.instance.create'(tx, { id: givenId, name, parentId, transform, model }, ctx) {
    const parent = parentId ?? tx.rootId;
    tx.get(parent);
    if (isEffectivelyLocked(tx.graph, parent))
      throw new CommandError('locked', 'The target parent is locked.');
    const id = givenId ?? ctx.newId();
    if (tx.find(id)) throw new CommandError('duplicate-id', `A node with id "${id}" already exists.`);
    const t = checkTransform({ ...identityNodeTransform(), ...transform });
    if (t.scale.some((v) => Math.abs(v - 1) > 1e-12))
      throw new CommandError(
        'invalid-transform',
        'Imported models are sized by their confirmed unit, not scale.',
      );
    tx.put({
      id,
      kind: 'model-instance',
      name: name ?? model.name,
      parentId: parent,
      childIds: [],
      transform: t,
      visible: true,
      locked: false,
      metadata: {},
      model,
    });
    const p = tx.get(parent);
    tx.put({ ...p, childIds: [...p.childIds, id] });
    return [id];
  },

  'model.instance.interfaces.set'(tx, { nodeId, interfaces }, ctx) {
    const n = tx.get(nodeId);
    if (n.kind !== 'model-instance')
      throw new CommandError('invalid-operation', `"${n.name}" is not an imported model instance.`);
    if (isEffectivelyLocked(tx.graph, nodeId)) throw new CommandError('locked', `"${n.name}" is locked.`);
    // Refuse to orphan a relationship: every interface a mate/constraint uses must remain.
    const parent = n.parentId ? tx.find(n.parentId) : undefined;
    if (parent?.kind === 'assembly') {
      const kept = new Set(interfaces.map((i) => i.id));
      const used = relationsOf(parent, nodeId).filter((r) =>
        [r.a, r.b].some(
          (e) => e.nodeId === nodeId && e.ref.kind === 'interface' && !kept.has(e.ref.interfaceId),
        ),
      );
      if (used.length)
        throw new CommandError(
          'invalid-operation',
          `Interfaces in use by ${used.map((r) => `"${r.name}"`).join(', ')} cannot be removed; delete those relationships first.`,
        );
    }
    tx.put({ ...n, model: { ...n.model, interfaces } });
    // Moved interfaces move what is mated to them (or the edit is refused on conflict).
    resolveOwner(tx, ctx, nodeId);
    return [nodeId];
  },
};
