import type { Zone } from '@forge/facility';
import { InstancedFixtures } from '@/rendering/InstancedFixtures';
import { markZoneModuleLoaded } from '../loaded';
import { MATERIALS } from '../materials';
import { RoomView } from '../ZoneViews';

markZoneModuleLoaded('central-workshop');

const DAIS = [{ position: [0, 0.01, 0] as [number, number, number] }];

/**
 * Zone 20 — Central Conjuring & Integration Workshop (18 × 12 × 4.5 m). The validated
 * vertical-slice room, now on the shared lab template, plus its unique conjuring dais
 * ring (an engineering-interface element, hence the restrained cyan).
 */
export default function CentralWorkshop({ zone }: { zone: Zone }) {
  return (
    <RoomView zone={zone}>
      <InstancedFixtures
        name="dais-ring"
        geometry={{ shape: 'torus', majorRadius: 1.4, tubeRadius: 0.025 }}
        material={MATERIALS.accent}
        placements={DAIS}
      />
    </RoomView>
  );
}
