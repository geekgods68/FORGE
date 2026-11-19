import {
  isEffectivelyLocked,
  TransformSession,
  type ComponentDefinition,
  type NodeTransform,
  type PrimitiveGeometry,
  type SceneNode,
} from '@forge/engineering-core';
import { Edges, GizmoHelper, GizmoViewport, Grid, OrbitControls, TransformControls } from '@react-three/drei';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Box3, Box3Helper, Color, type Object3D } from 'three';
import type {
  OrbitControls as OrbitControlsImpl,
  TransformControls as TransformControlsImpl,
} from 'three-stdlib';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useEditor, useEditorStore } from '@/app/store';

const PhysicsLayer = lazy(() => import('./PhysicsLayer'));

/** Initial camera: metres, right-handed, Y-up. */
const INITIAL_CAMERA: [number, number, number] = [1.4, 1.1, 1.8];
const ORBIT_TARGET: [number, number, number] = [0, 0.15, 0];

/** node id → rendered Object3D. Renderer-side lookup only; never engineering state. */
const RegistryContext = createContext<Map<string, Object3D>>(new Map());

/**
 * The 3D viewport renders the engineering scene graph. It owns no engineering
 * state: gizmo drags are previews committed through TransformSession (one command).
 */
export function EngineeringViewport() {
  const registry = useMemo(() => new Map<string, Object3D>(), []);
  const rootId = useEditor((s) => s.project.scene.rootId);
  const select = useEditor((s) => s.select);
  const setPhysics = useEditor((s) => s.setPhysics);
  const lastDragEnd = useRef(0);
  const pointerDownAt = useRef<{ x: number; y: number } | null>(null);

  return (
    <RegistryContext.Provider value={registry}>
      <Canvas
        camera={{ position: INITIAL_CAMERA, fov: 50, near: 0.005, far: 500 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
        aria-label="FORGE 3D viewport"
        onPointerDown={(e) => (pointerDownAt.current = { x: e.clientX, y: e.clientY })}
        onPointerMissed={(e) => {
          // Deselect only on a genuine click: pointer did not travel (orbit drag) and
          // the click did not end a gizmo drag.
          const down = pointerDownAt.current;
          const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 0;
          if (e.type === 'click' && moved <= 4 && performance.now() - lastDragEnd.current > 250) select(null);
        }}
      >
        <color attach="background" args={['#2a2d33']} />
        <hemisphereLight args={['#dfe6f0', '#33363c', 0.9]} />
        <directionalLight position={[3, 5, 2]} intensity={1.8} />
        <Grid
          infiniteGrid
          cellSize={0.01}
          sectionSize={0.1}
          cellColor="#3c4048"
          sectionColor="#5d6570"
          fadeDistance={12}
          position={[0, -0.0005, 0]}
        />
        <axesHelper args={[0.5]} />
        <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
          <GizmoViewport axisColors={['#e5534b', '#57ab5a', '#539bf5']} labelColor="#111" />
        </GizmoHelper>

        <NodeView id={rootId} />
        <SelectionHighlight />
        <Manipulator onDragEnd={() => (lastDragEnd.current = performance.now())} />

        <ErrorBoundary fallback={null} onError={(e) => setPhysics({ state: 'error', detail: e.message })}>
          <Suspense fallback={null}>
            <PhysicsLayer />
          </Suspense>
        </ErrorBoundary>
        <CameraRig />
        <DebugProbe />
      </Canvas>
    </RegistryContext.Provider>
  );
}

function NodeView({ id }: { id: string }) {
  const node = useEditor((s) => s.project.scene.nodes[id]);
  const definitions = useEditor((s) => s.project.definitions);
  const selected = useEditor((s) => s.selection.includes(id));
  const select = useEditor((s) => s.select);
  const registry = useContext(RegistryContext);
  if (!node) return null;
  const isRoot = node.kind === 'root';

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return; // it was an orbit drag, not a click
    e.stopPropagation();
    select(id);
  };

  return (
    <group
      name={`node:${id}`}
      ref={(o) => {
        if (o) registry.set(id, o);
        else registry.delete(id);
      }}
      position={node.transform.position}
      quaternion={node.transform.rotation}
      scale={node.transform.scale}
      visible={node.visible}
      userData={{ nodeId: id }}
    >
      {!isRoot && <NodeBody node={node} definitions={definitions} selected={selected} onClick={onClick} />}
      {node.childIds.map((c) => (
        <NodeView key={c} id={c} />
      ))}
    </group>
  );
}

function NodeBody({
  node,
  definitions,
  selected,
  onClick,
}: {
  node: SceneNode;
  definitions: readonly ComponentDefinition[];
  selected: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  if (node.kind === 'primitive')
    return (
      <PrimitiveMesh geometry={node.geometry} color={node.color} selected={selected} onClick={onClick} />
    );
  if (node.kind === 'component-instance') {
    const def = definitions.find((d) => d.id === node.definitionId);
    const g = def?.geometry;
    const geometry: PrimitiveGeometry | null =
      g?.kind === 'box'
        ? { shape: 'box', width: g.sizeM[0], height: g.sizeM[1], depth: g.sizeM[2] }
        : g?.kind === 'cylinder'
          ? { shape: 'cylinder', radius: g.radiusM, height: g.heightM }
          : g?.kind === 'sphere'
            ? { shape: 'sphere', radius: g.radiusM }
            : null;
    return geometry ? (
      <PrimitiveMesh geometry={geometry} color="#8a93a3" selected={selected} onClick={onClick} />
    ) : (
      <mesh onClick={onClick}>
        <boxGeometry args={[0.05, 0.05, 0.05]} />
        <meshBasicMaterial color="#e5a54b" wireframe />
      </mesh>
    );
  }
  if (node.kind === 'reference')
    return (
      <group>
        <axesHelper args={[node.sizeM]} />
        <mesh onClick={onClick}>
          <sphereGeometry args={[node.sizeM * 0.06, 16, 8]} />
          <meshBasicMaterial color={selected ? '#7dd3fc' : '#f5f5f4'} />
        </mesh>
      </group>
    );
  return null; // groups/assemblies have no body of their own
}

function PrimitiveMesh({
  geometry: g,
  color,
  selected,
  onClick,
}: {
  geometry: PrimitiveGeometry;
  color: string;
  selected: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  return (
    <mesh
      onClick={onClick}
      rotation={
        g.shape === 'plane' ? [-Math.PI / 2, 0, 0] : g.shape === 'torus' ? [Math.PI / 2, 0, 0] : [0, 0, 0]
      }
    >
      {g.shape === 'box' && <boxGeometry args={[g.width, g.height, g.depth]} />}
      {g.shape === 'sphere' && <sphereGeometry args={[g.radius, 48, 24]} />}
      {g.shape === 'cylinder' && <cylinderGeometry args={[g.radius, g.radius, g.height, 48]} />}
      {g.shape === 'cone' && <coneGeometry args={[g.radius, g.height, 48]} />}
      {g.shape === 'plane' && <planeGeometry args={[g.width, g.length]} />}
      {g.shape === 'torus' && <torusGeometry args={[g.majorRadius, g.tubeRadius, 24, 64]} />}
      <meshStandardMaterial
        color={color}
        emissive={selected ? new Color('#0e7490') : new Color('#000000')}
        roughness={0.6}
        metalness={0.05}
        side={g.shape === 'plane' ? 2 : 0}
      />
      {selected && <Edges color="#7dd3fc" threshold={20} />}
    </mesh>
  );
}

/** Bounding box for selected nodes without a mesh of their own (groups). */
function SelectionHighlight() {
  const selection = useEditor((s) => s.selection);
  const nodes = useEditor((s) => s.project.scene.nodes);
  const registry = useContext(RegistryContext);
  const helper = useMemo(() => new Box3Helper(new Box3(), new Color('#7dd3fc')), []);
  const id = selection[0];
  const show = !!id && (nodes[id]?.kind === 'group' || nodes[id]?.kind === 'assembly');
  useFrame(() => {
    if (!show || !id) return;
    const o = registry.get(id);
    if (o) helper.box.setFromObject(o);
  });
  return show ? <primitive object={helper} /> : null;
}

function readTransform(o: Object3D): NodeTransform {
  return {
    position: [o.position.x, o.position.y, o.position.z],
    rotation: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w],
    scale: [o.scale.x, o.scale.y, o.scale.z],
  };
}

function writeTransform(o: Object3D, t: NodeTransform) {
  o.position.set(...t.position);
  o.quaternion.set(...t.rotation);
  o.scale.set(...t.scale);
}

/** Transform gizmo for the selected node. Commits one command per completed drag. */
function Manipulator({ onDragEnd }: { onDragEnd: () => void }) {
  const store = useEditorStore();
  const id = useEditor((s) => (s.selection.length === 1 ? s.selection[0] : undefined));
  const node = useEditor((s) => (id ? s.project.scene.nodes[id] : undefined));
  const scene = useEditor((s) => s.project.scene);
  const mode = useEditor((s) => s.toolMode);
  const snap = useEditor((s) => s.snap);
  const cancelRequest = useEditor((s) => s.cancelDragRequest);
  const registry = useContext(RegistryContext);
  const controls = useRef<TransformControlsImpl>(null);
  const session = useRef<TransformSession | null>(null);
  const cancelled = useRef(false);
  /** reset() synchronously re-dispatches objectChange; guard against recursion. */
  const resetting = useRef(false);
  const resetToStart = () => {
    if (resetting.current) return;
    resetting.current = true;
    try {
      controls.current?.reset();
    } finally {
      resetting.current = false;
    }
  };
  const [target, setTarget] = useState<Object3D | null>(null);

  const editable = !!node && node.kind !== 'root' && node.visible && !isEffectivelyLocked(scene, node.id);
  // Resolve the rendered object each frame: it may register (via ref) in the same commit as the selection.
  useFrame(() => {
    const next = editable && id ? (registry.get(id) ?? null) : null;
    if (next !== target) setTarget(next);
  });

  useEffect(() => {
    if (cancelRequest === 0 || !session.current) return;
    cancelled.current = true;
    session.current.cancel();
    resetToStart();
  }, [cancelRequest]);

  if (!target || !id) return null;
  return (
    <TransformControls
      ref={controls}
      object={target}
      mode={mode}
      size={0.8}
      translationSnap={snap.enabled ? snap.translationM : null}
      rotationSnap={snap.enabled ? snap.rotationRad : null}
      onMouseDown={() => {
        cancelled.current = false;
        session.current = new TransformSession(store.getState().engine, id);
        store.getState().setDragging(true);
      }}
      onObjectChange={() => {
        if (resetting.current) return;
        if (cancelled.current) resetToStart();
        else session.current?.preview(readTransform(target));
      }}
      onMouseUp={() => {
        const s = session.current;
        session.current = null;
        store.getState().setDragging(false);
        onDragEnd();
        const authoritative = store.getState().engine.getNode(id)?.transform;
        if (cancelled.current) {
          cancelled.current = false;
          if (authoritative) writeTransform(target, authoritative);
          store.getState().setStatus({ tone: 'info', text: 'Manipulation cancelled.' });
          return;
        }
        const result = s?.commit('desktop-ui') ?? null;
        store
          .getState()
          .report(result, mode === 'translate' ? 'Move' : mode === 'rotate' ? 'Rotate' : 'Scale');
        // Always re-sync the rendered object with engineering state (e.g. a rejected commit).
        const now = store.getState().engine.getNode(id)?.transform;
        if (now) writeTransform(target, now);
      }}
    />
  );
}

function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const resetRequest = useEditor((s) => s.cameraResetRequest);
  useEffect(() => {
    controls.current?.saveState();
  }, []);
  useEffect(() => {
    if (resetRequest > 0) controls.current?.reset();
  }, [resetRequest]);
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={ORBIT_TARGET}
      enableDamping={false}
      minDistance={0.05}
      maxDistance={60}
    />
  );
}

/** Read-only diagnostics for automated browser tests (window.__forge). No mutations. */
function DebugProbe() {
  const { camera, gl, size } = useThree();
  const registry = useContext(RegistryContext);
  const stats = useRef({ frames: 0, lastDrawCalls: 0, lastTriangles: 0 });
  useFrame(() => {
    stats.current.frames += 1;
    stats.current.lastDrawCalls = gl.info.render.calls;
    stats.current.lastTriangles = gl.info.render.triangles;
  });
  useEffect(() => {
    const w = window as unknown as { __forge?: Record<string, unknown> };
    w.__forge = {
      ...w.__forge,
      render: () => ({ ...stats.current }),
      cameraPosition: () => camera.position.toArray(),
      /** Client-pixel position of a node's origin, for pointer tests. */
      screenPointOf: (id: string) => {
        const o = registry.get(id);
        if (!o) return null;
        const v = o.getWorldPosition(o.position.clone()).project(camera);
        const rect = gl.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * size.width, y: rect.top + ((1 - v.y) / 2) * size.height };
      },
    };
  }, [camera, gl, registry, size]);
  return null;
}
