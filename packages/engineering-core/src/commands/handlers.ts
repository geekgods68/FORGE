import { compose, decompose, multiply } from '../math/mat4';
import { identityNodeTransform } from '../project/create';
import {
  descendantsOf,
  isAncestor,
  isEffectivelyLocked,
  localTransformFor,
  worldMatrix,
} from '../scene/graph';
import {
  NodeTransformSchema,
  type ComponentParamValue,
  type ComponentRef,
  type NodeTransform,
  type SceneNode,
} from '../scene/schemas';
import { CommandError, type GraphTransaction } from '../scene/transaction';
import { quatNormalize } from '../transform';
import type { BatchSubCommand, NodeCommandType, PayloadOf } from './schemas';

export interface ComponentResolveInput {
  definitionId: string;
  variantId: string | null;
  /** Overrides on top of defaults/variant (or a complete set — both are valid input). */
  parameters: Record<string, ComponentParamValue>;
  /** undefined = the definition's default material. */
  materialId: string | null | undefined;
}
export type ComponentResolveResult =
  | { ok: true; ref: Omit<ComponentRef, 'connections'>; defaultName: string }
  | { ok: false; code: 'unknown-component' | 'invalid-parameters'; message: string };

/**
 * Validates component references against a component library. Injected into the
 * engine so @forge/engineering-core stays independent of the catalogue package; the UI
 * and (later) Vey reach components only through commands validated by this resolver.
 */
export interface ComponentResolver {
  resolve(input: ComponentResolveInput): ComponentResolveResult;
}

export interface HandlerContext {
  /** Id source; ids are recorded in history so redo restores identical ids. */
  newId: () => string;
  /** Component-library resolver; without one, catalogue components cannot be created or edited. */
  resolver?: ComponentResolver;
}

const isUnitScale = (t: NodeTransform) => t.scale.every((v) => Math.abs(v - 1) < 1e-12);
const isCatalogComponent = (n: SceneNode) => n.kind === 'component-instance' && !!n.component;

/** Catalogue components are resized through parameters; scale on them (or their ancestors) would silently deform real parts. */
function assertNoComponentDeformation(tx: GraphTransaction, nodeId: string, transform: NodeTransform) {
  if (isUnitScale(transform)) return;
  const affected = [nodeId, ...descendantsOf(tx.graph, nodeId)].some((id) => isCatalogComponent(tx.get(id)));
  if (affected)
    throw new CommandError(
      'invalid-transform',
      'Catalogue components cannot be scaled (directly or through a parent). Change their dimensions through component parameters instead.',
    );
}
function hasScaledAncestor(tx: GraphTransaction, id: string): boolean {
  for (let cur: string | null = id; cur; cur = tx.get(cur).parentId)
    if (!isUnitScale(tx.get(cur).transform)) return true;
  return false;
}

function resolveComponent(ctx: HandlerContext, input: ComponentResolveInput) {
  if (!ctx.resolver)
    throw new CommandError('unknown-component', 'No component library is available to this engine.');
  const r = ctx.resolver.resolve(input);
  if (!r.ok) throw new CommandError(r.code, r.message);
  return r;
}

/** Returns the ids the command created or modified. */
export type Handler<K extends NodeCommandType> = (
  tx: GraphTransaction,
  payload: PayloadOf<K>,
  ctx: HandlerContext,
) => string[];

const SHAPE_NAMES = {
  box: 'Box',
  sphere: 'Sphere',
  cylinder: 'Cylinder',
  cone: 'Cone',
  plane: 'Plane',
  torus: 'Torus',
};

function assertEditable(tx: GraphTransaction, id: string, action: string) {
  if (id === tx.rootId) throw new CommandError('protected', `The scene root cannot be ${action}.`);
  if (isEffectivelyLocked(tx.graph, id))
    throw new CommandError(
      'locked',
      `"${tx.get(id).name}" is locked (or inside a locked group) and cannot be ${action}.`,
    );
}

function assertParentEditable(tx: GraphTransaction, parentId: string) {
  if (isEffectivelyLocked(tx.graph, parentId))
    throw new CommandError('locked', `"${tx.get(parentId).name}" is locked; its children cannot change.`);
}

function checkTransform(t: NodeTransform): NodeTransform {
  const normalized = { ...t, rotation: quatNormalize(t.rotation) };
  const r = NodeTransformSchema.safeParse(normalized);
  if (!r.success)
    throw new CommandError('invalid-transform', r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}

function insertChild(tx: GraphTransaction, parentId: string, childId: string, index?: number) {
  const parent = tx.get(parentId);
  const childIds = parent.childIds.filter((c) => c !== childId);
  const at = index === undefined ? childIds.length : Math.min(index, childIds.length);
  childIds.splice(at, 0, childId);
  tx.put({ ...parent, childIds });
}

function detachChild(tx: GraphTransaction, parentId: string, childId: string): number {
  const parent = tx.get(parentId);
  const index = parent.childIds.indexOf(childId);
  tx.put({ ...parent, childIds: parent.childIds.filter((c) => c !== childId) });
  return index;
}

const sameTransform = (a: NodeTransform, b: NodeTransform) => JSON.stringify(a) === JSON.stringify(b);

export const HANDLERS: { [K in NodeCommandType]: Handler<K> } = {
  'scene.node.create'(tx, { node: spec }, ctx) {
    const parentId = spec.parentId ?? tx.rootId;
    tx.get(parentId);
    assertParentEditable(tx, parentId);
    const id = spec.id ?? ctx.newId();
    if (tx.find(id)) throw new CommandError('duplicate-id', `A node with id "${id}" already exists.`);
    const transform = checkTransform({ ...identityNodeTransform(), ...spec.transform });
    const base = {
      id,
      parentId,
      childIds: [],
      transform,
      visible: spec.visible ?? true,
      locked: spec.locked ?? false,
      metadata: spec.metadata ?? {},
    };
    let node: SceneNode;
    switch (spec.kind) {
      case 'group':
        node = { ...base, kind: 'group', name: spec.name ?? 'Group' };
        break;
      case 'primitive':
        node = {
          ...base,
          kind: 'primitive',
          name: spec.name ?? SHAPE_NAMES[spec.geometry.shape],
          geometry: spec.geometry,
          color: spec.color ?? '#9aa4b2',
        };
        break;
      case 'reference':
        node = {
          ...base,
          kind: 'reference',
          name: spec.name ?? 'Datum',
          referenceType: spec.referenceType,
          sizeM: spec.sizeM,
        };
        break;
      case 'component-instance': {
        if (!isUnitScale(transform))
          throw new CommandError(
            'invalid-transform',
            'Catalogue components are sized by their parameters; scale must be 1.',
          );
        if (hasScaledAncestor(tx, parentId))
          throw new CommandError(
            'invalid-transform',
            'Catalogue components cannot be placed under a scaled parent.',
          );
        const r = resolveComponent(ctx, {
          definitionId: spec.definitionId,
          variantId: spec.variantId ?? null,
          parameters: spec.parameters ?? {},
          materialId: spec.materialId,
        });
        node = {
          ...base,
          kind: 'component-instance',
          name: spec.name ?? r.defaultName,
          definitionId: spec.definitionId,
          component: { ...r.ref, connections: [] },
        };
        break;
      }
    }
    tx.put(node);
    insertChild(tx, parentId, id, spec.index);
    return [id];
  },

  'scene.node.delete'(tx, { nodeId }) {
    const node = tx.get(nodeId);
    assertEditable(tx, nodeId, 'deleted');
    const descendants = descendantsOf(tx.graph, nodeId);
    const lockedChild = descendants.find((d) => tx.get(d).locked);
    if (lockedChild) throw new CommandError('locked', `"${tx.get(lockedChild).name}" inside it is locked.`);
    detachChild(tx, node.parentId!, nodeId);
    for (const d of [...descendants].reverse()) tx.remove(d);
    tx.remove(nodeId);
    return [nodeId, ...descendants];
  },

  'scene.node.duplicate'(tx, { nodeId, offset }, ctx) {
    const source = tx.get(nodeId);
    if (nodeId === tx.rootId) throw new CommandError('protected', 'The scene root cannot be duplicated.');
    assertParentEditable(tx, source.parentId!);
    const ids = [nodeId, ...descendantsOf(tx.graph, nodeId)];
    const map = new Map(ids.map((id) => [id, ctx.newId()]));
    const created: string[] = [];
    for (const oldId of ids) {
      const orig = tx.get(oldId);
      const isTop = oldId === nodeId;
      const transform =
        isTop && offset
          ? checkTransform({
              ...orig.transform,
              position: orig.transform.position.map((v, i) => v + offset[i]!) as NodeTransform['position'],
            })
          : orig.transform;
      tx.put({
        ...orig,
        id: map.get(oldId)!,
        name: isTop ? `${orig.name} copy` : orig.name,
        parentId: isTop ? orig.parentId : map.get(orig.parentId!)!,
        childIds: orig.childIds.map((c) => map.get(c)!),
        transform,
        locked: false,
      });
      created.push(map.get(oldId)!);
    }
    const parent = tx.get(source.parentId!);
    insertChild(tx, parent.id, map.get(nodeId)!, parent.childIds.indexOf(nodeId) + 1);
    return created;
  },

  'scene.node.rename'(tx, { nodeId, name }) {
    const node = tx.get(nodeId);
    if (isEffectivelyLocked(tx.graph, nodeId)) throw new CommandError('locked', `"${node.name}" is locked.`);
    if (node.name !== name) tx.put({ ...node, name });
    return [nodeId];
  },

  'scene.node.transform'(tx, { nodeId, position, rotation, scale }) {
    if (scale) assertNoComponentDeformation(tx, nodeId, { ...tx.get(nodeId).transform, scale });
    const node = tx.get(nodeId);
    assertEditable(tx, nodeId, 'transformed');
    const next = checkTransform({
      position: position ?? node.transform.position,
      rotation: rotation ?? node.transform.rotation,
      scale: scale ?? node.transform.scale,
    });
    if (!sameTransform(next, node.transform)) tx.put({ ...node, transform: next });
    return [nodeId];
  },

  'scene.node.reparent'(tx, { nodeId, parentId, keepWorldTransform, index }) {
    const node = tx.get(nodeId);
    tx.get(parentId);
    assertEditable(tx, nodeId, 'moved');
    if (parentId === nodeId || isAncestor(tx.graph, nodeId, parentId))
      throw new CommandError('cycle', 'A node cannot be moved inside itself or one of its descendants.');
    assertParentEditable(tx, node.parentId!);
    assertParentEditable(tx, parentId);
    let transform = node.transform;
    if (keepWorldTransform && parentId !== node.parentId) {
      const r = localTransformFor(tx.graph, worldMatrix(tx.graph, nodeId), parentId);
      if (!r.ok) throw new CommandError('unrepresentable-transform', r.reason);
      transform = checkTransform(r.transform);
    }
    const subtreeHasComponent = [nodeId, ...descendantsOf(tx.graph, nodeId)].some((id) =>
      isCatalogComponent(tx.get(id)),
    );
    if (subtreeHasComponent && hasScaledAncestor(tx, parentId))
      throw new CommandError(
        'invalid-transform',
        'Catalogue components cannot be moved under a scaled parent (it would deform them).',
      );
    assertNoComponentDeformation(tx, nodeId, transform);
    detachChild(tx, node.parentId!, nodeId);
    tx.put({ ...tx.get(nodeId), parentId, transform });
    insertChild(tx, parentId, nodeId, index);
    return [nodeId];
  },

  'scene.node.visibility'(tx, { nodeId, visible }) {
    const node = tx.get(nodeId);
    if (nodeId === tx.rootId) throw new CommandError('protected', 'The scene root cannot be hidden.');
    // Visibility is a view property: allowed on locked nodes.
    if (node.visible !== visible) tx.put({ ...node, visible });
    return [nodeId];
  },

  'scene.node.lock'(tx, { nodeId, locked }) {
    const node = tx.get(nodeId);
    if (nodeId === tx.rootId) throw new CommandError('protected', 'The scene root cannot be locked.');
    if (node.locked !== locked) tx.put({ ...node, locked });
    return [nodeId];
  },

  'scene.node.group'(tx, { nodeIds, groupId, name }, ctx) {
    const nodes = nodeIds.map((id) => tx.get(id));
    for (const n of nodes) assertEditable(tx, n.id, 'grouped');
    const parentId = nodes[0]!.parentId!;
    if (nodes.some((n) => n.parentId !== parentId))
      throw new CommandError('invalid-operation', 'All nodes in a group must share the same parent.');
    assertParentEditable(tx, parentId);
    const id = groupId ?? ctx.newId();
    if (tx.find(id)) throw new CommandError('duplicate-id', `A node with id "${id}" already exists.`);
    const parent = tx.get(parentId);
    const ordered = parent.childIds.filter((c) => nodeIds.includes(c)); // preserve sibling order
    const insertAt = parent.childIds.indexOf(ordered[0]!);
    // The group gets an identity transform, so members keep their world placement unchanged.
    tx.put({
      ...parent,
      childIds: parent.childIds.filter((c) => !nodeIds.includes(c)),
    });
    tx.put({
      id,
      kind: 'group',
      name: name ?? 'Group',
      parentId,
      childIds: ordered,
      transform: identityNodeTransform(),
      visible: true,
      locked: false,
      metadata: {},
    });
    for (const m of ordered) tx.put({ ...tx.get(m), parentId: id });
    insertChild(tx, parentId, id, insertAt);
    return [id, ...ordered];
  },

  'scene.component.configure'(tx, { nodeId, variantId, parameters, materialId }, ctx) {
    const node = tx.get(nodeId);
    if (node.kind !== 'component-instance' || !node.component)
      throw new CommandError('invalid-operation', `"${node.name}" is not a component-library instance.`);
    assertEditable(tx, nodeId, 'reconfigured');
    const cur = node.component;
    const variantChanged = variantId !== undefined && variantId !== cur.variantId;
    // A new variant starts from that variant's values; otherwise edits merge onto the current set.
    const base = variantChanged ? {} : cur.parameters;
    const r = resolveComponent(ctx, {
      definitionId: node.definitionId,
      variantId: variantId === undefined ? cur.variantId : variantId,
      parameters: { ...base, ...(parameters ?? {}) },
      materialId: materialId === undefined ? cur.materialId : materialId,
    });
    tx.put({ ...node, component: { ...r.ref, connections: cur.connections } });
    return [nodeId];
  },

  'scene.node.ungroup'(tx, { groupId }) {
    const group = tx.get(groupId);
    if (group.kind !== 'group' && group.kind !== 'assembly')
      throw new CommandError('invalid-operation', `"${group.name}" is not a group.`);
    assertEditable(tx, groupId, 'ungrouped');
    const lockedChild = group.childIds.find((c) => tx.get(c).locked);
    if (lockedChild) throw new CommandError('locked', `"${tx.get(lockedChild).name}" is locked.`);
    const parentId = group.parentId!;
    const groupLocal = compose(group.transform);
    // Bake the group's transform into each child so world placement is preserved exactly.
    const baked = group.childIds.map((c) => {
      const child = tx.get(c);
      const { trs, exact } = decompose(multiply(groupLocal, compose(child.transform)));
      if (!exact)
        throw new CommandError(
          'unrepresentable-transform',
          `Ungrouping would shear "${child.name}" (rotated child inside a non-uniformly scaled group).`,
        );
      return { ...child, parentId, transform: checkTransform(trs) };
    });
    const at = detachChild(tx, parentId, groupId);
    tx.remove(groupId);
    const parent = tx.get(parentId);
    const childIds = [...parent.childIds];
    childIds.splice(at, 0, ...baked.map((b) => b.id));
    tx.put({ ...parent, childIds });
    for (const b of baked) tx.put(b);
    return baked.map((b) => b.id);
  },
};

/** Apply one single-node command inside a transaction (shared by direct commands and batches). */
export function runNodeCommand(tx: GraphTransaction, cmd: BatchSubCommand, ctx: HandlerContext): string[] {
  // Each case narrows `cmd` so the handler receives a precisely typed payload.
  switch (cmd.type) {
    case 'scene.node.create':
      return HANDLERS['scene.node.create'](tx, cmd.payload, ctx);
    case 'scene.node.delete':
      return HANDLERS['scene.node.delete'](tx, cmd.payload, ctx);
    case 'scene.node.duplicate':
      return HANDLERS['scene.node.duplicate'](tx, cmd.payload, ctx);
    case 'scene.node.rename':
      return HANDLERS['scene.node.rename'](tx, cmd.payload, ctx);
    case 'scene.node.transform':
      return HANDLERS['scene.node.transform'](tx, cmd.payload, ctx);
    case 'scene.node.reparent':
      return HANDLERS['scene.node.reparent'](tx, cmd.payload, ctx);
    case 'scene.node.visibility':
      return HANDLERS['scene.node.visibility'](tx, cmd.payload, ctx);
    case 'scene.node.lock':
      return HANDLERS['scene.node.lock'](tx, cmd.payload, ctx);
    case 'scene.node.group':
      return HANDLERS['scene.node.group'](tx, cmd.payload, ctx);
    case 'scene.node.ungroup':
      return HANDLERS['scene.node.ungroup'](tx, cmd.payload, ctx);
    case 'scene.component.configure':
      return HANDLERS['scene.component.configure'](tx, cmd.payload, ctx);
  }
}

/** Apply a batch: sub-commands run in order; the first failure aborts the whole transaction. */
export function runBatch(
  tx: GraphTransaction,
  commands: readonly BatchSubCommand[],
  ctx: HandlerContext,
): string[] {
  const affected = new Set<string>();
  commands.forEach((c, i) => {
    try {
      for (const id of runNodeCommand(tx, c, ctx)) affected.add(id);
    } catch (e) {
      if (e instanceof CommandError)
        throw new CommandError(e.code, `Batch step ${i + 1} (${c.type}): ${e.message}`);
      throw e;
    }
  });
  return [...affected];
}
