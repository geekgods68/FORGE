import { circle, polygonArea, type ComponentInterface, type Solid } from '@forge/components';
import type { Feature } from '@forge/engineering-core';
import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping';

/**
 * Prismatic feature kernel (supported subset — not a general B-rep CAD kernel).
 *
 * A part is a base extrusion of a planar profile on its local XZ plane, extruded along
 * +Y (0 → depth). Supported features:
 *   - boolean (union / difference / intersection) of the BASE PROFILE with a profile;
 *   - hole (circle, through or blind from the top face) and cut (polygon, through/blind);
 *   - rectangular / circular pattern and mirror of a hole or cut.
 * Booleans are exact 2D polygon operations (polygon-clipping); holes/cuts become
 * layered prisms, so volumes are exact for the modelled shape. Anything outside the
 * subset is REJECTED with a reason and the previous valid state is kept:
 * self-intersecting or degenerate profiles, tools leaving the part, overlapping tools,
 * results that split into several bodies, excessive complexity.
 */
type P2 = [number, number];
const AREA_EPS = 1e-12; // m² (1 mm²·1e-6)
export const MAX_PART_VERTICES = 20_000;
const HOLE_SEGMENTS = 32;

export interface PartGeometry {
  solids: Solid[];
  interfaces: ComponentInterface[];
  volumeM3: number;
  /** Final base region (outer + holes) and every cut tool (for measurement/inspection). */
  region: { outer: P2[]; holes: P2[][] };
  tools: { id: string; poly: P2[]; depth: number | null; diameter: number | null; center: P2 | null }[];
  depth: number;
}

export type PartResult = { ok: true; geometry: PartGeometry } | { ok: false; message: string };

function segIntersect(a: P2, b: P2, c: P2, d: P2): boolean {
  const o = (p: P2, q: P2, r: P2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Reasons a polygon is unusable, or null. */
export function polygonProblem(poly: readonly P2[], label: string): string | null {
  if (poly.length < 3) return `${label}: a profile needs at least 3 points.`;
  if (
    poly.some(
      (p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 100 || Math.abs(p[1]) > 100,
    )
  )
    return `${label}: coordinates must be finite and within ±100 m.`;
  const n = poly.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segIntersect(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!))
        return `${label}: the profile is self-intersecting.`;
    }
  if (polygonArea(poly as P2[]) < AREA_EPS) return `${label}: the profile is degenerate (zero area).`;
  return null;
}

const area = (mp: MultiPolygon) =>
  mp.reduce(
    (s, poly) =>
      s + polygonArea(poly[0] as P2[]) - poly.slice(1).reduce((h, r) => h + polygonArea(r as P2[]), 0),
    0,
  );
const ring = (r: P2[]): P2[] => {
  // polygon-clipping returns closed rings (last = first); store open rings.
  const out = r.map((p) => [p[0], p[1]] as P2);
  if (out.length > 1 && out[0]![0] === out.at(-1)![0] && out[0]![1] === out.at(-1)![1]) out.pop();
  return out;
};

/** Expand hole/cut/pattern/mirror features into concrete cutting tools. */
function tools(
  features: readonly Feature[],
): { ok: true; list: PartGeometry['tools'] } | { ok: false; message: string } {
  const list: PartGeometry['tools'] = [];
  const byId = new Map<string, PartGeometry['tools']>();
  for (const f of features) {
    if (f.type === 'hole') {
      const t = {
        id: f.id,
        poly: circle(f.center[0], f.center[1], f.diameter / 2, HOLE_SEGMENTS).reverse() as P2[],
        depth: f.depth,
        diameter: f.diameter,
        center: f.center,
      };
      byId.set(f.id, [t]);
      list.push(t);
    } else if (f.type === 'cut') {
      const p = polygonProblem(f.profile, `Cut ${f.id}`);
      if (p) return { ok: false, message: p };
      const t = { id: f.id, poly: f.profile, depth: f.depth, diameter: null, center: null };
      byId.set(f.id, [t]);
      list.push(t);
    } else if (f.type === 'pattern-rect' || f.type === 'pattern-circ' || f.type === 'mirror') {
      const src = byId.get(f.target);
      const target = features.find((x) => x.id === f.target);
      if (!src || !target || (target.type !== 'hole' && target.type !== 'cut'))
        return {
          ok: false,
          message: `${f.type} ${f.id}: its target must be an earlier hole or cut (patterns of patterns are not supported).`,
        };
      const made: PartGeometry['tools'] = [];
      const xf = (fn: (p: P2) => P2, k: string) =>
        src.forEach((t) =>
          made.push({
            ...t,
            id: `${f.id}:${k}`,
            poly: t.poly.map(fn),
            center: t.center ? fn(t.center) : null,
          }),
        );
      if (f.type === 'pattern-rect') {
        for (let i = 0; i < f.countU; i++)
          for (let j = 0; j < f.countV; j++)
            if (i || j) xf((p) => [p[0] + i * f.spacingU, p[1] + j * f.spacingV], `${i},${j}`);
      } else if (f.type === 'pattern-circ') {
        const step = f.totalAngle / (Math.abs(f.totalAngle - 2 * Math.PI) < 1e-9 ? f.count : f.count - 1);
        for (let k = 1; k < f.count; k++) {
          const c = Math.cos(k * step);
          const s = Math.sin(k * step);
          xf(
            (p) => [
              f.center[0] + (p[0] - f.center[0]) * c - (p[1] - f.center[1]) * s,
              f.center[1] + (p[0] - f.center[0]) * s + (p[1] - f.center[1]) * c,
            ],
            `${k}`,
          );
        }
      } else xf((p) => (f.axis === 'u' ? [p[0], 2 * f.offset - p[1]] : [2 * f.offset - p[0], p[1]]), 'm');
      byId.set(f.id, made);
      list.push(...made);
    }
  }
  return { ok: true, list };
}

/** ISO 273 medium clearance / tapping sizes used to label holes for fastener matching. */
const CLEARANCE_MM: [string, number][] = [
  ['M2', 2.4],
  ['M2.5', 2.9],
  ['M3', 3.4],
  ['M4', 4.5],
  ['M5', 5.5],
  ['M6', 6.6],
  ['M8', 9],
  ['M10', 11],
];
const TAP_MM: [string, number][] = [
  ['M2', 1.6],
  ['M2.5', 2.05],
  ['M3', 2.5],
  ['M4', 3.3],
  ['M5', 4.2],
  ['M6', 5],
  ['M8', 6.8],
  ['M10', 8.5],
];
export function holeDescriptors(diameterM: number): string[] {
  const d = diameterM * 1000;
  const out = [`hole-${Math.round(d * 100) / 100}mm`];
  for (const [m, c] of CLEARANCE_MM) if (Math.abs(c - d) <= 0.15) out.push(`${m}-clearance`);
  for (const [m, t] of TAP_MM) if (Math.abs(t - d) <= 0.05) out.push(`${m}-tapped`);
  return out;
}

export function evaluatePart(features: readonly Feature[]): PartResult {
  const base = features[0];
  if (!base || base.type !== 'extrude')
    return { ok: false, message: 'A part must start with a base extrusion.' };
  if (features.slice(1).some((f) => f.type === 'extrude'))
    return { ok: false, message: 'Only one base extrusion per part is supported.' };
  const ids = new Set<string>();
  for (const f of features) {
    if (ids.has(f.id)) return { ok: false, message: `Duplicate feature id "${f.id}".` };
    ids.add(f.id);
  }
  const D = base.depth;
  const p0 = polygonProblem(base.profile.outer, 'Base profile');
  if (p0) return { ok: false, message: p0 };
  for (const h of base.profile.holes) {
    const p = polygonProblem(h, 'Base profile hole');
    if (p) return { ok: false, message: p };
  }
  let region: MultiPolygon = polygonClipping.difference(
    [base.profile.outer as Polygon[0]],
    ...base.profile.holes.map((h) => [h] as Polygon),
  );
  for (const f of features) {
    if (f.type !== 'boolean') continue;
    const p = polygonProblem(f.profile, `Boolean ${f.id}`);
    if (p) return { ok: false, message: p };
    const tool: Polygon = [f.profile as Polygon[0]];
    region =
      f.op === 'union'
        ? polygonClipping.union(region, tool)
        : f.op === 'difference'
          ? polygonClipping.difference(region, tool)
          : polygonClipping.intersection(region, tool);
    if (region.length === 0 || area(region) < AREA_EPS)
      return { ok: false, message: `Boolean ${f.id} (${f.op}) leaves no material.` };
    if (region.length > 1)
      return {
        ok: false,
        message: `Boolean ${f.id} (${f.op}) splits the part into ${region.length} separate bodies — unsupported (one connected body per part).`,
      };
  }
  const t = tools(features);
  if (!t.ok) return t;
  const regionPoly: Polygon = region[0]!;
  for (const tool of t.list) {
    if (tool.depth !== null && tool.depth >= D - 1e-9)
      return {
        ok: false,
        message: `${tool.id}: depth ${(tool.depth * 1000).toFixed(3)} mm reaches the part thickness — use a through feature.`,
      };
    const outside = polygonClipping.difference([tool.poly as Polygon[0]], regionPoly);
    if (area(outside) > AREA_EPS)
      return {
        ok: false,
        message: `${tool.id} extends outside the part material (open/edge cuts are unsupported).`,
      };
  }
  for (let i = 0; i < t.list.length; i++)
    for (let j = i + 1; j < t.list.length; j++) {
      const ov = polygonClipping.intersection(
        [t.list[i]!.poly as Polygon[0]],
        [t.list[j]!.poly as Polygon[0]],
      );
      if (area(ov) > AREA_EPS)
        return {
          ok: false,
          message: `${t.list[i]!.id} and ${t.list[j]!.id} overlap (overlapping cuts are unsupported).`,
        };
    }
  const outer = ring(regionPoly[0] as P2[]);
  const regionHoles = regionPoly.slice(1).map((r) => ring(r as P2[]));
  const vertexCount =
    outer.length +
    regionHoles.reduce((n, h) => n + h.length, 0) +
    t.list.reduce((n, x) => n + x.poly.length, 0);
  if (vertexCount > MAX_PART_VERTICES)
    return {
      ok: false,
      message: `The part is too complex (${vertexCount} vertices > ${MAX_PART_VERTICES}).`,
    };

  // Layers from the top face down, split at every blind depth.
  const cuts = [...new Set(t.list.filter((x) => x.depth !== null).map((x) => x.depth!))].sort(
    (a, b) => a - b,
  );
  const levels = [0, ...cuts, D];
  const solids: Solid[] = [];
  let volume = 0;
  for (let k = 0; k + 1 < levels.length; k++) {
    const top = levels[k]!;
    const bottom = levels[k + 1]!;
    if (bottom - top < 1e-12) continue;
    const removed = t.list.filter((x) => x.depth === null || x.depth > top + 1e-12).map((x) => x.poly);
    const holes = [...regionHoles, ...removed];
    const solid: Solid = {
      type: 'prism',
      outline: outer,
      holes,
      depth: bottom - top,
      axis: 'y',
      at: [0, D - (top + bottom) / 2, 0],
      app: 'primary',
    };
    solids.push(solid);
    volume += (polygonArea(outer) - holes.reduce((s, h) => s + polygonArea(h), 0)) * (bottom - top);
  }
  const interfaces: ComponentInterface[] = [
    {
      id: 'top-face',
      name: 'Top face',
      type: 'mechanical-mount',
      position: [0, D, 0],
      direction: [0, 1, 0],
      gender: 'neutral',
      compatibility: ['flat-face'],
      limits: [],
    },
    {
      id: 'bottom-face',
      name: 'Bottom face',
      type: 'mechanical-mount',
      position: [0, 0, 0],
      direction: [0, -1, 0],
      gender: 'neutral',
      compatibility: ['flat-face'],
      limits: [],
    },
    ...t.list
      .filter((x) => x.diameter !== null && x.center)
      .map((x): ComponentInterface => ({
        id: `hole-${x.id}`,
        name: `Hole ${x.id} Ø${(x.diameter! * 1000).toFixed(2)} mm${x.depth === null ? ' (through)' : ` × ${(x.depth * 1000).toFixed(2)} mm deep`}`,
        type: 'bolt-hole',
        position: [x.center![0], D, x.center![1]],
        direction: [0, 1, 0],
        gender: 'female',
        compatibility: holeDescriptors(x.diameter!),
        limits: [],
      })),
  ];
  return {
    ok: true,
    geometry: {
      solids,
      interfaces,
      volumeM3: volume,
      region: { outer, holes: regionHoles },
      tools: t.list,
      depth: D,
    },
  };
}
