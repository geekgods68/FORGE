import { ZoneLifecycle, type Zone, type ZoneStatus } from '@forge/facility';
import { createElement, type ComponentType, type ReactElement } from 'react';

/**
 * Zone runtime: binds the renderer-independent ZoneLifecycle to lazily imported zone
 * template modules. Loading a zone = fetching/evaluating its template chunk (code only,
 * no GPU work). Mounting (GPU resources) happens only for ACTIVE zones with role
 * active/required; a prefetched zone has its code ready but renders nothing.
 * Templates are shared: 21 labs use one `lab-room` chunk, corridors one `corridor` chunk.
 */
export type ZoneComponent = ComponentType<{ zone: Zone }>;

const LOADERS: Record<string, () => Promise<{ default: ZoneComponent }>> = {
  'central-workshop': () => import('./zones/CentralWorkshop'),
  'corridor-e': () => import('./zones/CorridorE'),
  'lab-room': () => import('./zones/LabRoom'),
  corridor: () => import('./zones/Corridor'),
  environment: () => import('./zones/EnvironmentRoom'),
};
export const ZONE_MODULE_KEYS = Object.keys(LOADERS);

const components = new Map<string, ZoneComponent>();
export const zoneComponent = (moduleKey: string | null) =>
  moduleKey ? components.get(moduleKey) : undefined;
/** Element for a loaded zone's template (null until its module has loaded). */
export function zoneElement(zone: Zone): ReactElement | null {
  const C = zoneComponent(zone.moduleKey);
  return C ? createElement(C, { zone }) : null;
}

async function loadZone(zone: Zone): Promise<void> {
  const key = zone.moduleKey;
  const load = key ? LOADERS[key] : undefined;
  if (!key || !load) throw new Error(`No renderer module for ${zone.name}`);
  if (components.has(key)) return;
  const mod = await load();
  components.set(key, mod.default);
}

export const zoneLifecycle = new ZoneLifecycle(loadZone);

// Stable snapshot for useSyncExternalStore (recomputed only when the lifecycle emits).
let snapshot: Record<string, ZoneStatus> = {};
zoneLifecycle.subscribe(() => {
  snapshot = zoneLifecycle.snapshot();
});
export const subscribeZones = (fn: () => void) => zoneLifecycle.subscribe(fn);
export const zoneSnapshot = () => snapshot;

/** Zone transition timings (diagnostics): request → required zones mounted and a frame rendered. */
export interface TransitionRecord {
  zoneId: string;
  ms: number;
  coldModules: boolean;
}
export const transitions: TransitionRecord[] = [];
