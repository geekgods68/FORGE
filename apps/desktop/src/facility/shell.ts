import { getZone, portalSide, type PortalSide, type Zone } from '@forge/facility';
import type { MaterialName, Part } from './fixtures';

/**
 * Reusable architectural templates as pure data (no React): a zone's floor, walls with
 * doorways, glazed partitions, structure and luminaires, all derived from facility data.
 * Walls are drawn just OUTSIDE the zone footprint (0.2 m), so back-to-back walls of
 * adjacent zones form one realistic 0.4 m partition and never intrude on placement areas.
 */
const T = 0.2;
const KERB = 0.9;
const GLASS_TOP = 2.7;

const box = (size: [number, number, number], pos: [number, number, number], m: MaterialName): Part => ({
  shape: 'box',
  size,
  pos,
  m,
});

interface Opening {
  at: number;
  width: number;
  height: number;
  open: boolean;
}

function wallParts(
  axis: 'x' | 'z',
  length: number,
  h: number,
  center: [number, number],
  openings: Opening[],
  glazed: boolean,
  wallMat: MaterialName,
): Part[] {
  const out: Part[] = [];
  const place = (along: number, y: number): [number, number, number] =>
    axis === 'x' ? [center[0] + along, y, center[1]] : [center[0], y, center[1] + along];
  const sized = (len: number, hh: number, t = T): [number, number, number] =>
    axis === 'x' ? [len, hh, t] : [t, hh, len];
  const cuts = [...openings].sort((a, b) => a.at - b.at);
  const segs: [number, number][] = [];
  let cursor = -length / 2;
  for (const o of cuts) {
    segs.push([cursor, o.at - o.width / 2]);
    cursor = o.at + o.width / 2;
  }
  segs.push([cursor, length / 2]);
  for (const [a, b] of segs) {
    const len = b - a;
    if (len < 1e-6) continue;
    const mid = (a + b) / 2;
    if (!glazed || h < GLASS_TOP + 0.1) {
      out.push(box(sized(len, h), place(mid, h / 2), wallMat));
      continue;
    }
    // Glazed partition: solid kerb, clear glass band, aluminium transom and mullions, solid head.
    out.push(box(sized(len, KERB), place(mid, KERB / 2), wallMat));
    out.push(box(sized(len, GLASS_TOP - KERB, 0.03), place(mid, (KERB + GLASS_TOP) / 2), 'glass'));
    out.push(box(sized(len, 0.06, T + 0.02), place(mid, GLASS_TOP + 0.03), 'aluminium'));
    out.push(box(sized(len, 0.04, T + 0.02), place(mid, KERB + 0.02), 'aluminium'));
    out.push(box(sized(len, h - GLASS_TOP - 0.06), place(mid, (GLASS_TOP + 0.06 + h) / 2), wallMat));
    const n = Math.max(1, Math.ceil(len / 1.5));
    for (let i = 0; i <= n; i++)
      out.push(
        box(
          sized(0.05, GLASS_TOP - KERB, T + 0.02),
          place(a + (len * i) / n, (KERB + GLASS_TOP) / 2),
          'aluminium',
        ),
      );
  }
  for (const o of cuts) {
    if (h - o.height > 1e-6)
      out.push(box(sized(o.width, h - o.height), place(o.at, o.height + (h - o.height) / 2), wallMat));
    if (h - o.height > 0.05) {
      // Brushed-aluminium door frame (jambs + head).
      out.push(
        box(sized(0.06, o.height, T + 0.04), place(o.at - o.width / 2 - 0.03, o.height / 2), 'aluminium'),
      );
      out.push(
        box(sized(0.06, o.height, T + 0.04), place(o.at + o.width / 2 + 0.03, o.height / 2), 'aluminium'),
      );
      out.push(box(sized(o.width + 0.12, 0.06, T + 0.04), place(o.at, o.height + 0.03), 'aluminium'));
    }
    if (!o.open) out.push(box(sized(o.width, o.height, 0.06), place(o.at, o.height / 2), 'plannedDoor'));
  }
  return out;
}

/** Floor + four walls with doorways; `glazeSides` become glass partitions. */
export function shellParts(
  zone: Zone,
  {
    glazeSides,
    wallMat = 'wall',
    floorMat = 'floor',
  }: { glazeSides: Set<PortalSide>; wallMat?: MaterialName; floorMat?: MaterialName },
): Part[] {
  const [minX, minZ] = zone.footprint.min;
  const [maxX, maxZ] = zone.footprint.max;
  const w = maxX - minX;
  const d = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const h = zone.ceilingHeightM;
  const openings: Record<PortalSide, Opening[]> = { north: [], south: [], west: [], east: [] };
  for (const p of zone.portals) {
    const side = portalSide(zone, p);
    if (!side) continue;
    const along = side === 'north' || side === 'south' ? p.position[0] - cx : p.position[2] - cz;
    openings[side].push({ at: along, width: p.widthM, height: Math.min(p.heightM, h), open: p.open });
  }
  return [
    box([w, 0.1, d], [cx, -0.05, cz], floorMat),
    ...wallParts('x', w + 2 * T, h, [cx, minZ - T / 2], openings.north, glazeSides.has('north'), wallMat),
    ...wallParts('x', w + 2 * T, h, [cx, maxZ + T / 2], openings.south, glazeSides.has('south'), wallMat),
    ...wallParts('z', d, h, [minX - T / 2, cz], openings.west, glazeSides.has('west'), wallMat),
    ...wallParts('z', d, h, [maxX + T / 2, cz], openings.east, glazeSides.has('east'), wallMat),
  ];
}

const steps = (from: number, to: number, pitch: number) => {
  const n = Math.max(1, Math.floor((to - from) / pitch));
  const used = (n - 1) * pitch;
  return Array.from({ length: n }, (_, i) => from + (to - from - used) / 2 + i * pitch);
};

/** Laboratory template: shell with a glazed corridor wall, pilasters, beams, luminaires, wall wash. */
export function labTemplateParts(zone: Zone): Part[] {
  const [minX, minZ] = zone.footprint.min;
  const [maxX, maxZ] = zone.footprint.max;
  const h = zone.ceilingHeightM;
  const doorSides = new Set(zone.portals.map((p) => portalSide(zone, p)!).filter(Boolean));
  const out = shellParts(zone, { glazeSides: doorSides });
  const doorXs = zone.portals.map((p) => [p.position[0], p.widthM / 2 + 0.6] as const);
  for (const x of steps(minX, maxX + 1e-6, 6).concat([minX, maxX]))
    for (const z of [minZ, maxZ])
      if (!doorXs.some(([dx, hw]) => Math.abs(dx - x) < hw) && !(z === maxZ && doorSides.has('south')))
        out.push(box([0.4, h, 0.4], [x, h / 2, z + (z === minZ ? 0.2 : -0.2)], 'column'));
  for (const x of steps(minX + 1.5, maxX - 1.5, 3))
    for (const z of steps(minZ + 1.5, maxZ - 1.5, 3.5))
      out.push(box([1.2, 0.04, 0.6], [x, h - 0.45, z], 'lightPanel'));
  // Neutral linear wall wash on the solid back wall.
  out.push(
    box(
      [maxX - minX - 0.8, 0.03, 0.02],
      [(minX + maxX) / 2, Math.min(2.95, h - 1.2), minZ + 0.02],
      'lightLine',
    ),
  );
  for (const a of zone.placementAreas) out.push(...outline(a.rect, 'trim'));
  return out;
}

/** Environment template: concrete high bay, steel roof trusses, high-bay luminaires, glazed viewing wall. */
export function environmentTemplateParts(zone: Zone): Part[] {
  const [minX, minZ] = zone.footprint.min;
  const [maxX, maxZ] = zone.footprint.max;
  const h = zone.ceilingHeightM;
  const doorSides = new Set(zone.portals.map((p) => portalSide(zone, p)!).filter(Boolean));
  const out = shellParts(zone, { glazeSides: doorSides, wallMat: 'concrete' });
  for (const x of steps(minX + 4, maxX - 4, 8))
    out.push(box([0.18, 0.45, maxZ - minZ], [x, h - 0.25, (minZ + maxZ) / 2], 'column'));
  for (const x of steps(minX + 2, maxX - 2, 4))
    for (const z of steps(minZ + 2, maxZ - 2, 4))
      out.push({ shape: 'cyl', size: [0.5, 0.15, 0.5], pos: [x, h - 0.75, z], m: 'lightPanel' });
  for (const z of [minZ + 0.25, maxZ - 0.25])
    for (const x of steps(minX + 2, maxX - 2, 8)) out.push(box([0.45, h, 0.45], [x, h / 2, z], 'column'));
  for (const a of zone.placementAreas) out.push(...outline(a.rect, 'floorMarking'));
  return out;
}

/** Corridor template: glazed where rooms open onto it, luminaires along its length. */
export function corridorTemplateParts(zone: Zone): Part[] {
  const [minX, minZ] = zone.footprint.min;
  const [maxX, maxZ] = zone.footprint.max;
  const h = zone.ceilingHeightM;
  const glaze = new Set<PortalSide>();
  for (const p of zone.portals) if (getZone(p.toZoneId)?.kind !== 'corridor') glaze.add(portalSide(zone, p)!);
  const out = shellParts(zone, { glazeSides: glaze, floorMat: 'floorCorridor' });
  const alongX = maxX - minX >= maxZ - minZ;
  if (alongX)
    for (const x of steps(minX + 1, maxX - 1, 4.5))
      out.push(box([1.2, 0.04, 0.5], [x, h - 0.05, (minZ + maxZ) / 2], 'lightPanel'));
  else
    for (const z of steps(minZ + 1, maxZ - 1, 4.5))
      out.push(box([0.5, 0.04, 1.2], [(minX + maxX) / 2, h - 0.05, z], 'lightPanel'));
  return out;
}

function outline(r: { min: [number, number]; max: [number, number] }, m: MaterialName): Part[] {
  const w = r.max[0] - r.min[0];
  const d = r.max[1] - r.min[1];
  const cx = (r.min[0] + r.max[0]) / 2;
  const cz = (r.min[1] + r.max[1]) / 2;
  return [
    box([w, 0.004, 0.03], [cx, 0.002, r.min[1]], m),
    box([w, 0.004, 0.03], [cx, 0.002, r.max[1]], m),
    box([0.03, 0.004, d], [r.min[0], 0.002, cz], m),
    box([0.03, 0.004, d], [r.max[0], 0.002, cz], m),
  ];
}
