import type { SceneNode } from '@forge/engineering-core';
import { Edges } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';

type ModelNode = Extract<SceneNode, { kind: 'model-instance' }>;

/**
 * An imported GLB/glTF model instance. Until its asset is resolved from the local asset
 * store it is shown as a labelled wireframe of its recorded bounds, never as a substitute.
 */
export function ModelInstanceMesh({
  node,
  selected,
  onClick,
}: {
  node: ModelNode;
  selected: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const [w, h, d] = node.model.boundsM;
  const [x0, y0, z0] = node.model.minM;
  return (
    <mesh name="model-placeholder" position={[x0 + w / 2, y0 + h / 2, z0 + d / 2]} onClick={onClick}>
      <boxGeometry args={[w, h, d]} />
      <meshBasicMaterial color="#e7d36b" transparent opacity={0.15} depthWrite={false} />
      <Edges color={selected ? '#7dd3fc' : '#e7d36b'} threshold={20} />
    </mesh>
  );
}
