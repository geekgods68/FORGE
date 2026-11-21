import { z } from 'zod';
import { fromBase64, sha256Id, toBase64, type AssetStore } from './assetStore';

/**
 * Portable bundles: a project (or reusable assembly) file together with the bytes of
 * every imported model it references, so it opens on another machine with nothing
 * missing. Export REFUSES to produce a bundle with a missing asset (no silently broken
 * references); import verifies every asset's SHA-256 before storing it.
 */
const AssetEntry = z.object({
  hash: z.string().regex(/^sha256-[0-9a-f]{64}$/),
  mediaType: z.enum(['model/gltf-binary', 'model/gltf+json']),
  name: z.string().min(1).max(200),
  base64: z.string().max(23_000_000),
});
export const BundleSchema = z.object({
  format: z.enum(['forge-bundle', 'forge-assembly']),
  version: z.literal(1),
  /** forge-bundle: the project file object; forge-assembly: the assembly template. */
  content: z.unknown(),
  assets: z.array(AssetEntry).max(512),
});
export type Bundle = z.infer<typeof BundleSchema>;

export type BundleResult = { ok: true; text: string } | { ok: false; message: string; missing: string[] };

export async function writeBundle(
  format: Bundle['format'],
  content: unknown,
  hashes: readonly string[],
  store: AssetStore,
): Promise<BundleResult> {
  const assets: Bundle['assets'] = [];
  const missing: string[] = [];
  for (const h of hashes) {
    const a = await store.get(h);
    if (!a) missing.push(h);
    else
      assets.push({
        hash: a.hash,
        mediaType: a.mediaType as Bundle['assets'][number]['mediaType'],
        name: a.name,
        base64: toBase64(a.bytes),
      });
  }
  if (missing.length)
    return {
      ok: false,
      missing,
      message: `${missing.length} referenced model asset(s) are not in this browser's asset store; the bundle was not written.`,
    };
  return { ok: true, text: JSON.stringify({ format, version: 1, content, assets } satisfies Bundle) };
}

export type ReadResult = { ok: true; bundle: Bundle; stored: number } | { ok: false; message: string };

/** Parse + verify + store the assets of a bundle. Nothing is stored unless every asset verifies. */
export async function readBundle(
  text: string,
  store: AssetStore,
  expect: Bundle['format'],
): Promise<ReadResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'The file is not valid JSON.' };
  }
  const r = BundleSchema.safeParse(raw);
  if (!r.success) return { ok: false, message: 'The file is not a FORGE bundle.' };
  if (r.data.format !== expect)
    return { ok: false, message: `Expected a ${expect} file, got ${r.data.format}.` };
  const decoded = r.data.assets.map((a) => ({ ...a, bytes: fromBase64(a.base64) }));
  try {
    // Verify all first (put() re-verifies), so a bad asset leaves the store untouched.
    for (const a of decoded)
      if ((await sha256Id(a.bytes)) !== a.hash)
        return { ok: false, message: `Asset “${a.name}” failed its integrity check; nothing was imported.` };
    for (const a of decoded)
      await store.put({ hash: a.hash, mediaType: a.mediaType, name: a.name, bytes: a.bytes });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, bundle: r.data, stored: decoded.length };
}
