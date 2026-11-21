import { Group, Mesh, type Material, type Object3D, type Texture } from 'three';
import type { AssetStore } from '@/assets/assetStore';

/**
 * Parsed GLB/glTF templates keyed by asset hash, shared by every instance of the same
 * model (instances render `template.clone()`, which shares geometry and materials) and
 * reference-counted: GPU resources are disposed when the last instance unmounts.
 * Bytes come only from the local asset store — never from the network.
 */
export type Entry = {
  hash: string;
  refs: number;
  promise: Promise<Object3D | null>;
  template: Object3D | null;
  error: string | null;
};
const cache = new Map<string, Entry>();

async function parse(store: AssetStore, hash: string, entry: Entry): Promise<Object3D | null> {
  const asset = await store.get(hash);
  if (!asset) {
    entry.error = 'missing';
    forget(entry); // not cached: a later acquire (after an import) retries
    return null;
  }
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const b = asset.bytes;
    const gltf = await new GLTFLoader().parseAsync(
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
      '',
    );
    const g = new Group();
    g.add(gltf.scene);
    entry.template = g;
    return g;
  } catch (e) {
    entry.error = e instanceof Error ? e.message : String(e);
    forget(entry);
    return null;
  }
}

const forget = (e: Entry) => {
  if (cache.get(e.hash) === e) cache.delete(e.hash);
};

export function acquireModel(store: AssetStore, hash: string): Entry {
  let e = cache.get(hash);
  if (!e) {
    e = { hash, refs: 0, promise: Promise.resolve(null), template: null, error: null };
    e.promise = parse(store, hash, e);
    cache.set(hash, e);
  }
  e.refs += 1;
  return e;
}

export function releaseModel(e: Entry) {
  e.refs -= 1;
  if (e.refs > 0) return;
  forget(e);
  e.template?.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      for (const m of ([] as Material[]).concat(o.material)) {
        for (const v of Object.values(m)) if ((v as Texture | null)?.isTexture) (v as Texture).dispose();
        m.dispose();
      }
    }
  });
}

export const modelCacheStats = () => ({
  entries: cache.size,
  loaded: [...cache.values()].filter((e) => e.template).length,
  failed: [...cache.values()].filter((e) => e.error).length,
});
