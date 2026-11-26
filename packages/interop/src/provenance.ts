import {
  canonicalJson,
  sha256,
  type ImportRecord,
  type SceneGraph,
  type SceneNode,
} from '@forge/engineering-core';

/**
 * Modification detection for imported nodes. The fingerprint covers what an import sets —
 * kind, name, parent, transform and the node's geometry/model payload — so a later edit in
 * FORGE (move, rename, re-parent, geometry change) changes it, while unrelated project
 * changes do not.
 */
export function nodeEssence(n: SceneNode): unknown {
  const base = { id: n.id, kind: n.kind, name: n.name, parentId: n.parentId, transform: n.transform };
  switch (n.kind) {
    case 'model-instance':
      return { ...base, model: n.model };
    case 'primitive':
      return { ...base, geometry: n.geometry };
    case 'assembly':
      return { ...base, mechanical: n.mechanical };
    default:
      return base;
  }
}
export function nodesFingerprint(nodes: readonly SceneNode[]): string {
  return `sha256-${sha256(canonicalJson([...nodes].sort((a, b) => a.id.localeCompare(b.id)).map(nodeEssence)))}`;
}

export type ImportStatus = 'unmodified' | 'modified' | 'partially-deleted' | 'deleted';
export function importStatus(rec: ImportRecord, graph: SceneGraph): ImportStatus {
  const present = rec.nodeIds.map((id) => graph.nodes[id]).filter((n): n is SceneNode => !!n);
  if (!present.length) return 'deleted';
  if (present.length < rec.nodeIds.length) return 'partially-deleted';
  return nodesFingerprint(present) === rec.nodesFingerprint ? 'unmodified' : 'modified';
}
/** The import record that created a node, if any (native nodes have none). */
export function importOf(graph: SceneGraph, nodeId: string): ImportRecord | null {
  const root = graph.nodes[graph.rootId];
  if (root?.kind !== 'root') return null;
  return (root.imports ?? []).find((r) => r.nodeIds.includes(nodeId)) ?? null;
}
/** native: created in FORGE; imported: created by an import record. */
export function originOf(graph: SceneGraph, nodeId: string): 'native' | 'imported' {
  return importOf(graph, nodeId) ? 'imported' : 'native';
}
