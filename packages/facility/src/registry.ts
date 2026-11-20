import { FACILITY_V1 } from './facility-v1';
import { type FloorPose, type FrameChain } from './frames';
import {
  FacilitySchema,
  type Equipment,
  type Facility,
  type FloorRect,
  type WorkspaceItem,
  type Zone,
} from './schemas';

/**
 * Zone registry: the single index of all facility zones (implemented and planned).
 * Rendering code maps `zone.moduleKey` to a lazily imported module; zones without a
 * module are never loaded. Facility data is deep-frozen: nothing can mutate it.
 */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const FACILITY: Readonly<Facility> = deepFreeze(FacilitySchema.parse(FACILITY_V1));

const zoneById = new Map(FACILITY.zones.map((z) => [z.id, z]));
const equipmentById = new Map(FACILITY.equipment.map((e) => [e.id, e]));

export const getZone = (id: string): Zone | undefined => zoneById.get(id);
export const getEquipment = (id: string): Equipment | undefined => equipmentById.get(id);
export const implementedZones = (): Zone[] => FACILITY.zones.filter((z) => z.status === 'implemented');

/**
 * Zones to have loaded while the user is in `currentZoneId`: the zone itself plus
 * implemented zones reachable through an OPEN portal. Planned zones are never loaded.
 */
export function zonesToLoad(currentZoneId: string): string[] {
  const z = getZone(currentZoneId);
  if (!z || z.status !== 'implemented') return [];
  const out = [z.id];
  for (const p of z.portals) {
    const n = getZone(p.toZoneId);
    if (p.open && n?.status === 'implemented' && !out.includes(n.id)) out.push(n.id);
  }
  return out;
}

// ---------------------------------------------------------------- frames

export const zoneChain = (zone: Zone): FrameChain => [zone.pose];
export const itemChain = (zone: Zone, item: Pick<WorkspaceItem, 'pose'>): FrameChain => [
  item.pose,
  zone.pose,
];

/** Frame M (work-surface mount) of a workbench item, or null if the equipment has no mount. */
export function mountChain(
  zone: Zone,
  item: Pick<WorkspaceItem, 'pose'>,
  equipment: Equipment,
): FrameChain | null {
  return equipment.mount ? [equipment.mount, item.pose, zone.pose] : null;
}

// ---------------------------------------------------------------- geometry

/** Floor-plane AABB (zone frame) of an item's footprint rotated by its yaw. */
export function itemFootprint(pose: FloorPose, equipment: Equipment): FloorRect {
  const [w, , d] = equipment.sizeM;
  const c = Math.abs(Math.cos(pose.yaw));
  const s = Math.abs(Math.sin(pose.yaw));
  const ex = (c * w + s * d) / 2;
  const ez = (s * w + c * d) / 2;
  const [x, , z] = pose.position;
  return { min: [x - ex, z - ez], max: [x + ex, z + ez] };
}

export const rectInside = (inner: FloorRect, outer: FloorRect, eps = 1e-9) =>
  inner.min[0] >= outer.min[0] - eps &&
  inner.min[1] >= outer.min[1] - eps &&
  inner.max[0] <= outer.max[0] + eps &&
  inner.max[1] <= outer.max[1] + eps;

/** Strict overlap (touching edges do not overlap). */
export const rectsOverlap = (a: FloorRect, b: FloorRect, eps = 1e-9) =>
  a.min[0] < b.max[0] - eps &&
  b.min[0] < a.max[0] - eps &&
  a.min[1] < b.max[1] - eps &&
  b.min[1] < a.max[1] - eps;

/** Zone footprint in facility coordinates (zones are yaw 0 in this revision; general yaw handled). */
export function zoneFootprintInFacility(zone: Zone): FloorRect {
  const c = Math.abs(Math.cos(zone.pose.yaw));
  const s = Math.abs(Math.sin(zone.pose.yaw));
  const w = zone.footprint.max[0] - zone.footprint.min[0];
  const d = zone.footprint.max[1] - zone.footprint.min[1];
  const cx = zone.pose.position[0] + (zone.footprint.min[0] + zone.footprint.max[0]) / 2;
  const cz = zone.pose.position[2] + (zone.footprint.min[1] + zone.footprint.max[1]) / 2;
  const ex = (c * w + s * d) / 2;
  const ez = (s * w + c * d) / 2;
  return { min: [cx - ex, cz - ez], max: [cx + ex, cz + ez] };
}

/** Structural invariants of facility content (run in tests; cheap enough for startup). */
export function validateFacility(f: Facility): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const z of f.zones) {
    if (ids.has(z.id)) errors.push(`duplicate zone id ${z.id}`);
    ids.add(z.id);
  }
  const labs = f.zones.filter((z) => z.kind === 'laboratory').map((z) => z.labNumber);
  for (let n = 1; n <= 22; n++)
    if (labs.filter((l) => l === n).length !== 1) errors.push(`lab ${n} must exist exactly once`);
  if (f.zones.filter((z) => z.kind === 'environment').length !== 6)
    errors.push('exactly 6 environments required');
  const wings = new Set(f.wings.map((w) => w.id));
  for (const z of f.zones) {
    if (!wings.has(z.wingId)) errors.push(`${z.id}: unknown wing ${z.wingId}`);
    if (z.status === 'implemented' && !z.moduleKey)
      errors.push(`${z.id}: implemented zone needs a moduleKey`);
    if (z.status === 'planned' && z.moduleKey) errors.push(`${z.id}: planned zone must not have a module`);
    for (const p of z.portals)
      if (!ids.has(p.toZoneId)) errors.push(`${z.id}: portal ${p.id} → unknown zone ${p.toZoneId}`);
    for (const a of z.placementAreas)
      if (!rectInside(a.rect, z.footprint))
        errors.push(`${z.id}: placement area ${a.id} exceeds the zone footprint`);
  }
  for (let i = 0; i < f.zones.length; i++)
    for (let j = i + 1; j < f.zones.length; j++) {
      const a = f.zones[i]!;
      const b = f.zones[j]!;
      if (rectsOverlap(zoneFootprintInFacility(a), zoneFootprintInFacility(b)))
        errors.push(`zones ${a.id} and ${b.id} overlap`);
    }
  for (const e of f.equipment) {
    if (e.category === 'workbench' && (!e.mount || !e.workSurfaceM))
      errors.push(`${e.id}: workbench needs a mount`);
    if (e.category !== 'workbench' && e.mount) errors.push(`${e.id}: only workbenches may host projects`);
  }
  return errors;
}
