import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * Lazy zone modules, keyed by `zone.moduleKey`. Each import becomes its own build chunk
 * and is fetched only when the zone (or an open-portal neighbour) is entered. Planned
 * zones have no entry here, so they can never be loaded. Adding a zone = add data in
 * @forge/facility + one line here + the module file.
 */
export const ZONE_MODULES: Record<string, LazyExoticComponent<ComponentType>> = {
  'central-workshop': lazy(() => import('./zones/CentralWorkshop')),
  'corridor-e': lazy(() => import('./zones/CorridorE')),
};
