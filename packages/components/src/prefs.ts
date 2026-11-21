import { z } from 'zod';

/**
 * Per-user library preferences (favourites, recently used). Pure state transitions;
 * the desktop app persists them locally (they are viewer conveniences, not project data).
 */
export const LibraryPrefsSchema = z.object({
  version: z.literal(1),
  favorites: z.array(z.string()).max(500),
  recent: z.array(z.object({ id: z.string(), variantId: z.string().nullable() })).max(30),
});
export type LibraryPrefs = z.infer<typeof LibraryPrefsSchema>;
export const RECENT_LIMIT = 12;

export const emptyPrefs = (): LibraryPrefs => ({ version: 1, favorites: [], recent: [] });

export function parsePrefs(raw: unknown): LibraryPrefs {
  const r = LibraryPrefsSchema.safeParse(raw);
  return r.success ? r.data : emptyPrefs();
}

export const toggleFavorite = (p: LibraryPrefs, id: string): LibraryPrefs => ({
  ...p,
  favorites: p.favorites.includes(id) ? p.favorites.filter((f) => f !== id) : [...p.favorites, id],
});

export const recordRecent = (p: LibraryPrefs, id: string, variantId: string | null): LibraryPrefs => ({
  ...p,
  recent: [{ id, variantId }, ...p.recent.filter((r) => !(r.id === id && r.variantId === variantId))].slice(
    0,
    RECENT_LIMIT,
  ),
});
