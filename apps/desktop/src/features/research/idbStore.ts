import type { RunData, RunDataStore } from '@forge/research';

/**
 * Raw run telemetry in IndexedDB (typed arrays are stored natively by structured clone), one
 * database per storage namespace. Falls back to memory when IndexedDB is unavailable; the
 * fallback is reported so results are not presented as persisted when they are not.
 */
export class IdbRunDataStore implements RunDataStore {
  private db: Promise<IDBDatabase | null>;
  private mem = new Map<string, RunData>();
  persistent = true;
  constructor(namespace: string) {
    this.db = new Promise((resolve) => {
      try {
        const req = indexedDB.open(`${namespace}-research-data`, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('runs');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    }).then((d) => {
      if (!d) this.persistent = false;
      return d as IDBDatabase | null;
    });
  }
  private async tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    if (!db) throw new Error('no-idb');
    return new Promise((resolve, reject) => {
      const r = f(db.transaction('runs', mode).objectStore('runs'));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async put(key: string, data: RunData) {
    try {
      await this.tx('readwrite', (s) => s.put(data, key));
    } catch {
      this.mem.set(key, data);
    }
  }
  async get(key: string) {
    try {
      return (
        ((await this.tx('readonly', (s) => s.get(key))) as RunData | undefined) ?? this.mem.get(key) ?? null
      );
    } catch {
      return this.mem.get(key) ?? null;
    }
  }
  async delete(key: string) {
    try {
      await this.tx('readwrite', (s) => s.delete(key));
    } catch {
      /* ignore */
    }
    this.mem.delete(key);
  }
  async bytes() {
    let n = 0;
    try {
      const all = (await this.tx('readonly', (s) => s.getAll())) as RunData[];
      for (const d of all) for (const s of d.signals) n += s.t.byteLength + s.v.byteLength;
    } catch {
      /* memory only */
    }
    for (const d of this.mem.values()) for (const s of d.signals) n += s.t.byteLength + s.v.byteLength;
    return n;
  }
}
