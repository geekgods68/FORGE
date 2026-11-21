/**
 * Records which zone modules have actually been imported (lazy-loading evidence for
 * diagnostics/tests). A zone module calls `markZoneModuleLoaded` at its top level, so an
 * entry exists only once the browser has fetched and evaluated that chunk.
 */
const loaded = new Set<string>();

export function markZoneModuleLoaded(moduleKey: string) {
  loaded.add(moduleKey);
}

export function loadedZoneModules(): string[] {
  return [...loaded].sort();
}

/** Signs currently mounted in the scene (diagnostics/tests): id → content + facility position. */
export interface RenderedSign {
  zoneId: string;
  kind: string;
  lines: string[];
  position: number[];
}
const signs = new Map<string, RenderedSign>();
export const markSignRendered = (id: string, s: RenderedSign) => void signs.set(id, s);
export const unmarkSignRendered = (id: string) => void signs.delete(id);
export const renderedSigns = (): Record<string, RenderedSign> => Object.fromEntries(signs);
