import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { frameMarkerStats } from './markers';
import {
  ArrowHelper,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  type Object3D,
} from 'three';

/**
 * Interface frame markers (renderer-only; never in the scene graph): a dot at the
 * interface origin and an arrow along its mounting axis, positioned every frame from the
 * owning node's RENDERED object (so they follow drags, previews, explode offsets and the
 * facility mount). Sizes are constant on screen. Used for user-declared imported-model
 * interfaces and for drag-to-snap targets.
 */
export interface MarkerItem {
  key: string;
  nodeId: string;
  /** Interface origin and axis in the node's local frame (metres / unit vector). */
  position: readonly [number, number, number];
  direction: readonly [number, number, number];
  color: string;
  /** Relative size (1 = default). */
  size?: number;
}

const SPHERE = new SphereGeometry(1, 12, 8);

export function FrameMarkers({
  name,
  items,
  registry,
}: {
  name: string;
  items: readonly MarkerItem[];
  registry: Map<string, Object3D>;
}) {
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const built = useMemo(() => {
    const materials = new Map<string, MeshBasicMaterial>();
    const mat = (c: string) => {
      let m = materials.get(c);
      if (!m) {
        m = new MeshBasicMaterial({
          color: new Color(c),
          depthTest: false,
          transparent: true,
          opacity: 0.95,
        });
        materials.set(c, m);
      }
      return m;
    };
    const root = new Group();
    root.name = `markers:${name}`;
    const parts = items.map((it) => {
      const g = new Group();
      const dot = new Mesh(SPHERE, mat(it.color));
      dot.renderOrder = 20;
      dot.raycast = () => {};
      const arrow = new ArrowHelper(new Vector3(0, 1, 0), new Vector3(), 1, new Color(it.color).getHex());
      arrow.traverse((o) => {
        o.renderOrder = 20;
        o.raycast = () => {};
        const m = (o as Mesh).material as MeshBasicMaterial | undefined;
        if (m) m.depthTest = false;
      });
      g.add(dot, arrow);
      g.visible = false;
      g.userData = { markerKey: it.key, item: it };
      root.add(g);
      return { it, g, dot, arrow };
    });
    return { root, parts, materials };
  }, [items, name]);
  useEffect(() => {
    frameMarkerStats[name] = items.map((i) => i.key);
    invalidate();
    return () => {
      delete frameMarkerStats[name];
      for (const m of built.materials.values()) m.dispose();
      for (const p of built.parts) p.arrow.dispose();
    };
  }, [built, items, name, invalidate]);
  // Per-frame placement of the marker objects (reached through a ref; no React state).
  const holder = useRef<Group>(null);
  useFrame(() => {
    const root = holder.current?.children[0];
    if (!root) return;
    const p = new Vector3();
    const d = new Vector3();
    for (const g of root.children) {
      const it = g.userData.item as MarkerItem;
      const [dot, arrow] = g.children as [Mesh, ArrowHelper];
      const o = registry.get(it.nodeId);
      if (!o) {
        g.visible = false;
        continue;
      }
      o.updateWorldMatrix(true, false);
      p.set(...it.position).applyMatrix4(o.matrixWorld);
      d.set(...it.direction).transformDirection(o.matrixWorld);
      const s = camera.position.distanceTo(p) * 0.006 * (it.size ?? 1);
      g.position.copy(p);
      dot.scale.setScalar(s);
      arrow.setDirection(d);
      arrow.setLength(s * 7, s * 2.5, s * 1.5);
      g.visible = true;
    }
  });
  return (
    <group ref={holder}>
      <primitive object={built.root} />
    </group>
  );
}
