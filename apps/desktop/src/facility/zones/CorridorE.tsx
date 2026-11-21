import type { Zone } from '@forge/facility';
import { markZoneModuleLoaded } from '../loaded';
import { CorridorView } from '../ZoneViews';

markZoneModuleLoaded('corridor-e');

/**
 * Wing E main corridor (54 × 3 × 3.5 m) — the vertical-slice corridor, now built from the
 * shared corridor template. Kept as its own module key/chunk so revision-1 behaviour and
 * the slice's lazy-loading evidence are unchanged.
 */
export default function CorridorE({ zone }: { zone: Zone }) {
  return <CorridorView zone={zone} />;
}
