import { getMaterial, type Appearance, type ParamValues } from '@forge/components';
import type { ComponentRef } from '@forge/engineering-core';
import { Edges } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import type { BufferGeometry } from 'three';
import { useSharedGeometry, useSharedMaterial } from '@/rendering/hooks';
import { appearanceSpec } from './appearance';
import { useComponentGeometry } from './hooks';

/**
 * A placed component-library instance: its definition's generated geometry (shared and
 * reference-counted per configuration), one mesh per appearance. If the definition is
 * missing from this build's library, a translucent placeholder of the recorded size is
 * shown instead — never a substitute part.
 */
export function ComponentMesh({
  definitionId,
  component,
  selected,
  onClick,
}: {
  definitionId: string;
  component: ComponentRef;
  selected: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const entry = useComponentGeometry(definitionId, component.parameters as ParamValues, component.materialId);
  if (!entry) return <Placeholder size={component.snapshot.boundsM} selected={selected} onClick={onClick} />;
  return (
    <group name={`component:${definitionId}`}>
      {[...entry.geometries].map(([app, geometry]) => (
        <AppearanceMesh
          key={app}
          app={app}
          geometry={geometry}
          materialId={component.materialId}
          selected={selected}
          onClick={onClick}
        />
      ))}
    </group>
  );
}

function AppearanceMesh({
  app,
  geometry,
  materialId,
  selected,
  onClick,
}: {
  app: Appearance;
  geometry: BufferGeometry;
  materialId: string | null;
  selected: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const material = useSharedMaterial(
    appearanceSpec(app, getMaterial(materialId), selected ? 'selected' : 'none'),
  );
  return (
    <mesh geometry={geometry} material={material} onClick={onClick} dispose={null}>
      {selected && app === 'primary' && <Edges color="#7dd3fc" threshold={30} />}
    </mesh>
  );
}

function Placeholder({
  size,
  selected,
  onClick,
}: {
  size: [number, number, number];
  selected: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const geometry = useSharedGeometry({ shape: 'box', width: size[0], height: size[1], depth: size[2] });
  const material = useSharedMaterial(appearanceSpec('label', undefined, 'placeholder'));
  return (
    <mesh
      name="component-placeholder"
      geometry={geometry}
      material={material}
      position={[0, size[1] / 2, 0]}
      onClick={onClick}
      dispose={null}
    >
      <Edges color={selected ? '#7dd3fc' : '#e7d36b'} threshold={20} />
    </mesh>
  );
}
