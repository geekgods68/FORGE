import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PointsMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Object3D,
  type Points,
} from 'three';
import { ConvexGeometry } from 'three-stdlib';
import { useStore } from 'zustand';
import { useEditorStore } from '@/app/store';
import { simulationFor } from '@/features/simulation/controller';
import type { ModelBody } from '@forge/physics';

const tmp = new Matrix4();
const parentInv = new Matrix4();
const local = new Matrix4();
const pos = new Vector3();
const quat = new Quaternion();
const scl = new Vector3();

/**
 * Simulation display (Simulation mode only). Each frame: advance the physics session by
 * real elapsed time (fixed steps), then place every moving body unit's rendered object at
 * its SIMULATED pose. This is display only — the engineering scene graph is never written;
 * leaving Simulation mode restores every object to its CAD pose.
 */
export function SimulationLayer({ registry }: { registry: Map<string, Object3D> }) {
  const editor = useEditorStore();
  const c = simulationFor(editor);
  const showColliders = useStore(c.ui, (s) => s.showColliders);
  const showContacts = useStore(c.ui, (s) => s.showContacts);
  const runId = useStore(c.ui, (s) => s.runId);
  const state = useRef({ originals: new Map<string, { p: Vector3; q: Quaternion; o: Object3D }>() });

  useEffect(() => {
    const originals = state.current.originals;
    return () => {
      for (const { p, q, o } of originals.values()) {
        o.position.copy(p);
        o.quaternion.copy(q);
      }
      originals.clear();
    };
  }, []);

  useFrame((_, delta) => {
    c.tick(delta);
    const s = c.session;
    const originals = state.current.originals;
    const touched = new Set<string>();
    if (s)
      for (const b of s.model.bodies) {
        if (b.mode === 'fixed') continue;
        for (const u of b.unitIds) {
          const o = registry.get(u);
          const M = s.unitWorldMatrix(u);
          if (!o || !M || !o.parent) continue;
          if (!originals.has(u)) originals.set(u, { p: o.position.clone(), q: o.quaternion.clone(), o });
          touched.add(u);
          tmp.fromArray(M);
          parentInv.copy(o.parent.matrixWorld).invert();
          local.multiplyMatrices(parentInv, tmp).decompose(pos, quat, scl);
          o.position.copy(pos);
          o.quaternion.copy(quat);
        }
      }
    for (const [u, v] of originals)
      if (!touched.has(u)) {
        v.o.position.copy(v.p);
        v.o.quaternion.copy(v.q);
        originals.delete(u);
      }
  });

  return (
    <>
      {showColliders && runId && <ColliderOverlay key={runId} />}
      {showContacts && <ContactOverlay />}
    </>
  );
}

const MATERIALS = {
  dynamic: new MeshBasicMaterial({
    color: '#22d3ee',
    wireframe: true,
    depthTest: false,
    transparent: true,
    opacity: 0.8,
  }),
  fixed: new MeshBasicMaterial({
    color: '#9ca3af',
    wireframe: true,
    depthTest: false,
    transparent: true,
    opacity: 0.5,
  }),
  kinematic: new MeshBasicMaterial({
    color: '#facc15',
    wireframe: true,
    depthTest: false,
    transparent: true,
    opacity: 0.8,
  }),
};

function colliderGeometry(c: ModelBody['colliders'][number]): BufferGeometry {
  switch (c.shape.type) {
    case 'cuboid':
      return new BoxGeometry(c.shape.half[0] * 2, c.shape.half[1] * 2, c.shape.half[2] * 2);
    case 'ball':
      return new SphereGeometry(c.shape.radius, 12, 8);
    case 'cylinder':
      return new CylinderGeometry(c.shape.radius, c.shape.radius, c.shape.halfHeight * 2, 16);
    case 'convex': {
      const pts: Vector3[] = [];
      for (let i = 0; i < c.shape.points.length; i += 3)
        pts.push(new Vector3(c.shape.points[i], c.shape.points[i + 1], c.shape.points[i + 2]));
      return new ConvexGeometry(pts);
    }
  }
}

/** Contact geometry (wireframes), separate from display geometry: what the solver collides. */
function ColliderOverlay() {
  const c = simulationFor(useEditorStore());
  const model = c.session?.model;
  const groups = useRef(new Map<string, Group>());
  const built = useMemo(() => {
    if (!model) return [];
    return model.bodies.map((b) => {
      const g = new Group();
      for (const col of b.colliders) {
        const m = new Mesh(colliderGeometry(col), MATERIALS[b.mode]);
        m.position.set(...col.position);
        m.quaternion.set(...col.rotation);
        g.add(m);
      }
      return { id: b.id, g };
    });
  }, [model]);
  useEffect(
    () => () => {
      for (const { g } of built)
        g.traverse((o) => {
          const geo = (o as unknown as { geometry?: BufferGeometry }).geometry;
          geo?.dispose();
        });
    },
    [built],
  );
  useFrame(() => {
    const s = c.session;
    if (!s) return;
    for (const { id } of built) {
      const g = groups.current.get(id);
      const pose = s.bodyPose(id);
      if (!g || !pose) continue;
      g.position.set(...pose.p);
      g.quaternion.set(...pose.q);
    }
  });
  return (
    <group name="simulation-colliders" renderOrder={10}>
      {built.map(({ id, g }) => (
        <primitive
          key={id}
          object={g}
          ref={(o: Group | null) => {
            if (o) groups.current.set(id, o);
            else groups.current.delete(id);
          }}
        />
      ))}
    </group>
  );
}

const CONTACT_CAPACITY = 256;
function ContactOverlay() {
  const c = simulationFor(useEditorStore());
  const ref = useRef<Points>(null);
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(CONTACT_CAPACITY * 3), 3));
    g.setDrawRange(0, 0);
    return g;
  }, []);
  const material = useMemo(
    () => new PointsMaterial({ color: '#f43f5e', size: 6, sizeAttenuation: false, depthTest: false }),
    [],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  useFrame(() => {
    const pts = c.session?.contactPoints(CONTACT_CAPACITY) ?? [];
    const attr = geometry.getAttribute('position') as BufferAttribute;
    pts.forEach((p, i) => attr.setXYZ(i, p[0], p[1], p[2]));
    attr.needsUpdate = true;
    geometry.setDrawRange(0, pts.length);
    ref.current?.geometry.computeBoundingSphere();
  });
  return (
    <points ref={ref} geometry={geometry} material={material} renderOrder={11} name="simulation-contacts" />
  );
}
