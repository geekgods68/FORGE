import { compose, decompose, IDENTITY_MAT4, invert, multiply, type Mat4 } from '../math/mat4';
import { quatNormalize } from '../transform';
import { MAX_DEPTH, MAX_NODES, type NodeTransform, type SceneGraph, type SceneNode } from './schemas';

/**
 * Pure, deterministic scene-graph queries and structural validation.
 * No React, no three.js, no mutation.
 */

export interface GraphIssue {
  path: string;
  message: string;
}

/** Structural integrity: one root, consistent parent/child links, no cycles/orphans, limits. */
export function validateGraph(graph: SceneGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const { nodes, rootId } = graph;
  const ids = Object.keys(nodes);

  if (ids.length > MAX_NODES) add('nodes', `too many nodes (${ids.length} > ${MAX_NODES})`);
  for (const [key, n] of Object.entries(nodes)) {
    if (n.id !== key) add(`nodes.${key}.id`, `node key "${key}" does not match id "${n.id}"`);
  }
  const root = nodes[rootId];
  if (!root) {
    add('rootId', `root node "${rootId}" does not exist`);
    return issues;
  }
  if (root.kind !== 'root') add(`nodes.${rootId}.kind`, 'root node must have kind "root"');
  if (root.parentId !== null) add(`nodes.${rootId}.parentId`, 'root node cannot have a parent');
  // Pass 1: which parent lists each child (O(total children)). Replaces a per-node
  // `parent.childIds.includes(id)` scan, which was O(siblings) per node — quadratic
  // for flat scenes (thousands of children under one parent).
  const listedBy = new Map<string, string>();
  for (const n of Object.values(nodes)) {
    const seen = new Set<string>();
    for (const c of n.childIds) {
      if (seen.has(c)) add(`nodes.${n.id}.childIds`, `child "${c}" listed twice`);
      seen.add(c);
      const child = nodes[c];
      if (!child) add(`nodes.${n.id}.childIds`, `child "${c}" does not exist`);
      else if (child.parentId !== n.id) add(`nodes.${n.id}.childIds`, `child "${c}" has a different parent`);
      if (!listedBy.has(c)) listedBy.set(c, n.id);
    }
  }
  // Pass 2: every non-root node's declared parent must exist and list it.
  for (const n of Object.values(nodes)) {
    if (n.kind === 'root' && n.id !== rootId) add(`nodes.${n.id}.kind`, 'only one root node is allowed');
    if (n.id === rootId) continue;
    if (n.parentId === null) add(`nodes.${n.id}.parentId`, 'non-root node must have a parent');
    else if (!nodes[n.parentId]) add(`nodes.${n.id}.parentId`, `parent "${n.parentId}" does not exist`);
    else if (listedBy.get(n.id) !== n.parentId && !nodes[n.parentId]!.childIds.includes(n.id))
      add(`nodes.${n.id}.parentId`, `parent "${n.parentId}" does not list this node as a child`);
  }
  // Reachability from the root detects cycles and orphans (a cycle can never reach the root).
  const visited = new Set<string>();
  const stack: [string, number][] = [[rootId, 0]];
  while (stack.length) {
    const [id, depth] = stack.pop()!;
    if (visited.has(id)) {
      add(`nodes.${id}`, 'node reachable through more than one path (cycle or duplicate parent)');
      continue;
    }
    visited.add(id);
    if (depth > MAX_DEPTH) add(`nodes.${id}`, `hierarchy deeper than ${MAX_DEPTH} levels`);
    for (const c of nodes[id]?.childIds ?? []) if (nodes[c]) stack.push([c, depth + 1]);
  }
  for (const id of ids) {
    if (!visited.has(id)) add(`nodes.${id}`, 'node is not reachable from the root (orphan or cycle)');
  }
  return issues;
}

export function getNode(graph: SceneGraph, id: string): SceneNode | undefined {
  return graph.nodes[id];
}

/** Ancestor ids from the parent up to the root (excluding the node itself). */
export function ancestorsOf(graph: SceneGraph, id: string): string[] {
  const out: string[] = [];
  let cur = graph.nodes[id]?.parentId ?? null;
  while (cur !== null && out.length <= MAX_NODES) {
    out.push(cur);
    cur = graph.nodes[cur]?.parentId ?? null;
  }
  return out;
}

/** Depth-first descendants (excluding the node itself), in child order. */
export function descendantsOf(graph: SceneGraph, id: string): string[] {
  const out: string[] = [];
  const visit = (nid: string) => {
    for (const c of graph.nodes[nid]?.childIds ?? []) {
      out.push(c);
      visit(c);
    }
  };
  visit(id);
  return out;
}

export function isAncestor(graph: SceneGraph, ancestorId: string, id: string): boolean {
  return ancestorsOf(graph, id).includes(ancestorId);
}

/** A node is effectively locked if it or any ancestor is locked. */
export function isEffectivelyLocked(graph: SceneGraph, id: string): boolean {
  const n = graph.nodes[id];
  if (!n) return false;
  return n.locked || ancestorsOf(graph, id).some((a) => graph.nodes[a]?.locked);
}

export function localMatrix(t: NodeTransform): Mat4 {
  return compose(t);
}

/** World matrix = parent world × local, composed from the root down. */
export function worldMatrix(graph: SceneGraph, id: string): Mat4 {
  const chain = [id, ...ancestorsOf(graph, id)].reverse();
  let m: Mat4 = [...IDENTITY_MAT4];
  for (const nid of chain) {
    const n = graph.nodes[nid];
    if (n) m = multiply(m, localMatrix(n.transform));
  }
  return m;
}

export type TransformConversion = { ok: true; transform: NodeTransform } | { ok: false; reason: string };

/**
 * Local transform that gives a node world matrix `world` when placed under `parentId`.
 * Fails (rather than silently distorting) if the result would need shear.
 */
export function localTransformFor(graph: SceneGraph, world: Mat4, parentId: string): TransformConversion {
  const parentInv = invert(worldMatrix(graph, parentId));
  if (!parentInv) return { ok: false, reason: 'parent transform is singular' };
  const { trs, exact } = decompose(multiply(parentInv, world));
  if (!exact)
    return {
      ok: false,
      reason:
        'the world transform cannot be represented under the new parent without shear (rotated child under a non-uniformly scaled parent)',
    };
  return {
    ok: true,
    transform: { position: trs.position, rotation: quatNormalize(trs.rotation), scale: trs.scale },
  };
}

/** Outline of the tree in display order (root first), with depth. */
export function flattenTree(graph: SceneGraph): { id: string; depth: number }[] {
  const out: { id: string; depth: number }[] = [];
  const visit = (id: string, depth: number) => {
    out.push({ id, depth });
    for (const c of graph.nodes[id]?.childIds ?? []) visit(c, depth + 1);
  };
  visit(graph.rootId, 0);
  return out;
}
