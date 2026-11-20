import type { Vec3 } from '@forge/engineering-core';
import { useSharedGeometry, useSharedMaterial } from '@/rendering/hooks';
import type { StandardMaterialSpec } from '@/rendering/resources';

/** Facility geometry is never pickable: editing tools cannot target architecture. */
const noRaycast = () => null;

/** An axis-aligned architectural block (walls, slabs, door frames) with shared GPU resources. */
export function Block({
  size,
  position,
  material,
  name,
}: {
  size: Vec3;
  position: Vec3;
  material: StandardMaterialSpec;
  name?: string;
}) {
  const geometry = useSharedGeometry({ shape: 'box', width: size[0], height: size[1], depth: size[2] });
  const mat = useSharedMaterial(material);
  return (
    <mesh
      name={name}
      geometry={geometry}
      material={mat}
      position={position}
      raycast={noRaycast}
      dispose={null}
      userData={{ layer: 'facility' }}
    />
  );
}

export interface Opening {
  /** Centre along the wall (m, from the wall's centre). */
  at: number;
  width: number;
  height: number;
}

/**
 * A straight wall along local X (length `length`, centred on `center`), with door
 * openings cut as gaps plus lintels. `axis = 'z'` runs the wall along Z instead.
 */
export function Wall({
  length,
  height,
  thickness,
  center,
  axis = 'x',
  openings = [],
  material,
}: {
  length: number;
  height: number;
  thickness: number;
  center: Vec3;
  axis?: 'x' | 'z';
  openings?: Opening[];
  material: StandardMaterialSpec;
}) {
  const half = length / 2;
  const cuts = [...openings].sort((a, b) => a.at - b.at);
  const pieces: { from: number; to: number }[] = [];
  let cursor = -half;
  for (const o of cuts) {
    pieces.push({ from: cursor, to: o.at - o.width / 2 });
    cursor = o.at + o.width / 2;
  }
  pieces.push({ from: cursor, to: half });
  const place = (along: number, y: number): Vec3 =>
    axis === 'x' ? [center[0] + along, y, center[2]] : [center[0], y, center[2] + along];
  const sized = (len: number, h: number): Vec3 => (axis === 'x' ? [len, h, thickness] : [thickness, h, len]);
  return (
    <group>
      {pieces
        .filter((p) => p.to - p.from > 1e-6)
        .map((p, i) => (
          <Block
            key={`w${i}`}
            size={sized(p.to - p.from, height)}
            position={place((p.from + p.to) / 2, height / 2)}
            material={material}
          />
        ))}
      {cuts.map((o, i) => (
        <Block
          key={`l${i}`}
          size={sized(o.width, height - o.height)}
          position={place(o.at, o.height + (height - o.height) / 2)}
          material={material}
        />
      ))}
    </group>
  );
}
