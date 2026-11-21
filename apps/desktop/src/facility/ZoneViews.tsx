import type { Zone } from '@forge/facility';
import { useMemo, type ReactNode } from 'react';
import { furnishingParts } from './fixtures';
import { PartBatch } from './PartBatch';
import { corridorTemplateParts, environmentTemplateParts, labTemplateParts } from './shell';
import { ZoneSigns } from './Signs';

/**
 * Reusable zone templates. Every zone is architecture (template) + discipline-specific
 * furnishings (data) + signage (derived from data), rendered as instanced batches.
 * Nothing here is pickable or editable; workspace equipment is rendered separately.
 */
function ZoneView({
  zone,
  template,
  children,
}: {
  zone: Zone;
  template: (z: Zone) => ReturnType<typeof labTemplateParts>;
  children?: ReactNode;
}) {
  const parts = useMemo(
    () => [...template(zone), ...zone.furnishings.flatMap(furnishingParts)],
    [zone, template],
  );
  return (
    <group name={`zone:${zone.id}`} userData={{ layer: 'facility', zoneId: zone.id }}>
      <PartBatch parts={parts} name={`arch:${zone.id}`} />
      <ZoneSigns zone={zone} />
      {children}
    </group>
  );
}

export function RoomView({ zone, children }: { zone: Zone; children?: ReactNode }) {
  return (
    <ZoneView zone={zone} template={labTemplateParts}>
      {children}
    </ZoneView>
  );
}
export const EnvironmentView = ({ zone }: { zone: Zone }) => (
  <ZoneView zone={zone} template={environmentTemplateParts} />
);
export const CorridorView = ({ zone }: { zone: Zone }) => (
  <ZoneView zone={zone} template={corridorTemplateParts} />
);
