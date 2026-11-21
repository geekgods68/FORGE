import { checkCompatibility, type ComponentInterface } from '@forge/components';
import {
  isEffectivelyLocked,
  isMateDriven,
  worldMatrix,
  type Mate,
  type PayloadInput,
  type SceneGraph,
} from '@forge/engineering-core';
import { bodyInterfaces, transformDir, transformPoint, type V3 } from '@forge/mechanics';

/**
 * Drag-to-snap (Phase 4.1), the renderer-independent part:
 * - which bodies may be snap-dragged, and why not;
 * - which target interfaces are COMPATIBLE with the dragged body's interfaces — decided
 *   only from declared connection metadata (checkCompatibility), never from proximity or
 *   mesh overlap;
 * - ranking of candidate pairs by on-screen distance during the drag;
 * - the single validated command a confirmed snap issues (insert into the target's
 *   assembly if needed, then create the mate) — one undoable step.
 * Nothing here changes the model; overlap alone never creates a mate.
 */

export interface SnapTarget {
  /** Stable key `<sourceIfc>|<targetNode>|<targetIfc>`. */
  key: string;
  sourceInterfaceId: string;
  sourceName: string;
  targetNodeId: string;
  targetInterfaceId: string;
  targetName: string;
  targetBodyName: string;
  assemblyId: string;
  /** Target interface in the project frame (current committed pose). */
  targetWorld: { p: V3; d: V3 };
  /** Target interface in the target body's local frame. */
  targetLocal: { p: V3; d: V3 };
  suggestedType: Mate['type'];
  shared: string[];
}

export type SnapContext =
  | {
      ok: true;
      nodeId: string;
      sources: ComponentInterface[];
      targets: SnapTarget[];
    }
  | { ok: false; reason: string };

const BODY_KINDS = new Set(['component-instance', 'part', 'model-instance']);

/** Mate type implied by the paired interface types (the user can change it before confirming). */
export function suggestMateType(a: ComponentInterface, b: ComponentInterface): Mate['type'] {
  const t = new Set([a.type, b.type]);
  if (t.has('slider')) return 'prismatic';
  if (t.has('revolute-joint') || (t.has('shaft-coupling') && a.type === b.type)) return 'revolute';
  return 'fixed';
}

/** Can `nodeId` be snap-dragged, and onto what? */
export function snapContext(graph: SceneGraph, nodeId: string): SnapContext {
  const n = graph.nodes[nodeId];
  if (!n || n.kind === 'root') return { ok: false, reason: 'Select a component to snap.' };
  if (!BODY_KINDS.has(n.kind))
    return {
      ok: false,
      reason: `A ${n.kind} cannot be snapped; select a component, part or imported model.`,
    };
  if (isEffectivelyLocked(graph, nodeId)) return { ok: false, reason: `“${n.name}” is locked.` };
  if (n.transform.scale.some((v) => Math.abs(v - 1) > 1e-12))
    return { ok: false, reason: `“${n.name}” is scaled; mates require unit-scale bodies.` };
  const parent = n.parentId ? graph.nodes[n.parentId] : undefined;
  if (parent?.kind === 'assembly' && parent.mechanical.grounded.includes(nodeId))
    return { ok: false, reason: `“${n.name}” is grounded; unground it to snap it elsewhere.` };
  if (isMateDriven(graph, nodeId))
    return {
      ok: false,
      reason: `“${n.name}” is already placed by mates; delete its mate to snap it to another interface.`,
    };
  const own = bodyInterfaces(graph, nodeId);
  if (typeof own === 'string' || own.length === 0)
    return { ok: false, reason: typeof own === 'string' ? own : `“${n.name}” declares no interfaces.` };

  // Target bodies: the other members of the dragged body's own assembly; a body outside
  // any assembly may snap onto members of any assembly (it is inserted on confirm).
  const assemblies =
    parent?.kind === 'assembly' ? [parent] : Object.values(graph.nodes).filter((x) => x.kind === 'assembly');
  const targets: SnapTarget[] = [];
  for (const asm of assemblies) {
    if (asm.kind !== 'assembly' || isEffectivelyLocked(graph, asm.id)) continue;
    for (const tid of asm.childIds) {
      if (tid === nodeId) continue;
      const t = graph.nodes[tid];
      if (!t || !BODY_KINDS.has(t.kind)) continue;
      const list = bodyInterfaces(graph, tid);
      if (typeof list === 'string') continue;
      const W = worldMatrix(graph, tid);
      for (const ti of list)
        for (const si of own) {
          const c = checkCompatibility(si, ti);
          if (!c.compatible) continue;
          targets.push({
            key: `${si.id}|${tid}|${ti.id}`,
            sourceInterfaceId: si.id,
            sourceName: si.name,
            targetNodeId: tid,
            targetInterfaceId: ti.id,
            targetName: ti.name,
            targetBodyName: t.name,
            assemblyId: asm.id,
            targetWorld: { p: transformPoint(W, ti.position), d: transformDir(W, ti.direction) },
            targetLocal: { p: [...ti.position], d: [...ti.direction] },
            suggestedType: suggestMateType(si, ti),
            shared: c.shared,
          });
        }
    }
  }
  if (targets.length === 0)
    return {
      ok: false,
      reason: `No interface in reach of “${n.name}” is declared compatible with its interfaces.`,
    };
  return { ok: true, nodeId, sources: own, targets };
}

export interface ScreenPair {
  key: string;
  /** On-screen distance (px) between the dragged source interface and the target interface. */
  px: number;
}

/** Candidates within `radiusPx`, nearest first (ties broken by key for determinism). */
export function rankCandidates(pairs: readonly ScreenPair[], radiusPx: number): ScreenPair[] {
  return pairs
    .filter((p) => Number.isFinite(p.px) && p.px <= radiusPx)
    .sort((a, b) => a.px - b.px || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export type SnapCommand =
  | { type: 'assembly.mate.create'; payload: PayloadInput<'assembly.mate.create'> }
  | { type: 'scene.batch'; payload: PayloadInput<'scene.batch'> };

/** The one command a confirmed snap issues (inserting the body into the target assembly first if needed). */
export function snapCommand(
  graph: SceneGraph,
  nodeId: string,
  target: SnapTarget,
  type: Mate['type'],
  alignment: Mate['alignment'],
): SnapCommand {
  const mate = {
    name: `Snap: ${target.targetBodyName} · ${target.targetName}`.slice(0, 200),
    type,
    alignment,
    a: {
      nodeId: target.targetNodeId,
      ref: { kind: 'interface' as const, interfaceId: target.targetInterfaceId },
    },
    b: { nodeId, ref: { kind: 'interface' as const, interfaceId: target.sourceInterfaceId } },
  };
  if (graph.nodes[nodeId]?.parentId === target.assemblyId)
    return { type: 'assembly.mate.create', payload: { assemblyId: target.assemblyId, mate } };
  return {
    type: 'scene.batch',
    payload: {
      commands: [
        { type: 'assembly.insertComponent', payload: { assemblyId: target.assemblyId, nodeId } },
        { type: 'assembly.mate.create', payload: { assemblyId: target.assemblyId, mate } },
      ],
    },
  };
}
