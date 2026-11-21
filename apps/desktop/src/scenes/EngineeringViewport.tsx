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
import {
  Box3,
  Box3Helper,
  Color,
  InstancedMesh,
  Mesh,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from 'three';
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
import { signTextureStats } from '@/facility/signTextures';
import type {
  OrbitControls as OrbitControlsImpl,
  TransformControls as TransformControlsImpl,
} from 'three-stdlib';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { explodeOffsets } from '@forge/mechanics';
import { useEditor, useEditorStore } from '@/app/store';

const PhysicsLayer = lazy(() => import('./PhysicsLayer'));

/** Initial camera: metres, right-handed, Y-up. */
const INITIAL_CAMERA: [number, number, number] = [1.4, 1.1, 1.8];
const ORBIT_TARGET: [number, number, number] = [0, 0.15, 0];

/** node id → rendered Object3D. Renderer-side lookup only; never engineering state. */
const RegistryContext = createContext<Map<string, Object3D>>(new Map());
/** View-only explode offsets (parent-assembly frame, metres) for the exploded assembly's members. */
const ExplodeContext = createContext<Record<string, [number, number, number]>>({});

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
            <FacilityScene project={<NodeView id={rootId} />} />
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
      <NodeView id={rootId} />
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
  // Mate-driven bodies are placed by the solver (edit joints instead); the exploded view
  // is a display offset, so direct manipulation is paused while it is shown.
  const editable =
    !!node &&
    node.kind !== 'root' &&
    node.visible &&
    !exploded &&
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
       * ESTIMATE of GPU memory held by the scene (not a driver measurement): bytes of every
       * unique vertex/index buffer reachable from the scene, per-mesh instance buffers, sign
       * textures (RGBA8 + mips) and the default framebuffer (colour + depth, ×4 if MSAA).
       * Excludes shader programs and driver overhead.
       */
      gpuEstimate: () => {
        const geos = new Set<BufferGeometry>();
        let instanceBytes = 0;
        scene.traverse((o) => {
          if (o instanceof Mesh) geos.add(o.geometry as BufferGeometry);
          if (o instanceof InstancedMesh) instanceBytes += o.instanceMatrix.array.byteLength;
        });
        let geometryBytes = 0;
        for (const g of geos) {
          for (const a of Object.values(g.attributes))
            geometryBytes += (a.array as ArrayLike<number> & { byteLength: number }).byteLength;
          if (g.index) geometryBytes += g.index.array.byteLength;
        }
        const signs = signTextureStats();
        const samples = gl.getContextAttributes()?.antialias ? 4 : 1;
        const framebufferBytes = gl.domElement.width * gl.domElement.height * 8 * samples;
        const total = geometryBytes + instanceBytes + signs.estimatedBytes + framebufferBytes;
        return {
          estimate: true,
          geometryBytes,
          instanceBytes,
          signTextureBytes: signs.estimatedBytes,
          framebufferBytes,
          totalMB: +(total / 1048576).toFixed(2),
          rendererInfo: { ...gl.info.memory },
        };
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
      /** Client-pixel position of a node's origin, for pointer tests. */
      screenPointOf: (id: string) => {
        const o = registry.get(id);
        if (!o) return null;
        const v = o.getWorldPosition(o.position.clone()).project(camera);
        const rect = gl.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * size.width, y: rect.top + ((1 - v.y) / 2) * size.height };
      },
    };
  }, [camera, gl, registry, size, scene]);
  return null;
}
