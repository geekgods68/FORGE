/**
 * Local, persistent, content-addressed store for imported model bytes (GLB / glTF).
 * Keys are `sha256-<hex>` of the exact bytes, so identical files are stored once and a
 * stored asset can always be verified. Backed by IndexedDB (this browser profile only —
 * never uploaded); an in-memory store is used where IndexedDB is unavailable (tests).
 * Assets are never fetched from the network: the CSP is same-origin.
 */
export interface StoredAsset {
  hash: string;
  mediaType: string;
  name: string;
  bytes: Uint8Array;
}

export interface AssetStore {
  readonly kind: 'indexeddb' | 'memory';
  put(asset: StoredAsset): Promise<void>;
  get(hash: string): Promise<StoredAsset | null>;
  has(hash: string): Promise<boolean>;
  list(): Promise<string[]>;
}

export const MAX_ASSET_BYTES = 16 * 1024 * 1024;

export async function sha256Id(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return `sha256-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Refuses bytes whose hash does not match their key (corrupt or tampered input). */
async function verified(asset: StoredAsset): Promise<StoredAsset> {
  if (asset.bytes.byteLength > MAX_ASSET_BYTES)
    throw new Error(`“${asset.name}” is larger than the 16 MiB asset limit.`);
  const actual = await sha256Id(asset.bytes);
  if (actual !== asset.hash) throw new Error(`“${asset.name}” failed its integrity check (hash mismatch).`);
  return asset;
}

export function createMemoryAssetStore(): AssetStore {
  const m = new Map<string, StoredAsset>();
  return {
    kind: 'memory',
    async put(a) {
      m.set(a.hash, await verified(a));
    },
    async get(h) {
      return m.get(h) ?? null;
    },
    async has(h) {
      return m.has(h);
    },
    async list() {
      return [...m.keys()];
    },
  };
}

const DB = 'forge-assets';
const STORE = 'assets';

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'hash' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

export function createIndexedDbAssetStore(namespace = ''): AssetStore {
  let db: Promise<IDBDatabase> | null = null;
  const tx = async (mode: IDBTransactionMode) => {
    db ??= openDb(namespace ? `${DB}:${namespace}` : DB);
    return (await db).transaction(STORE, mode).objectStore(STORE);
  };
  return {
    kind: 'indexeddb',
    async put(a) {
      const v = await verified(a);
      await request((await tx('readwrite')).put({ ...v, bytes: v.bytes.slice().buffer }));
    },
    async get(h) {
      const r = (await request((await tx('readonly')).get(h))) as
        { hash: string; mediaType: string; name: string; bytes: ArrayBuffer } | undefined;
      return r ? { ...r, bytes: new Uint8Array(r.bytes) } : null;
    },
    async has(h) {
      return (await request((await tx('readonly')).count(h))) > 0;
    },
    async list() {
      return (await request((await tx('readonly')).getAllKeys())).map(String);
    },
  };
}

export function createDefaultAssetStore(namespace = ''): AssetStore {
  return typeof indexedDB === 'undefined' ? createMemoryAssetStore() : createIndexedDbAssetStore(namespace);
}

// --------------------------------------------------------------- base64 (bundles)

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
