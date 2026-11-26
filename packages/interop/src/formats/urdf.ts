import {
  defaultSimulationDefinition,
  inertiaIssue,
  sha256Bytes,
  type BatchSubCommand,
  type ImportRecord,
  type ModelRef,
  type Project,
  type SceneNode,
} from '@forge/engineering-core';
import { IDENTITY, metrics, mul, triangles, type Mat4, type MeshScene, type V3 } from '../mesh';
import { nodesFingerprint } from '../provenance';
import {
  err,
  info,
  INTEROP_VERSION,
  MAX_INPUT_BYTES,
  warn,
  type Diagnostic,
  type FileInput,
} from '../schemas';
import { parseGltf, weld, writeGlb } from './gltf';
import { parseStl } from './stl';
import { kid, kids, parseXml, XmlError, type XmlElement } from './xml';

/**
 * URDF (Unified Robot Description Format) import — no ROS installation needed.
 *
 * Mapped: links → bodies (groups inside one assembly), fixed / revolute / continuous /
 * prismatic joints → FORGE mates with limits, <origin xyz rpy> → exact frames, visual box /
 * cylinder / sphere → primitives, visual meshes (STL, GLB/glTF) → imported models resolved
 * ONLY from files the user selected (never fetched), <inertial> → explicit mass, centre of
 * mass and inertia tensor, <dynamics damping friction> → joint damping/friction.
 *
 * Reported as unsupported (never silently dropped): floating and planar joints, <mimic>,
 * <safety_controller>, <calibration>, <transmission>, <gazebo>, <ros2_control>, sensors,
 * Collada/OBJ meshes, separate collision geometry (contact uses the visual primitives).
 * URDF joint effort/velocity limits are recorded; FORGE actuators are added only on request.
 */
declare const TextDecoder: { new (label?: string): { decode(input: Uint8Array): string } };

export interface UrdfOrigin {
  xyz: V3;
  rpy: V3;
}
export type UrdfGeometry =
  | { kind: 'box'; size: V3 }
  | { kind: 'cylinder'; radius: number; length: number }
  | { kind: 'sphere'; radius: number }
  | { kind: 'mesh'; filename: string; scale: V3 };
export interface UrdfVisual {
  name: string;
  origin: UrdfOrigin;
  geometry: UrdfGeometry;
  rgba: [number, number, number, number] | null;
}
export interface UrdfLink {
  name: string;
  inertial: {
    origin: UrdfOrigin;
    mass: number;
    inertia: [number, number, number, number, number, number];
  } | null;
  visuals: UrdfVisual[];
  collisions: { origin: UrdfOrigin; geometry: UrdfGeometry }[];
}
export interface UrdfJoint {
  name: string;
  type: 'fixed' | 'revolute' | 'continuous' | 'prismatic' | 'floating' | 'planar';
  parent: string;
  child: string;
  origin: UrdfOrigin;
  axis: V3;
  limit: { lower: number; upper: number; effort: number; velocity: number } | null;
  dynamics: { damping: number; friction: number } | null;
}
export interface UrdfRobot {
  name: string;
  links: UrdfLink[];
  joints: UrdfJoint[];
  root: string;
  unsupported: string[];
}

const nums = (s: string | undefined, n: number, dflt: number[]): number[] => {
  if (s === undefined) return dflt;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === n && v.every(Number.isFinite) ? v : [NaN];
};

export function parseUrdf(bytes: Uint8Array): { robot: UrdfRobot | null; diagnostics: Diagnostic[] } {
  const d: Diagnostic[] = [];
  if (bytes.byteLength > MAX_INPUT_BYTES.urdf)
    return { robot: null, diagnostics: [err('too-large', 'URDF larger than 2 MiB.')] };
  let root: XmlElement;
  try {
    root = parseXml(new TextDecoder('utf-8').decode(bytes));
  } catch (e) {
    return {
      robot: null,
      diagnostics: [err('urdf-xml', `Not well-formed XML: ${e instanceof XmlError ? e.message : String(e)}`)],
    };
  }
  if (root.name !== 'robot')
    return { robot: null, diagnostics: [err('urdf-root', 'Root element is not <robot>.')] };
  const unsupported: string[] = [];
  const bad = (what: string) => d.push(err('urdf-value', what));
  const origin = (e: XmlElement | null, where: string): UrdfOrigin => {
    const o = e ? kid(e, 'origin') : null;
    const xyz = nums(o?.attrs.xyz, 3, [0, 0, 0]);
    const rpy = nums(o?.attrs.rpy, 3, [0, 0, 0]);
    if (xyz.length !== 3 || rpy.length !== 3)
      bad(`${where}: <origin> must have three numbers in xyz and rpy.`);
    return { xyz: xyz as V3, rpy: rpy as V3 };
  };
  const materials = new Map<string, [number, number, number, number]>();
  const colour = (m: XmlElement | null): [number, number, number, number] | null => {
    if (!m) return null;
    const c = kid(m, 'color');
    if (c) {
      const v = nums(c.attrs.rgba, 4, [NaN]);
      if (v.length === 4) return v as [number, number, number, number];
    }
    if (kid(m, 'texture')) unsupported.push(`material ${m.attrs.name ?? ''} texture`);
    return m.attrs.name ? (materials.get(m.attrs.name) ?? null) : null;
  };
  for (const m of kids(root, 'material')) {
    const c = colour(m);
    if (m.attrs.name && c) materials.set(m.attrs.name, c);
  }
  const geometry = (g: XmlElement | null, where: string): UrdfGeometry | null => {
    if (!g) {
      bad(`${where}: <geometry> is missing.`);
      return null;
    }
    const box = kid(g, 'box');
    const cyl = kid(g, 'cylinder');
    const sph = kid(g, 'sphere');
    const mesh = kid(g, 'mesh');
    if (box) {
      const s = nums(box.attrs.size, 3, [NaN]);
      if (s.length !== 3 || s.some((x) => !(x > 0)))
        return (bad(`${where}: box size must be three positive numbers.`), null);
      return { kind: 'box', size: s as V3 };
    }
    if (cyl) {
      const r = Number(cyl.attrs.radius);
      const l = Number(cyl.attrs.length);
      if (!(r > 0 && l > 0)) return (bad(`${where}: cylinder radius and length must be positive.`), null);
      return { kind: 'cylinder', radius: r, length: l };
    }
    if (sph) {
      const r = Number(sph.attrs.radius);
      if (!(r > 0)) return (bad(`${where}: sphere radius must be positive.`), null);
      return { kind: 'sphere', radius: r };
    }
    if (mesh) {
      const s = nums(mesh.attrs.scale, 3, [1, 1, 1]);
      if (!mesh.attrs.filename) return (bad(`${where}: mesh has no filename.`), null);
      if (s.length !== 3 || s.some((x) => !(x !== 0 && Number.isFinite(x))))
        return (bad(`${where}: mesh scale must be three non-zero numbers.`), null);
      return { kind: 'mesh', filename: mesh.attrs.filename, scale: s as V3 };
    }
    bad(`${where}: unsupported geometry <${g.children[0]?.name ?? '?'}>.`);
    return null;
  };
  const links: UrdfLink[] = [];
  for (const l of kids(root, 'link')) {
    const name = l.attrs.name;
    if (!name) {
      bad('A <link> has no name.');
      continue;
    }
    if (links.some((x) => x.name === name)) bad(`Duplicate link "${name}".`);
    const ie = kid(l, 'inertial');
    let inertial: UrdfLink['inertial'] = null;
    if (ie) {
      const mass = Number(kid(ie, 'mass')?.attrs.value);
      const I = kid(ie, 'inertia');
      const t = ['ixx', 'iyy', 'izz', 'ixy', 'ixz', 'iyz'].map((k) => Number(I?.attrs[k] ?? 0)) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      if (!(mass > 0)) d.push(warn('urdf-mass', `Link "${name}": inertial mass is not positive; ignored.`));
      else if (t.some((x) => !Number.isFinite(x)))
        d.push(warn('urdf-inertia', `Link "${name}": inertia values are not numbers; ignored.`));
      else inertial = { origin: origin(ie, `link ${name} inertial`), mass, inertia: t };
    }
    const visuals: UrdfVisual[] = [];
    kids(l, 'visual').forEach((v, k) => {
      const g = geometry(kid(v, 'geometry'), `link ${name} visual ${k + 1}`);
      if (g)
        visuals.push({
          name: v.attrs.name ?? `${name}_visual${k + 1}`,
          origin: origin(v, `link ${name} visual`),
          geometry: g,
          rgba: colour(kid(v, 'material')),
        });
    });
    const collisions = kids(l, 'collision')
      .map((c, k) => {
        const g = geometry(kid(c, 'geometry'), `link ${name} collision ${k + 1}`);
        return g ? { origin: origin(c, `link ${name} collision`), geometry: g } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    links.push({ name, inertial, visuals, collisions });
  }
  const joints: UrdfJoint[] = [];
  for (const j of kids(root, 'joint')) {
    const name = j.attrs.name ?? '';
    const type = j.attrs.type as UrdfJoint['type'];
    if (!['fixed', 'revolute', 'continuous', 'prismatic', 'floating', 'planar'].includes(type)) {
      bad(`Joint "${name}": unknown type "${j.attrs.type}".`);
      continue;
    }
    const parent = kid(j, 'parent')?.attrs.link ?? '';
    const child = kid(j, 'child')?.attrs.link ?? '';
    const axisRaw = nums(kid(j, 'axis')?.attrs.xyz, 3, [1, 0, 0]);
    const an = Math.hypot(...axisRaw);
    if (axisRaw.length !== 3 || !(an > 0)) bad(`Joint "${name}": axis must be a non-zero vector.`);
    const le = kid(j, 'limit');
    const limit = le
      ? {
          lower: Number(le.attrs.lower ?? 0),
          upper: Number(le.attrs.upper ?? 0),
          effort: Number(le.attrs.effort ?? 0),
          velocity: Number(le.attrs.velocity ?? 0),
        }
      : null;
    if ((type === 'revolute' || type === 'prismatic') && !limit)
      bad(`Joint "${name}" (${type}) requires <limit> (URDF specification).`);
    if (limit && limit.lower > limit.upper) bad(`Joint "${name}": lower limit exceeds upper.`);
    const de = kid(j, 'dynamics');
    for (const tag of ['mimic', 'safety_controller', 'calibration'])
      if (kid(j, tag)) unsupported.push(`joint ${name}: <${tag}>`);
    joints.push({
      name,
      type,
      parent,
      child,
      origin: origin(j, `joint ${name}`),
      axis: axisRaw.map((x) => x / (an || 1)) as V3,
      limit,
      dynamics: de
        ? {
            damping: Math.max(0, Number(de.attrs.damping ?? 0)),
            friction: Math.max(0, Number(de.attrs.friction ?? 0)),
          }
        : null,
    });
  }
  for (const tag of ['transmission', 'gazebo', 'ros2_control', 'sensor']) {
    const n = kids(root, tag).length;
    if (n) unsupported.push(`${n} <${tag}> element(s) (ROS-specific)`);
  }
  // Tree validation.
  const names = new Set(links.map((l) => l.name));
  const parentOf = new Map<string, string>();
  for (const j of joints) {
    if (!names.has(j.parent)) bad(`Joint "${j.name}": parent link "${j.parent}" does not exist.`);
    if (!names.has(j.child)) bad(`Joint "${j.name}": child link "${j.child}" does not exist.`);
    if (parentOf.has(j.child)) bad(`Link "${j.child}" has more than one parent joint (not a tree).`);
    parentOf.set(j.child, j.parent);
  }
  const roots = links.filter((l) => !parentOf.has(l.name)).map((l) => l.name);
  if (roots.length !== 1 && links.length)
    bad(`A URDF has exactly one root link; found ${roots.length} (${roots.slice(0, 5).join(', ')}).`);
  for (const l of links) {
    let cur = l.name;
    for (let k = 0; parentOf.has(cur); k++) {
      if (k > links.length) {
        bad('The joint graph contains a cycle.');
        break;
      }
      cur = parentOf.get(cur)!;
    }
  }
  if (!links.length) bad('The robot has no links.');
  const ok = !d.some((x) => x.severity === 'error');
  return {
    robot: ok ? { name: root.attrs.name ?? 'robot', links, joints, root: roots[0]!, unsupported } : null,
    diagnostics: d,
  };
}

// -- kinematics -------------------------------------------------------------------------------
/** URDF rpy (fixed axes X, then Y, then Z): R = Rz(yaw)·Ry(pitch)·Rx(roll), column-major Mat4. */
export function originMatrix(o: UrdfOrigin): Mat4 {
  const [r, p, y] = o.rpy;
  const cr = Math.cos(r),
    sr = Math.sin(r),
    cp = Math.cos(p),
    sp = Math.sin(p),
    cy = Math.cos(y),
    sy = Math.sin(y);
  return [
    cy * cp,
    sy * cp,
    -sp,
    0,
    cy * sp * sr - sy * cr,
    sy * sp * sr + cy * cr,
    cp * sr,
    0,
    cy * sp * cr + sy * sr,
    sy * sp * cr - cy * sr,
    cp * cr,
    0,
    o.xyz[0],
    o.xyz[1],
    o.xyz[2],
    1,
  ];
}
/** Joint motion: rotation about (revolute) or translation along (prismatic) the unit axis. */
export function jointMatrix(type: UrdfJoint['type'], axis: V3, q: number): Mat4 {
  if (type === 'prismatic')
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, axis[0] * q, axis[1] * q, axis[2] * q, 1];
  if (type !== 'revolute' && type !== 'continuous') return [...IDENTITY];
  const [x, y, z] = axis;
  const c = Math.cos(q),
    s = Math.sin(q),
    t = 1 - c;
  return [
    t * x * x + c,
    t * x * y + s * z,
    t * x * z - s * y,
    0,
    t * x * y - s * z,
    t * y * y + c,
    t * y * z + s * x,
    0,
    t * x * z + s * y,
    t * y * z - s * x,
    t * z * z + c,
    0,
    0,
    0,
    0,
    1,
  ];
}
/** Forward kinematics: link frame matrices relative to the robot root at joint values q. */
export function forwardKinematics(robot: UrdfRobot, q: Record<string, number> = {}): Map<string, Mat4> {
  const out = new Map<string, Mat4>([[robot.root, [...IDENTITY]]]);
  const byParent = new Map<string, UrdfJoint[]>();
  for (const j of robot.joints) byParent.set(j.parent, [...(byParent.get(j.parent) ?? []), j]);
  const visit = (link: string) => {
    for (const j of byParent.get(link) ?? []) {
      out.set(
        j.child,
        mul(mul(out.get(link)!, originMatrix(j.origin)), jointMatrix(j.type, j.axis, q[j.name] ?? 0)),
      );
      visit(j.child);
    }
  };
  visit(robot.root);
  return out;
}

export function quatOf(m: Mat4): [number, number, number, number] {
  const [m00, m10, m20, , m01, m11, m21, , m02, m12, m22] = m as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w);
  return [x / l, y / l, z / l, w / l];
}
const R3 = (m: Mat4) => [m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!]; // row-major 3×3
const rotVec = (m: Mat4, v: V3): V3 => [
  m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
  m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
  m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
];
/** A unit vector perpendicular to `a` (deterministic). */
export function perpendicular(a: V3): V3 {
  const t: V3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = t[0] * a[0] + t[1] * a[1] + t[2] * a[2];
  const p: V3 = [t[0] - d * a[0], t[1] - d * a[1], t[2] - d * a[2]];
  const l = Math.hypot(...p);
  return [p[0] / l, p[1] / l, p[2] / l];
}
const trs = (m: Mat4) => ({
  position: [m[12]!, m[13]!, m[14]!] as V3,
  rotation: quatOf(m),
  scale: [1, 1, 1] as V3,
});
const hex = (c: [number, number, number, number] | null) =>
  c
    ? `#${c
        .slice(0, 3)
        .map((x) =>
          Math.round(Math.min(1, Math.max(0, x)) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`
    : '#9aa4b1';

// -- import plan ------------------------------------------------------------------------------
export interface UrdfImportOptions {
  /** Other selected files (meshes); resolved by package path or base name, never fetched. */
  files: FileInput[];
  name?: string;
  parentId?: string;
  position?: V3;
  /** Create a simulation setup if the project has none (needed for mass and joint settings). */
  createSimulation: boolean;
  /** Add generic position actuators holding each movable joint at its initial value. */
  actuators: 'none' | 'hold-initial';
  importId: string;
  idPrefix: string;
  now?: Date;
}
export interface UrdfPlan {
  ok: boolean;
  diagnostics: Diagnostic[];
  assets: { hash: string; bytes: Uint8Array; mediaType: ModelRef['mediaType'] }[];
  commands: BatchSubCommand[];
  record: ImportRecord | null;
  nodeIds: string[];
  /** URDF link name → FORGE node id; URDF joint name → mate id. */
  linkNodes: Record<string, string>;
  jointMates: Record<string, string>;
  summary: {
    links: number;
    joints: Record<string, number>;
    meshes: number;
    primitives: number;
    inertials: number;
  };
}

function resolveMesh(
  filename: string,
  files: FileInput[],
): { file: FileInput | null; problem: string | null } {
  if (/^(https?|ftp):/i.test(filename))
    return { file: null, problem: `"${filename}" is a network URL (never fetched)` };
  const path = filename
    .replace(/^package:\/\/[^/]+\//, '')
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/');
  const exact = files.filter((f) => f.name.replace(/\\/g, '/').endsWith(path));
  if (exact.length === 1) return { file: exact[0]!, problem: null };
  const base = path.split('/').pop()!;
  const byBase = files.filter((f) => f.name.split(/[\\/]/).pop() === base);
  if (byBase.length === 1) return { file: byBase[0]!, problem: null };
  if (byBase.length > 1)
    return { file: null, problem: `"${filename}" matches ${byBase.length} selected files (ambiguous)` };
  return { file: null, problem: `"${filename}" was not among the selected files` };
}

export function planUrdfImport(file: FileInput, o: UrdfImportOptions, project: Project): UrdfPlan {
  const parsed = parseUrdf(file.bytes);
  const d: Diagnostic[] = [...parsed.diagnostics];
  const empty: UrdfPlan = {
    ok: false,
    diagnostics: d,
    assets: [],
    commands: [],
    record: null,
    nodeIds: [],
    linkNodes: {},
    jointMates: {},
    summary: { links: 0, joints: {}, meshes: 0, primitives: 0, inertials: 0 },
  };
  const robot = parsed.robot;
  if (!robot) return empty;
  const root = project.scene.nodes[project.scene.rootId];
  const hasSim = root?.kind === 'root' && !!root.simulation;
  if (!hasSim && !o.createSimulation)
    d.push(
      warn(
        'no-simulation',
        'No simulation setup: inertial data and joint dynamics are recorded in the import record only.',
      ),
    );
  const sim = hasSim || o.createSimulation;
  const slug = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 48);
  const id = (k: string) => `${o.idPrefix}.${slug(k)}`.slice(0, 128);
  const parentId = o.parentId ?? project.scene.rootId;
  if (!project.scene.nodes[parentId])
    return { ...empty, diagnostics: [...d, err('parent', `Target node "${parentId}" does not exist.`)] };
  for (const n of [id('robot'), ...robot.links.map((l) => id(`link.${l.name}`))])
    if (project.scene.nodes[n])
      return {
        ...empty,
        diagnostics: [...d, err('duplicate-id', `Node id "${n}" already exists; choose another prefix.`)],
      };
  const commands: BatchSubCommand[] = [];
  const predicted: SceneNode[] = [];
  const assets: UrdfPlan['assets'] = [];
  const referencedFiles: ImportRecord['referencedFiles'] = [];
  const conversions: string[] = [
    'URDF frame (x forward, y left, z up; REP-103) → FORGE +Y up: −90° about X on the robot assembly',
  ];
  const unsupported = [...robot.unsupported];
  const nodeIds: string[] = [];
  const counts = {
    links: robot.links.length,
    joints: {} as Record<string, number>,
    meshes: 0,
    primitives: 0,
    inertials: 0,
  };
  if (!hasSim && o.createSimulation) {
    const def = defaultSimulationDefinition();
    commands.push({ type: 'physics.simulation.create', payload: {} } as BatchSubCommand);
    // Small robot links (inertias of 1e-6–1e-4 kg·m²) with generic auto-gain position
    // actuators are unstable at the default 4 sub-steps (measured: the hold-pose test drifts
    // > 1 rad); 8 sub-steps hold the pose. Raised explicitly and recorded.
    commands.push({
      type: 'physics.configure',
      payload: { patch: { solver: { ...def.solver, substeps: Math.max(def.solver.substeps, 8) } } },
    } as BatchSubCommand);
    conversions.push(
      'Simulation setup created with FORGE defaults (gravity −9.81 m/s² along −Y); solver sub-steps raised to 8 for the small link inertias',
    );
  } else if (
    hasSim &&
    o.actuators === 'hold-initial' &&
    root.kind === 'root' &&
    root.simulation!.solver.substeps < 8
  )
    d.push(
      warn(
        'urdf-substeps',
        `The simulation uses ${root.simulation!.solver.substeps} sub-steps; generic actuators on small links can be unstable below 8 (raise it in Simulation mode).`,
      ),
    );
  const asmId = id('robot');
  const s = Math.SQRT1_2;
  const asmTransform = {
    position: o.position ?? ([0, 0, 0] as V3),
    rotation: [-s, 0, 0, s] as [number, number, number, number],
    scale: [1, 1, 1] as V3,
  };
  const asmName = (o.name ?? robot.name).slice(0, 200);
  commands.push({
    type: 'assembly.create',
    payload: { id: asmId, name: asmName, parentId, transform: asmTransform, nodeIds: [] },
  } as BatchSubCommand);
  predicted.push({
    id: asmId,
    kind: 'assembly',
    name: asmName,
    parentId,
    transform: asmTransform,
  } as unknown as SceneNode);
  nodeIds.push(asmId);
  // Initial joint values: 0, clamped into the limits.
  const q0: Record<string, number> = {};
  for (const j of robot.joints)
    if (j.limit && (j.type === 'revolute' || j.type === 'prismatic'))
      q0[j.name] = Math.min(j.limit.upper, Math.max(j.limit.lower, 0));
  const fk = forwardKinematics(robot, q0);
  const linkNodes: Record<string, string> = {};
  for (const l of robot.links) {
    const lid = id(`link.${l.name}`);
    linkNodes[l.name] = lid;
    const t = trs(fk.get(l.name)!);
    commands.push({
      type: 'scene.node.create',
      payload: {
        node: {
          kind: 'group',
          id: lid,
          name: l.name.slice(0, 200),
          parentId: asmId,
          transform: t,
          metadata: { 'urdf.link': l.name.slice(0, 500) },
        },
      },
    } as BatchSubCommand);
    predicted.push({
      id: lid,
      kind: 'group',
      name: l.name.slice(0, 200),
      parentId: asmId,
      transform: t,
    } as unknown as SceneNode);
    nodeIds.push(lid);
    let hasPrimitive = false;
    l.visuals.forEach((v, k) => {
      const vid = id(`link.${l.name}.v${k + 1}`);
      let M = originMatrix(v.origin);
      const g = v.geometry;
      if (g.kind === 'mesh') {
        const r = resolveMesh(g.filename, o.files);
        if (!r.file) {
          d.push(
            warn(
              'urdf-mesh',
              `Link "${l.name}": mesh ${r.problem}; the visual is omitted (mass and joints are unaffected).`,
            ),
          );
          unsupported.push(`link ${l.name}: mesh ${g.filename} (unresolved)`);
          return;
        }
        const ext = r.file.name.toLowerCase().split('.').pop();
        let scene: MeshScene;
        let bytes: Uint8Array;
        if (ext === 'stl') {
          const p = parseStl(r.file.bytes, v.name);
          if (!p.ok) {
            d.push(
              warn(
                'urdf-mesh',
                `Link "${l.name}": ${r.file.name} did not parse (${p.diagnostics.find((x) => x.severity === 'error')?.message ?? ''}).`,
              ),
            );
            return;
          }
          scene = p.scene!;
        } else if (ext === 'glb' || ext === 'gltf') {
          const p = parseGltf(r.file.bytes);
          if (!p.ok) {
            d.push(warn('urdf-mesh', `Link "${l.name}": ${r.file.name} did not parse.`));
            return;
          }
          scene = p.scene!;
          // URDF mesh frames are the file's own frame; glTF is Y-up by spec, so the
          // file is used as-is (ROS tooling treats meshes the same way).
        } else {
          d.push(
            warn(
              'urdf-mesh-format',
              `Link "${l.name}": ${r.file.name} (.${ext}) is not a supported mesh format (STL, GLB, glTF); omitted.`,
            ),
          );
          unsupported.push(`link ${l.name}: ${ext?.toUpperCase()} mesh ${r.file.name}`);
          return;
        }
        referencedFiles.push({
          name: r.file.name.slice(0, 260),
          sourceHash: `sha256-${sha256Bytes(r.file.bytes)}`,
        });
        const uniform =
          Math.abs(g.scale[0] - g.scale[1]) < 1e-12 &&
          Math.abs(g.scale[1] - g.scale[2]) < 1e-12 &&
          g.scale[0] > 0;
        // Bake non-uniform (or mirrored) scale into the vertices; uniform positive scale is the unit scale.
        const S: Mat4 = uniform
          ? [...IDENTITY]
          : [g.scale[0], 0, 0, 0, 0, g.scale[1], 0, 0, 0, 0, g.scale[2], 0, 0, 0, 0, 1];
        if (ext === 'stl' || !uniform) {
          const tri = triangles(scene, S).tri;
          const soupScene: MeshScene = {
            roots: [0],
            nodes: [{ name: v.name, matrix: [...IDENTITY], mesh: 0, children: [], metadata: {} }],
            meshes: [],
            materials: [],
          };
          const prim = {
            positions: Float32Array.from(tri),
            indices: new Uint32Array(tri.length / 3).map((_, i) => i),
            normals: null as Float32Array | null,
            material: null,
          };
          const fn = new Float32Array(tri.length);
          for (let t = 0; t < tri.length; t += 9) {
            const ax = tri[t + 3]! - tri[t]!,
              ay = tri[t + 4]! - tri[t + 1]!,
              az = tri[t + 5]! - tri[t + 2]!;
            const bx = tri[t + 6]! - tri[t]!,
              by = tri[t + 7]! - tri[t + 1]!,
              bz = tri[t + 8]! - tri[t + 2]!;
            const nx = ay * bz - az * by,
              ny = az * bx - ax * bz,
              nz = ax * by - ay * bx;
            const ln = Math.hypot(nx, ny, nz) || 1;
            for (let k2 = 0; k2 < 3; k2++) fn.set([nx / ln, ny / ln, nz / ln], t + k2 * 3);
          }
          prim.normals = fn;
          soupScene.meshes.push({ name: v.name, primitives: [weld(prim)] });
          bytes = writeGlb(soupScene, { generator: `FORGE ${INTEROP_VERSION} (URDF mesh ${r.file.name})` });
          scene = soupScene;
        } else bytes = r.file.bytes;
        const hash = `sha256-${sha256Bytes(bytes)}`;
        if (!assets.some((x) => x.hash === hash))
          assets.push({ hash, bytes, mediaType: 'model/gltf-binary' });
        const unitScale = uniform ? g.scale[0] : 1;
        const m = metrics(
          triangles(scene, [unitScale, 0, 0, 0, 0, unitScale, 0, 0, 0, 0, unitScale, 0, 0, 0, 0, 1]).tri,
        );
        const model: ModelRef = {
          assetHash: hash,
          byteLength: bytes.byteLength,
          mediaType: ext === 'gltf' && uniform ? 'model/gltf+json' : 'model/gltf-binary',
          name: v.name.slice(0, 200),
          categoryId: 'robotics-mobility',
          description: `URDF ${robot.name} link ${l.name} visual mesh (${r.file.name})`.slice(0, 2000),
          unitScale,
          upAxis: 'Y',
          boundsM: m.bounds!.size,
          minM: m.bounds!.min,
          metadata: {
            'source.file': r.file.name.slice(0, 500),
            'source.format': 'urdf-mesh',
            'urdf.link': l.name.slice(0, 500),
            'geometry.class': 'mesh',
          },
          interfaces: [],
        };
        if (model.mediaType === 'model/gltf+json') assets[assets.length - 1]!.mediaType = 'model/gltf+json';
        const t2 = trs(M);
        commands.push({
          type: 'model.instance.create',
          payload: { id: vid, name: v.name.slice(0, 200), parentId: lid, transform: t2, model },
        } as BatchSubCommand);
        predicted.push({
          id: vid,
          kind: 'model-instance',
          name: v.name.slice(0, 200),
          parentId: lid,
          transform: t2,
          model,
        } as unknown as SceneNode);
        nodeIds.push(vid);
        counts.meshes++;
        return;
      }
      const geometry =
        g.kind === 'box'
          ? { shape: 'box' as const, width: g.size[0], height: g.size[1], depth: g.size[2] }
          : g.kind === 'sphere'
            ? { shape: 'sphere' as const, radius: g.radius }
            : { shape: 'cylinder' as const, radius: g.radius, height: g.length };
      // URDF cylinders run along local +Z; FORGE cylinders along +Y: rotate +90° about X.
      if (g.kind === 'cylinder') M = mul(M, [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
      const t2 = trs(M);
      commands.push({
        type: 'scene.node.create',
        payload: {
          node: {
            kind: 'primitive',
            id: vid,
            name: v.name.slice(0, 200),
            parentId: lid,
            transform: t2,
            geometry,
            color: hex(v.rgba),
          },
        },
      } as BatchSubCommand);
      predicted.push({
        id: vid,
        kind: 'primitive',
        name: v.name.slice(0, 200),
        parentId: lid,
        transform: t2,
        geometry,
      } as unknown as SceneNode);
      nodeIds.push(vid);
      counts.primitives++;
      hasPrimitive = true;
    });
    if (l.collisions.length)
      d.push(
        info(
          'urdf-collision',
          `Link "${l.name}": ${l.collisions.length} <collision> element(s) recorded; contact uses the link's visual primitives${hasPrimitive ? '' : ' (none: no contact)'}.`,
        ),
      );
    if (l.collisions.length)
      unsupported.push(
        `link ${l.name}: separate collision geometry (${l.collisions.map((c) => c.geometry.kind).join(', ')})`,
      );
    if (sim) {
      let mass: Record<string, unknown> | null = null;
      if (l.inertial) {
        const R = originMatrix(l.inertial.origin);
        const [ixx, iyy, izz, ixy, ixz, iyz] = l.inertial.inertia;
        // Rotate the tensor from the inertial frame into the link frame: R I Rᵀ.
        const I = [ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz];
        const Rr = R3(R);
        const RI = [0, 1, 2].flatMap((r) =>
          [0, 1, 2].map((c) => Rr[r * 3]! * I[c]! + Rr[r * 3 + 1]! * I[3 + c]! + Rr[r * 3 + 2]! * I[6 + c]!),
        );
        const RIRt = [0, 1, 2].flatMap((r) =>
          [0, 1, 2].map(
            (c) =>
              RI[r * 3]! * Rr[c * 3]! + RI[r * 3 + 1]! * Rr[c * 3 + 1]! + RI[r * 3 + 2]! * Rr[c * 3 + 2]!,
          ),
        );
        const tensor = [RIRt[0]!, RIRt[4]!, RIRt[8]!, RIRt[1]!, RIRt[2]!, RIRt[5]!];
        const issue = inertiaIssue(tensor);
        if (issue)
          d.push(
            warn(
              'urdf-inertia',
              `Link "${l.name}": ${issue}; its inertial data was not applied (supply a mass in Simulation mode).`,
            ),
          );
        else {
          mass = {
            source: 'inertial',
            massKg: l.inertial.mass,
            comM: l.inertial.origin.xyz,
            inertia: tensor,
            note: `URDF <inertial> of link ${l.name}`.slice(0, 500),
          };
          counts.inertials++;
        }
      } else if (l.name !== robot.root)
        d.push(
          warn(
            'urdf-no-inertial',
            `Link "${l.name}" has no <inertial>: supply a mass in Simulation mode before simulating it.`,
          ),
        );
      commands.push({
        type: 'physics.body.set',
        payload: {
          nodeId: lid,
          settings: { ...(mass ? { mass } : {}), collider: hasPrimitive ? 'auto' : 'none' },
        },
      } as BatchSubCommand);
    }
  }
  commands.push({
    type: 'assembly.ground',
    payload: { assemblyId: asmId, nodeId: linkNodes[robot.root]!, grounded: true },
  } as BatchSubCommand);
  conversions.push(`Root link "${robot.root}" grounded (fixed to the world)`);
  const jointMates: Record<string, string> = {};
  for (const j of robot.joints) {
    counts.joints[j.type] = (counts.joints[j.type] ?? 0) + 1;
    if (j.type === 'floating' || j.type === 'planar') {
      d.push(
        warn(
          'urdf-joint',
          `Joint "${j.name}" (${j.type}) is not supported; "${j.child}" is not connected and will move freely in simulation.`,
        ),
      );
      unsupported.push(`joint ${j.name}: ${j.type}`);
      continue;
    }
    const O = originMatrix(j.origin);
    const xr = perpendicular(j.axis);
    const mateId = id(`joint.${j.name}`);
    jointMates[j.name] = mateId;
    const type = j.type === 'fixed' ? 'fixed' : j.type === 'prismatic' ? 'prismatic' : 'revolute';
    const q = q0[j.name] ?? 0;
    const lim =
      j.type === 'revolute' || j.type === 'prismatic' ? { min: j.limit!.lower, max: j.limit!.upper } : null;
    commands.push({
      type: 'assembly.mate.create',
      payload: {
        assemblyId: asmId,
        mate: {
          id: mateId,
          name: j.name.slice(0, 200),
          type,
          a: {
            nodeId: linkNodes[j.parent]!,
            ref: { kind: 'frame', origin: j.origin.xyz, axis: rotVec(O, j.axis), xRef: rotVec(O, xr) },
          },
          b: {
            nodeId: linkNodes[j.child]!,
            ref: { kind: 'frame', origin: [0, 0, 0], axis: j.axis, xRef: xr },
          },
          alignment: 'aligned',
          offsetRad: 0,
          ...(type === 'fixed'
            ? { coordinates: [], home: [], limits: [] }
            : { coordinates: [q], home: [q], limits: [lim] }),
        },
      },
    } as BatchSubCommand);
    if (sim && type !== 'fixed') {
      const settings: Record<string, unknown> = {
        damping: j.dynamics?.damping ?? 0,
        friction: j.dynamics?.friction ?? 0,
      };
      if (o.actuators === 'hold-initial' && j.limit && j.limit.effort > 0)
        settings.actuator = {
          enabled: true,
          mode: 'position',
          target: q,
          effortLimit: j.limit.effort,
          speedLimit: j.limit.velocity > 0 ? j.limit.velocity : 6,
          source: 'user',
          sourceNote:
            `Effort/velocity limits from URDF <limit> of ${j.name}; generic FORGE position controller (an assumption, not the robot's controller).`.slice(
              0,
              500,
            ),
        };
      else if (o.actuators === 'hold-initial')
        d.push(
          warn('urdf-actuator', `Joint "${j.name}" has no effort limit; no actuator added (passive joint).`),
        );
      commands.push({ type: 'physics.joint.set', payload: { mateId, settings } } as BatchSubCommand);
    }
  }
  if (o.actuators === 'hold-initial')
    conversions.push(
      'Generic position actuators added (target = initial joint value, limits from URDF <limit>)',
    );
  conversions.push(
    `${robot.links.length} links → bodies, ${Object.values(counts.joints).reduce((a, b) => a + b, 0)} joints → mates; ${counts.inertials} <inertial> blocks → explicit mass properties`,
  );
  if (unsupported.length)
    d.push(
      info(
        'urdf-unsupported',
        `Not represented: ${unsupported.slice(0, 12).join('; ')}${unsupported.length > 12 ? '; …' : ''}.`,
      ),
    );
  const record: ImportRecord = {
    id: o.importId,
    format: 'urdf',
    formatVersion: null,
    fileName: file.name.slice(0, 260),
    byteLength: file.bytes.byteLength,
    sourceHash: `sha256-${sha256Bytes(file.bytes)}`,
    referencedFiles,
    importedAt: (o.now ?? new Date()).toISOString(),
    importer: INTEROP_VERSION,
    sourceUnit: 'm',
    toMetres: 1,
    upAxis: 'Z',
    handedness: 'right',
    geometryClass: counts.meshes ? 'mesh' : 'primitive',
    nodeIds,
    assetHashes: assets.map((a) => a.hash),
    summary: {
      robot: robot.name.slice(0, 500),
      links: counts.links,
      ...Object.fromEntries(Object.entries(counts.joints).map(([k, v]) => [`joints.${k}`, v])),
      meshes: counts.meshes,
      primitives: counts.primitives,
      inertials: counts.inertials,
    },
    conversions,
    unsupported: unsupported.slice(0, 500).map((x) => x.slice(0, 500)),
    warnings: d.filter((x) => x.severity === 'warning').map((x) => x.message.slice(0, 1000)),
    nodesFingerprint: nodesFingerprint(predicted),
  };
  commands.push({ type: 'interop.import.record', payload: { record } } as BatchSubCommand);
  return {
    ok: !d.some((x) => x.severity === 'error'),
    diagnostics: d,
    assets,
    commands,
    record,
    nodeIds,
    linkNodes,
    jointMates,
    summary: counts,
  };
}
