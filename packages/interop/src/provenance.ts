import {
  CIRCUIT_IMPORT_FORMATS,
  circuitFingerprint,
  importFingerprint,
  type ImportRecord,
  type SceneGraph,
  type SceneNode,
} from '@forge/engineering-core';

/** Fingerprint of imported nodes (the same function the record command uses). */
export function nodesFingerprint(nodes: readonly SceneNode[]): string {
  return importFingerprint(nodes);
}

export type ImportStatus = 'unmodified' | 'modified' | 'partially-deleted' | 'deleted';
export function importStatus(rec: ImportRecord, graph: SceneGraph): ImportStatus {
  if (CIRCUIT_IMPORT_FORMATS.includes(rec.format)) {
    const root = graph.nodes[graph.rootId];
    const el = root?.kind === 'root' ? root.electrical : undefined;
    if (!el) return 'deleted';
    return circuitFingerprint(el) === rec.nodesFingerprint ? 'unmodified' : 'modified';
  }
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
