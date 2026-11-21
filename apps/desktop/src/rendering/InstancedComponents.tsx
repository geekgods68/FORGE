import { getMaterial, type Appearance } from '@forge/components';
import { compose, worldMatrix, type SceneGraph } from '@forge/engineering-core';
import type { ThreeEvent } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import { useLayoutEffect, useRef } from 'react';
import { Matrix4, type BufferGeometry, type InstancedMesh } from 'three';
import { appearanceSpec } from '@/components3d/appearance';
import { useComponentGeometry } from '@/components3d/hooks';
import { useEditor } from '@/app/store';
import { useSharedMaterial } from './hooks';
import type { ComponentBatch } from './componentBatches';

type Offsets = Record<string, [number, number, number]>;

/** World matrix of a node as displayed (including a view-only explode offset on itself). */
function displayMatrix(graph: SceneGraph, id: string, offsets: Offsets, out: Matrix4) {
  const n = graph.nodes[id]!;
  const parent = n.parentId ? worldMatrix(graph, n.parentId) : null;
  const o = offsets[id];
  const p = n.transform.position;
  const local = compose({
    ...n.transform,
    position: o ? [p[0] + o[0], p[1] + o[1], p[2] + o[2]] : p,
  });
  out.fromArray(local);
  if (parent) out.premultiply(new Matrix4().fromArray(parent));
  return out;
}

/** One configuration's instances: one InstancedMesh (= one draw call) per appearance. */
export function InstancedBatch({
  batch,
  graph,
  offsets,
}: {
  batch: ComponentBatch;
  graph: SceneGraph;
  offsets: Offsets;
}) {
  const entry = useComponentGeometry(batch.definitionId, batch.parameters, batch.materialId);
  if (!entry) return null;
  return (
    <group name={`instanced:${batch.definitionId}`}>
      {[...entry.geometries].map(([app, geometry]) => (
        <AppearanceInstances
          key={app}
          app={app}
          geometry={geometry}
          materialId={batch.materialId}
          ids={batch.ids}
          graph={graph}
          offsets={offsets}
        />
      ))}
    </group>
  );
}

function AppearanceInstances({
  app,
  geometry,
  materialId,
  ids,
  graph,
  offsets,
}: {
  app: Appearance;
  geometry: BufferGeometry;
  materialId: string | null;
  ids: readonly string[];
  graph: SceneGraph;
  offsets: Offsets;
}) {
  const ref = useRef<InstancedMesh>(null);
  const select = useEditor((s) => s.select);
  const layoutActive = useEditor((s) => s.view === 'facility' && s.editLayer === 'layout');
  const material = useSharedMaterial(appearanceSpec(app, getMaterial(materialId), 'none'));
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new Matrix4();
    ids.forEach((id, i) => mesh.setMatrixAt(i, displayMatrix(graph, id, offsets, m)));
    mesh.count = ids.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
    invalidate();
  }, [ids, graph, offsets, invalidate]);
  useLayoutEffect(() => {
    const mesh = ref.current;
    return () => mesh?.dispose(); // per-mesh instance buffer only; geometry/material are shared
  }, []);
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4 || layoutActive || e.instanceId === undefined) return;
    e.stopPropagation();
    select(ids[e.instanceId] ?? null);
  };
  return (
    <instancedMesh
      // A new capacity needs a new buffer: remount when the instance count changes.
      key={ids.length}
      ref={ref}
      args={[geometry, material, ids.length]}
      onClick={onClick}
      dispose={null}
      userData={{ instancedIds: ids }}
    />
  );
}
