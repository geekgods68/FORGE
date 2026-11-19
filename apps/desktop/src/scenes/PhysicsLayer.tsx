import { CuboidCollider, Physics, useRapier } from '@react-three/rapier';
import { useEffect } from 'react';
import { useForge } from '@/app/store';

/**
 * Physics foundation only (lazy-loaded chunk: Rapier ships its WASM inline).
 * A static ground collider proves the engine initialises. The world is paused:
 * there is NO physical simulation in Phase 0.
 */
export default function PhysicsLayer() {
  return (
    <Physics paused>
      <CuboidCollider args={[50, 0.01, 50]} position={[0, -0.01, 0]} />
      <PhysicsProbe />
    </Physics>
  );
}

function PhysicsProbe() {
  const { rapier, world } = useRapier();
  const setPhysics = useForge((s) => s.setPhysics);
  useEffect(() => {
    setPhysics({
      state: 'ready',
      detail: `Rapier ${rapier.version()} · ${world.colliders.len()} static collider(s) · simulation paused`,
    });
  }, [rapier, world, setPhysics]);
  return null;
}
