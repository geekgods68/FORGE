import { hashOfSeries } from './hash';
import type { Signal } from './measure';
import type { RunData } from './runner';

/**
 * Raw run telemetry lives OUTSIDE the research document (and far from the project JSON):
 * a key–value store of typed arrays. The browser uses IndexedDB (desktop app); Node and tests
 * use memory. Data are checked against the run record's SHA-256 hash when loaded.
 */
export interface RunDataStore {
  put(key: string, data: RunData): Promise<void>;
  get(key: string): Promise<RunData | null>;
  delete(key: string): Promise<void>;
  bytes(): Promise<number>;
}

export class MemoryRunDataStore implements RunDataStore {
  private m = new Map<string, RunData>();
  async put(key: string, data: RunData) {
    this.m.set(key, data);
  }
  async get(key: string) {
    return this.m.get(key) ?? null;
  }
  async delete(key: string) {
    this.m.delete(key);
  }
  async bytes() {
    let n = 0;
    for (const d of this.m.values()) for (const s of d.signals) n += s.t.byteLength + s.v.byteLength;
    return n;
  }
}

export function dataHash(d: RunData): string {
  return hashOfSeries(
    Float64Array.from(d.signals.flatMap((s) => Array.from(s.t))),
    d.signals.map((s) => s.v),
  );
}

/** Load and verify; a missing or altered dataset is reported, never silently used. */
export async function loadVerified(
  store: RunDataStore,
  ref: { key: string; hash: string },
): Promise<{ ok: true; data: RunData } | { ok: false; reason: 'missing' | 'hash-mismatch' }> {
  const d = await store.get(ref.key);
  if (!d) return { ok: false, reason: 'missing' };
  return dataHash(d) === ref.hash ? { ok: true, data: d } : { ok: false, reason: 'hash-mismatch' };
}

// -- portable encoding (base64 of little-endian float64) ---------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function f64ToBase64(a: Float64Array): string {
  const b = new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s +=
      B64[(n >> 18) & 63]! +
      B64[(n >> 12) & 63]! +
      (i + 1 < b.length ? B64[(n >> 6) & 63]! : '=') +
      (i + 2 < b.length ? B64[n & 63]! : '=');
  }
  return s;
}
export function base64ToF64(s: string): Float64Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].reduce(
      (acc, k) => (acc << 6) | (i + k < clean.length ? B64.indexOf(clean[i + k]!) : 0),
      0,
    );
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return new Float64Array(out.buffer, 0, Math.floor(out.length / 8));
}
export interface EncodedRunData {
  format: 'forge-run-data';
  version: 1;
  signals: { key: string; unit: string; source: string; t: string; v: string }[];
}
export const encodeRunData = (d: RunData): EncodedRunData => ({
  format: 'forge-run-data',
  version: 1,
  signals: d.signals.map((s) => ({
    key: s.key,
    unit: s.unit,
    source: s.source,
    t: f64ToBase64(s.t),
    v: f64ToBase64(s.v),
  })),
});
export function decodeRunData(e: unknown): RunData | null {
  const x = e as EncodedRunData;
  if (!x || x.format !== 'forge-run-data' || x.version !== 1 || !Array.isArray(x.signals)) return null;
  const signals: Signal[] = [];
  for (const s of x.signals) {
    if (typeof s.key !== 'string' || typeof s.t !== 'string' || typeof s.v !== 'string') return null;
    const t = base64ToF64(s.t);
    const v = base64ToF64(s.v);
    if (t.length !== v.length) return null;
    signals.push({ key: s.key, unit: String(s.unit), source: String(s.source), t, v });
  }
  return { signals };
}
