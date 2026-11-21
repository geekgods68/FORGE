import { makeCommand, worldMatrix } from '@forge/engineering-core';
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box3,
  Matrix4,
  MeshBasicMaterial,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
  type Mesh,
  type Object3D,
} from 'three';
import { FrameMarkers, type MarkerItem } from '@/components3d/FrameMarkers';
import {
  rankCandidates,
  snapCommand,
  snapContext,
  type ScreenPair,
  type SnapTarget,
} from '@/features/snap/snapLogic';
import { useEditor, useEditorStore } from '@/app/store';
import { snapDiagnostics } from '@/features/snap/snapDiagnostics';

/**
 * Drag-to-snap (Phase 4.1), viewport side. Active only in snap mode (toolbar / S) for a
 * single selected body that is free to move; the transform gizmo is hidden meanwhile, so
 * ordinary free movement is unaffected outside the mode.
 *
 * 1. Press on the selected body and drag: it follows the pointer in a camera-facing plane.
 *    The movement is RENDER-ONLY — the engineering model is not touched during the drag.
 * 2. Compatible target interfaces (declared metadata only) are highlighted; those within
 *    SNAP_RADIUS_PX of one of the dragged body's interfaces on screen are candidates, and
 *    a ghost shows the nearest candidate's solved mate pose (engine dry run).
 * 3. Release near a candidate: the pending snap opens (choose target / type / alignment;
 *    the mate is previewed by dry run) for Confirm or Cancel. Release elsewhere, Escape or
 *    Cancel: the body returns to its unchanged position. Nothing is committed until Confirm,
 *    which issues ONE validated, undoable command; overlap alone never creates a mate.
 */
export const SNAP_RADIUS_PX = 36;

interface DragState {
  obj: Object3D;
  pointerId: number;
  startWorld: Vector3;
  grab: Vector3;
  plane: Plane;
}

export function SnapController({
  registry,
  rootId,
  onDragEnd,
}: {
  registry: Map<string, Object3D>;
  rootId: string;
  onDragEnd: () => void;
}) {
  const store = useEditorStore();
  const mode = useEditor(
    (s) => s.mateSnapMode && s.explode === null && !(s.view === 'facility' && s.editLayer === 'layout'),
  );
  const id = useEditor((s) => (s.selection.length === 1 ? s.selection[0] : undefined));
  const scene = useEditor((s) => s.project.scene);
  const pending = useEditor((s) => s.mateSnap);
  const cancelDragRequest = useEditor((s) => s.cancelDragRequest);
  const { gl, camera, invalidate } = useThree();
  const ctx = useMemo(() => (mode && id ? snapContext(scene, id) : null), [mode, id, scene]);
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [ranked, setRanked] = useState<ScreenPair[]>([]);
  const [dragging, setDragging] = useState(false);

  const restore = (nodeId: string) => {
    const o = registry.get(nodeId);
    const t = store.getState().engine.getNode(nodeId)?.transform;
    if (o && t) {
      o.position.set(...t.position);
      o.quaternion.set(...t.rotation);
      o.scale.set(...t.scale);
      o.updateMatrixWorld(true);
    }
    invalidate();
  };

  // Explain why the selection cannot be snapped (once per selection / mode change).
  useEffect(() => {
    if (mode && id && ctx && !ctx.ok) store.getState().setStatus({ tone: 'info', text: ctx.reason });
  }, [mode, id, ctx, store]);
  // A pending snap ends when the selection changes or the mode is turned off.
  useEffect(() => {
    const p = store.getState().mateSnap;
    if (p && (p.nodeId !== id || !mode)) store.getState().cancelMateSnap();
  }, [id, mode, store]);
  // When a pending snap ends (confirm or cancel), show the body at its authoritative pose.
  const lastPending = useRef<string | null>(null);
  useEffect(() => {
    if (pending) lastPending.current = pending.nodeId;
    else if (lastPending.current) {
      restore(lastPending.current);
      lastPending.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  /** Project-frame point → world (the project root may be mounted in the facility). */
  const projectToWorld = (p: readonly number[], out: Vector3) => {
    const parent = registry.get(rootId)?.parent;
    out.set(p[0]!, p[1]!, p[2]!);
    if (parent) out.applyMatrix4(parent.matrixWorld);
    return out;
  };
  const toScreen = (w: Vector3) => {
    const v = w.clone().project(camera);
    const r = gl.domElement.getBoundingClientRect();
    return new Vector2(((v.x + 1) / 2) * r.width, ((1 - v.y) / 2) * r.height);
  };

  // Pointer handling on the canvas (capture phase: a snap drag pre-empts orbit + selection).
  useEffect(() => {
    if (!ctx?.ok || !id) return;
    const el = gl.domElement;
    const ray = new Raycaster();
    const ndc = new Vector2();
    const setRay = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
    };
    const sources = new Map(ctx.sources.map((s) => [s.id, s]));
    const candidatesAt = (obj: Object3D): ScreenPair[] => {
      obj.updateMatrixWorld(true);
      const w = new Vector3();
      return rankCandidates(
        ctx.targets.map((t) => {
          const s = sources.get(t.sourceInterfaceId)!;
          const a = toScreen(w.set(...s.position).applyMatrix4(obj.matrixWorld));
          const b = toScreen(projectToWorld(t.targetWorld.p, w));
          return { key: t.key, px: a.distanceTo(b) };
        }),
        SNAP_RADIUS_PX,
      );
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || store.getState().mateSnap || store.getState().conjure) return;
      const obj = registry.get(id);
      if (!obj) return;
      setRay(e);
      const box = new Box3().setFromObject(obj);
      if (box.isEmpty()) return;
      const hit = ray.ray.intersectBox(box, new Vector3());
      if (!hit) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const normal = camera.getWorldDirection(new Vector3()).negate();
      drag.current = {
        obj,
        pointerId: e.pointerId,
        startWorld: obj.getWorldPosition(new Vector3()),
        grab: hit.clone(),
        plane: new Plane().setFromNormalAndCoplanarPoint(normal, hit),
      };
      store.getState().setDragging(true);
      snapDiagnostics.dragging = true;
      setDragging(true);
      setRanked([]);
    };
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      e.stopImmediatePropagation();
      setRay(e);
      const p = ray.ray.intersectPlane(d.plane, new Vector3());
      if (!p) return;
      const world = d.startWorld.clone().add(p.sub(d.grab));
      d.obj.parent?.updateWorldMatrix(true, false);
      d.obj.position.copy(d.obj.parent ? d.obj.parent.worldToLocal(world) : world);
      const next = candidatesAt(d.obj);
      snapDiagnostics.candidates = next;
      setRanked((cur) =>
        cur.length === next.length && cur.every((c, i) => c.key === next[i]!.key) ? cur : next,
      );
      invalidate();
    };
    const end = (e: PointerEvent, cancelled = false) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      e.stopImmediatePropagation();
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      drag.current = null;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      onDragEnd();
      const s = store.getState();
      s.setDragging(false);
      snapDiagnostics.dragging = false;
      setDragging(false);
      const found = cancelled ? [] : candidatesAt(d.obj);
      snapDiagnostics.candidates = found;
      setRanked([]);
      if (found.length === 0) {
        restore(id);
        s.setStatus({
          tone: 'info',
          text: cancelled
            ? 'Snap drag cancelled — nothing was changed.'
            : 'No compatible interface within reach — nothing was changed.',
        });
        return;
      }
      const byKey = new Map(ctx.targets.map((t) => [t.key, t]));
      const candidates = found.map((f) => byKey.get(f.key)!).filter(Boolean) as SnapTarget[];
      s.beginMateSnap({
        nodeId: id,
        candidates,
        chosen: candidates[0]!.key,
        type: candidates[0]!.suggestedType,
        alignment: 'opposed',
      });
    };
    const up = (e: PointerEvent) => end(e);
    const cancel = (e: PointerEvent) => end(e, true);
    const click = (e: MouseEvent) => {
      if (suppressClick.current) e.stopImmediatePropagation();
    };
    el.addEventListener('pointerdown', down, { capture: true });
    el.addEventListener('pointermove', move, { capture: true });
    el.addEventListener('pointerup', up, { capture: true });
    el.addEventListener('pointercancel', cancel, { capture: true });
    el.addEventListener('click', click, { capture: true });
    return () => {
      el.removeEventListener('pointerdown', down, { capture: true });
      el.removeEventListener('pointermove', move, { capture: true });
      el.removeEventListener('pointerup', up, { capture: true });
      el.removeEventListener('pointercancel', cancel, { capture: true });
      el.removeEventListener('click', click, { capture: true });
      if (drag.current) {
        const nodeId = id;
        drag.current = null;
        store.getState().setDragging(false);
        snapDiagnostics.dragging = false;
        restore(nodeId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, id, gl, camera, registry, store]);

  // Escape during a snap drag (handled as "cancel the active manipulation").
  useEffect(() => {
    const d = drag.current;
    if (cancelDragRequest === 0 || !d || !id) return;
    drag.current = null;
    gl.domElement.releasePointerCapture?.(d.pointerId);
    store.getState().setDragging(false);
    snapDiagnostics.dragging = false;
    snapDiagnostics.candidates = [];
    setDragging(false);
    setRanked([]);
    restore(id);
    store.getState().setStatus({ tone: 'info', text: 'Snap drag cancelled — nothing was changed.' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelDragRequest]);

  // Ghost: the nearest candidate's solved mate pose (engine dry run, nothing committed).
  const nearest = dragging ? ranked[0] : undefined;
  const ghostPose = useMemo(() => {
    if (!nearest || !ctx?.ok || !id) return null;
    const t = ctx.targets.find((x) => x.key === nearest.key);
    if (!t) return null;
    const cmd = snapCommand(scene, id, t, t.suggestedType, 'opposed');
    const { result, scene: next } = store
      .getState()
      .engine.preview(makeCommand(cmd.type, cmd.payload as never, 'desktop-ui'));
    return result.ok && next ? worldMatrix(next, id) : null;
  }, [nearest, ctx, id, scene, store]);
  const ghost = useMemo(() => {
    if (!ghostPose || !id) return null;
    const src = registry.get(id);
    if (!src) return null;
    const mat = new MeshBasicMaterial({
      color: '#4ade80',
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    const g = src.clone(true);
    g.name = 'snap-ghost';
    g.traverse((o) => {
      o.raycast = () => {};
      if ((o as Mesh).isMesh) (o as Mesh).material = mat;
    });
    g.matrixAutoUpdate = false;
    const parent = registry.get(rootId)?.parent;
    const m = new Matrix4().fromArray(ghostPose);
    if (parent) m.premultiply(parent.matrixWorld);
    g.matrix.copy(m);
    g.userData = { ghostMaterial: mat };
    return g;
  }, [ghostPose, id, registry, rootId]);
  useEffect(() => {
    snapDiagnostics.ghost = !!ghost;
    invalidate();
    return () => {
      snapDiagnostics.ghost = false;
      (ghost?.userData.ghostMaterial as MeshBasicMaterial | undefined)?.dispose();
    };
  }, [ghost, invalidate]);

  // Highlights: compatible targets (amber), candidates in reach (green), chosen (bright),
  // and the dragged body's own interfaces (cyan).
  const active = !!ctx?.ok && (dragging || !!pending);
  const markers = useMemo((): MarkerItem[] => {
    if (!active || !ctx?.ok || !id) return [];
    const inReach = new Set(pending ? pending.candidates.map((c) => c.key) : ranked.map((r) => r.key));
    const chosen = pending?.chosen ?? ranked[0]?.key;
    const seen = new Set<string>();
    const out: MarkerItem[] = [];
    for (const t of ctx.targets) {
      const k = `${t.targetNodeId}|${t.targetInterfaceId}`;
      const isChosen = chosen === t.key;
      const near = inReach.has(t.key);
      if (seen.has(k) && !isChosen) continue;
      seen.add(k);
      out.push({
        key: `t:${t.key}`,
        nodeId: t.targetNodeId,
        position: t.targetLocal.p,
        direction: t.targetLocal.d,
        color: isChosen ? '#22c55e' : near ? '#86efac' : '#f59e0b',
        size: isChosen ? 1.8 : near ? 1.3 : 1,
      });
    }
    for (const s of ctx.sources)
      if (ctx.targets.some((t) => t.sourceInterfaceId === s.id))
        out.push({
          key: `s:${s.id}`,
          nodeId: id,
          position: s.position,
          direction: s.direction,
          color: '#22d3ee',
        });
    return out;
  }, [active, ctx, id, pending, ranked]);
  useEffect(() => {
    snapDiagnostics.targets = markers.filter((m) => m.key.startsWith('t:')).length;
  }, [markers]);

  return (
    <>
      {ghost && <primitive object={ghost} />}
      {markers.length > 0 && <FrameMarkers name="snap" items={markers} registry={registry} />}
    </>
  );
}
