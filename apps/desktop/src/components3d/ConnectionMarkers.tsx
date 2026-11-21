import { evaluate, findCompatibleInterfaces, getDefinition } from '@forge/components';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Vector3, type Group, type Object3D } from 'three';
import { useEditor } from '@/app/store';
import { useSharedGeometry, useSharedMaterial } from '@/rendering/hooks';
import { markerStats } from './markers';

/**
 * Connection-point preview: the focused interface (cyan) and every interface in the
 * project whose DECLARED metadata is compatible (green). Proximity plays no part, and
 * nothing is connected — this is inspection only (mating is Phase 4).
 */
export function ConnectionMarkers({ registry }: { registry: Map<string, Object3D> }) {
  const focus = useEditor((s) => s.connectionFocus);
  const project = useEditor((s) => s.project);
  const points = useMemo(() => {
    if (!focus) return [];
    const local = (nodeId: string, interfaceId: string) => {
      const n = project.scene.nodes[nodeId];
      if (!n || n.kind !== 'component-instance' || !n.component) return null;
      const def = getDefinition(n.definitionId);
      const i =
        def &&
        evaluate(def, n.component.parameters, n.component.materialId).interfaces.find(
          (x) => x.id === interfaceId,
        );
      return i ? { nodeId, position: i.position } : null;
    };
    const src = local(focus.nodeId, focus.interfaceId);
    if (!src) return [];
    const targets = findCompatibleInterfaces(project, focus.nodeId, focus.interfaceId).flatMap(
      (t) => local(t.nodeId, t.interfaceId) ?? [],
    );
    return [{ ...src, source: true }, ...targets.map((t) => ({ ...t, source: false }))];
  }, [focus, project]);
  const geometry = useSharedGeometry({ shape: 'sphere', radius: 0.0025 });
  const src = useSharedMaterial({ color: '#22d3ee', emissive: '#22d3ee' });
  const ok = useSharedMaterial({ color: '#4ade80', emissive: '#16a34a' });
  useEffect(() => {
    markerStats.count = points.length;
    return () => {
      markerStats.count = 0;
    };
  }, [points]);
  const refs = useRef<(Group | null)[]>([]);
  const v = useMemo(() => new Vector3(), []);
  useFrame(() => {
    points.forEach((p, i) => {
      const g = refs.current[i];
      const o = registry.get(p.nodeId);
      if (!g || !o) return;
      g.position.copy(o.localToWorld(v.set(...p.position)));
      g.visible = true;
    });
  });
  return (
    <group name="connection-markers">
      {points.map((p, i) => (
        <group key={`${p.nodeId}:${i}`} ref={(g) => void (refs.current[i] = g)} visible={false}>
          <mesh
            geometry={geometry}
            material={p.source ? src : ok}
            raycast={() => null}
            dispose={null}
            renderOrder={10}
          />
        </group>
      ))}
    </group>
  );
}
