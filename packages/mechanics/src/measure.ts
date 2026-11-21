import {
  evaluate,
  getDefinition,
  getMaterial,
  polygonArea,
  solidBounds,
  solidVolume,
  type Solid,
} from '@forge/components';
import { worldMatrix, type Mat4, type SceneGraph, type SceneNode } from '@forge/engineering-core';
import { evaluatePart } from './part';
import {
  add,
  cross,
  dot,
  len3,
  mul,
  normalize,
  scale,
  sub,
  transformDir,
  transformPoint,
  translation,
  type V3,
} from './pose';

/**
 * Engineering measurement from model geometry and material data (never from pixels).
 * Every quantity carries a validity label (docs/SIMULATION_VALIDITY.md):
 *   - 'exact'        — computed exactly from the modelled geometry (and stated inputs);
 *   - 'approximate'  — simplified geometry (approximate profiles, envelope bounds,
 *                      typical handbook densities) or bounding-volume estimates;
 *   - 'unknown'      — insufficient data (no density, envelope model without mass).
 */
export type Validity = 'exact' | 'approximate' | 'unknown';

export interface BodyGeometry {
  nodeId: string;
  name: string;
  solids: Solid[];
  /** exact / approximate / envelope (envelope = outer shape only). */
  representation: 'exact' | 'approximate' | 'envelope';
  materialId: string | null;
  densityKgM3: number | null;
  specifiedMassKg: number | null;
}

/** Local geometry of a body node (component / part / primitive / model). */
export function bodyGeometry(_graph: SceneGraph, node: SceneNode): BodyGeometry | null {
  if (node.kind === 'component-instance' && node.component) {
    const def = getDefinition(node.definitionId);
    if (!def) return null;
    const e = evaluate(def, node.component.parameters, node.component.materialId);
    return {
      nodeId: node.id,
      name: node.name,
      solids: e.solids,
      representation: def.geometry.representation,
      materialId: node.component.materialId,
      densityKgM3: e.material?.densityKgM3 ?? null,
      specifiedMassKg: def.specifiedMassKg,
    };
  }
  if (node.kind === 'part') {
    const p = evaluatePart(node.features);
    if (!p.ok) return null;
    return {
      nodeId: node.id,
      name: node.name,
      solids: p.geometry.solids,
      representation: 'exact',
      materialId: node.materialId,
      densityKgM3: getMaterial(node.materialId)?.densityKgM3 ?? null,
      specifiedMassKg: null,
    };
  }
  if (node.kind === 'primitive' && node.geometry.shape === 'box') {
    const g = node.geometry;
    const s = node.transform.scale;
    return {
      nodeId: node.id,
      name: node.name,
      solids: [
        {
          type: 'box',
          size: [g.width * s[0], g.height * s[1], g.depth * s[2]],
          at: [0, 0, 0],
          app: 'primary',
        },
      ],
      representation: 'exact',
      materialId: null,
      densityKgM3: null,
      specifiedMassKg: null,
    };
  }
  if (node.kind === 'model-instance') {
    const [x, y, z] = node.model.boundsM;
    return {
      nodeId: node.id,
      name: node.name,
      solids: [{ type: 'box', size: [x, y, z], at: [0, y / 2, 0], app: 'primary' }],
      representation: 'envelope',
      materialId: null,
      densityKgM3: null,
      specifiedMassKg: null,
    };
  }
  return null;
}

/** Centroid (component frame) of one solid. */
function solidCentroid(s: Solid): V3 {
  if (s.type !== 'prism') {
    const b = solidBounds(s);
    return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  }
  // Polygon centroid with holes (signed areas), then mapped by axis.
  const c2 = (pts: [number, number][]) => {
    let a = 0,
      cx = 0,
      cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i]!;
      const [x2, y2] = pts[(i + 1) % pts.length]!;
      const f = x1 * y2 - x2 * y1;
      a += f;
      cx += (x1 + x2) * f;
      cy += (y1 + y2) * f;
    }
    a /= 2;
    return { a: Math.abs(a), c: [cx / (6 * a), cy / (6 * a)] as [number, number] };
  };
  const outer = c2(s.outline);
  let A = outer.a;
  let u = outer.c[0] * outer.a;
  let v = outer.c[1] * outer.a;
  for (const h of s.holes ?? []) {
    const hc = c2(h);
    A -= hc.a;
    u -= hc.c[0] * hc.a;
    v -= hc.c[1] * hc.a;
  }
  u /= A;
  v /= A;
  const [x, y, z] = s.at;
  return s.axis === 'z' ? [x + u, y + v, z] : s.axis === 'x' ? [x, y + v, z + u] : [x + u, y, z + v];
}

export interface MassProperties {
  massKg: number | null;
  /** Centre of mass (world frame, metres). */
  centerOfMass: V3 | null;
  validity: Validity;
  note: string;
}

/** Mass and centre of mass of one body in the world frame. */
export function massProperties(graph: SceneGraph, nodeId: string): MassProperties {
  const n = graph.nodes[nodeId];
  const g = n && bodyGeometry(graph, n);
  if (!n || !g)
    return {
      massKg: null,
      centerOfMass: null,
      validity: 'unknown',
      note: 'No engineering geometry for this node.',
    };
  const W = worldMatrix(graph, nodeId);
  const primary = g.solids.filter((s) => s.app === 'primary');
  const vol = primary.reduce((s, x) => s + solidVolume(x), 0);
  const com = (solids: Solid[]): V3 => {
    const w = solids.map(solidVolume);
    const tot = w.reduce((a, b) => a + b, 0) || 1;
    return solids.reduce((acc, s, i) => add(acc, scale(solidCentroid(s), w[i]! / tot)), [0, 0, 0] as V3);
  };
  if (g.specifiedMassKg !== null)
    return {
      massKg: g.specifiedMassKg,
      centerOfMass: transformPoint(W, com(g.solids)),
      validity: 'approximate',
      note: 'Published mass; centre of mass from the envelope geometry (approximate).',
    };
  if (g.representation === 'envelope' || g.densityKgM3 === null || primary.length === 0)
    return {
      massKg: null,
      centerOfMass: transformPoint(W, com(g.solids)),
      validity: 'unknown',
      note:
        g.representation === 'envelope'
          ? 'Envelope model: mass unknown; centre shown is the geometric centre.'
          : 'Material density unknown.',
    };
  return {
    massKg: vol * g.densityKgM3,
    centerOfMass: transformPoint(W, com(primary)),
    validity: 'approximate', // typical handbook density, even when the geometry is exact
    note: `Volume ${(vol * 1e6).toFixed(3)} cm³ ${g.representation === 'exact' ? '(exact geometry)' : '(simplified geometry)'} × typical density ${g.densityKgM3} kg/m³ (handbook value — therefore approximate).`,
  };
}

/** Total mass and centre of mass of an assembly's bodies (recursing into sub-assemblies). */
export function assemblyMass(
  graph: SceneGraph,
  assemblyId: string,
): MassProperties & { known: number; unknown: string[] } {
  const ids: string[] = [];
  const walk = (id: string) => {
    for (const c of graph.nodes[id]?.childIds ?? []) {
      const k = graph.nodes[c]!.kind;
      if (k === 'assembly' || k === 'group') walk(c);
      else ids.push(c);
    }
  };
  walk(assemblyId);
  let m = 0;
  let acc: V3 = [0, 0, 0];
  const unknown: string[] = [];
  for (const id of ids) {
    const p = massProperties(graph, id);
    if (p.massKg === null || !p.centerOfMass) {
      unknown.push(graph.nodes[id]!.name);
      continue;
    }
    m += p.massKg;
    acc = add(acc, scale(p.centerOfMass, p.massKg));
  }
  return {
    massKg: ids.length - unknown.length > 0 ? m : null,
    centerOfMass: m > 0 ? scale(acc, 1 / m) : null,
    validity: unknown.length ? 'unknown' : 'approximate',
    note: unknown.length
      ? `Partial: ${unknown.length} part(s) have unknown mass and are excluded.`
      : 'Sum of approximate part masses.',
    known: ids.length - unknown.length,
    unknown,
  };
}

export interface Aabb {
  min: V3;
  max: V3;
}
/** World-axis-aligned bounds of a body (transformed corners of its local bounds). */
export function worldBounds(graph: SceneGraph, nodeId: string): Aabb | null {
  const n = graph.nodes[nodeId];
  const g = n && bodyGeometry(graph, n);
  if (!g) return null;
  const W = worldMatrix(graph, nodeId);
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const s of g.solids) {
    const b = solidBounds(s);
    for (const cx of [b.min[0], b.max[0]])
      for (const cy of [b.min[1], b.max[1]])
        for (const cz of [b.min[2], b.max[2]]) {
          const p = transformPoint(W, [cx, cy, cz]);
          for (let i = 0; i < 3; i++) {
            min[i] = Math.min(min[i]!, p[i]!);
            max[i] = Math.max(max[i]!, p[i]!);
          }
        }
  }
  return { min, max };
}

export const pointDistance = (a: V3, b: V3) => len3(sub(a, b));
/** Angle between two directions (rad, 0…π). */
export const axisAngle = (a: V3, b: V3) =>
  Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b)))));
/** Gap between two AABBs (0 if overlapping) — a bounding-volume ESTIMATE of clearance. */
export function aabbGap(a: Aabb, b: Aabb): number {
  const d = [0, 1, 2].map((i) => Math.max(0, a.min[i]! - b.max[i]!, b.min[i]! - a.max[i]!));
  return Math.hypot(d[0]!, d[1]!, d[2]!);
}

// ----------------------------------------------------------------- interference

/** Oriented box in world space. */
interface Obb {
  c: V3;
  axes: [V3, V3, V3];
  half: V3;
  /** true when the box IS the solid (box solids); false when it bounds a curved/holed solid. */
  exact: boolean;
}
function solidObbs(graph: SceneGraph, nodeId: string): Obb[] {
  const n = graph.nodes[nodeId]!;
  const g = bodyGeometry(graph, n);
  if (!g) return [];
  const W = worldMatrix(graph, nodeId);
  return g.solids.map((s) => {
    let M: Mat4;
    let half: V3;
    let exact: boolean;
    if (s.type === 'box') {
      M = mul(
        W,
        translation(...s.at),
        s.yaw
          ? [
              Math.cos(s.yaw),
              0,
              -Math.sin(s.yaw),
              0,
              0,
              1,
              0,
              0,
              Math.sin(s.yaw),
              0,
              Math.cos(s.yaw),
              0,
              0,
              0,
              0,
              1,
            ]
          : translation(0, 0, 0),
      );
      half = [s.size[0] / 2, s.size[1] / 2, s.size[2] / 2];
      exact = g.representation !== 'envelope';
    } else {
      const b = solidBounds(s);
      M = mul(
        W,
        translation((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2),
      );
      half = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2];
      exact =
        s.type === 'prism' &&
        !s.holes?.length &&
        s.outline.length === 4 &&
        Math.abs(
          polygonArea(s.outline) -
            (b.max[0] - b.min[0]) * (s.axis === 'y' ? b.max[2] - b.min[2] : b.max[1] - b.min[1]),
        ) < 1e-12 &&
        g.representation !== 'envelope';
    }
    return {
      c: transformPoint(M, [0, 0, 0]),
      axes: [transformDir(M, [1, 0, 0]), transformDir(M, [0, 1, 0]), transformDir(M, [0, 0, 1])],
      half,
      exact,
    };
  });
}

/** Separating-axis test; returns penetration depth (> 0 overlap) along the best axis. */
function obbPenetration(a: Obb, b: Obb): number {
  const axes: V3[] = [...a.axes, ...b.axes];
  for (const u of a.axes)
    for (const v of b.axes) {
      const c = cross(u, v);
      if (len3(c) > 1e-9) axes.push(normalize(c));
    }
  const d = sub(b.c, a.c);
  let min = Infinity;
  for (const L of axes) {
    const ra = a.half.reduce((s, h, i) => s + h * Math.abs(dot(a.axes[i]!, L)), 0);
    const rb = b.half.reduce((s, h, i) => s + h * Math.abs(dot(b.axes[i]!, L)), 0);
    const overlap = ra + rb - Math.abs(dot(d, L));
    if (overlap < min) min = overlap;
    if (min < 0) return min;
  }
  return min;
}

export const CONTACT_TOLERANCE = 1e-5; // 0.01 mm

export interface InterferenceResult {
  a: string;
  b: string;
  /** contact: touching within tolerance; interference: verified overlap of exact box solids;
   *  possible: overlap of bounding boxes of curved / holed / envelope solids (preliminary). */
  kind: 'contact' | 'interference' | 'possible';
  penetrationM: number;
  /** Bodies directly related by a mate or constraint (contact there is usually intended). */
  mated: boolean;
  note: string;
}

/** Broad phase (world AABBs) then narrow phase (OBB SAT per solid pair). */
export function checkInterference(
  graph: SceneGraph,
  nodeIds: readonly string[],
  matedPairs: ReadonlySet<string> = new Set(),
): InterferenceResult[] {
  const boxes = nodeIds.map((id) => ({ id, aabb: worldBounds(graph, id) })).filter((x) => x.aabb) as {
    id: string;
    aabb: Aabb;
  }[];
  const out: InterferenceResult[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i]!;
      const B = boxes[j]!;
      if (aabbGap(A.aabb, B.aabb) > CONTACT_TOLERANCE) continue;
      const oa = solidObbs(graph, A.id);
      const ob = solidObbs(graph, B.id);
      let best = -Infinity;
      let exact = true;
      for (const x of oa)
        for (const y of ob) {
          const p = obbPenetration(x, y);
          if (p > best) {
            best = p;
            exact = x.exact && y.exact;
          } else if (p > CONTACT_TOLERANCE) exact = exact && x.exact && y.exact;
        }
      if (best < -CONTACT_TOLERANCE) continue;
      const mated = matedPairs.has(`${A.id}|${B.id}`) || matedPairs.has(`${B.id}|${A.id}`);
      const kind: InterferenceResult['kind'] =
        best <= CONTACT_TOLERANCE ? 'contact' : exact ? 'interference' : 'possible';
      out.push({
        a: A.id,
        b: B.id,
        kind,
        penetrationM: Math.max(0, best),
        mated,
        note:
          kind === 'interference'
            ? 'Overlap of exact box solids (verified for this geometry).'
            : kind === 'possible'
              ? 'Bounding volumes of curved, holed or envelope solids overlap — preliminary; the parts may not actually intersect.'
              : 'Surfaces touch within 0.01 mm.',
      });
    }
  return out;
}

// ----------------------------------------------------------------- exploded views

/**
 * View-only explode offsets (assembly frame): each body moves away from the assembly's
 * centroid by `factor` × its distance (min 10 mm). Never written to the model.
 */
export function explodeOffsets(graph: SceneGraph, assemblyId: string, factor: number): Record<string, V3> {
  const asm = graph.nodes[assemblyId];
  if (!asm) return {};
  const centers = asm.childIds.map((id) => {
    const b = bodyGeometry(graph, graph.nodes[id]!);
    const t = graph.nodes[id]!.transform.position;
    if (!b) return { id, c: t as V3 };
    const bb = b.solids.map(solidBounds);
    const lc: V3 = [0, 1, 2].map(
      (i) => (Math.min(...bb.map((x) => x.min[i]!)) + Math.max(...bb.map((x) => x.max[i]!))) / 2,
    ) as V3;
    const T = graph.nodes[id]!.transform;
    // Centre in the assembly frame.
    const q = T.rotation;
    const M = [
      1 - 2 * (q[1] ** 2 + q[2] ** 2),
      2 * (q[0] * q[1] + q[2] * q[3]),
      2 * (q[0] * q[2] - q[1] * q[3]),
      0,
      2 * (q[0] * q[1] - q[2] * q[3]),
      1 - 2 * (q[0] ** 2 + q[2] ** 2),
      2 * (q[1] * q[2] + q[0] * q[3]),
      0,
      2 * (q[0] * q[2] + q[1] * q[3]),
      2 * (q[1] * q[2] - q[0] * q[3]),
      1 - 2 * (q[0] ** 2 + q[1] ** 2),
      0,
      T.position[0],
      T.position[1],
      T.position[2],
      1,
    ];
    return { id, c: transformPoint(M, lc) };
  });
  if (centers.length === 0) return {};
  const g = scale(
    centers.reduce((a, x) => add(a, x.c), [0, 0, 0] as V3),
    1 / centers.length,
  );
  const out: Record<string, V3> = {};
  for (const { id, c } of centers) {
    const d = sub(c, g);
    const L = len3(d);
    const dirn: V3 = L > 1e-9 ? scale(d, 1 / L) : [0, 1, 0];
    out[id] = scale(dirn, factor * Math.max(L, 0.01));
  }
  return out;
}
