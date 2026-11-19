import {
  activeScene,
  type ComponentDefinition,
  type ComponentInstance,
  type MaterialDefinition,
} from '@forge/engineering-core';
import { GizmoHelper, GizmoViewport, Grid, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { lazy, Suspense, useEffect, useRef } from 'react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useForge } from '@/app/store';

const PhysicsLayer = lazy(() => import('./PhysicsLayer'));

/** Initial camera: ~2 m eye height, looking at the demo cube. Metres, right-handed, Y-up. */
const INITIAL_CAMERA: [number, number, number] = [1.6, 1.2, 2.0];
const ORBIT_TARGET: [number, number, number] = [0, 0.15, 0];

/** Temporary Phase 0 scene: grid, axes, lighting, one component instance, orbit controls. */
export function Phase0Scene() {
  const project = useForge((s) => s.project);
  const setPhysics = useForge((s) => s.setPhysics);
  const scene = activeScene(project);

  return (
    <Canvas
      camera={{ position: INITIAL_CAMERA, fov: 50, near: 0.01, far: 500 }}
      dpr={[1, 2]}
      gl={{ antialias: true }}
      aria-label="FORGE 3D viewport"
    >
      <color attach="background" args={['#2a2d33']} />
      <hemisphereLight args={['#dfe6f0', '#33363c', 0.9]} />
      <directionalLight position={[3, 5, 2]} intensity={1.8} />

      {/* 0.1 m cells, 1 m sections. */}
      <Grid
        infiniteGrid
        cellSize={0.1}
        sectionSize={1}
        cellColor="#474c55"
        sectionColor="#6b7480"
        fadeDistance={25}
        position={[0, -0.0005, 0]}
      />
      {/* World axes at the origin: X red, Y green, Z blue (0.6 m). */}
      <axesHelper args={[0.6]} />
      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <GizmoViewport axisColors={['#e5534b', '#57ab5a', '#539bf5']} labelColor="#111" />
      </GizmoHelper>

      {scene.instances.map((inst) => (
        <InstanceMesh
          key={inst.id}
          instance={inst}
          definition={project.definitions.find((d) => d.id === inst.definitionId)}
          materials={project.materials}
        />
      ))}

      {/* Physics foundation only (lazy chunk). No simulation in Phase 0. */}
      <ErrorBoundary fallback={null} onError={(e) => setPhysics({ state: 'error', detail: e.message })}>
        <Suspense fallback={null}>
          <PhysicsLayer />
        </Suspense>
      </ErrorBoundary>

      <CameraRig />
      <DebugProbe />
    </Canvas>
  );
}

function InstanceMesh({
  instance,
  definition,
  materials,
}: {
  instance: ComponentInstance;
  definition: ComponentDefinition | undefined;
  materials: MaterialDefinition[];
}) {
  if (!definition) return null;
  const color = materials.find((m) => m.id === definition.materialId)?.renderColor ?? '#8a93a3';
  const g = definition.geometry;
  return (
    <mesh
      name={`instance:${instance.id}`}
      position={instance.transform.position}
      quaternion={instance.transform.rotation}
    >
      {g.kind === 'box' && <boxGeometry args={g.sizeM} />}
      {g.kind === 'cylinder' && <cylinderGeometry args={[g.radiusM, g.radiusM, g.heightM, 32]} />}
      {g.kind === 'sphere' && <sphereGeometry args={[g.radiusM, 32, 16]} />}
      {/* Imported models are not loaded in Phase 0; show an explicit placeholder. */}
      {g.kind === 'model' && <boxGeometry args={[0.1, 0.1, 0.1]} />}
      <meshStandardMaterial color={color} roughness={0.65} metalness={0.05} wireframe={g.kind === 'model'} />
    </mesh>
  );
}

function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const resetRequest = useForge((s) => s.cameraResetRequest);

  useEffect(() => {
    controls.current?.saveState(); // remember the initial pose for reset
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
      minDistance={0.3}
      maxDistance={60}
    />
  );
}

/** Read-only diagnostics for automated browser tests (window.__forge). No mutations. */
function DebugProbe() {
  const { camera, gl } = useThree();
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
    };
  }, [camera]);
  return null;
}
