import { signsForZone, type SignSpec, type Zone } from '@forge/facility';
import { useThree } from '@react-three/fiber';
import { useLayoutEffect, useMemo } from 'react';
import { Matrix4, Vector3 } from 'three';
import { markSignRendered, unmarkSignRendered } from './loaded';
import { acquireSign, releaseSign, unitPlane } from './signTextures';

/**
 * Wayfinding signs rasterised locally into CanvasTextures (system font stack — no remote
 * fonts or images, CSP-safe). Textures are zone-specific GPU resources: reference-counted
 * by content and disposed when the last sign using them unmounts (i.e. when the owning
 * zone unloads). Text is fitted to the panel so long names never overflow.
 */
const noRaycast = () => null;

function Sign({ spec, zone }: { spec: SignSpec; zone: Zone }) {
  const invalidate = useThree((s) => s.invalidate);
  const entry = useMemo(() => acquireSign(spec), [spec]);
  useLayoutEffect(() => {
    // Facility-frame position of the sign centre (for tests: signs render where the data says).
    const m = new Matrix4().makeRotationY(zone.pose.yaw).setPosition(...zone.pose.position);
    const p = new Vector3(...spec.position).applyMatrix4(m);
    markSignRendered(spec.id, { zoneId: zone.id, kind: spec.kind, lines: spec.lines, position: p.toArray() });
    invalidate();
    return () => {
      unmarkSignRendered(spec.id);
      releaseSign(spec);
    };
  }, [entry, spec, zone, invalidate]);
  return (
    <mesh
      name={`sign:${spec.id}`}
      geometry={unitPlane}
      material={entry.material}
      position={spec.position}
      rotation={[0, spec.yaw, 0]}
      scale={[spec.size[0], spec.size[1], 1]}
      raycast={noRaycast}
      dispose={null}
      userData={{ layer: 'facility' }}
    />
  );
}

export function ZoneSigns({ zone }: { zone: Zone }) {
  const specs = useMemo(() => signsForZone(zone.id), [zone.id]);
  return (
    <group name={`signs:${zone.id}`}>
      {specs.map((s) => (
        <Sign key={s.id} spec={s} zone={zone} />
      ))}
    </group>
  );
}
