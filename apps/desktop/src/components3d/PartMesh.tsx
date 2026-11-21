import { getMaterial } from '@forge/components';
import type { Feature, SceneNode } from '@forge/engineering-core';
import { evaluatePart } from '@forge/mechanics';
import { Edges, Line } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { useSharedMaterial } from '@/rendering/hooks';
import { appearanceSpec } from './appearance';
import { buildAppearanceGeometries } from './geometry';

/**
 * A feature-based part (Phase 4 prismatic kernel): the regenerated solids for the current
 * feature list. Geometry is rebuilt only when the features change and disposed after.
 * The engine refuses invalid feature edits, so a failed evaluation here means a part
 * loaded from a file that this build cannot regenerate: it is shown as a labelled outline.
 */
export function PartMesh({
  features,
  materialId,
  selected,
  onClick,
}: {
  features: readonly Feature[];
  materialId: string | null;
  selected: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const result = useMemo(() => evaluatePart(features), [features]);
  const geometries = useMemo(
    () => (result.ok ? buildAppearanceGeometries(result.geometry.solids) : null),
    [result],
  );
  useEffect(() => () => geometries?.forEach((g) => g.dispose()), [geometries]);
  const material = useSharedMaterial(
    appearanceSpec('primary', getMaterial(materialId), selected ? 'selected' : 'none'),
  );
  if (!geometries)
    return (
      <mesh name="part-invalid" onClick={onClick}>
        <boxGeometry args={[0.05, 0.005, 0.05]} />
        <meshBasicMaterial color="#ef4444" wireframe />
      </mesh>
    );
  return (
    <group name="part">
      {[...geometries.values()].map((g, i) => (
        <mesh key={i} geometry={g} material={material} onClick={onClick} dispose={null}>
          <Edges color={selected ? '#7dd3fc' : '#1f2328'} threshold={25} />
        </mesh>
      ))}
    </group>
  );
}

type SketchNode = Extract<SceneNode, { kind: 'sketch' }>;

/** A 2D sketch drawn in its local XZ plane (sketch x → X, sketch y → Z), lines and circles. */
export function SketchLines({
  node,
  selected,
  onClick,
}: {
  node: SketchNode;
  selected: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const segments = useMemo(() => {
    const pts = new Map<string, { x: number; y: number }>();
    for (const e of node.entities) if (e.kind === 'point') pts.set(e.id, e);
    const out: [number, number, number][][] = [];
    const at = (id: string): [number, number, number] => {
      const p = pts.get(id)!;
      return [p.x, 0, p.y];
    };
    for (const e of node.entities) {
      if (e.kind === 'line' && pts.has(e.p1) && pts.has(e.p2)) out.push([at(e.p1), at(e.p2)]);
      if (e.kind === 'circle' && pts.has(e.center)) {
        const c = pts.get(e.center)!;
        out.push(
          Array.from({ length: 65 }, (_, i) => {
            const a = (i / 64) * Math.PI * 2;
            return [c.x + e.r * Math.cos(a), 0, c.y + e.r * Math.sin(a)] as [number, number, number];
          }),
        );
      }
      if (e.kind === 'arc' && pts.has(e.center) && pts.has(e.start) && pts.has(e.end)) {
        const c = pts.get(e.center)!;
        const s = pts.get(e.start)!;
        const t = pts.get(e.end)!;
        const r = Math.hypot(s.x - c.x, s.y - c.y);
        const a0 = Math.atan2(s.y - c.y, s.x - c.x);
        let a1 = Math.atan2(t.y - c.y, t.x - c.x);
        if (a1 <= a0) a1 += Math.PI * 2;
        out.push(
          Array.from({ length: 33 }, (_, i) => {
            const a = a0 + ((a1 - a0) * i) / 32;
            return [c.x + r * Math.cos(a), 0, c.y + r * Math.sin(a)] as [number, number, number];
          }),
        );
      }
    }
    return out;
  }, [node.entities]);
  return (
    <group name="sketch" onClick={onClick}>
      {segments.map((pts, i) => (
        <Line
          key={i}
          points={pts}
          color={selected ? '#7dd3fc' : '#fbbf24'}
          lineWidth={selected ? 2.5 : 1.5}
        />
      ))}
    </group>
  );
}
