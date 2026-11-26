import { getMaterial, solidBounds, solidVolume, type Solid } from '@forge/components';
import {
  bodySettingsFor,
  compose,
  decompose,
  drivingRelations,
  invert,
  multiply,
  worldMatrix,
  type BodySettings,
  type JointSettings,
  type Mat4,
  type Mate,
  type SceneGraph,
  type SceneNode,
  type SimulationDefinition,
} from '@forge/engineering-core';
import { bodyGeometry, makeRefResolver, solveAssembly } from '@forge/mechanics';
import {
  combine,
  pointMass,
  quatFromMat3,
  rotationOf,
  solidMass,
  transformMass,
  type Mat3,
  type MassProps,
  type V3,
} from './mass';

/**
 * CAD → physics bridge (pure data; no Rapier). Converts the authoritative engineering
 * scene + the simulation definition into a PhysicsModel:
 *
 *  - every body of every assembly, and every loose body, becomes a physics BODY UNIT;
 *    units welded together by unsuppressed FIXED mates are merged into one rigid body
 *    (exact for ideal rigid fixed joints, and far more stable than a stiff fixed joint);
 *  - every other unsuppressed mate becomes a joint whose meaning is preserved exactly, or
 *    the conversion fails with an explicit issue (no silent degradation);
 *  - mass, centre of mass and inertia come from the modelled solids and declared/selected
 *    densities or masses. A dynamic body with unknown mass is an ERROR: the user must supply
 *    a mass or choose an approximate material model. Nothing is inferred from appearance;
 *  - colliders are primitive shapes per modelled solid (box, cylinder, sphere, convex hull);
 *    each approximation is listed. Imported meshes get NO collider unless the user selects
 *    the (approximate) bounding-box collider.
 *
 * Frames: each physics body's frame starts WORLD-ALIGNED (identity rotation) at its centre
 * of mass (dynamic) or at its first unit's origin (fixed/kinematic). Therefore a joint axis
 * is the same vector in both bodies' frames at t = 0, which is what Rapier's single-axis
 * joints require, and every joint coordinate is measured as q = q₀ + (relative motion since
 * t = 0), where q₀ is the CAD (or home) coordinate.
 */

export type Severity = 'error' | 'warning' | 'info';
export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  refs: string[];
}
export type Status = 'verified' | 'approximate' | 'illustrative' | 'unsupported';
export interface Assumption {
  topic: string;
  status: Status;
  text: string;
}

export type ColliderShape =
  | { type: 'cuboid'; half: V3 }
  | { type: 'ball'; radius: number }
  | { type: 'cylinder'; halfHeight: number; radius: number }
  | { type: 'convex'; points: number[] };

export interface ColliderSpec {
  nodeId: string;
  shape: ColliderShape;
  /** Body-local pose. */
  position: V3;
  rotation: [number, number, number, number];
  /** null = the shape equals the modelled solid exactly. */
  approximation: string | null;
}

export interface MassSource {
  nodeId: string;
  name: string;
  massKg: number;
  source: 'geometry-density' | 'published' | 'user' | 'material' | 'inertial';
  status: Status;
  note: string;
}

export interface ModelBody {
  id: string;
  name: string;
  /** Body units (assembly members / loose bodies) rigidly carried by this body. */
  unitIds: string[];
  assemblyId: string | null;
  mode: 'dynamic' | 'fixed' | 'kinematic';
  /** World position of the body frame at t = 0 (frame rotation is identity at t = 0). */
  origin: V3;
  /** Without payloads; null for fixed/kinematic bodies (mass is irrelevant to them). */
  mass: MassProps | null;
  massSources: MassSource[];
  colliders: ColliderSpec[];
  /** unit node id → rigid world matrix of the unit relative to the body frame (body⁻¹ · unit). */
  unitOffsets: Record<string, Mat4>;
  settings: BodySettings;
  /** Rapier interaction-groups word (membership << 16 | filter). */
  collisionGroups: number;
}

export type JointMapping = 'revolute' | 'prismatic' | 'spherical' | 'cylindrical' | 'planar';

export interface ModelJoint {
  mateId: string;
  name: string;
  type: Mate['type'];
  mapping: JointMapping;
  assemblyId: string;
  bodyA: string;
  bodyB: string;
  /** Anchor in each body's frame (m). */
  anchorA: V3;
  anchorB: V3;
  /** Joint axis (= mate +Z of A), world = body-local at t = 0. */
  axis: V3;
  /** Mate +X of A (planar in-plane coordinate reference), world at t = 0. */
  xRef: V3;
  /** Rotation of A's mate frame at t = 0 (row-major, world). */
  frameA0: Mat3;
  /** CAD (or home) joint coordinates at t = 0 (rad / m). */
  q0: number[];
  /** Enforced limits in the joint's own coordinates (null = free). */
  limits: ({ min: number; max: number } | null)[];
  droppedLimits: boolean;
  settings: JointSettings;
}

export interface ModelPayload {
  id: string;
  name: string;
  bodyId: string;
  massKg: number;
  /** Body-local point (m). */
  at: V3;
}

export interface PhysicsModel {
  ok: boolean;
  bodies: ModelBody[];
  joints: ModelJoint[];
  payloads: ModelPayload[];
  issues: Issue[];
  assumptions: Assumption[];
  /** node id → body id, for every node carried by a body (units and their descendants). */
  bodyOfNode: Record<string, string>;
  definition: SimulationDefinition;
}

// ---------------------------------------------------------------------------------------

const ROOTLESS_BODY_KINDS = new Set(['component-instance', 'part', 'primitive', 'model-instance']);
const COMPOSITE_KINDS = new Set(['assembly', 'group']);

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const originOf = (m: Mat4): V3 => [m[12]!, m[13]!, m[14]!];
const colOf = (m: Mat4, c: number): V3 => [m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!];
const translationM = (t: V3): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];

interface Unit {
  nodeId: string;
  name: string;
  assemblyId: string | null;
  /** Geometry-bearing nodes carried by the unit (itself, or descendants of a composite). */
  leaves: string[];
  settings: BodySettings;
  mode: 'dynamic' | 'fixed' | 'kinematic';
}

/** Graph with every assembly's mates at their home coordinates, re-solved (initialPose: 'home'). */
function homeGraph(graph: SceneGraph, issues: Issue[]): SceneGraph {
  const nodes = { ...graph.nodes };
  for (const n of Object.values(graph.nodes)) {
    if (n.kind !== 'assembly') continue;
    nodes[n.id] = {
      ...n,
      mechanical: {
        ...n.mechanical,
        mates: n.mechanical.mates.map((m) => ({ ...m, coordinates: [...m.home] })),
      },
    };
  }
  let g: SceneGraph = { rootId: graph.rootId, nodes };
  for (const n of Object.values(graph.nodes)) {
    if (n.kind !== 'assembly' || !n.mechanical.mates.length) continue;
    const r = solveAssembly(
      g,
      n.id,
      n.mechanical.mates.map((m) => m.id),
    );
    if (!r.ok) {
      issues.push({
        severity: 'error',
        code: 'home-pose',
        message: `Home pose of "${n.name}" cannot be solved: ${r.message}`,
        refs: [n.id],
      });
      continue;
    }
    const next = { ...g.nodes };
    for (const [id, t] of Object.entries(r.transforms))
      next[id] = { ...next[id]!, transform: t } as SceneNode;
    g = { rootId: g.rootId, nodes: next };
  }
  return g;
}

/** Local solids of a leaf plus the uniform scale baked into them (primitives may be scaled). */
function leafSolids(
  graph: SceneGraph,
  n: SceneNode,
): { solids: Solid[]; g: ReturnType<typeof bodyGeometry> } | null {
  if (n.kind === 'primitive' && n.geometry.shape !== 'box') {
    const s = n.transform.scale;
    if (n.geometry.shape === 'sphere' && Math.abs(s[0] - s[1]) < 1e-9 && Math.abs(s[1] - s[2]) < 1e-9)
      return {
        solids: [{ type: 'sphere', r: n.geometry.radius * s[0], at: [0, 0, 0], app: 'primary' }],
        g: null,
      };
    if (n.geometry.shape === 'cylinder' && Math.abs(s[0] - s[2]) < 1e-9)
      return {
        solids: [
          {
            type: 'cylinder',
            r: n.geometry.radius * s[0],
            h: n.geometry.height * s[1],
            axis: 'y',
            at: [0, 0, 0],
            app: 'primary',
          },
        ],
        g: null,
      };
    return null;
  }
  const g = bodyGeometry(graph, n);
  return g ? { solids: g.solids, g } : null;
}

/** Rigid part of a world matrix; `ownScale` is allowed (baked into primitive geometry). */
function rigid(m: Mat4, ownScale: V3): { M: Mat4; ok: boolean } {
  const { trs } = decompose(m);
  const ok = trs.scale.every((v, i) => Math.abs(v - ownScale[i]!) < 1e-6);
  return { M: compose({ position: trs.position, rotation: trs.rotation, scale: [1, 1, 1] }), ok };
}

const quatOfRotation = (R: Mat3) => quatFromMat3(R);
const ROT_Y_TO = {
  x: [0, 0, -Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number], // Rz(−90°): +Y → +X
  y: [0, 0, 0, 1] as [number, number, number, number],
  z: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as [number, number, number, number], // Rx(+90°): +Y → +Z
};
function quatMul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  const [ax, ay, az, aw] = a as [number, number, number, number];
  const [bx, by, bz, bw] = b as [number, number, number, number];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Colliders for one leaf, in the body frame (rigid leaf pose W relative to body origin). */
function leafColliders(
  nodeId: string,
  solids: readonly Solid[],
  W: Mat4,
  origin: V3,
  mode: BodySettings['collider'],
): ColliderSpec[] {
  const R = rotationOf(W);
  const qW = quatOfRotation(R);
  const toBody = (p: V3): V3 => {
    const x = W[0]! * p[0] + W[4]! * p[1] + W[8]! * p[2] + W[12]!;
    const y = W[1]! * p[0] + W[5]! * p[1] + W[9]! * p[2] + W[13]!;
    const z = W[2]! * p[0] + W[6]! * p[1] + W[10]! * p[2] + W[14]!;
    return [x - origin[0], y - origin[1], z - origin[2]];
  };
  if (mode === 'none' || solids.length === 0) return [];
  if (mode === 'bounds-box') {
    const bs = solids.map(solidBounds);
    const min = [0, 1, 2].map((k) => Math.min(...bs.map((b) => b.min[k]!))) as V3;
    const max = [0, 1, 2].map((k) => Math.max(...bs.map((b) => b.max[k]!))) as V3;
    return [
      {
        nodeId,
        shape: {
          type: 'cuboid',
          half: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
        },
        position: toBody([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]),
        rotation: qW,
        approximation: 'bounding box of the modelled solids (approximate contact surface)',
      },
    ];
  }
  const out: ColliderSpec[] = [];
  for (const s of solids) {
    switch (s.type) {
      case 'box': {
        const y = s.yaw ?? 0;
        out.push({
          nodeId,
          shape: { type: 'cuboid', half: [s.size[0] / 2, s.size[1] / 2, s.size[2] / 2] },
          position: toBody(s.at),
          rotation: quatMul(qW, [0, Math.sin(y / 2), 0, Math.cos(y / 2)]),
          approximation: null,
        });
        break;
      }
      case 'cylinder':
      case 'tube':
        out.push({
          nodeId,
          shape: { type: 'cylinder', halfHeight: s.h / 2, radius: s.type === 'tube' ? s.ro : s.r },
          position: toBody(s.at),
          rotation: quatMul(qW, ROT_Y_TO[s.axis]),
          approximation: s.type === 'tube' ? 'hollow tube collides as a solid cylinder' : null,
        });
        break;
      case 'sphere':
        out.push({
          nodeId,
          shape: { type: 'ball', radius: s.r },
          position: toBody(s.at),
          rotation: [0, 0, 0, 1],
          approximation: null,
        });
        break;
      case 'prism': {
        const idx = s.axis === 'z' ? [0, 1, 2] : s.axis === 'x' ? [2, 1, 0] : [0, 2, 1];
        const pts: number[] = [];
        for (const w of [-s.depth / 2, s.depth / 2])
          for (const [u, v] of s.outline) {
            const p: V3 = [...s.at];
            p[idx[0]!]! += u;
            p[idx[1]!]! += v;
            p[idx[2]!]! += w;
            pts.push(...toBody(p));
          }
        const holes = (s.holes ?? []).length > 0;
        out.push({
          nodeId,
          shape: { type: 'convex', points: pts },
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          approximation:
            holes || !convexPolygon(s.outline)
              ? 'convex hull of the profile (holes and concavities are filled)'
              : null,
        });
        break;
      }
    }
  }
  return out;
}

function convexPolygon(pts: readonly [number, number][]): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const c = pts[(i + 2) % pts.length]!;
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-15) continue;
    if (sign === 0) sign = Math.sign(z);
    else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

/** Mass properties (world frame) and their provenance for one leaf under its unit's settings. */
function leafMass(
  graph: SceneGraph,
  n: SceneNode,
  solids: readonly Solid[],
  geo: ReturnType<typeof bodyGeometry>,
  W: Mat4,
  settings: BodySettings,
  userShare: number | null,
): { mass: MassProps; source: MassSource } | { error: string } {
  const R = rotationOf(W);
  const t = originOf(W);
  const byVolume = (total: number) => {
    const vol = solids.reduce((s, x) => s + solidVolume(x), 0);
    if (!(vol > 0)) return null;
    return combine(solids.map((s) => solidMass(s, total / vol)));
  };
  const toWorld = (mp: MassProps | null) => (mp ? transformMass(mp, R, t) : null);
  if (settings.mass.source === 'user') {
    const mp = toWorld(byVolume(userShare ?? settings.mass.massKg));
    if (!mp) return { error: `"${n.name}" has no modelled volume to distribute a mass over.` };
    return {
      mass: mp,
      source: {
        nodeId: n.id,
        name: n.name,
        massKg: mp.massKg,
        source: 'user',
        status: 'approximate',
        note: `User-supplied mass${settings.mass.note ? ` (${settings.mass.note})` : ''}; inertia assumes uniform density over the modelled solids.`,
      },
    };
  }
  if (settings.mass.source === 'material') {
    const mat = getMaterial(settings.mass.materialId);
    if (!mat?.densityKgM3) return { error: `Material "${settings.mass.materialId}" has no known density.` };
    const mp = toWorld(combine(solids.map((s) => solidMass(s, mat.densityKgM3!))));
    if (!mp) return { error: `"${n.name}" has no modelled volume.` };
    return {
      mass: mp,
      source: {
        nodeId: n.id,
        name: n.name,
        massKg: mp.massKg,
        source: 'material',
        status: 'approximate',
        note: `Modelled volume × typical density of ${mat.name} (${mat.densityKgM3} kg/m³, handbook value).`,
      },
    };
  }
  // 'model': the engineering model's own mass data.
  if (geo?.specifiedMassKg != null) {
    const mp = toWorld(byVolume(geo.specifiedMassKg));
    if (mp)
      return {
        mass: mp,
        source: {
          nodeId: n.id,
          name: n.name,
          massKg: mp.massKg,
          source: 'published',
          status: 'approximate',
          note: 'Published (datasheet-cited) mass; inertia from the envelope geometry with uniform density.',
        },
      };
  }
  const density = geo ? geo.densityKgM3 : null;
  const primary = solids.filter((s) => s.app === 'primary');
  if (geo && geo.representation !== 'envelope' && density && primary.length) {
    const mp = toWorld(combine(primary.map((s) => solidMass(s, density))));
    if (mp)
      return {
        mass: mp,
        source: {
          nodeId: n.id,
          name: n.name,
          massKg: mp.massKg,
          source: 'geometry-density',
          status: 'approximate',
          note: `Modelled volume (${geo.representation} geometry) × typical density ${density} kg/m³ (handbook value).`,
        },
      };
  }
  void graph;
  return {
    error:
      geo?.representation === 'envelope' || n.kind === 'model-instance'
        ? `Mass of "${n.name}" is unknown (envelope/imported geometry). Supply a mass or select a material model.`
        : `Mass of "${n.name}" is unknown (no material density). Supply a mass or select a material model.`,
  };
}

/** Build the physics model. Never throws for user data: problems become issues. */
export function buildPhysicsModel(sourceGraph: SceneGraph, definition: SimulationDefinition): PhysicsModel {
  const issues: Issue[] = [];
  const assumptions: Assumption[] = [];
  const graph = definition.initialPose === 'home' ? homeGraph(sourceGraph, issues) : sourceGraph;
  const nodes = graph.nodes;
  const err = (code: string, message: string, refs: string[] = []) =>
    issues.push({ severity: 'error', code, message, refs });
  const warn = (code: string, message: string, refs: string[] = []) =>
    issues.push({ severity: 'warning', code, message, refs });
  const info = (code: string, message: string, refs: string[] = []) =>
    issues.push({ severity: 'info', code, message, refs });

  // Dangling setting references are reported, never fatal.
  for (const b of definition.bodies)
    if (!nodes[b.nodeId])
      warn('stale-setting', `Body settings refer to a deleted node "${b.nodeId}" (ignored).`, [b.nodeId]);
  const allMates = new Map<string, { mate: Mate; assemblyId: string }>();
  for (const n of Object.values(nodes))
    if (n.kind === 'assembly')
      for (const m of n.mechanical.mates) allMates.set(m.id, { mate: m, assemblyId: n.id });
  for (const j of definition.joints)
    if (!allMates.has(j.mateId))
      warn('stale-setting', `Joint settings refer to a deleted mate "${j.mateId}" (ignored).`, [j.mateId]);

  // 1. Body units.
  const units: Unit[] = [];
  const descendantsWithGeometry = (id: string): string[] => {
    const out: string[] = [];
    const walk = (x: string) => {
      const n = nodes[x];
      if (!n) return;
      if (ROOTLESS_BODY_KINDS.has(n.kind)) out.push(x);
      for (const c of n.childIds) walk(c);
    };
    walk(id);
    return out;
  };
  const addUnit = (id: string, assemblyId: string | null) => {
    const n = nodes[id]!;
    const settings = bodySettingsFor(definition, id);
    if (settings.mode === 'excluded') {
      info('excluded', `"${n.name}" is excluded from the simulation.`, [id]);
      return;
    }
    let mode: Unit['mode'];
    if (settings.mode === 'auto') {
      const asm = assemblyId ? nodes[assemblyId] : undefined;
      mode =
        asm?.kind === 'assembly' ? (asm.mechanical.grounded.includes(id) ? 'fixed' : 'dynamic') : 'fixed';
    } else mode = settings.mode;
    const leaves = COMPOSITE_KINDS.has(n.kind) ? descendantsWithGeometry(id) : [id];
    if (
      COMPOSITE_KINDS.has(n.kind) &&
      n.kind === 'assembly' &&
      drivingRelations(n.mechanical).some((r) => 'type' in r && r.type !== 'fixed')
    )
      warn(
        'rigid-subassembly',
        `Sub-assembly "${n.name}" moves as ONE rigid body; its internal joints are not simulated.`,
        [id],
      );
    units.push({ nodeId: id, name: n.name, assemblyId, leaves, settings, mode });
  };
  const visit = (id: string) => {
    const n = nodes[id];
    if (!n) return;
    if (n.kind === 'assembly') {
      for (const c of n.childIds) {
        const k = nodes[c]?.kind;
        if (k && (ROOTLESS_BODY_KINDS.has(k) || COMPOSITE_KINDS.has(k))) addUnit(c, id);
      }
      return;
    }
    if (n.kind === 'group' || n.kind === 'root') {
      for (const c of n.childIds) visit(c);
      return;
    }
    if (ROOTLESS_BODY_KINDS.has(n.kind)) addUnit(id, null);
  };
  visit(graph.rootId);
  const unitById = new Map(units.map((u) => [u.nodeId, u]));

  // 2. Clusters: units welded by unsuppressed fixed mates.
  const parent = new Map(units.map((u) => [u.nodeId, u.nodeId]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const assemblyIds = [...new Set(units.map((u) => u.assemblyId).filter((x): x is string => !!x))];
  for (const aid of assemblyIds) {
    const a = nodes[aid];
    if (a?.kind !== 'assembly') continue;
    for (const m of a.mechanical.mates)
      if (!m.suppressed && m.type === 'fixed' && unitById.has(m.a.nodeId) && unitById.has(m.b.nodeId))
        parent.set(find(m.a.nodeId), find(m.b.nodeId));
  }
  const clusters = new Map<string, Unit[]>();
  for (const u of units) {
    const r = find(u.nodeId);
    clusters.set(r, [...(clusters.get(r) ?? []), u]);
  }

  // 3. Bodies.
  const bodies: ModelBody[] = [];
  const bodyOfUnit = new Map<string, string>();
  const bodyOfNode: Record<string, string> = {};
  const rigidWorld = new Map<string, Mat4>();
  const worldOf = (id: string): Mat4 | null => {
    const hit = rigidWorld.get(id);
    if (hit) return hit;
    const n = nodes[id]!;
    const own: V3 = n.kind === 'primitive' ? [...n.transform.scale] : [1, 1, 1];
    const r = rigid(worldMatrix(graph, id), own);
    if (!r.ok) {
      err(
        'scaled-body',
        `"${n.name}" is scaled through its parents; scaled bodies cannot be simulated rigidly.`,
        [id],
      );
      return null;
    }
    rigidWorld.set(id, r.M);
    return r.M;
  };
  const asmIndex = new Map(assemblyIds.map((id, i) => [id, i]));
  if (assemblyIds.length > 15)
    warn(
      'collision-groups',
      'More than 15 assemblies: some share a collision group, so their self-collision setting is shared.',
    );
  let bodyCount = 0;
  for (const members of clusters.values()) {
    const modes = new Set(members.map((u) => u.mode));
    let mode: ModelBody['mode'];
    if (modes.has('fixed') && modes.has('kinematic')) {
      err(
        'mode-conflict',
        `Bodies welded by fixed mates mix "fixed" and "kinematic": ${members.map((u) => `"${u.name}"`).join(', ')}.`,
        members.map((u) => u.nodeId),
      );
      continue;
    }
    if (modes.has('fixed')) mode = 'fixed';
    else if (modes.has('kinematic')) mode = 'kinematic';
    else mode = 'dynamic';
    if (modes.size > 1 && mode !== 'fixed')
      warn(
        'mode-merge',
        `Welded bodies ${members.map((u) => `"${u.name}"`).join(', ')} move together as one ${mode} body.`,
        members.map((u) => u.nodeId),
      );

    // Mass (dynamic only).
    const massSources: MassSource[] = [];
    const parts: MassProps[] = [];
    let massOk = true;
    const geometry: {
      unit: Unit;
      leaf: string;
      solids: Solid[];
      geo: ReturnType<typeof bodyGeometry>;
      W: Mat4;
    }[] = [];
    for (const u of members) {
      if (!worldOf(u.nodeId)) massOk = false;
      for (const leaf of u.leaves) {
        const ln = nodes[leaf]!;
        const W = worldOf(leaf);
        if (!W) {
          massOk = false;
          continue;
        }
        const ls = leafSolids(graph, ln);
        if (!ls) {
          info('no-geometry', `"${ln.name}" has no engineering geometry: no mass and no collider.`, [leaf]);
          continue;
        }
        geometry.push({ unit: u, leaf, solids: ls.solids, geo: ls.g, W });
      }
    }
    if (mode === 'dynamic') {
      for (const u of members) {
        const own = geometry.filter((g) => g.unit === u);
        // Phase 8: complete mass properties supplied by a source document (e.g. URDF
        // <inertial>) or the user, in the unit node's local frame — used as given.
        if (u.settings.mass.source === 'inertial') {
          const Wu = worldOf(u.nodeId);
          if (!Wu) {
            massOk = false;
            continue;
          }
          const ms = u.settings.mass;
          const [ixx, iyy, izz, ixy, ixz, iyz] = ms.inertia;
          const local: MassProps = {
            massKg: ms.massKg,
            com: [...ms.comM],
            inertia: [ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz],
          };
          const mp = transformMass(local, rotationOf(Wu), originOf(Wu));
          parts.push(mp);
          massSources.push({
            nodeId: u.nodeId,
            name: u.name,
            massKg: mp.massKg,
            source: 'inertial',
            status: 'approximate',
            note: `Mass, centre of mass and inertia tensor supplied explicitly${ms.note ? ` (${ms.note})` : ''}; used as given, not derived from geometry.`,
          });
          continue;
        }
        // A user mass on a composite unit is shared among its leaves by volume.
        const vols = own.map((g) => g.solids.reduce((s, x) => s + solidVolume(x), 0));
        const totalVol = vols.reduce((a, b) => a + b, 0);
        if (!own.length) {
          err('no-mass', `"${u.name}" is dynamic but has no modelled geometry to give it mass properties.`, [
            u.nodeId,
          ]);
          massOk = false;
          continue;
        }
        own.forEach((g, i) => {
          const share =
            u.settings.mass.source === 'user' && totalVol > 0
              ? (u.settings.mass.massKg * vols[i]!) / totalVol
              : null;
          const r = leafMass(graph, nodes[g.leaf]!, g.solids, g.geo, g.W, u.settings, share);
          if ('error' in r) {
            err('mass-unknown', r.error, [g.leaf]);
            massOk = false;
          } else {
            parts.push(r.mass);
            massSources.push(r.source);
          }
        });
      }
    }
    const total = mode === 'dynamic' && massOk ? combine(parts) : null;
    if (mode === 'dynamic' && massOk && !total) {
      err(
        'no-mass',
        `Dynamic body ${members.map((u) => `"${u.name}"`).join(', ')} has zero mass.`,
        members.map((u) => u.nodeId),
      );
      massOk = false;
    }
    const firstWorld = worldOf(members[0]!.nodeId);
    const origin: V3 = total ? [...total.com] : firstWorld ? originOf(firstWorld) : [0, 0, 0];
    const mass: MassProps | null = total
      ? { massKg: total.massKg, com: [0, 0, 0], inertia: total.inertia }
      : null;
    if (mode === 'dynamic' && !massOk) continue;

    // Colliders, offsets.
    const settings = members[0]!.settings;
    const colliders: ColliderSpec[] = [];
    for (const g of geometry) {
      const n = nodes[g.leaf]!;
      let cmode = g.unit.settings.collider;
      if (n.kind === 'model-instance' && cmode === 'auto') {
        info(
          'no-collider',
          `Imported model "${n.name}" has no collision geometry (select the bounding-box collider explicitly).`,
          [g.leaf],
        );
        cmode = 'none';
      }
      colliders.push(...leafColliders(g.leaf, g.solids, g.W, origin, cmode));
    }
    const id = `body-${bodyCount++}`;
    const unitOffsets: Record<string, Mat4> = {};
    const inv0 = translationM([-origin[0], -origin[1], -origin[2]]);
    for (const u of members) {
      const W = worldOf(u.nodeId);
      if (W) unitOffsets[u.nodeId] = multiply(inv0, W);
      bodyOfUnit.set(u.nodeId, id);
      bodyOfNode[u.nodeId] = id;
      for (const d of descendantsOf(nodes, u.nodeId)) bodyOfNode[d] = id;
    }
    const aid = members[0]!.assemblyId;
    const bit = aid !== null ? 1 << (1 + (asmIndex.get(aid)! % 15)) : 1;
    const filter = aid !== null && !definition.selfCollision ? 0xffff & ~bit : 0xffff;
    bodies.push({
      id,
      name: members.length > 1 ? `${members[0]!.name} (+${members.length - 1})` : members[0]!.name,
      unitIds: members.map((u) => u.nodeId),
      assemblyId: aid,
      mode,
      origin,
      mass,
      massSources,
      colliders,
      unitOffsets,
      settings,
      collisionGroups: ((bit & 0xffff) << 16) | filter,
    });
  }
  const bodyById = new Map(bodies.map((b) => [b.id, b]));

  // 4. Joints.
  const joints: ModelJoint[] = [];
  for (const aid of assemblyIds) {
    const a = nodes[aid];
    if (a?.kind !== 'assembly') continue;
    const resolve = makeRefResolver(graph);
    const driving = a.mechanical.constraints.filter((c) => c.driving);
    if (driving.length) {
      if (definition.approvals.ignoreDrivingConstraints)
        warn(
          'constraint-ignored',
          `${driving.length} driving constraint(s) of "${a.name}" have no dynamic equivalent and are IGNORED (approved).`,
          driving.map((c) => c.id),
        );
      else
        err(
          'constraint-unsupported',
          `"${a.name}" has ${driving.length} driving constraint(s) (${driving.map((c) => `“${c.name}”`).join(', ')}) with no dynamic equivalent. Make them check-only, or approve ignoring them.`,
          driving.map((c) => c.id),
        );
    }
    for (const m of a.mechanical.mates) {
      if (m.suppressed || m.type === 'fixed') continue;
      const ba = bodyOfUnit.get(m.a.nodeId);
      const bb = bodyOfUnit.get(m.b.nodeId);
      if (!ba || !bb) {
        warn(
          'joint-skipped',
          `Joint "${m.name}" is not simulated: one of its bodies is excluded or invalid.`,
          [m.id],
        );
        continue;
      }
      if (ba === bb) {
        warn(
          'joint-welded',
          `Joint "${m.name}" connects bodies already welded by fixed mates; it has no effect.`,
          [m.id],
        );
        continue;
      }
      const A = bodyById.get(ba)!;
      const B = bodyById.get(bb)!;
      if (A.mode !== 'dynamic' && B.mode !== 'dynamic') {
        info('joint-static', `Joint "${m.name}" connects two non-dynamic bodies; it is not simulated.`, [
          m.id,
        ]);
        continue;
      }
      const LA = resolve(m.a.nodeId, m.a.ref);
      const LB = resolve(m.b.nodeId, m.b.ref);
      const WA = worldOf(m.a.nodeId);
      const WB = worldOf(m.b.nodeId);
      if (typeof LA === 'string' || typeof LB === 'string' || !WA || !WB) {
        err(
          'joint-reference',
          `Joint "${m.name}": ${typeof LA === 'string' ? LA : typeof LB === 'string' ? LB : 'invalid body pose'}`,
          [m.id],
        );
        continue;
      }
      const FA = multiply(WA, LA);
      const FB = multiply(WB, LB);
      const pA = originOf(FA);
      const pB = originOf(FB);
      const axis = colOf(FA, 2);
      const gap = Math.hypot(...sub(pB, pA));
      const mapping: JointMapping =
        m.type === 'revolute'
          ? 'revolute'
          : m.type === 'prismatic'
            ? 'prismatic'
            : m.type === 'ball'
              ? 'spherical'
              : m.type === 'cylindrical'
                ? 'cylindrical'
                : 'planar';
      // Ball/revolute/cylindrical anchors coincide in a solved CAD pose; prismatic/planar may be offset along the joint.
      if ((mapping === 'revolute' || mapping === 'spherical') && gap > 1e-6)
        warn(
          'joint-residual',
          `Joint "${m.name}": the CAD pose does not satisfy the mate (anchor gap ${(gap * 1000).toFixed(3)} mm).`,
          [m.id],
        );
      let limits = m.limits.map((l) => (l ? { ...l } : null));
      let dropped = false;
      if (
        (mapping === 'spherical' || mapping === 'cylindrical' || mapping === 'planar') &&
        limits.some(Boolean)
      ) {
        if (definition.approvals.ignoreUnsupportedLimits) {
          warn(
            'limits-dropped',
            `Joint "${m.name}" (${m.type}): its limits cannot be enforced by the physics engine and are DROPPED (approved).`,
            [m.id],
          );
          limits = limits.map(() => null);
          dropped = true;
        } else {
          err(
            'limits-unsupported',
            `Joint "${m.name}" (${m.type}) has limits the physics engine cannot enforce. Remove them or approve dropping them.`,
            [m.id],
          );
          continue;
        }
      }
      const settings: JointSettings = definition.joints.find((j) => j.mateId === m.id) ?? {
        mateId: m.id,
        damping: 0,
        friction: 0,
        actuator: null,
      };
      if (settings.actuator && mapping !== 'revolute' && mapping !== 'prismatic') {
        err('actuator-unsupported', `Joint "${m.name}" (${m.type}) cannot carry an actuator.`, [m.id]);
        continue;
      }
      if (settings.actuator) {
        const l = limits[0];
        if (l && (settings.actuator.target < l.min - 1e-9 || settings.actuator.target > l.max + 1e-9))
          warn(
            'target-outside-limits',
            `Actuator target of "${m.name}" lies outside the joint limits; the joint limit will stop it.`,
            [m.id],
          );
      }
      joints.push({
        mateId: m.id,
        name: m.name,
        type: m.type,
        mapping,
        assemblyId: aid,
        bodyA: ba,
        bodyB: bb,
        anchorA: sub(pA, A.origin),
        anchorB: sub(pB, B.origin),
        axis,
        xRef: colOf(FA, 0),
        frameA0: rotationOf(FA),
        q0: [...m.coordinates],
        limits,
        droppedLimits: dropped,
        settings,
      });
    }
  }

  // 5. Payloads.
  const payloads: ModelPayload[] = [];
  for (const p of definition.payloads) {
    const bid = bodyOfNode[p.nodeId];
    const b = bid ? bodyById.get(bid) : undefined;
    if (!b || b.mode !== 'dynamic') {
      warn(
        'payload-ignored',
        `Payload "${p.name}" is ignored: "${nodes[p.nodeId]?.name ?? p.nodeId}" is not a dynamic simulated body.`,
        [p.id],
      );
      continue;
    }
    const W = worldOf(p.nodeId);
    if (!W) continue;
    const at = sub(
      [
        W[0]! * p.offsetM[0] + W[4]! * p.offsetM[1] + W[8]! * p.offsetM[2] + W[12]!,
        W[1]! * p.offsetM[0] + W[5]! * p.offsetM[1] + W[9]! * p.offsetM[2] + W[13]!,
        W[2]! * p.offsetM[0] + W[6]! * p.offsetM[1] + W[10]! * p.offsetM[2] + W[14]!,
      ],
      b.origin,
    );
    payloads.push({ id: p.id, name: p.name, bodyId: b.id, massKg: p.massKg, at });
  }

  // 6. Assumptions (always shown with the run).
  assumptions.push(
    {
      topic: 'Rigid bodies',
      status: 'approximate',
      text: 'All bodies are perfectly rigid: no deformation, stress, fracture, fatigue or buckling is modelled.',
    },
    {
      topic: 'Solver',
      status: 'approximate',
      text: `Rapier rigid-body solver (impulse-based, iterative, single-precision): fixed step ${(definition.solver.timestepS * 1000).toFixed(3)} ms × ${definition.solver.substeps} sub-steps, ${definition.solver.solverIterations} solver iterations. Joint constraints are satisfied within solver tolerance (drift is measured and reported).`,
    },
    {
      topic: 'Mass properties',
      status: 'approximate',
      text: 'Masses come from modelled volume × typical handbook density, published (datasheet-cited) values, or user-supplied values; inertia assumes uniform density over the modelled solids.',
    },
    {
      topic: 'Fixed mates',
      status: 'approximate',
      text: 'Bodies joined by fixed mates are merged into one rigid body (ideal weld): no joint compliance or failure.',
    },
  );
  if (bodies.some((b) => b.colliders.some((c) => c.approximation)))
    assumptions.push({
      topic: 'Collision geometry',
      status: 'approximate',
      text: 'Contact uses primitive/convex colliders per modelled solid; approximations (e.g. tubes as solid cylinders, convex hulls filling holes) are listed per body. Contact is not a detailed surface-contact calculation.',
    });
  if (definition.ground.enabled)
    assumptions.push({
      topic: 'Work surface',
      status: 'approximate',
      text: `A static, flat, rigid work surface at y = ${definition.ground.heightM} m (friction ${definition.ground.friction}, restitution ${definition.ground.restitution}).`,
    });
  assumptions.push({
    topic: 'Friction and restitution',
    status: 'approximate',
    text: 'Coulomb friction and restitution coefficients are user-selected values combined by Rapier (average), not measured material pairs.',
  });
  if (joints.some((j) => j.settings.actuator))
    assumptions.push({
      topic: 'Actuators',
      status: 'approximate',
      text: "Generic servo model (PID on joint position with a linear torque–speed envelope and effort saturation). It does not reproduce any specific product's dynamics; cited limits are datasheet values, not validated.",
    });

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    bodies,
    joints,
    payloads,
    issues,
    assumptions,
    bodyOfNode,
    definition,
  };
}

function descendantsOf(nodes: SceneGraph['nodes'], id: string): string[] {
  const out: string[] = [];
  const walk = (x: string) => {
    for (const c of nodes[x]?.childIds ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(id);
  return out;
}

/** A body's mass properties including the payloads attached to it (body frame). */
export function massWithPayloads(body: ModelBody, payloads: readonly ModelPayload[]): MassProps | null {
  if (!body.mass) return null;
  const ps = payloads
    .filter((p) => p.bodyId === body.id && p.massKg > 0)
    .map((p) => pointMass(p.massKg, p.at));
  return combine([body.mass, ...ps]);
}

/** Inertia of `bodyIds` about an axis through `point` (all world-aligned at t = 0). */
export function axisInertia(
  bodies: readonly ModelBody[],
  payloads: readonly ModelPayload[],
  bodyIds: readonly string[],
  axis: V3,
  point: V3,
  prismatic: boolean,
): number {
  let sum = 0;
  for (const id of bodyIds) {
    const b = bodies.find((x) => x.id === id);
    const mp = b && massWithPayloads(b, payloads);
    if (!b || !mp) continue;
    if (prismatic) {
      sum += mp.massKg;
      continue;
    }
    const c: V3 = [
      b.origin[0] + mp.com[0] - point[0],
      b.origin[1] + mp.com[1] - point[1],
      b.origin[2] + mp.com[2] - point[2],
    ];
    const along = c[0] * axis[0] + c[1] * axis[1] + c[2] * axis[2];
    const perp2 = c[0] * c[0] + c[1] * c[1] + c[2] * c[2] - along * along;
    const I = mp.inertia;
    const Iw =
      axis[0] * (I[0] * axis[0] + I[1] * axis[1] + I[2] * axis[2]) +
      axis[1] * (I[3] * axis[0] + I[4] * axis[1] + I[5] * axis[2]) +
      axis[2] * (I[6] * axis[0] + I[7] * axis[1] + I[8] * axis[2]);
    sum += Iw + mp.massKg * Math.max(0, perp2);
  }
  return sum;
}

/**
 * Effective inertia (kg·m², or kg for prismatic) a joint's actuator drives: the bodies on
 * the far side of the joint from the grounded/fixed side, at the initial pose. For a
 * floating chain the reduced inertia of the two sides. An APPROXIMATION (configuration-
 * dependent in reality), used only to derive automatic controller gains.
 */
export function effectiveInertia(
  model: Pick<PhysicsModel, 'bodies' | 'joints' | 'payloads'>,
  joint: ModelJoint,
): number {
  const side = (start: string): string[] => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const j of model.joints) {
        if (j === joint) continue;
        const other = j.bodyA === cur ? j.bodyB : j.bodyB === cur ? j.bodyA : null;
        if (other && !seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
      }
    }
    return [...seen];
  };
  const point: V3 = (() => {
    const A = model.bodies.find((b) => b.id === joint.bodyA)!;
    return [A.origin[0] + joint.anchorA[0], A.origin[1] + joint.anchorA[1], A.origin[2] + joint.anchorA[2]];
  })();
  const prismatic = joint.mapping === 'prismatic';
  const sB = side(joint.bodyB);
  const sA = side(joint.bodyA);
  const grounded = (s: string[]) => s.some((id) => model.bodies.find((b) => b.id === id)?.mode !== 'dynamic');
  const I = (s: string[]) => axisInertia(model.bodies, model.payloads, s, joint.axis, point, prismatic);
  if (sB.includes(joint.bodyA)) return I([joint.bodyB]); // closed loop: the joint's own body (approximation)
  if (grounded(sA) && !grounded(sB)) return I(sB);
  if (grounded(sB) && !grounded(sA)) return I(sA);
  const a = I(sA);
  const b = I(sB);
  return a > 0 && b > 0 ? (a * b) / (a + b) : Math.max(a, b);
}

export const bodyCollidersSummary = (b: ModelBody) => {
  const counts: Record<string, number> = {};
  for (const c of b.colliders) counts[c.shape.type] = (counts[c.shape.type] ?? 0) + 1;
  return (
    Object.entries(counts)
      .map(([k, v]) => `${v} × ${k}`)
      .join(', ') || 'none'
  );
};

export { invert };
