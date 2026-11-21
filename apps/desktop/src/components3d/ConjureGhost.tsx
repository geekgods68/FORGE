import { getDefinition, resolveParameters, type ParamValues } from '@forge/components';
import { chainToFacility, getEquipment, getZone, mountChain } from '@forge/facility';
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Matrix4, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { useEditor, useEditorStore } from '@/app/store';
import { useSharedMaterial } from '@/rendering/hooks';
import { BUILD_AREA_HALF_M, fitsSurface, publishGhost, publishSurface } from './ghost';
import { useComponentGeometry } from './hooks';

/**
 * Ghost-preview placement for conjuring. The ghost is a renderer-only object (never in
 * the engineering scene graph) that follows the pointer over the ACTIVE WORK SURFACE:
 *   facility view → the work surface (frame M) of the bench hosting the project;
 *   project view  → the project's 2 × 2 m build area on y = 0.
 * Placement is valid when the rotated footprint lies inside that surface. Clicking a
 * valid spot issues ONE `scene.node.create` command (undoable); Esc cancels.
 * Positions are snapped to the editor grid in the PROJECT frame, so relocating the
 * project to another bench later never rewrites component-local coordinates.
 */
export function ConjureGhost() {
  const conjure = useEditor((s) => s.conjure);
  if (!conjure) return null;
  return <Ghost key={`${conjure.definitionId}|${conjure.variantId}|${JSON.stringify(conjure.parameters)}`} />;
}

function Ghost() {
  const store = useEditorStore();
  const conjure = useEditor((s) => s.conjure)!;
  const view = useEditor((s) => s.view);
  const projectId = useEditor((s) => s.project.id);
  const items = useEditor((s) => s.layout.items);
  const snap = useEditor((s) => s.snap);
  const { camera, gl, invalidate } = useThree();
  const def = getDefinition(conjure.definitionId);
  const params = useMemo(
    () => (def ? resolveParameters(def, conjure.variantId, conjure.parameters).values : {}),
    [def, conjure.variantId, conjure.parameters],
  ) as ParamValues;
  const entry = useComponentGeometry(
    conjure.definitionId,
    params,
    conjure.materialId ?? def?.materialId ?? null,
  );
  const okMat = useSharedMaterial({
    color: '#22d3ee',
    emissive: '#0e7490',
    opacity: 0.45,
    depthWrite: false,
  });
  const badMat = useSharedMaterial({
    color: '#ef4444',
    emissive: '#7f1d1d',
    opacity: 0.45,
    depthWrite: false,
  });

  // Active surface: frame + work-surface half-extents (project frame).
  const surface = useMemo(() => {
    if (view === 'project')
      return {
        frame: new Matrix4(),
        half: [BUILD_AREA_HALF_M, BUILD_AREA_HALF_M] as [number, number],
        kind: 'build-area' as const,
      };
    const bench = Object.values(items).find((i) => i.mountedProjectId === projectId);
    const zone = bench && getZone(bench.zoneId);
    const eq = bench && getEquipment(bench.equipmentId);
    const chain = zone && eq && bench ? mountChain(zone, bench, eq) : null;
    if (!chain || !eq?.workSurfaceM) return null;
    return {
      frame: new Matrix4().fromArray(chainToFacility(chain)),
      half: [eq.workSurfaceM[0] / 2, eq.workSurfaceM[1] / 2] as [number, number],
      kind: 'bench' as const,
    };
  }, [view, items, projectId]);

  const [pose, setPose] = useState<{ position: [number, number, number]; valid: boolean } | null>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  const poseRef = useRef(pose);
  useEffect(() => {
    poseRef.current = pose;
  }, [pose]);

  useEffect(() => {
    publishSurface(
      surface
        ? {
            kind: surface.kind,
            centre: new Vector3().setFromMatrixPosition(surface.frame).toArray() as [number, number, number],
          }
        : null,
    );
    if (!surface)
      store.getState().setStatus({
        tone: 'error',
        text: 'Mount the project on a workbench (Layout → Mount here) to conjure in the facility, or switch to the Project view.',
      });
    return () => publishSurface(undefined);
  }, [surface, store]);

  useEffect(() => {
    if (!surface || !entry) return;
    const el = gl.domElement;
    const inv = surface.frame.clone().invert();
    const plane = new Plane().setFromNormalAndCoplanarPoint(
      new Vector3(0, 1, 0),
      new Vector3().setFromMatrixPosition(surface.frame),
    );
    const ray = new Raycaster();
    const ndc = new Vector2();
    const hit = new Vector3();
    const size = entry.evaluation.size;
    const step = snap.enabled ? snap.translationM : 0;
    const q = (v: number) => (step > 0 ? Math.round(v / step) * step : v);
    const fits = (p: [number, number, number], yaw: number) => fitsSurface(surface.half, size, p, yaw);
    const update = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      if (!ray.ray.intersectPlane(plane, hit)) return setPose(null);
      const local = hit.clone().applyMatrix4(inv);
      const position: [number, number, number] = [+q(local.x).toFixed(9), 0, +q(local.z).toFixed(9)];
      setPose({ position, valid: fits(position, store.getState().conjure?.yaw ?? 0) });
      invalidate();
    };
    const move = (e: PointerEvent) => update(e.clientX, e.clientY);
    const pdown = (e: PointerEvent) => (down.current = { x: e.clientX, y: e.clientY });
    // Capture phase on window: a placement click must not also select/deselect scene objects.
    const click = (e: MouseEvent) => {
      if (e.target !== el) return;
      const d = down.current;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return; // orbit drag, not a placement
      e.stopPropagation();
      update(e.clientX, e.clientY);
      const p = poseRef.current;
      queueMicrotask(() => {
        const now = poseRef.current ?? p;
        if (!now) return;
        if (!fits(now.position, store.getState().conjure?.yaw ?? 0)) {
          store.getState().setStatus({
            tone: 'error',
            text: `Invalid placement: the part must fit inside the ${surface.kind === 'bench' ? 'workbench surface' : 'build area'}.`,
          });
          return;
        }
        store.getState().confirmConjure(now.position);
      });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', pdown);
    window.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerdown', pdown);
      window.removeEventListener('click', click, true);
    };
  }, [surface, entry, camera, gl, snap, store, invalidate]);

  const yaw = conjure.yaw;
  useEffect(() => invalidate(), [yaw, invalidate]);
  useEffect(() => {
    publishGhost(
      pose && surface && entry
        ? {
            position: pose.position,
            valid: fitsSurface(surface.half, entry.evaluation.size, pose.position, yaw),
          }
        : null,
    );
  }, [pose, surface, entry, yaw]);
  if (!surface || !entry || !pose) return null;
  const valid = fitsSurface(surface.half, entry.evaluation.size, pose.position, yaw);
  const matrix = surface.frame
    .clone()
    .multiply(new Matrix4().makeRotationY(yaw).setPosition(...pose.position));
  return (
    <group name="conjure-ghost" matrix={matrix} matrixAutoUpdate={false} raycast={() => null}>
      {[...entry.geometries.values()].map((g, i) => (
        <mesh key={i} geometry={g} material={valid ? okMat : badMat} raycast={() => null} dispose={null} />
      ))}
    </group>
  );
}
