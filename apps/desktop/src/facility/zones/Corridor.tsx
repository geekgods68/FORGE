import type { Zone } from '@forge/facility';
import { markZoneModuleLoaded } from '../loaded';
import { CorridorView } from '../ZoneViews';

markZoneModuleLoaded('corridor');

/** Corridor/concourse template: walls cut by every portal, glazing toward rooms, door and directional signs. */
export default function Corridor({ zone }: { zone: Zone }) {
  return <CorridorView zone={zone} />;
}
