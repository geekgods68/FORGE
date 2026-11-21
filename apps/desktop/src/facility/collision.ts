import {
  FACILITY,
  getZone,
  neighbours,
  zoneFootprintInFacility,
  type FloorRect,
  type Zone,
} from '@forge/facility';
import { furnishingParts, type Part } from './fixtures';
import { corridorTemplateParts, environmentTemplateParts, labTemplateParts } from './shell';

/**
 * First-person collision, derived from the SAME data the renderer draws (zone templates
 * + furnishings), so walls, glazing, door frames and furniture block the walker while
 * doorways stay open. Pure functions, no renderer: colliders exist for a zone whether or
 * not it is currently mounted, so you can never walk through an unloaded neighbour.
 * Connector stubs are visual only and are deliberately not colliders.
 */
export const BODY_MIN_Y = 0.3;
export const BODY_MAX_Y = 1.7;
export const WALKER_RADIUS = 0.25;
export const EYE_HEIGHT = 1.6;

function templateFor(zone: Zone): (z: Zone) => Part[] {
  if (zone.kind === 'corridor') return corridorTemplateParts;
  if (zone.kind === 'environment') return environmentTemplateParts;
  return labTemplateParts;
}

/** Facility-frame floor AABB of a part (handles the part's and the zone's yaw). */
function partRect(zone: Zone, p: Part): FloorRect {
  const yaw = (p.yaw ?? 0) + zone.pose.yaw;
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const ex = (c * p.size[0] + s * p.size[2]) / 2;
  const ez = (s * p.size[0] + c * p.size[2]) / 2;
  const zc = Math.cos(zone.pose.yaw);
  const zs = Math.sin(zone.pose.yaw);
  const x = zone.pose.position[0] + p.pos[0] * zc + p.pos[2] * zs;
  const z = zone.pose.position[2] - p.pos[0] * zs + p.pos[2] * zc;
  return { min: [x - ex, z - ez], max: [x + ex, z + ez] };
}

const cache = new Map<string, FloorRect[]>();

/** Body-height obstacles of one zone (walls, glazing, frames, furnishings), facility frame. */
export function zoneColliders(zoneId: string): FloorRect[] {
  const hit = cache.get(zoneId);
  if (hit) return hit;
  const zone = getZone(zoneId);
  if (!zone) return [];
  const parts = [...templateFor(zone)(zone), ...zone.furnishings.flatMap(furnishingParts)];
  const rects = parts
    .filter((p) => p.pos[1] - p.size[1] / 2 < BODY_MAX_Y && p.pos[1] + p.size[1] / 2 > BODY_MIN_Y)
    .map((p) => partRect(zone, p));
  cache.set(zoneId, rects);
  return rects;
}

/** Colliders relevant while standing in `zoneId`: the zone itself and every neighbour. */
export function collidersAround(zoneId: string): FloorRect[] {
  return [zoneId, ...neighbours(zoneId).map((n) => n.id)].flatMap(zoneColliders);
}

const footprints = FACILITY.zones.map((z) => ({ id: z.id, rect: zoneFootprintInFacility(z) }));
const inside = (r: FloorRect, x: number, z: number, eps = 1e-6) =>
  x >= r.min[0] - eps && x <= r.max[0] + eps && z >= r.min[1] - eps && z <= r.max[1] + eps;

/** Zone containing a facility floor point (current zone preferred at shared edges). */
export function zoneAt(x: number, z: number, prefer?: string): string | null {
  if (prefer) {
    const own = footprints.find((f) => f.id === prefer);
    if (own && inside(own.rect, x, z, 0)) return prefer;
  }
  return footprints.find((f) => inside(f.rect, x, z))?.id ?? null;
}

const circleHits = (x: number, z: number, r: number, b: FloorRect) => {
  const cx = Math.max(b.min[0], Math.min(x, b.max[0]));
  const cz = Math.max(b.min[1], Math.min(z, b.max[1]));
  return (x - cx) ** 2 + (z - cz) ** 2 < r * r;
};

/** True if a walker centred at (x, z) is inside the building and touches no obstacle. */
export function canStand(x: number, z: number, colliders: readonly FloorRect[], r = WALKER_RADIUS): boolean {
  if (!zoneAt(x, z)) return false;
  return !colliders.some((b) => circleHits(x, z, r, b));
}

/**
 * Moves a walker by (dx, dz), resolving each axis separately so it slides along walls
 * instead of sticking. Returns the new position.
 */
export function resolveMove(
  x: number,
  z: number,
  dx: number,
  dz: number,
  colliders: readonly FloorRect[],
): [number, number] {
  let nx = x;
  let nz = z;
  if (dx !== 0 && canStand(x + dx, nz, colliders)) nx = x + dx;
  if (dz !== 0 && canStand(nx, z + dz, colliders)) nz = z + dz;
  return [nx, nz];
}

/** Where to stand when walking starts in a zone: just inside its door, facing in. */
export function spawnFor(zone: Zone): { x: number; z: number; yaw: number } {
  const c = Math.cos(zone.pose.yaw);
  const s = Math.sin(zone.pose.yaw);
  const local = (lx: number, lz: number) => ({
    x: zone.pose.position[0] + lx * c + lz * s,
    z: zone.pose.position[2] - lx * s + lz * c,
  });
  if (zone.kind === 'corridor') {
    const w = zone.footprint.max[0] - zone.footprint.min[0];
    const d = zone.footprint.max[1] - zone.footprint.min[1];
    // Centre line, offset from the junction, looking along the corridor.
    const p = w >= d ? local(6, 0) : local(0, 2);
    return { ...p, yaw: w >= d ? Math.PI / 2 : 0 };
  }
  const door = zone.portals[0]!;
  // Local −Z is "into the room" (doors are on local +Z); camera yaw 0 looks along −Z.
  return { ...local(door.position[0], door.position[2] - 1.6), yaw: zone.pose.yaw };
}
