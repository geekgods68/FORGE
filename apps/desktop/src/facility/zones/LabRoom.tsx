import type { Zone } from '@forge/facility';
import { markZoneModuleLoaded } from '../loaded';
import { RoomView } from '../ZoneViews';

markZoneModuleLoaded('lab-room');

/** Laboratory template (labs 1–19, 21, 22): glazed corridor wall + discipline furnishings + signage. */
export default function LabRoom({ zone }: { zone: Zone }) {
  return <RoomView zone={zone} />;
}
