import { createCatalogResolver } from '@forge/components';
import {
  createProject,
  ForgeEngine,
  makeCommand,
  type BatchSubCommand,
  type CommandInput,
  type FrameRef,
  type Mate,
  type Project,
} from '@forge/engineering-core';
import { createMechanicsService } from '../index';

/**
 * Sample project: the VEYRIS desktop robotic arm as a CONSTRAINED mechanical assembly,
 * built entirely through validated engine commands (the same path the UI and Vey use).
 *
 * Kinematic chain (all placements computed by the assembly solver):
 *   base plate (grounded) ─fixed─ base servo ─REVOLUTE yaw─ shoulder bracket ─fixed─
 *   shoulder servo ─REVOLUTE shoulder─ upper link ─fixed─ elbow servo ─REVOLUTE elbow─
 *   forearm ─fixed─ wrist bracket ─fixed─ wrist servo ─REVOLUTE roll─ gripper
 *   plus: shoulder shaft and 608 bearing fixed at the shoulder joint; HC-SR04 fixed to the
 *   plate; four M4 × 12 screws through the plate's M4 clearance holes into M4 nuts.
 * Electronics and power are SEPARATE groups (not mechanically related).
 *
 * KINEMATICS ONLY: joint coordinates are set by hand. No motor torque, payload, static
 * stability, wiring or servo control is modelled or claimed (Phase 5+).
 */
export const ROBOT_ARM_SAMPLE_NAME = 'Sample — Robotic arm (constrained assembly)';
export const ARM_ASSEMBLY_ID = 'grp-arm';
export const ARM_JOINTS = {
  yaw: 'j-yaw',
  shoulder: 'j-shoulder',
  elbow: 'j-elbow',
  wrist: 'j-wrist',
} as const;

const deg = (d: number) => (d * Math.PI) / 180;
type V = [number, number, number];
const F = (origin: V, axis: V, xRef: V): FrameRef => ({ kind: 'frame', origin, axis, xRef });
const I = (interfaceId: string): FrameRef => ({ kind: 'interface', interfaceId });
const UP: V = [0, 1, 0];
const DOWN: V = [0, -1, 0];
const X: V = [1, 0, 0];

// Local geometry of the catalogue parts used (metres; see the catalogue definitions).
const MG996R_OUTPUT_X = -0.0407 / 2 + 0.0197 / 2; // output spline sits over one end of the case
const SG90_OUTPUT_X = -0.0222 / 2 + 0.0118 / 2;
const servoBase = (outputX: number) => F([outputX, 0, 0], DOWN, X); // case underside, below the output axis

type Part = {
  id: string;
  definitionId: string;
  name: string;
  variantId?: string;
  parameters?: Record<string, number | string | boolean>;
};
type MateSpec = Omit<Partial<Mate>, 'a' | 'b' | 'type'> & {
  id: string;
  name: string;
  type: Mate['type'];
  a: [string, FrameRef];
  b: [string, FrameRef];
};

export function createRoboticArmSample(now = new Date()): Project {
  const base = createProject(ROBOT_ARM_SAMPLE_NAME, now);
  const cube = base.scene.nodes[base.scene.rootId]!.childIds[0]!;
  const engine = new ForgeEngine(base, {
    componentResolver: createCatalogResolver(),
    mechanics: createMechanicsService(),
    now: () => now,
  });
  const root = base.scene.rootId;

  const arm: Part[] = [
    { id: 'base-plate', definitionId: 'arm-base-plate', name: 'Base plate', parameters: { holes: 'M4' } },
    { id: 'base-servo', definitionId: 'towerpro-mg996r', name: 'Base yaw servo (MG996R)' },
    {
      id: 'shoulder-bracket',
      definitionId: 'servo-mount-bracket',
      name: 'Shoulder bracket',
      variantId: 'standard',
    },
    { id: 'shoulder-servo', definitionId: 'towerpro-mg996r', name: 'Shoulder pitch servo (MG996R)' },
    { id: 'upper-link', definitionId: 'arm-link', name: 'Upper arm link (120 mm)', variantId: '120' },
    {
      id: 'shoulder-shaft',
      definitionId: 'precision-shaft',
      name: 'Shoulder shaft Ø8',
      variantId: 'd8',
      parameters: { length: 0.04 },
    },
    { id: 'shoulder-bearing', definitionId: 'ball-bearing', name: 'Shoulder bearing 608', variantId: '608' },
    { id: 'elbow-servo', definitionId: 'towerpro-mg996r', name: 'Elbow servo (MG996R)' },
    { id: 'forearm-link', definitionId: 'arm-link', name: 'Forearm link (100 mm)', variantId: '100' },
    { id: 'wrist-bracket', definitionId: 'servo-mount-bracket', name: 'Wrist bracket', variantId: 'micro' },
    { id: 'wrist-servo', definitionId: 'towerpro-sg90', name: 'Wrist servo (SG90)' },
    {
      id: 'gripper',
      definitionId: 'parallel-gripper',
      name: 'Two-finger gripper',
      parameters: { opening: 0.035 },
    },
    { id: 'range-sensor', definitionId: 'hc-sr04', name: 'Range sensor (HC-SR04)' },
    ...[1, 2, 3, 4].flatMap((k): Part[] => [
      {
        id: `screw-${k}`,
        definitionId: 'machine-screw',
        name: `M4 × 12 socket screw ${k}`,
        variantId: 'm4x12',
      },
      { id: `nut-${k}`, definitionId: 'hex-nut', name: `M4 hex nut ${k}`, variantId: 'm4' },
    ]),
  ];
  const others: (Part & { parentId: string; position: V })[] = [
    {
      id: 'arduino',
      definitionId: 'arduino-uno-r3',
      name: 'Arduino UNO R3',
      parentId: 'grp-controller',
      position: [0.32, 0, -0.06],
    },
    {
      id: 'breadboard',
      definitionId: 'breadboard',
      name: 'Breadboard (half)',
      variantId: 'half',
      parentId: 'grp-controller',
      position: [0.32, 0, 0.05],
    },
    {
      id: 'motor-driver',
      definitionId: 'dual-h-bridge-module',
      name: 'Motor-control module',
      parentId: 'grp-controller',
      position: [0.45, 0, -0.06],
    },
    {
      id: 'power-module',
      definitionId: 'breadboard-power-module',
      name: 'Breadboard power module',
      parentId: 'grp-controller',
      position: [0.32, 0.0085, 0.05],
    },
    {
      id: 'jumper-1',
      definitionId: 'jumper-wire',
      name: 'Jumper (signal)',
      variantId: 'mm-100',
      parameters: { color: 'yellow' },
      parentId: 'grp-controller',
      position: [0.32, 0.0085, 0],
    },
    {
      id: 'jumper-2',
      definitionId: 'jumper-wire',
      name: 'Jumper (5 V)',
      variantId: 'mm-100',
      parameters: { color: 'red' },
      parentId: 'grp-controller',
      position: [0.32, 0.0085, 0.006],
    },
    {
      id: 'jumper-3',
      definitionId: 'jumper-wire',
      name: 'Jumper (GND)',
      variantId: 'mm-100',
      parameters: { color: 'black' },
      parentId: 'grp-controller',
      position: [0.32, 0.0085, 0.012],
    },
    {
      id: 'battery',
      definitionId: 'battery-pack',
      name: 'Battery pack (4 × AA)',
      variantId: '4xaa',
      parentId: 'grp-power',
      position: [0.45, 0, 0.06],
    },
  ];
  const holes: [number, number][] = [
    [-0.065, -0.065],
    [0.065, -0.065],
    [0.065, 0.065],
    [-0.065, 0.065],
  ];
  const lim = (min: number, max: number) => [{ min: deg(min), max: deg(max) }];
  const mates: MateSpec[] = [
    {
      id: 'm-base-servo',
      name: 'Base servo on plate',
      type: 'fixed',
      a: ['base-plate', F([0, 0.006, 0], UP, X)],
      b: ['base-servo', servoBase(MG996R_OUTPUT_X)],
    },
    {
      id: ARM_JOINTS.yaw,
      name: 'Base yaw joint',
      type: 'revolute',
      a: ['base-servo', I('output')],
      b: ['shoulder-bracket', F([0.01375, 0, 0], DOWN, X)],
      limits: lim(-150, 150),
    },
    {
      id: 'm-shoulder-servo',
      name: 'Shoulder servo in bracket',
      type: 'fixed',
      a: ['shoulder-bracket', F([0.00125, 0.025, 0], X, UP)],
      b: ['shoulder-servo', servoBase(MG996R_OUTPUT_X)],
    },
    {
      id: ARM_JOINTS.shoulder,
      name: 'Shoulder joint',
      type: 'revolute',
      a: ['shoulder-servo', I('output')],
      b: ['upper-link', I('joint-a')],
      limits: lim(-90, 90),
    },
    {
      id: 'm-shaft',
      name: 'Shoulder shaft in upper link',
      type: 'fixed',
      a: ['upper-link', I('joint-a')],
      b: ['shoulder-shaft', F([0, 0.004, 0], X, UP)],
    },
    {
      id: 'm-bearing',
      name: 'Bearing on shoulder shaft',
      type: 'fixed',
      a: ['shoulder-shaft', F([0.012, 0.004, 0], X, UP)],
      b: ['shoulder-bearing', I('bore')],
    },
    {
      id: 'm-elbow-servo',
      name: 'Elbow servo on upper link',
      type: 'fixed',
      a: ['upper-link', F([0.06, 0.003, 0], UP, X)],
      b: ['elbow-servo', servoBase(MG996R_OUTPUT_X)],
    },
    {
      id: ARM_JOINTS.elbow,
      name: 'Elbow joint',
      type: 'revolute',
      a: ['elbow-servo', I('output')],
      b: ['forearm-link', I('joint-a')],
      limits: lim(-135, 135),
      coordinates: [deg(-90)],
      home: [deg(-90)],
    },
    {
      id: 'm-wrist-bracket',
      name: 'Wrist bracket on forearm',
      type: 'fixed',
      a: ['forearm-link', F([0.05, 0.003, 0], UP, X)],
      b: ['wrist-bracket', F([0.009, 0, 0], DOWN, X)],
    },
    {
      id: 'm-wrist-servo',
      name: 'Wrist servo in bracket',
      type: 'fixed',
      a: ['wrist-bracket', F([0.001, 0.016, 0], X, UP)],
      b: ['wrist-servo', servoBase(SG90_OUTPUT_X)],
    },
    {
      id: ARM_JOINTS.wrist,
      name: 'Wrist roll joint',
      type: 'revolute',
      a: ['wrist-servo', I('output')],
      b: ['gripper', I('wrist')],
      limits: lim(-90, 90),
    },
    {
      id: 'm-sensor',
      name: 'Range sensor on plate',
      type: 'fixed',
      a: ['base-plate', F([0, 0.006, 0.055], UP, X)],
      b: ['range-sensor', F([0, 0, 0], DOWN, X)],
    },
    ...holes.flatMap(([hx, hz], i): MateSpec[] => [
      {
        id: `m-screw-${i + 1}`,
        name: `Screw ${i + 1} through plate`,
        type: 'fixed',
        a: ['base-plate', I(`hole-${i + 1}`)],
        b: [`screw-${i + 1}`, F([0, 0.012, 0], DOWN, X)],
      },
      {
        id: `m-nut-${i + 1}`,
        name: `Nut ${i + 1} under plate`,
        type: 'fixed',
        a: ['base-plate', F([hx, 0, hz], DOWN, X)],
        b: [`nut-${i + 1}`, F([0, 0.0032, 0], UP, X)],
      },
    ]),
  ];

  const create = (p: Part, parentId: string, position: V = [0, 0, 0]): BatchSubCommand => ({
    type: 'scene.node.create',
    payload: {
      node: {
        kind: 'component-instance',
        id: p.id,
        name: p.name,
        parentId,
        definitionId: p.definitionId,
        ...(p.variantId ? { variantId: p.variantId } : {}),
        ...(p.parameters ? { parameters: p.parameters } : {}),
        transform: { position },
      },
    },
  });
  const commands: BatchSubCommand[] = [
    { type: 'scene.node.delete', payload: { nodeId: cube } },
    {
      type: 'assembly.create',
      payload: { id: ARM_ASSEMBLY_ID, name: 'Robotic arm', parentId: root, nodeIds: [] },
    },
    {
      type: 'scene.node.create',
      payload: {
        node: { kind: 'group', id: 'grp-controller', name: 'Controller & electronics', parentId: root },
      },
    },
    {
      type: 'scene.node.create',
      payload: { node: { kind: 'group', id: 'grp-power', name: 'Power', parentId: root } },
    },
    ...arm.map((p) => create(p, ARM_ASSEMBLY_ID)),
    ...others.map((p) => create(p, p.parentId, p.position)),
    {
      type: 'assembly.ground',
      payload: { assemblyId: ARM_ASSEMBLY_ID, nodeId: 'base-plate', grounded: true },
    },
    ...mates.map((m): BatchSubCommand => ({
      type: 'assembly.mate.create',
      payload: {
        assemblyId: ARM_ASSEMBLY_ID,
        mate: {
          id: m.id,
          name: m.name,
          type: m.type,
          a: { nodeId: m.a[0], ref: m.a[1] },
          b: { nodeId: m.b[0], ref: m.b[1] },
          ...(m.limits ? { limits: m.limits } : {}),
          ...(m.coordinates ? { coordinates: m.coordinates } : {}),
          ...(m.home ? { home: m.home } : {}),
        },
      },
    })),
  ];
  const r = engine.execute(
    makeCommand('scene.batch', { commands }, 'desktop-ui', {
      label: 'Build robotic-arm sample',
    }) as CommandInput,
  );
  if (!r.ok) throw new Error(`Robotic-arm sample failed to build: ${r.error.message}`);
  return { ...engine.getProject(), revision: 0 };
}
