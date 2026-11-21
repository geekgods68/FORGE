import {
  createProject,
  ForgeEngine,
  makeCommand,
  type CommandInput,
  type Project,
} from '@forge/engineering-core';
import { createCatalogResolver } from '../resolver';

/**
 * Sample project: a desktop robotic arm with its controller and electronics, built
 * ENTIRELY through validated engine commands (the same path the UI and Vey use).
 *
 * Parts are positioned manually to show a plausible layout. Nothing here is actuated,
 * wired or constrained: servo motion, circuits and joint mates are later phases
 * (4 and 6). Connections are not declared. All positions are in the project frame
 * (metres) — mount the project on any workbench and the layout moves with it.
 */
const qz = (deg: number): [number, number, number, number] => {
  const h = (deg * Math.PI) / 360;
  return [0, 0, Math.sin(h), Math.cos(h)];
};
const qy = (deg: number): [number, number, number, number] => {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
};

type Spec = {
  id: string;
  definitionId: string;
  name: string;
  parentId: string;
  position: [number, number, number];
  rotation?: [number, number, number, number];
  variantId?: string;
  parameters?: Record<string, number | string | boolean>;
  materialId?: string;
};

export const ROBOT_ARM_SAMPLE_NAME = 'Sample — Robotic arm (Phase 3)';

export function createRoboticArmSample(now = new Date()): Project {
  const base = createProject(ROBOT_ARM_SAMPLE_NAME, now);
  // The sample replaces the default reference cube.
  const cube = base.scene.nodes[base.scene.rootId]!.childIds[0]!;
  const engine = new ForgeEngine(base, { componentResolver: createCatalogResolver(), now: () => now });
  const root = base.scene.rootId;
  const groups: [string, string][] = [
    ['grp-arm', 'Robotic arm'],
    ['grp-fasteners', 'Fastener set (base)'],
    ['grp-controller', 'Controller & electronics'],
    ['grp-power', 'Power'],
  ];
  const parts: Spec[] = [
    // Arm structure (stacked on a 150 mm base plate at the origin).
    {
      id: 'base-plate',
      definitionId: 'arm-base-plate',
      name: 'Base plate',
      parentId: 'grp-arm',
      position: [0, 0, 0],
      parameters: { holes: 'M4' },
    },
    {
      id: 'base-servo',
      definitionId: 'towerpro-mg996r',
      name: 'Base yaw servo (MG996R)',
      parentId: 'grp-arm',
      position: [0.0102, 0.006, 0],
    },
    {
      id: 'shoulder-bracket',
      definitionId: 'servo-mount-bracket',
      name: 'Shoulder bracket',
      parentId: 'grp-arm',
      position: [0, 0.0489, 0],
      variantId: 'standard',
    },
    {
      id: 'shoulder-servo',
      definitionId: 'towerpro-mg996r',
      name: 'Shoulder pitch servo (MG996R)',
      parentId: 'grp-arm',
      position: [0.03, 0.0515, 0],
      rotation: qz(90),
    },
    {
      id: 'shoulder-shaft',
      definitionId: 'precision-shaft',
      name: 'Shoulder idler shaft Ø8',
      parentId: 'grp-arm',
      position: [-0.02, 0.09, 0],
      rotation: qy(90),
      variantId: 'd8',
      parameters: { length: 0.04 },
    },
    {
      id: 'shoulder-bearing',
      definitionId: 'ball-bearing',
      name: 'Shoulder bearing 608',
      parentId: 'grp-arm',
      position: [-0.02, 0.083, -0.02],
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      variantId: '608',
    },
    {
      id: 'upper-link',
      definitionId: 'arm-link',
      name: 'Upper arm link (120 mm)',
      parentId: 'grp-arm',
      position: [0.012, 0.15, 0.015],
      rotation: qz(90),
      variantId: '120',
    },
    {
      id: 'elbow-servo',
      definitionId: 'towerpro-mg996r',
      name: 'Elbow servo (MG996R)',
      parentId: 'grp-arm',
      position: [0.03, 0.2, 0],
      rotation: qz(90),
    },
    {
      id: 'forearm-link',
      definitionId: 'arm-link',
      name: 'Forearm link (100 mm)',
      parentId: 'grp-arm',
      position: [0.08, 0.235, 0.015],
      variantId: '100',
    },
    {
      id: 'wrist-bracket',
      definitionId: 'servo-mount-bracket',
      name: 'Wrist bracket',
      parentId: 'grp-arm',
      position: [0.14, 0.238, 0],
      variantId: 'micro',
    },
    {
      id: 'wrist-servo',
      definitionId: 'towerpro-sg90',
      name: 'Wrist servo (SG90)',
      parentId: 'grp-arm',
      position: [0.15, 0.24, 0],
    },
    {
      id: 'gripper',
      definitionId: 'parallel-gripper',
      name: 'Two-finger gripper',
      parentId: 'grp-arm',
      position: [0.2, 0.23, 0],
      parameters: { opening: 0.035 },
    },
    {
      id: 'range-sensor',
      definitionId: 'hc-sr04',
      name: 'Range sensor (HC-SR04)',
      parentId: 'grp-arm',
      position: [0, 0.006, 0.06],
    },
    // Fastener set: four M4 × 12 screws and nuts at the base-plate corner holes.
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].flatMap((sz) => [
        {
          id: `screw-${sx}${sz}`,
          definitionId: 'machine-screw',
          name: 'M4 × 12 socket screw',
          parentId: 'grp-fasteners',
          position: [sx * 0.065, -0.006, sz * 0.065] as [number, number, number],
          variantId: 'm4x12',
        },
        {
          id: `nut-${sx}${sz}`,
          definitionId: 'hex-nut',
          name: 'M4 hex nut',
          parentId: 'grp-fasteners',
          position: [sx * 0.065, 0.006, sz * 0.065] as [number, number, number],
          variantId: 'm4',
        },
      ]),
    ),
    // Controller and electronics to the side.
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
      parentId: 'grp-controller',
      position: [0.32, 0, 0.05],
      variantId: 'half',
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
      parentId: 'grp-controller',
      position: [0.32, 0.0085, 0.0],
      variantId: 'mm-100',
      parameters: { color: 'yellow' },
    },
    {
      id: 'jumper-2',
      definitionId: 'jumper-wire',
      name: 'Jumper (5 V)',
      parentId: 'grp-controller',
      position: [0.32, 0.0085, 0.006],
      variantId: 'mm-100',
      parameters: { color: 'red' },
    },
    {
      id: 'jumper-3',
      definitionId: 'jumper-wire',
      name: 'Jumper (GND)',
      parentId: 'grp-controller',
      position: [0.32, 0.0085, 0.012],
      variantId: 'mm-100',
      parameters: { color: 'black' },
    },
    {
      id: 'battery',
      definitionId: 'battery-pack',
      name: 'Battery pack (4 × AA)',
      parentId: 'grp-power',
      position: [0.45, 0, 0.06],
      variantId: '4xaa',
    },
  ];
  const r = engine.execute(
    makeCommand(
      'scene.batch',
      {
        commands: [
          { type: 'scene.node.delete', payload: { nodeId: cube } },
          ...groups.map(([id, name]) => ({
            type: 'scene.node.create' as const,
            payload: { node: { kind: 'group' as const, id, name, parentId: root } },
          })),
          ...parts.map((p) => ({
            type: 'scene.node.create' as const,
            payload: {
              node: {
                kind: 'component-instance' as const,
                id: p.id,
                name: p.name,
                parentId: p.parentId,
                definitionId: p.definitionId,
                ...(p.variantId ? { variantId: p.variantId } : {}),
                ...(p.parameters ? { parameters: p.parameters } : {}),
                ...(p.materialId ? { materialId: p.materialId } : {}),
                transform: { position: p.position, ...(p.rotation ? { rotation: p.rotation } : {}) },
              },
            },
          })),
        ],
      },
      'desktop-ui',
      { label: 'Build robotic-arm sample' },
    ) as CommandInput,
  );
  if (!r.ok) throw new Error(`Robotic-arm sample failed to build: ${r.error.message}`);
  // Saved state: no undo history needed for a freshly opened sample.
  return { ...engine.getProject(), revision: 0 };
}
