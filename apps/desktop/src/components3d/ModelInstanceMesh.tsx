import type { SceneNode } from '@forge/engineering-core';
import { Edges } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import type { Object3D } from 'three';
import { useEditor } from '@/app/store';
import { acquireModel, releaseModel } from './modelCache';

type ModelNode = Extract<SceneNode, { kind: 'model-instance' }>;

/**
 * An imported GLB/glTF model instance, loaded from the local asset store and shown in
 * the unit and up-axis the user confirmed. While loading — or if the asset is missing
 * or unreadable — a labelled wireframe of the recorded bounds is shown instead, never a
 * substitute model.
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
  const store = useEditor((s) => s.assetStore);
  // Bumped whenever assets are added, so a missing model is retried after an import.
  const assetsVersion = useEditor((s) => s.assetsVersion);
  const hash = node.model.assetHash;
  const [state, setState] = useState<{ hash: string; template: Object3D | null; failed: boolean } | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    const entry = acquireModel(store, hash);
    void entry.promise.then((t) => {
      if (live) setState({ hash, template: t, failed: !t });
    });
    return () => {
      live = false;
      releaseModel(entry);
    };
  }, [store, hash, assetsVersion]);
  const template = state?.hash === hash ? state.template : null;
  const clone = useMemo(() => template?.clone(true) ?? null, [template]);
  const s = node.model.unitScale;
  if (!clone)
    return (
      <Placeholder
        node={node}
        selected={selected}
        onClick={onClick}
        state={state?.hash === hash && state.failed ? 'missing' : 'loading'}
      />
    );
  return (
    <group
      name="model"
      userData={{ modelState: 'loaded' }}
      scale={[s, s, s]}
      rotation={node.model.upAxis === 'Z' ? [-Math.PI / 2, 0, 0] : [0, 0, 0]}
      onClick={onClick}
    >
      <primitive object={clone} />
      {selected && (
        <Placeholder
          node={node}
          selected
          onClick={onClick}
          state="outline"
          unscale={1 / s}
          upZ={node.model.upAxis === 'Z'}
        />
      )}
    </group>
  );
}

function Placeholder({
  node,
  selected,
  onClick,
  state,
  unscale = 1,
  upZ = false,
}: {
  node: ModelNode;
  selected: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
  state: 'loading' | 'missing' | 'outline';
  unscale?: number;
  upZ?: boolean;
}) {
  const [w, h, d] = node.model.boundsM;
  const [x0, y0, z0] = node.model.minM;
  const color = state === 'missing' ? '#ef4444' : selected ? '#7dd3fc' : '#e7d36b';
  // The outline is drawn inside the converted model group: undo its scale/rotation.
  return (
    <group scale={[unscale, unscale, unscale]} rotation={upZ ? [Math.PI / 2, 0, 0] : [0, 0, 0]}>
      <mesh
        name={
          state === 'missing' ? 'model-missing' : state === 'loading' ? 'model-placeholder' : 'model-outline'
        }
        position={[x0 + w / 2, y0 + h / 2, z0 + d / 2]}
        onClick={state === 'outline' ? undefined : onClick}
      >
        <boxGeometry args={[w, h, d]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={state === 'outline' ? 0 : 0.15}
          depthWrite={false}
        />
        <Edges color={color} threshold={20} />
      </mesh>
    </group>
  );
}
