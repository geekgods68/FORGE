import type { PrimitiveGeometry } from '@forge/engineering-core';
import { useThree } from '@react-three/fiber';
import { useLayoutEffect, useRef } from 'react';
import { Matrix4, Quaternion, Vector3, type InstancedMesh } from 'three';
import { useSharedGeometry, useSharedMaterial } from './hooks';
import type { StandardMaterialSpec } from './resources';

export interface FixturePlacement {
  position: [number, number, number];
  /** Rotation about +Y (radians). */
  yaw?: number;
  scale?: [number, number, number];
}

/**
 * Static repeated geometry (light panels, floor tiles, shelving uprights…) drawn as ONE
 * InstancedMesh = one draw call. Not raycastable: facility fixtures are never selectable.
 */
export function InstancedFixtures({
  geometry,
  material,
  placements,
  name,
}: {
  geometry: PrimitiveGeometry;
  material: StandardMaterialSpec;
  placements: readonly FixturePlacement[];
  name?: string;
}) {
  const ref = useRef<InstancedMesh>(null);
  const geo = useSharedGeometry(geometry);
  const mat = useSharedMaterial(material);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    placements.forEach((p, i) => {
      q.setFromAxisAngle(up, p.yaw ?? 0);
      m.compose(new Vector3(...p.position), q, new Vector3(...(p.scale ?? [1, 1, 1])));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [placements, invalidate]);
  return (
    <instancedMesh
      ref={ref}
      name={name}
      args={[geo, mat, placements.length]}
      raycast={() => null}
      dispose={null}
      userData={{ layer: 'facility' }}
    />
  );
}
