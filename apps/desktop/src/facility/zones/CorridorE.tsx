import { CORRIDOR_E_ID, getZone } from '@forge/facility';
import { InstancedFixtures } from '@/rendering/InstancedFixtures';
import { Block, Wall } from '../arch';
import { markZoneModuleLoaded } from '../loaded';
import { MATERIALS } from '../materials';

markZoneModuleLoaded('corridor-e');

/**
 * Wing E main corridor (zone frame; 54 m × 3 m × 3.5 m). Openings toward labs 20–22:
 * Lab 20's door is open; labs 21/22 are planned, so their doors are drawn closed.
 * Architecture only — not pickable, no placement areas.
 */

// Static facility data → computed once at module load.
const zone = getZone(CORRIDOR_E_ID)!;
const [minX, minZ] = zone.footprint.min;
const [maxX, maxZ] = zone.footprint.max;
const len = maxX - minX;
const h = zone.ceilingHeightM;
const lights = Array.from({ length: Math.floor(len / 4.5) }, (_, i) => ({
  position: [minX + 2.25 + i * 4.5, h - 0.05, 0] as [number, number, number],
}));

export default function CorridorE() {
  return (
    <group name={`zone:${zone.id}`}>
      <Block
        size={[len, 0.1, maxZ - minZ]}
        position={[0, -0.05, 0]}
        material={MATERIALS.floor}
        name="floor"
      />
      {/* North wall shares its plane with the labs' south walls: openings only, lab walls carry the doors. */}
      <Wall
        length={len}
        height={h}
        thickness={0.2}
        center={[0, 0, minZ - 0.1]}
        openings={zone.portals.map((p) => ({ at: p.position[0], width: p.widthM, height: p.heightM }))}
        material={MATERIALS.wall}
      />
      <Wall length={len} height={h} thickness={0.2} center={[0, 0, maxZ + 0.1]} material={MATERIALS.wall} />
      <Wall
        length={maxZ - minZ + 0.4}
        height={h}
        thickness={0.2}
        center={[minX - 0.1, 0, 0]}
        axis="z"
        material={MATERIALS.wall}
      />
      <Wall
        length={maxZ - minZ + 0.4}
        height={h}
        thickness={0.2}
        center={[maxX + 0.1, 0, 0]}
        axis="z"
        material={MATERIALS.wall}
      />
      {/* Closed doors to planned zones. */}
      {zone.portals
        .filter((p) => !p.open)
        .map((p) => (
          <Block
            key={p.id}
            size={[p.widthM, p.heightM, 0.08]}
            position={[p.position[0], p.heightM / 2, minZ - 0.1]}
            material={MATERIALS.plannedDoor}
            name={`door:${p.toZoneId}`}
          />
        ))}
      <InstancedFixtures
        name="corridor-lights"
        geometry={{ shape: 'box', width: 1.2, height: 0.04, depth: 0.5 }}
        material={MATERIALS.lightPanel}
        placements={lights}
      />
      <InstancedFixtures
        name="corridor-accent"
        geometry={{ shape: 'box', width: len, height: 0.03, depth: 0.02 }}
        material={MATERIALS.accent}
        placements={[{ position: [0, 0.15, maxZ - 0.01] }, { position: [0, 0.15, minZ + 0.01] }]}
      />
    </group>
  );
}
