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
