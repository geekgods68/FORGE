import { CENTRAL_WORKSHOP_ID, getZone } from '@forge/facility';
import { InstancedFixtures } from '@/rendering/InstancedFixtures';
import { Block, Wall } from '../arch';
import { markZoneModuleLoaded } from '../loaded';
import { MATERIALS } from '../materials';

markZoneModuleLoaded('central-workshop');

/**
 * Zone 20 — Central Conjuring & Integration Workshop (zone frame; 18 m × 12 m × 4.5 m).
 * Fixed architecture only: floor, walls with the corridor door, columns, ceiling beams,
 * light panels, wall accent strip, placement-area markings and the conjuring dais ring.
 * Nothing here is pickable or editable; workspace equipment is rendered separately.
 * Repeated fixtures use instancing (one draw call per fixture type).
 */

// Static facility data → computed once at module load (no per-render work).

const zone = getZone(CENTRAL_WORKSHOP_ID)!;
const [minX, minZ] = zone.footprint.min;
const [maxX, maxZ] = zone.footprint.max;
const w = maxX - minX;
const d = maxZ - minZ;
const h = zone.ceilingHeightM;
const door = zone.portals[0]!;

const fixtures = (() => {
  const columns = [-9, -3, 3, 9].flatMap((x) =>
    [minZ, maxZ].map((z) => ({ position: [x, h / 2, z] as [number, number, number] })),
  );
  const beams = [-6, -3, 0, 3, 6].map((x) => ({ position: [x, h - 0.2, 0] as [number, number, number] }));
  const lights = [-6, -3, 0, 3, 6].flatMap((x) =>
    [-3.5, 0, 3.5].map((z) => ({ position: [x, h - 0.45, z] as [number, number, number] })),
  );
  const accentNS = [minZ + 0.11, maxZ - 0.11].map((z) => ({
    position: [0, 2.6, z] as [number, number, number],
  }));
  const accentEW = [minX + 0.11, maxX - 0.11].map((x) => ({
    position: [x, 2.6, 0] as [number, number, number],
    yaw: Math.PI / 2,
  }));
  return { columns, beams, lights, accentNS, accentEW };
})();
const bench = zone.placementAreas.find((a) => a.id === 'bench-floor')!.rect;
const benchW = bench.max[0] - bench.min[0];
const benchD = bench.max[1] - bench.min[1];
const benchC: [number, number] = [(bench.min[0] + bench.max[0]) / 2, (bench.min[1] + bench.max[1]) / 2];

export default function CentralWorkshop() {
  return (
    <group name={`zone:${zone.id}`}>
      {/* Floor slab (top at y = 0). */}
      <Block size={[w, 0.1, d]} position={[0, -0.05, 0]} material={MATERIALS.floor} name="floor" />
      {/* Placement-area outline (thin floor strips). */}
      {(
        [
          [
            [benchW, 0.004, 0.03],
            [benchC[0], 0.002, bench.min[1]],
          ],
          [
            [benchW, 0.004, 0.03],
            [benchC[0], 0.002, bench.max[1]],
          ],
          [
            [0.03, 0.004, benchD],
            [bench.min[0], 0.002, benchC[1]],
          ],
          [
            [0.03, 0.004, benchD],
            [bench.max[0], 0.002, benchC[1]],
          ],
        ] as const
      ).map(([size, pos], i) => (
        <Block key={i} size={[...size]} position={[...pos]} material={MATERIALS.trim} />
      ))}
      {/* Walls: north solid, east/west solid, south with the corridor door. */}
      <Wall length={w} height={h} thickness={0.2} center={[0, 0, minZ - 0.1]} material={MATERIALS.wall} />
      <Wall
        length={w}
        height={h}
        thickness={0.2}
        center={[0, 0, maxZ + 0.1]}
        openings={[{ at: door.position[0], width: door.widthM, height: door.heightM }]}
        material={MATERIALS.wall}
      />
      <Wall
        length={d + 0.4}
        height={h}
        thickness={0.2}
        center={[minX - 0.1, 0, 0]}
        axis="z"
        material={MATERIALS.wall}
      />
      <Wall
        length={d + 0.4}
        height={h}
        thickness={0.2}
        center={[maxX + 0.1, 0, 0]}
        axis="z"
        material={MATERIALS.wall}
      />
      <InstancedFixtures
        name="columns"
        geometry={{ shape: 'box', width: 0.4, height: h, depth: 0.4 }}
        material={MATERIALS.column}
        placements={fixtures.columns}
      />
      <InstancedFixtures
        name="beams"
        geometry={{ shape: 'box', width: 0.25, height: 0.4, depth: d }}
        material={MATERIALS.trim}
        placements={fixtures.beams}
      />
      <InstancedFixtures
        name="light-panels"
        geometry={{ shape: 'box', width: 1.2, height: 0.04, depth: 0.6 }}
        material={MATERIALS.lightPanel}
        placements={fixtures.lights}
      />
      <InstancedFixtures
        name="accent-strips-ns"
        geometry={{ shape: 'box', width: w - 0.4, height: 0.03, depth: 0.02 }}
        material={MATERIALS.accent}
        placements={fixtures.accentNS}
      />
      <InstancedFixtures
        name="accent-strips-ew"
        geometry={{ shape: 'box', width: d - 0.4, height: 0.03, depth: 0.02 }}
        material={MATERIALS.accent}
        placements={fixtures.accentEW}
      />
      {/* Conjuring dais ring (restrained emissive inlay). */}
      <InstancedFixtures
        name="dais-ring"
        geometry={{ shape: 'torus', majorRadius: 1.4, tubeRadius: 0.025 }}
        material={MATERIALS.accent}
        placements={[{ position: [0, 0.01, 0] }]}
      />
    </group>
  );
}
