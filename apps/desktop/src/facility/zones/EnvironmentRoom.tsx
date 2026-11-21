import type { Zone } from '@forge/facility';
import { markZoneModuleLoaded } from '../loaded';
import { EnvironmentView } from '../ZoneViews';

markZoneModuleLoaded('environment');

/** Configurable research environment (24 × 24 × 8 m high bay). Architecture only in Phase 2. */
export default function EnvironmentRoom({ zone }: { zone: Zone }) {
  return <EnvironmentView zone={zone} />;
}
