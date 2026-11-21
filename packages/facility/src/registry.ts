import { FACILITY_V1 } from './facility-v1';
import { pointToFacility, type FloorPose, type FrameChain } from './frames';
import { FURNISHING_TYPES, isFurnishingType } from './furnishings';
import {
  FacilitySchema,
  type Equipment,
  type Facility,
  type FloorRect,
  type Furnishing,
  type Portal,
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

/** Floor-plane AABB (zone frame) of a fixed furnishing, or null for an unknown type. */
export function furnishingFootprint(f: Furnishing): FloorRect | null {
  if (!isFurnishingType(f.type)) return null;
  const [w, , d] = f.size ?? FURNISHING_TYPES[f.type].sizeM;
  const c = Math.abs(Math.cos(f.yaw));
  const s = Math.abs(Math.sin(f.yaw));
  const ex = (c * w + s * d) / 2;
  const ez = (s * w + c * d) / 2;
  return { min: [f.position[0] - ex, f.position[2] - ez], max: [f.position[0] + ex, f.position[2] + ez] };
}

export type PortalSide = 'north' | 'south' | 'west' | 'east';

/** Which footprint edge a portal lies on (zone frame), or null if it is not on an edge. */
export function portalSide(zone: Zone, p: Portal, eps = 1e-6): PortalSide | null {
  const [x, , z] = p.position;
  const { min, max } = zone.footprint;
  if (Math.abs(z - min[1]) < eps) return 'north';
  if (Math.abs(z - max[1]) < eps) return 'south';
  if (Math.abs(x - min[0]) < eps) return 'west';
  if (Math.abs(x - max[0]) < eps) return 'east';
  return null;
}

/** Floor area just inside a portal that must stay free of furnishings and equipment. */
export function portalClearance(zone: Zone, p: Portal): FloorRect | null {
  const side = portalSide(zone, p);
  const depth = zone.kind === 'corridor' ? 1.0 : 1.5;
  const hw = p.widthM / 2 + 0.3;
  const [x, , z] = p.position;
  switch (side) {
    case 'north':
      return { min: [x - hw, z], max: [x + hw, z + depth] };
    case 'south':
      return { min: [x - hw, z - depth], max: [x + hw, z] };
    case 'west':
      return { min: [x, z - hw], max: [x + depth, z + hw] };
    case 'east':
      return { min: [x - depth, z - hw], max: [x, z + hw] };
    default:
      return null;
  }
}

/** Zones connected to `zoneId` through open portals (navigation exits), in portal order. */
export function neighbours(zoneId: string): Zone[] {
  const z = getZone(zoneId);
  if (!z) return [];
  const out: Zone[] = [];
  for (const p of z.portals) {
    const n = getZone(p.toZoneId);
    if (p.open && n && !out.includes(n)) out.push(n);
  }
  return out;
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
    const clearances = z.portals.map((p) => {
      const c = portalClearance(z, p);
      if (!c) errors.push(`${z.id}: portal ${p.id} is not on a footprint edge`);
      return c;
    });
    for (const a of z.placementAreas)
      for (const c of clearances)
        if (c && rectsOverlap(a.rect, c)) errors.push(`${z.id}: placement area ${a.id} blocks a doorway`);
    const rects: FloorRect[] = [];
    z.furnishings.forEach((f, i) => {
      const r = furnishingFootprint(f);
      const label = `${z.id}: furnishing #${i} (${f.type})`;
      if (!r) return void errors.push(`${label} has an unknown type`);
      if (!rectInside(r, z.footprint)) errors.push(`${label} exceeds the zone footprint`);
      for (const a of z.placementAreas)
        if (rectsOverlap(r, a.rect)) errors.push(`${label} overlaps placement area ${a.id}`);
      for (const c of clearances) if (c && rectsOverlap(r, c)) errors.push(`${label} blocks a doorway`);
      rects.forEach((o, j) => {
        if (rectsOverlap(r, o)) errors.push(`${label} overlaps furnishing #${j}`);
      });
      rects.push(r);
    });
  }
  // Portals are reciprocal: an open portal is matched by one in the target zone at the
  // same facility point and width, so both sides cut the same doorway.
  const byId = new Map(f.zones.map((z) => [z.id, z]));
  for (const z of f.zones)
    for (const p of z.portals) {
      const t = byId.get(p.toZoneId);
      if (!t || !p.open) continue;
      const at = pointToFacility(p.position, [z.pose]);
      const match = t.portals.find(
        (q) =>
          q.toZoneId === z.id &&
          q.open &&
          Math.abs(q.widthM - p.widthM) < 1e-9 &&
          pointToFacility(q.position, [t.pose]).every((v, i) => Math.abs(v - at[i]!) < 1e-6),
      );
      if (!match) errors.push(`${z.id}: portal ${p.id} has no reciprocal portal in ${t.id}`);
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
