import type { PrimitiveGeometry } from '@forge/engineering-core';
import { useMemo } from 'react';
import { InstancedFixtures } from '@/rendering/InstancedFixtures';
import { groupParts, type Part } from './fixtures';
import { MATERIALS } from './materials';

const UNIT: Record<Part['shape'], PrimitiveGeometry> = {
  box: { shape: 'box', width: 1, height: 1, depth: 1 },
  cyl: { shape: 'cylinder', radius: 0.5, height: 1 },
};

export function PartBatch({ parts, name }: { parts: readonly Part[]; name: string }) {
  const groups = useMemo(() => groupParts(parts), [parts]);
  return (
    <group name={name}>
      {groups.map((g) => (
        <InstancedFixtures
          key={g.key}
          name={`${name}:${g.m}`}
          geometry={UNIT[g.shape]}
          material={MATERIALS[g.m]}
          placements={g.placements}
        />
      ))}
    </group>
  );
}
