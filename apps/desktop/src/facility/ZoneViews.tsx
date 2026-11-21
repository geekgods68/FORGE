import type { Zone } from '@forge/facility';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, type ReactNode } from 'react';
import { Vector3, type Group } from 'three';
import { furnishingParts, type Part } from './fixtures';
import { PartBatch } from './PartBatch';
import {
  ceilingParts,
  connectorStubs,
  corridorTemplateParts,
  environmentTemplateParts,
  labTemplateParts,
} from './shell';
import { ZoneSigns } from './Signs';

/**
 * Reusable zone templates. Every zone is architecture (template) + discipline-specific
 * furnishings (data) + signage (derived from data), rendered as instanced batches.
 * Nothing here is pickable or editable; workspace equipment is rendered separately.
 */
const camWorld = new Vector3();
const groupWorld = new Vector3();

/**
 * Automatic ceiling cutaway: a ceiling is drawn only while the camera is below it (first-
 * person walking, low orbit), and hidden for overhead inspection — evaluated every frame
 * before rendering, so it never needs extra frames in demand mode.
 */
function Ceiling({ parts, name, height }: { parts: readonly Part[]; name: string; height: number }) {
  const ref = useRef<Group>(null);
  useFrame(({ camera }) => {
    const g = ref.current;
    if (!g) return;
    camera.getWorldPosition(camWorld);
    g.getWorldPosition(groupWorld);
    g.visible = camWorld.y < groupWorld.y + height - 0.02;
  });
  return (
    <group ref={ref} name={name} userData={{ layer: 'facility', ceiling: true }}>
      <PartBatch parts={parts} name={`${name}:parts`} />
    </group>
  );
}

function ZoneView({
  zone,
  template,
  ceiling = true,
  children,
}: {
  zone: Zone;
  template: (z: Zone) => Part[];
  ceiling?: boolean;
  children?: ReactNode;
}) {
  const parts = useMemo(
    () => [...template(zone), ...zone.furnishings.flatMap(furnishingParts)],
    [zone, template],
  );
  const ceil = useMemo(() => (ceiling ? ceilingParts(zone) : []), [zone, ceiling]);
  const stubs = useMemo(() => connectorStubs(zone), [zone]);
  return (
    <group name={`zone:${zone.id}`} userData={{ layer: 'facility', zoneId: zone.id }}>
      <PartBatch parts={parts} name={`arch:${zone.id}`} />
      {ceiling && <Ceiling parts={ceil} name={`ceiling:${zone.id}`} height={zone.ceilingHeightM} />}
      {stubs.map((s) => (
        <group key={s.targetId} name={`stub:${zone.id}:${s.targetId}`}>
          <PartBatch parts={s.parts} name={`stub-parts:${s.targetId}`} />
          <Ceiling parts={s.ceiling} name={`ceiling:stub:${s.targetId}`} height={s.height} />
        </group>
      ))}
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
/** High-bay environments have open roof trusses (no suspended ceiling). */
export const EnvironmentView = ({ zone }: { zone: Zone }) => (
  <ZoneView zone={zone} template={environmentTemplateParts} ceiling={false} />
);
export const CorridorView = ({ zone }: { zone: Zone }) => (
  <ZoneView zone={zone} template={corridorTemplateParts} />
);
