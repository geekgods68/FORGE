import {
  isEffectivelyLocked,
  isMateDriven,
  TransformSession,
  type ComponentDefinition,
  type NodeTransform,
  type PrimitiveGeometry,
  type SceneNode,
} from '@forge/engineering-core';
import { Edges, GizmoHelper, GizmoViewport, Grid, OrbitControls, TransformControls } from '@react-three/drei';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Box3, Box3Helper, Color, Sphere, InstancedMesh, Vector3, type Object3D } from 'three';
import { ComponentMesh } from '@/components3d/ComponentMesh';
import { PartMesh, SketchLines } from '@/components3d/PartMesh';
import { ModelInstanceMesh } from '@/components3d/ModelInstanceMesh';
import { ConjureGhost } from '@/components3d/ConjureGhost';
import { ghostDiagnostics } from '@/components3d/ghost';
import { componentCacheStats } from '@/components3d/cache';
import { ConnectionMarkers } from '@/components3d/ConnectionMarkers';
import { markerStats } from '@/components3d/markers';
import { FacilityScene } from '@/facility/FacilityScene';
import { WalkControls } from '@/facility/WalkControls';
import { useSharedGeometry, useSharedMaterial } from '@/rendering/hooks';
import { resourceStats } from '@/rendering/resources';
import { estimateGpuMemory } from '@/rendering/gpuEstimate';
import type {
  OrbitControls as OrbitControlsImpl,
  TransformControls as TransformControlsImpl,
} from 'three-stdlib';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { explodeOffsets } from '@forge/mechanics';
import { InstancedBatch } from '@/rendering/InstancedComponents';
import { planComponentBatches } from '@/rendering/componentBatches';
import { useEditor, useEditorStore } from '@/app/store';
import { FrameMarkers, type MarkerItem } from '@/components3d/FrameMarkers';
import { frameMarkerStats } from '@/components3d/markers';
import { snapDiagnostics } from '@/features/snap/snapDiagnostics';
import { SnapController } from './SnapDrag';
import { SimulationLayer } from './SimulationLayer';
import { simulationFor } from '@/features/simulation/controller';
import { CircuitLayer3D } from '@/features/electronics/CircuitLayer3D';
import { useStore } from 'zustand';
import { bodyInterfaces } from '@forge/mechanics';

const PhysicsLayer = lazy(() => import('./PhysicsLayer'));

/** Initial camera: metres, right-handed, Y-up. */
const INITIAL_CAMERA: [number, number, number] = [1.4, 1.1, 1.8];
const ORBIT_TARGET: [number, number, number] = [0, 0.15, 0];

/** node id → rendered Object3D. Renderer-side lookup only; never engineering state. */
const RegistryContext = createContext<Map<string, Object3D>>(new Map());
/** View-only explode offsets (parent-assembly frame, metres) for the exploded assembly's members. */
const ExplodeContext = createContext<Record<string, [number, number, number]>>({});
/** Nodes whose body is drawn by an instanced batch (their NodeView keeps only the transform). */
const InstancedContext = createContext<ReadonlySet<string>>(new Set());
/** Renderer diagnostics for the current instancing plan (read by the debug probe). */
const instancingStats = { batches: 0, instanced: 0, drawn: [] as { definitionId: string; count: number }[] };

/**
 * The 3D viewport renders the engineering scene graph. It owns no engineering
 * state: gizmo drags are previews committed through TransformSession (one command).
 */
export function EngineeringViewport() {
  const registry = useMemo(() => new Map<string, Object3D>(), []);
  const rootId = useEditor((s) => s.project.scene.rootId);
  const select = useEditor((s) => s.select);
  const setPhysics = useEditor((s) => s.setPhysics);
  // Demand rendering: frames are drawn only when something changes (camera, drag, state),
  // unless a subsystem (e.g. a future running simulation) requests continuous rendering.
  const continuous = useEditor((s) => s.continuousReasons.length > 0);
  const view = useEditor((s) => s.view);
  const workMode = useEditor((s) => s.workMode);
  const lastDragEnd = useRef(0);
  const walking = useEditor((s) => s.navMode === 'walk' && s.view === 'facility');
  const pointerDownAt = useRef<{ x: number; y: number } | null>(null);
  const explode = useEditor((s) => s.explode);
  const sceneGraph = useEditor((s) => s.previewScene ?? s.project.scene);
  const offsets = useMemo(
    () => (explode ? explodeOffsets(sceneGraph, explode.assemblyId, explode.factor) : {}),
    [explode, sceneGraph],
  );

  return (
    <RegistryContext.Provider value={registry}>
      <ExplodeContext.Provider value={offsets}>
        <Canvas
          camera={{ position: INITIAL_CAMERA, fov: 50, near: 0.005, far: 500 }}
          dpr={[1, 2]}
          frameloop={continuous ? 'always' : 'demand'}
          gl={{ antialias: true }}
          onCreated={({ gl }) => {
            // Accumulate render stats across all passes per frame (reset in DebugProbe).
            gl.info.autoReset = false;
          }}
          aria-label="FORGE 3D viewport"
          onPointerDown={(e) => (pointerDownAt.current = { x: e.clientX, y: e.clientY })}
          onPointerMissed={(e) => {
            // Deselect only on a genuine click: pointer did not travel (orbit drag) and
            // the click did not end a gizmo drag.
            const down = pointerDownAt.current;
            const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 0;
            if (e.type === 'click' && moved <= 4 && performance.now() - lastDragEnd.current > 250)
              select(null);
          }}
        >
          {view === 'facility' ? (
            // Facility: architecture + workspace + the project mounted on its bench (frame M).
            <FacilityScene project={<ProjectContent rootId={rootId} />} />
          ) : (
            <ProjectStage rootId={rootId} />
          )}
          <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
            <GizmoViewport axisColors={['#e5534b', '#57ab5a', '#539bf5']} labelColor="#111" />
          </GizmoHelper>
          <SelectionHighlight />
          <Manipulator onDragEnd={() => (lastDragEnd.current = performance.now())} />

          <ErrorBoundary fallback={null} onError={(e) => setPhysics({ state: 'error', detail: e.message })}>
            <Suspense fallback={null}>
              <PhysicsLayer />
            </Suspense>
          </ErrorBoundary>
          <CameraRig />
          {walking && <WalkControls />}
          <ConjureGhost />
          <ConnectionMarkers registry={registry} />
          <SnapController
            registry={registry}
            rootId={rootId}
            onDragEnd={() => (lastDragEnd.current = performance.now())}
          />
          <SelectedInterfaceMarkers registry={registry} />
          {workMode === 'simulation' && <SimulationLayer registry={registry} />}
          {workMode !== 'cad' && <CircuitLayer3D registry={registry} />}
          <InterferenceHighlights />
          <DebugProbe />
        </Canvas>
      </ExplodeContext.Provider>
    </RegistryContext.Provider>
  );
}

/** Project view: the engineering scene at its own origin with the measurement grid. */
function ProjectStage({ rootId }: { rootId: string }) {
  return (
    <>
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
      <ProjectContent rootId={rootId} />
    </>
  );
}

/**
 * The engineering scene graph as rendered in either view (project stage, or mounted on a
 * bench in the facility): repeated identical components are drawn by instanced batches,
 * everything else by NodeView. Batches are siblings of the root node's group, so both are
 * in the same (project) frame wherever the project is mounted.
 */
function ProjectContent({ rootId }: { rootId: string }) {
  const graph = useEditor((s) => s.previewScene ?? s.project.scene);
  const selection = useEditor((s) => s.selection);
  const offsets = useContext(ExplodeContext);
  const simulating = useEditor((s) => s.workMode === 'simulation');
  const moving = useStore(simulationFor(useEditorStore()).ui, (s) => s.movingUnits);
  // Bodies moved by the simulation are drawn individually (their poses change every frame).
  const excluded = useMemo(
    () => (simulating ? [...selection, ...moving] : selection),
    [simulating, selection, moving],
  );
  const batches = useMemo(() => planComponentBatches(graph, excluded), [graph, excluded]);
  const instanced = useMemo(() => new Set(batches.flatMap((b) => b.ids)), [batches]);
  useEffect(() => {
    instancingStats.batches = batches.length;
    instancingStats.instanced = instanced.size;
    instancingStats.drawn = batches.map((b) => ({ definitionId: b.definitionId, count: b.ids.length }));
  }, [batches, instanced]);
  return (
    <>
      <InstancedContext.Provider value={instanced}>
        <NodeView id={rootId} />
      </InstancedContext.Provider>
      {batches.map((b) => (
        <InstancedBatch key={b.key} batch={b} graph={graph} offsets={offsets} />
      ))}
    </>
  );
}

function NodeView({ id }: { id: string }) {
  // A pending dry-run (e.g. a mate being previewed) is displayed in place of the model.
  const node = useEditor((s) => (s.previewScene ?? s.project.scene).nodes[id]);
  const definitions = useEditor((s) => s.project.definitions);
  const selected = useEditor((s) => s.selection.includes(id));
  const select = useEditor((s) => s.select);
  const layoutActive = useEditor((s) => s.view === 'facility' && s.editLayer === 'layout');
  const walkingNav = useEditor((s) => s.navMode === 'walk');
  const registry = useContext(RegistryContext);
  const offset = useContext(ExplodeContext)[id];
  const instancedBody = useContext(InstancedContext).has(id);
  if (!node) return null;
  const isRoot = node.kind === 'root';
  const p = node.transform.position;
  const position: [number, number, number] = offset
    ? [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]]
    : [p[0], p[1], p[2]];

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return; // it was an orbit drag, not a click
    if (layoutActive) return; // layout editing: let the click reach the equipment underneath
    if (walkingNav) return; // walking: clicks capture the mouse, never edit
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
      position={position}
      quaternion={node.transform.rotation}
      scale={node.transform.scale}
      visible={node.visible}
      userData={{ nodeId: id }}
    >
      {!isRoot && !instancedBody && (
        <NodeBody node={node} definitions={definitions} selected={selected} onClick={onClick} />
      )}
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
  if (node.kind === 'component-instance' && node.component)
    return (
      <ComponentMesh
        definitionId={node.definitionId}
        component={node.component}
        selected={selected}
        onClick={onClick}
      />
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
  if (node.kind === 'part')
    return (
      <PartMesh features={node.features} materialId={node.materialId} selected={selected} onClick={onClick} />
    );
  if (node.kind === 'sketch') return <SketchLines node={node} selected={selected} onClick={onClick} />;
  if (node.kind === 'model-instance')
    return <ModelInstanceMesh node={node} selected={selected} onClick={onClick} />;
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
  // Identical dimensions/colours share one GPU geometry/material (reference-counted).
  const geometry = useSharedGeometry(g);
  const material = useSharedMaterial({
    color,
    emissive: selected ? '#0e7490' : '#000000',
    doubleSided: g.shape === 'plane',
  });
  return (
    <mesh
      onClick={onClick}
      geometry={geometry}
      material={material}
      dispose={null}
      rotation={
        g.shape === 'plane' ? [-Math.PI / 2, 0, 0] : g.shape === 'torus' ? [Math.PI / 2, 0, 0] : [0, 0, 0]
      }
    >
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

/** Bounding boxes of bodies involved in the last interference check (red: overlap, amber: possible). */
function InterferenceHighlights() {
  const interference = useEditor((s) => s.interference);
  const revision = useEditor((s) => s.project.revision);
  const registry = useContext(RegistryContext);
  const items = useMemo(() => {
    if (!interference || interference.revision !== revision) return [];
    const out = new Map<string, 'interference' | 'possible'>();
    for (const r of interference.results)
      if (r.kind !== 'contact')
        for (const id of [r.a, r.b]) if (out.get(id) !== 'interference') out.set(id, r.kind);
    return [...out].map(([id, kind]) => ({
      id,
      helper: new Box3Helper(new Box3(), new Color(kind === 'interference' ? '#ef4444' : '#f59e0b')),
    }));
  }, [interference, revision]);
  useEffect(() => () => items.forEach((i) => i.helper.dispose()), [items]);
  useFrame(() => {
    for (const { id, helper } of items) {
      const o = registry.get(id);
      if (o) helper.box.setFromObject(o);
    }
  });
  return (
    <>
      {items.map(({ id, helper }) => (
        <primitive key={id} object={helper} />
      ))}
    </>
  );
}

/** Declared interfaces of the selected imported model (cyan dot + mounting-axis arrow each). */
function SelectedInterfaceMarkers({ registry }: { registry: Map<string, Object3D> }) {
  const node = useEditor((s) =>
    s.selection.length === 1 ? (s.previewScene ?? s.project.scene).nodes[s.selection[0]!] : undefined,
  );
  const items = useMemo((): MarkerItem[] => {
    if (node?.kind !== 'model-instance') return [];
    return node.model.interfaces.map((i) => ({
      key: i.id,
      nodeId: node.id,
      position: i.position,
      direction: i.direction,
      color: '#22d3ee',
    }));
  }, [node]);
  return items.length ? <FrameMarkers name="model-interfaces" items={items} registry={registry} /> : null;
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
  const invalidate = useThree((s) => s.invalidate);

  const exploded = useEditor((s) => s.explode !== null);
  const snapMode = useEditor((s) => s.mateSnapMode);
  const simulating = useEditor((s) => s.workMode !== 'cad');
  // Mate-driven bodies are placed by the solver (edit joints instead); the exploded view
  // is a display offset, so direct manipulation is paused while it is shown.
  const editable =
    !!node &&
    node.kind !== 'root' &&
    node.visible &&
    !exploded &&
    !snapMode && // drag-to-snap replaces the gizmo while its mode is on
    !simulating && // Simulation/Electronics mode: the CAD model is read-only
    !isMateDriven(scene, node.id) &&
    !isEffectivelyLocked(scene, node.id);
  // Resolve the rendered object each frame: it may register (via ref) in the same commit as the selection.
  useFrame(() => {
    const candidate = editable && id ? (registry.get(id) ?? null) : null;
    // Only attach to objects actually in the rendered scene (e.g. not a project node while
    // the facility view shows an unmounted project).
    let attached = false;
    for (let o: Object3D | null = candidate; o; o = o.parent)
      if ((o as { isScene?: boolean }).isScene) attached = true;
    const next = attached ? candidate : null;
    if (next !== target) setTarget(next);
  });
  // In demand mode, make sure a frame runs after the selection/editability changes.
  useEffect(() => invalidate(), [id, editable, invalidate]);

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
  const registry = useContext(RegistryContext);
  const store = useEditorStore();
  const frameRequest = useEditor((s) => s.frameRequest);
  const resetRequest = useEditor((s) => s.cameraResetRequest);
  const preset = useEditor((s) => s.cameraPreset);
  const view = useEditor((s) => s.view);
  const walking = useEditor((s) => s.navMode === 'walk');
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    controls.current?.saveState();
  }, []);
  useEffect(() => {
    if (resetRequest > 0) controls.current?.reset();
  }, [resetRequest]);
  // Frame the selection: keep the viewing direction, centre and fit its rendered bounds.
  useEffect(() => {
    const c = controls.current;
    const id = store.getState().selection[0];
    const o = id ? registry.get(id) : undefined;
    if (frameRequest === 0 || !c || !o) return;
    const box = new Box3().setFromObject(o);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new Sphere());
    const dir = c.object.position.clone().sub(c.target).normalize();
    const fov = ((c.object as { fov?: number }).fov ?? 50) * (Math.PI / 180);
    const dist = Math.max(sphere.radius / Math.sin(fov / 2), 0.08) * 1.4;
    c.target.copy(sphere.center);
    c.object.position.copy(sphere.center).addScaledVector(dir, dist);
    c.update();
    invalidate();
  }, [frameRequest, registry, store, invalidate]);
  // Facility navigation: jump to zone/bench presets. Back in the project view, restore its home view.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    if (walking) return; // the walker owns the camera
    if (view === 'facility' && preset) {
      c.object.position.set(...preset.position);
      c.target.set(...preset.target);
      c.update();
    } else if (view === 'project') {
      c.reset();
    }
    invalidate();
  }, [preset, view, walking, invalidate]);
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={!walking}
      target={ORBIT_TARGET}
      enableDamping={false}
      minDistance={0.05}
      maxDistance={60}
    />
  );
}

/** Read-only diagnostics for automated browser tests (window.__forge). No mutations. */
function DebugProbe() {
  const { camera, gl, size, scene } = useThree();
  const store = useEditorStore();
  const frameloop = useThree((s) => s.frameloop);
  const frameloopRef = useRef(frameloop);
  useEffect(() => {
    frameloopRef.current = frameloop;
  }, [frameloop]);
  const registry = useContext(RegistryContext);
  const stats = useRef({ frames: 0, lastDrawCalls: 0, lastTriangles: 0 });
  // GizmoHelper issues its own render pass, and three resets gl.info per render() call,
  // so the default counters only ever reported the last (gizmo) pass. Accumulate across
  // all passes instead (autoReset is disabled in Canvas onCreated) and reset once per
  // frame, at the very start (priority -1000 runs first and does not take over
  // rendering; only positive priorities do).
  useFrame(() => {
    if (stats.current.frames > 0) {
      stats.current.lastDrawCalls = gl.info.render.calls;
      stats.current.lastTriangles = gl.info.render.triangles;
    }
    stats.current.frames += 1;
    gl.info.reset();
  }, -1000);
  useEffect(() => {
    const w = window as unknown as { __forge?: Record<string, unknown> };
    w.__forge = {
      ...w.__forge,
      render: () => ({ ...stats.current }),
      /** Totals for the most recently rendered frame (all passes); stable while idle. */
      lastFrame: () => ({ drawCalls: gl.info.render.calls, triangles: gl.info.render.triangles }),
      resources: () => resourceStats(),
      frameloop: () => frameloopRef.current,
      cameraPosition: () => camera.position.toArray(),
      cameraDirection: () => camera.getWorldDirection(new Vector3()).toArray(),
      /**
       * ESTIMATE of GPU memory held by the scene — not a driver measurement (see
       * rendering/gpuEstimate.ts for what is and is not counted). Never shown in the UI.
       */
      gpuEstimate: () => ({
        ...estimateGpuMemory(scene, {
          width: gl.domElement.width,
          height: gl.domElement.height,
          samples: gl.getContextAttributes()?.antialias ? 4 : 1,
        }),
        estimate: true,
        rendererInfo: { ...gl.info.memory },
      }),
      /** Unmasked WebGL renderer string (identifies software vs hardware rendering in benchmarks). */
      rendererName: () => {
        const ctx = gl.getContext();
        const ext = ctx.getExtension('WEBGL_debug_renderer_info');
        return ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
      },
      /**
       * Benchmark only: render the current view `frames` times, then read back one pixel —
       * readPixels cannot return before the GPU has finished every queued draw (gl.finish()
       * is not a reliable barrier in Chromium) — and return mean ms per frame, including
       * that one synchronisation. Renderer-only — engineering state is untouched.
       */
      benchRender: (frames = 30) => {
        const ctx = gl.getContext();
        const px = new Uint8Array(4);
        const sync = () => ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
        gl.render(scene, camera);
        sync();
        const t0 = performance.now();
        for (let i = 0; i < frames; i++) gl.render(scene, camera);
        sync();
        const ms = (performance.now() - t0) / frames;
        gl.info.reset();
        return +ms.toFixed(3);
      },
      /** Conjuring ghost state (renderer-only preview; never in the scene graph). */
      ghost: () => ({ ...ghostDiagnostics, inSceneGraph: false }),
      componentCache: () => componentCacheStats(),
      connectionMarkers: () => markerStats.count,
      /** Ceiling groups in the scene → whether each is currently drawn (automatic cutaway). */
      ceilings: () => {
        const out: Record<string, boolean> = {};
        scene.traverse((o) => {
          if (o.userData.ceiling) out[o.name.slice(8)] = o.visible;
        });
        return out;
      },
      /** Connector stubs (owner:target) currently mounted. */
      stubs: () => {
        const out: string[] = [];
        scene.traverse((o) => {
          if (o.name.startsWith('stub:')) out.push(o.name.slice(5));
        });
        return out.sort();
      },
      /** Rendered architecture/furnishing of a zone: instanced draws and total instances (0 if not mounted). */
      zoneGeometry: (zoneId: string) => {
        const root = scene.getObjectByName(`zone:${zoneId}`);
        let draws = 0;
        let instances = 0;
        let signs = 0;
        root?.traverse((o) => {
          if (o instanceof InstancedMesh) {
            draws += 1;
            instances += o.count;
          } else if (o.name.startsWith('sign:')) signs += 1;
        });
        return { mounted: !!root, draws, instances, signs };
      },
      /** Client-pixel position of any world (facility-frame in the facility view) point. */
      worldToScreen: (p: [number, number, number]) => {
        const v = new Vector3(...p).project(camera);
        const rect = gl.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * size.width, y: rect.top + ((1 - v.y) / 2) * size.height };
      },
      /** Instanced rendering plan (project view): batches, instanced nodes, per-batch counts. */
      instancing: () => ({ ...instancingStats, drawn: [...instancingStats.drawn] }),
      /** Imported model instances as rendered: loaded GLB, still loading, or missing asset placeholder. */
      modelInstances: () => {
        const out = { loaded: 0, loading: 0, missing: 0 };
        scene.traverse((o) => {
          if (o.name === 'model' && o.userData.modelState === 'loaded') out.loaded += 1;
          if (o.name === 'model-placeholder') out.loading += 1;
          if (o.name === 'model-missing') out.missing += 1;
        });
        return out;
      },
      /** Rendered world position of a project node (proves where the renderer actually placed it). */
      nodeWorldPosition: (id: string) => {
        const o = registry.get(id);
        return o ? o.getWorldPosition(new Vector3()).toArray() : null;
      },
      /** Drag-to-snap state (renderer diagnostics; read-only). */
      /** Simulation-mode snapshot (read-only): phase, time, joints, events, telemetry summary. */
      sim: () => {
        const c = simulationFor(store);
        const u = c.ui.getState();
        return { ...u, sessionTime: c.session?.time ?? null, rapier: c.session?.rapierVersion ?? null };
      },
      /** One telemetry channel of the current run (oldest first). */
      simSeries: (key: string) => {
        const t = simulationFor(store).session?.telemetry.series(key);
        return t ? { t: Array.from(t.t), v: Array.from(t.v) } : null;
      },
      /** Simulated world position of a body unit (display pose; never engineering state). */
      simUnitPosition: (id: string) => {
        const m = simulationFor(store).session?.unitWorldMatrix(id);
        return m ? [m[12], m[13], m[14]] : null;
      },
      snapState: () => {
        const st = store.getState();
        return {
          mode: st.mateSnapMode,
          dragging: snapDiagnostics.dragging,
          candidates: snapDiagnostics.candidates.map((c) => ({ ...c })),
          ghost: snapDiagnostics.ghost,
          targetMarkers: snapDiagnostics.targets,
          pending: st.mateSnap
            ? {
                nodeId: st.mateSnap.nodeId,
                chosen: st.mateSnap.chosen,
                candidates: st.mateSnap.candidates.map((c) => c.key),
                type: st.mateSnap.type,
                alignment: st.mateSnap.alignment,
                message: st.mateSnap.message,
              }
            : null,
        };
      },
      /** Interface markers currently drawn, per marker set. */
      frameMarkers: () => Object.fromEntries(Object.entries(frameMarkerStats).map(([k, v]) => [k, [...v]])),
      /** Client-pixel position of a body's declared interface as rendered (pointer tests). */
      interfaceScreenPoint: (nodeId: string, interfaceId: string) => {
        const o = registry.get(nodeId);
        const list = bodyInterfaces(store.getState().project.scene, nodeId);
        const i = Array.isArray(list) ? list.find((x) => x.id === interfaceId) : undefined;
        if (!o || !i) return null;
        o.updateWorldMatrix(true, false);
        const v = new Vector3(...i.position).applyMatrix4(o.matrixWorld).project(camera);
        const rect = gl.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * size.width, y: rect.top + ((1 - v.y) / 2) * size.height };
      },
      /** Client-pixel centre of a node's rendered bounds (a point on screen that presses the body). */
      bodyScreenPoint: (id: string) => {
        const o = registry.get(id);
        if (!o) return null;
        const v = new Box3().setFromObject(o).getCenter(new Vector3()).project(camera);
        const rect = gl.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * size.width, y: rect.top + ((1 - v.y) / 2) * size.height };
      },
      /** Client-pixel position of a node's origin, for pointer tests. */
      screenPointOf: (id: string) => {
        const o = registry.get(id);
        if (!o) return null;
        const v = o.getWorldPosition(o.position.clone()).project(camera);
        const rect = gl.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * size.width, y: rect.top + ((1 - v.y) / 2) * size.height };
      },
    };
  }, [camera, gl, registry, size, scene, store]);
  return null;
}
