import { FURNISHING_TYPES, isFurnishingType, type Furnishing, type FurnishingTypeId } from '@forge/facility';
import type { FixturePlacement } from '@/rendering/InstancedFixtures';
import { materialKey } from '@/rendering/resources';
import { MATERIALS } from './materials';

/**
 * Procedural fixture library: every furnishing type as a handful of boxes/cylinders in
 * the shared palette. Parts are in the furnishing frame (origin = footprint centre on
 * the floor, +Z = front, metres). Zone templates batch parts by (shape, material) into
 * instanced meshes, so a zone costs one draw call per distinct material, not per part.
 * Illustrative dressing only — no dimensions here are engineering data.
 */
export type MaterialName = keyof typeof MATERIALS;
export interface Part {
  shape: 'box' | 'cyl';
  /** box: [w, h, d]; cyl: [diameter, h, diameter]. */
  size: [number, number, number];
  /** Centre of the part. */
  pos: [number, number, number];
  /** Extra rotation about +Y (radians). */
  yaw?: number;
  m: MaterialName;
}

const b = (w: number, h: number, d: number, x: number, y: number, z: number, m: MaterialName): Part => ({
  shape: 'box',
  size: [w, h, d],
  pos: [x, y, z],
  m,
});
const c = (dia: number, h: number, x: number, y: number, z: number, m: MaterialName): Part => ({
  shape: 'cyl',
  size: [dia, h, dia],
  pos: [x, y, z],
  m,
});
const range = (n: number, from: number, to: number) =>
  Array.from({ length: n }, (_, i) => (n === 1 ? (from + to) / 2 : from + ((to - from) * i) / (n - 1)));
const legs = (w: number, d: number, h: number, m: MaterialName = 'graphite', t = 0.05) =>
  [-1, 1].flatMap((sx) => [-1, 1].map((sz) => b(t, h, t, sx * (w / 2 - t), h / 2, sz * (d / 2 - t), m)));
const frameBox = (w: number, h: number, d: number, y0: number, m: MaterialName, t = 0.05): Part[] => [
  ...[-1, 1].flatMap((sx) =>
    [-1, 1].map((sz) => b(t, h, t, sx * (w / 2 - t / 2), y0 + h / 2, sz * (d / 2 - t / 2), m)),
  ),
  ...[-1, 1].map((sz) => b(w, t, t, 0, y0 + h - t / 2, sz * (d / 2 - t / 2), m)),
  ...[-1, 1].map((sx) => b(t, t, d, sx * (w / 2 - t / 2), y0 + h - t / 2, 0, m)),
];
const monitor = (x: number, y: number, z: number, w = 0.55): Part[] => [
  b(w, w * 0.6, 0.03, x, y, z, 'screen'),
  b(0.04, 0.25, 0.04, x, y - w * 0.3 - 0.1, z - 0.04, 'graphite'),
];

type Recipe = (W: number, H: number, D: number) => Part[];

const RECIPES: Record<FurnishingTypeId, Recipe> = {
  'wall-bench': (W, _H, D) => [
    b(W, 0.04, D, 0, 0.9, 0, 'worktop'),
    b(W - 0.04, 0.84, D - 0.06, 0, 0.44, -0.02, 'enamel'),
    b(W, 0.03, 0.3, 0, 1.6, -D / 2 + 0.15, 'aluminium'),
    b(W, 0.03, 0.3, 0, 1.95, -D / 2 + 0.15, 'aluminium'),
    ...[-1, 1].map((s) => b(0.04, 1.1, 0.04, s * (W / 2 - 0.05), 1.45, -D / 2 + 0.04, 'aluminium')),
    ...range(3, -W / 3, W / 3).map((x) => b(0.25, 0.22, 0.2, x, 1.73, -D / 2 + 0.15, 'graphite')),
  ],
  'storage-wall': (W, H, D) => [
    b(W, H - 0.08, D, 0, H / 2 + 0.04, 0, 'enamel'),
    b(W - 0.04, 0.08, D - 0.04, 0, 0.04, 0, 'graphite'),
    ...range(3, -W / 4, W / 4).map((x) => b(0.012, H - 0.2, 0.006, x, H / 2, D / 2 + 0.003, 'trim')),
  ],
  whiteboard: (W, H) => [
    b(W, H, 0.025, 0, 0.9 + H / 2, 0, 'worktop'),
    b(W + 0.04, 0.03, 0.05, 0, 0.9, 0.01, 'aluminium'),
    b(W + 0.04, 0.03, 0.05, 0, 0.9 + H, 0.01, 'aluminium'),
  ],
  'desk-cluster': (W, _H, D) => [
    b(W, 0.03, D, 0, 0.73, 0, 'worktop'),
    ...legs(W, D, 0.715),
    b(W, 0.4, 0.03, 0, 0.95, 0, 'fabric'),
    ...[-W / 4, W / 4].flatMap((x) => [...monitor(x, 1.02, -0.3), ...monitor(x, 1.02, 0.3)]),
  ],
  'meeting-table': (W, _H, D) => [
    b(W, 0.04, D, 0, 0.73, 0, 'timber'),
    ...[-1, 1].map((s) => b(0.1, 0.71, D * 0.6, s * W * 0.3, 0.355, 0, 'graphite')),
  ],
  'display-wall': (W, H, D) => [
    b(W + 0.06, H * 0.55 + 0.06, 0.06, 0, 0.95 + H * 0.275, -D / 2 + 0.03, 'graphite'),
    b(W, H * 0.55, 0.02, 0, 0.95 + H * 0.275, -D / 2 + 0.07, 'screen'),
    b(W * 0.5, 0.7, D, 0, 0.35, 0, 'graphite'),
  ],
  'flammables-cabinet': (W, H, D) => [
    b(W, H, D, 0, H / 2, 0, 'safetyYellow'),
    b(0.012, H - 0.15, 0.006, 0, H / 2, D / 2 + 0.003, 'graphite'),
  ],
  'directory-kiosk': (W, H) => [
    b(0.12, H - 0.6, 0.12, 0, (H - 0.6) / 2, -0.05, 'aluminium'),
    b(W, 0.84, 0.08, 0, H - 0.42, 0, 'graphite'),
    b(W - 0.06, 0.78, 0.01, 0, H - 0.42, 0.045, 'screen'),
  ],
  'server-rack-row': (W, H, D) => [
    ...range(8, -W / 2 + 0.3, W / 2 - 0.3).flatMap((x) => [
      b(0.58, H, D, x, H / 2, 0, 'graphite'),
      b(0.4, 0.02, 0.006, x, H - 0.2, D / 2 + 0.003, 'screen'),
    ]),
    b(W, 0.04, 0.35, 0, H - 0.02, -D / 2 + 0.2, 'aluminium'),
  ],
  'gpu-cluster': (W, H, D) =>
    range(4, -W / 2 + 0.3, W / 2 - 0.3).flatMap((x) => [
      b(0.58, H, D, x, H / 2, 0, 'graphite'),
      b(0.5, H - 0.4, 0.01, x, H / 2, D / 2 + 0.005, 'trim'),
      b(0.08, 0.5, 0.006, x + 0.2, H / 2, D / 2 + 0.011, 'screen'),
    ]),
  'camera-rig': (W, H, D) => [
    ...frameBox(W, H, D, 0, 'aluminium', 0.06),
    ...[-W / 2 + 0.1, 0, W / 2 - 0.1].flatMap((x) =>
      [-D / 2 + 0.1, D / 2 - 0.1].map((z) => b(0.14, 0.1, 0.18, x, H - 0.15, z, 'graphite')),
    ),
    c(1.0, 0.3, 0, 0.15, 0, 'graphite'),
    b(0.8, 0.6, 0.02, 0, 1.2, -D / 2 + 0.2, 'worktop'),
  ],
  'vr-tracking-space': (W, H, D) => [
    b(W - 0.2, 0.01, D - 0.2, 0, 0.005, 0, 'rubber'),
    ...frameBox(W, H, D, 0, 'aluminium', 0.06),
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].map((sz) => b(0.3, 0.06, 0.06, sx * (W / 2 - 0.3), H - 0.12, sz * (D / 2 - 0.1), 'graphite')),
    ),
    ...monitor(W / 2 - 0.8, 1.2, D / 2 - 0.1, 1.0),
  ],
  'robot-arm-cell': (W, H, D) => [
    b(0.8, 0.75, 0.8, 0, 0.375, -0.3, 'graphite'),
    c(0.3, 0.3, 0, 0.9, -0.3, 'enamel'),
    b(0.22, 0.22, 0.22, 0, 1.15, -0.3, 'enamel'),
    b(0.13, 0.13, 0.7, 0, 1.25, 0.0, 'enamel'),
    b(0.11, 0.45, 0.11, 0, 1.05, 0.32, 'enamel'),
    b(0.12, 0.08, 0.08, 0, 0.8, 0.32, 'graphite'),
    b(1.2, 0.04, 0.7, 0, 0.78, 0.6, 'worktop'),
    ...legs(1.2, 0.7, 0.76).map((p) => ({
      ...p,
      pos: [p.pos[0], p.pos[1], p.pos[2] + 0.6] as [number, number, number],
    })),
    // Guarding: glass panels on three sides, open front with a pendant HMI.
    b(W, 1.8, 0.02, 0, 1.0, -D / 2 + 0.01, 'glass'),
    ...[-1, 1].map((s) => b(0.02, 1.8, D, s * (W / 2 - 0.01), 1.0, 0, 'glass')),
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].map((sz) => b(0.05, H, 0.05, sx * (W / 2 - 0.03), H / 2, sz * (D / 2 - 0.03), 'aluminium')),
    ),
    b(0.3, 0.24, 0.04, W / 2 - 0.25, 1.35, D / 2 - 0.05, 'screen'),
    b(W, 0.006, 0.06, 0, 0.003, D / 2 - 0.03, 'floorMarking'),
  ],
  'mobile-robot-arena': (W, H, D) => [
    b(W, 0.006, D, 0, 0.003, 0, 'epoxyTop'),
    ...[-1, 1].map((s) => b(W, H, 0.04, 0, H / 2, s * (D / 2 - 0.02), 'enamel')),
    ...[-1, 1].map((s) => b(0.04, H, D, s * (W / 2 - 0.02), H / 2, 0, 'enamel')),
    ...range(3, -W / 3, W / 3).map((x) => b(0.04, 0.008, D - 0.6, x, 0.007, 0, 'floorMarking')),
    b(0.6, 0.4, 0.6, -1.5, 0.2, -1, 'timber'),
    b(0.6, 0.4, 1.2, 1.8, 0.2, 0.8, 'timber'),
    b(0.45, 0.22, 0.5, -0.4, 0.13, 1.2, 'graphite'),
    c(0.12, 0.08, -0.4, 0.28, 1.2, 'graphite'),
    b(0.45, 0.22, 0.5, 2.6, 0.13, -1.8, 'graphite'),
    c(0.12, 0.08, 2.6, 0.28, -1.8, 'graphite'),
  ],
  'charging-dock': (W, _H, D) => [
    b(W, 0.5, 0.3, 0, 0.25, -D / 2 + 0.15, 'graphite'),
    b(0.5, 0.02, 0.3, 0, 0.01, 0.1, 'aluminium'),
    b(0.2, 0.04, 0.01, 0, 0.42, -D / 2 + 0.305, 'screen'),
  ],
  'electronics-bench': (W, _H, D) => [
    b(W, 0.04, D, 0, 0.9, 0, 'epoxyTop'),
    ...legs(W, D, 0.88),
    b(W * 0.3, 0.6, D - 0.1, -W / 2 + W * 0.15 + 0.05, 0.42, 0, 'enamel'),
    b(W, 0.03, 0.38, 0, 1.36, -D / 2 + 0.2, 'aluminium'),
    ...[-1, 1].map((s) => b(0.04, 0.5, 0.04, s * (W / 2 - 0.05), 1.15, -D / 2 + 0.05, 'aluminium')),
    ...[-0.7, 0, 0.7].flatMap((x) => [
      b(0.4, 0.2, 0.32, x, 1.475, -D / 2 + 0.2, 'graphite'),
      b(0.16, 0.1, 0.006, x - 0.08, 1.48, -D / 2 + 0.363, 'screen'),
    ]),
  ],
  'control-rig': (W, _H, D) => [
    b(W, 0.04, D, 0, 0.8, 0, 'aluminium'),
    ...legs(W, D, 0.78, 'aluminium', 0.045),
    b(0.3, 0.22, 0.22, -0.45, 0.93, 0, 'graphite'),
    b(0.35, 0.05, 0.05, -0.15, 0.93, 0, 'steel'),
    c(0.32, 0.05, 0.08, 0.93, 0, 'steel'),
    b(0.4, 0.15, 0.3, 0.55, 0.895, 0, 'graphite'),
    ...monitor(0.1, 1.28, -D / 2 + 0.1),
  ],
  'cnc-mill': (W, H, D) => [
    b(W, 0.3, D, 0, 0.15, 0, 'graphite'),
    b(W, H * 0.72, D, 0, 0.3 + H * 0.36, 0, 'enamel'),
    b(W * 0.5, H * 0.28, 0.02, -0.25, 1.25, D / 2 + 0.01, 'glass'),
    b(0.6, H * 0.15, 0.7, 0, 0.3 + H * 0.72 + H * 0.075 - 0.01, -0.3, 'graphite'),
    b(0.42, 0.5, 0.08, W / 2 - 0.28, 1.45, D / 2 + 0.04, 'screen'),
  ],
  lathe: (W, _H, D) => [
    b(W, 0.85, 0.6, 0, 0.425, -0.1, 'enamel'),
    b(W, 0.22, 0.4, 0, 0.96, -0.1, 'graphite'),
    b(0.6, 0.45, 0.5, -W / 2 + 0.3, 1.3, -0.1, 'enamel'),
    b(0.3, 0.3, 0.3, W / 2 - 0.3, 1.22, -0.1, 'enamel'),
    b(0.08, 0.28, 0.28, -W / 2 + 0.64, 1.25, -0.1, 'steel'),
    b(1.2, 0.45, 0.02, 0.1, 1.3, D / 2 - 0.12, 'glass'),
    b(0.3, 0.25, 0.05, -W / 2 + 0.3, 1.3, 0.17, 'screen'),
  ],
  'printer-row': (W, _H, D) =>
    range(4, -W / 2 + W / 8, W / 2 - W / 8).flatMap((x) => [
      b(W / 4 - 0.06, 0.75, D - 0.05, x, 0.375, 0, 'enamel'),
      b(W / 4 - 0.12, 0.85, D - 0.12, x, 1.18, 0, 'glass'),
      b(W / 4 - 0.1, 0.08, D - 0.1, x, 1.64, 0, 'graphite'),
      b(0.5, 0.02, 0.5, x, 0.8, 0, 'steel'),
      b(0.18, 0.12, 0.01, x + 0.2, 0.62, D / 2 - 0.02, 'screen'),
    ]),
  'tensile-tester': (W, H, D) => [
    b(W, 0.6, D, 0, 0.3, 0, 'enamel'),
    ...[-1, 1].map((s) => c(0.09, H - 0.75, s * 0.3, 0.6 + (H - 0.75) / 2, 0, 'steel')),
    b(0.8, 0.15, 0.3, 0, H - 0.08, 0, 'enamel'),
    b(0.72, 0.14, 0.26, 0, 1.75, 0, 'graphite'),
    b(0.1, 0.16, 0.1, 0, 1.05, 0, 'steel'),
    b(0.1, 0.16, 0.1, 0, 1.6, 0, 'steel'),
    b(0.3, 0.22, 0.03, W / 2 - 0.18, 1.2, D / 2 - 0.02, 'screen'),
  ],
  'shaker-table': (W, _H, D) => [
    b(W * 0.75, 0.7, D * 0.75, 0, 0.35, 0, 'graphite'),
    b(W * 0.6, 0.06, D * 0.6, 0, 0.73, 0, 'steel'),
    b(0.4, 0.5, 0.4, W / 2 - 0.22, 0.25, D / 2 - 0.22, 'enamel'),
  ],
  'fume-hood': (W, H, D) => [
    b(W, 0.85, D, 0, 0.425, 0, 'enamel'),
    b(W, 0.03, D, 0, 0.865, 0, 'epoxyTop'),
    ...[-1, 1].map((s) => b(0.08, 1.24, D, s * (W / 2 - 0.04), 1.5, 0, 'enamel')),
    b(W, H - 2.12, D, 0, (H + 2.12) / 2, 0, 'enamel'),
    b(W, 1.24, 0.04, 0, 1.5, -D / 2 + 0.02, 'enamel'),
    b(W - 0.16, 0.75, 0.02, 0, 1.55, D / 2 - 0.05, 'glass'),
    b(W - 0.3, 0.02, 0.25, 0, 2.08, 0, 'lightPanel'),
    b(0.1, 0.07, 0.01, W / 2 - 0.06, 1.95, D / 2 + 0.005, 'screen'),
  ],
  'microscope-station': (W, _H, D) => [
    b(W, 0.05, D, 0, 0.75, 0, 'epoxyTop'),
    ...legs(W, D, 0.73),
    b(0.25, 0.45, 0.35, -0.3, 1.0, -0.05, 'enamel'),
    b(0.1, 0.1, 0.2, -0.3, 1.28, 0.12, 'graphite'),
    ...monitor(0.4, 1.05, -0.2),
  ],
  'reflow-line': (W, H, D) => [
    b(1.4, H - 0.1, D, -W / 2 + 0.7, (H - 0.1) / 2, 0, 'enamel'),
    b(0.8, 0.02, 0.6, -W / 2 + 0.7, H - 0.09, 0, 'glass'),
    b(0.4, 0.1, 0.35, 0, 0.9, 0, 'steel'),
    b(1.4, 1.0, 0.8, W / 2 - 0.7, 0.5, 0, 'graphite'),
    b(1.3, 0.02, 0.6, W / 2 - 0.7, 1.01, 0, 'trim'),
    b(0.3, 0.2, 0.01, -W / 2 + 1.15, 1.05, D / 2 + 0.005, 'screen'),
    b(0.3, 0.2, 0.01, W / 2 - 0.3, 0.75, 0.405, 'screen'),
  ],
  'laminar-flow-bench': (W, H, D) => [
    ...legs(W, D, 0.84, 'aluminium'),
    b(W, 0.03, D, 0, 0.855, 0, 'steel'),
    b(W, 1.1, 0.04, 0, 1.42, -D / 2 + 0.02, 'enamel'),
    ...[-1, 1].map((s) => b(0.02, 1.1, D, s * (W / 2 - 0.01), 1.42, 0, 'glass')),
    b(W, 0.4, 0.02, 0, 1.75, D / 2 - 0.01, 'glass'),
    b(W, H - 1.97, D, 0, (H + 1.97) / 2, 0, 'enamel'),
    b(W - 0.2, 0.02, 0.2, 0, 1.95, 0, 'lightPanel'),
  ],
  'lithography-tool': (W, H, D) => [
    b(W, H, D - 0.3, 0, H / 2, -0.15, 'enamel'),
    b(0.8, 0.5, 0.02, -0.2, 1.25, D / 2 - 0.29, 'glass'),
    b(W, 0.75, 0.3, 0, 0.375, D / 2 - 0.15, 'graphite'),
    b(0.5, 0.35, 0.05, W / 2 - 0.35, 1.35, D / 2 - 0.27, 'screen'),
  ],
  'air-shower': (W, H, D) => [
    ...[-1, 1].map((s) => b(0.1, H, D, s * (W / 2 - 0.05), H / 2, 0, 'enamel')),
    b(W, 0.2, D, 0, H - 0.1, 0, 'enamel'),
    ...[-1, 1].map((s) => b(W - 0.2, 2.1, 0.03, 0, 1.05, s * (D / 2 - 0.015), 'glass')),
    b(0.15, 0.08, 0.01, W / 2 - 0.12, 1.6, D / 2 + 0.005, 'screen'),
  ],
  'motor-dyno': (W, _H, D) => [
    b(W, 0.25, D * 0.8, 0, 0.125, 0, 'graphite'),
    b(0.6, 0.5, 0.5, -0.8, 0.5, 0, 'enamel'),
    b(0.8, 0.6, 0.6, 0.7, 0.55, 0, 'enamel'),
    b(0.75, 0.06, 0.06, -0.12, 0.5, 0, 'steel'),
    b(W * 0.9, 0.9, 0.02, 0, 0.7, D / 2 - 0.08, 'glass'),
    b(0.4, 0.3, 0.05, W / 2 - 0.25, 1.2, D / 2 - 0.12, 'screen'),
    b(W, 0.006, 0.06, 0, 0.003, D / 2 - 0.03, 'floorMarking'),
  ],
  'battery-cabinet': (W, H, D) => [
    b(W, H, D, 0, H / 2, 0, 'graphite'),
    b(0.3, 0.1, 0.005, 0, H - 0.25, D / 2 + 0.003, 'safetyYellow'),
    b(0.5, 0.06, 0.005, 0, H - 0.45, D / 2 + 0.003, 'screen'),
  ],
  'switchgear-panel': (W, H, D) => [
    b(W, H, D, 0, H / 2, 0, 'enamel'),
    ...range(4, -W / 2 + W / 8, W / 2 - W / 8).flatMap((x) => [
      b(0.012, H - 0.2, 0.006, x + W / 8, H / 2, D / 2 + 0.003, 'trim'),
      b(0.18, 0.12, 0.006, x, 1.55, D / 2 + 0.003, 'screen'),
    ]),
  ],
  'optical-table': (W, _H, D) => [
    b(W, 0.25, D, 0, 0.775, 0, 'steel'),
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].map((sz) => c(0.26, 0.65, sx * (W / 2 - 0.25), 0.325, sz * (D / 2 - 0.25), 'graphite')),
    ),
    b(0.5, 0.12, 0.12, -W / 2 + 0.4, 0.96, -D / 2 + 0.35, 'enamel'),
    ...range(5, -0.8, 1.1).map((x, i) => c(0.03, 0.16, x, 0.98, i % 2 ? -0.2 : 0.15, 'graphite')),
    ...range(3, -0.4, 0.9).map((x) => b(0.06, 0.06, 0.02, x, 1.08, 0.15, 'aluminium')),
  ],
  'laser-enclosure': (W, H, D) => [
    b(W, 0.75, D, 0, 0.375, 0, 'graphite'),
    b(W, H - 0.75, D, 0, 0.75 + (H - 0.75) / 2, 0, 'graphite'),
    b(0.6, 0.25, 0.01, 0, 1.3, D / 2 + 0.005, 'trim'),
    b(0.12, 0.06, 0.01, W / 2 - 0.15, H - 0.15, D / 2 + 0.005, 'screen'),
    b(0.3, 0.1, 0.005, -W / 2 + 0.3, H - 0.15, D / 2 + 0.005, 'safetyYellow'),
  ],
  'bench-wind-tunnel': (W, _H, D) => [
    ...range(4, -W / 2 + 0.4, W / 2 - 0.4).flatMap((x) =>
      [-1, 1].map((s) => b(0.08, 0.5, 0.08, x, 0.25, s * 0.5, 'graphite')),
    ),
    b(1.6, 1.4, D - 0.2, -W / 2 + 0.8, 1.2, 0, 'enamel'),
    b(1.6, 0.6, 0.6, -W / 2 + 2.4, 1.2, 0, 'glass'),
    ...[-1, 1].flatMap((sy) =>
      [-1, 1].map((sz) => b(1.6, 0.04, 0.04, -W / 2 + 2.4, 1.2 + sy * 0.3, sz * 0.3, 'aluminium')),
    ),
    b(2.4, 0.9, 0.9, -W / 2 + 4.4, 1.2, 0, 'enamel'),
    b(1.4, 1.2, 1.2, W / 2 - 0.7, 1.2, 0, 'graphite'),
    b(0.3, 0.2, 0.05, -W / 2 + 2.4, 0.75, D / 2 - 0.1, 'screen'),
  ],
  'environmental-chamber': (W, H, D) => [
    b(W - 0.6, H - 0.1, D, -0.3, (H - 0.1) / 2 + 0.1, 0, 'enamel'),
    b(0.6, H - 0.4, D, W / 2 - 0.3, (H - 0.4) / 2 + 0.1, 0, 'graphite'),
    b(W, 0.1, D, 0, 0.05, 0, 'graphite'),
    b(1.2, 1.8, 0.04, -0.3, 1.1, D / 2 + 0.02, 'enamel'),
    b(0.4, 0.4, 0.02, -0.3, 1.45, D / 2 + 0.045, 'glass'),
    b(0.3, 0.22, 0.02, W / 2 - 0.3, 1.5, D / 2 + 0.01, 'screen'),
  ],
  'daq-console': (W, _H, D) => [
    b(W, 0.04, D, 0, 0.74, 0, 'worktop'),
    ...[-1, 1].map((s) => b(0.45, 0.72, D - 0.1, s * (W / 2 - 0.25), 0.36, 0, 'enamel')),
    ...[-0.7, 0, 0.7].flatMap((x) => monitor(x, 1.02, -0.25, 0.6)),
  ],
  'large-format-plotter': (W, _H, D) => [
    b(W, 0.35, 0.45, 0, 0.95, -0.1, 'graphite'),
    ...[-1, 1].map((s) => b(0.06, 0.78, 0.5, s * (W / 2 - 0.05), 0.39, -0.1, 'aluminium')),
    b(W * 0.9, 0.01, 0.35, 0, 0.6, D / 2 - 0.2, 'worktop'),
    b(0.2, 0.1, 0.006, W / 2 - 0.25, 1.05, 0.125, 'screen'),
  ],
  conveyor: (W, _H, D) => [
    b(W, 0.06, D, 0, 0.87, 0, 'rubber'),
    ...[-1, 1].map((s) => b(W, 0.1, 0.04, 0, 0.82, s * (D / 2 - 0.02), 'aluminium')),
    ...range(Math.max(2, Math.round(W / 1.5) + 1), -W / 2 + 0.1, W / 2 - 0.1).flatMap((x) =>
      [-1, 1].map((s) => b(0.05, 0.77, 0.05, x, 0.385, s * (D / 2 - 0.05), 'graphite')),
    ),
  ],
  'mocap-truss': (W, H, D) => [
    ...[-W / 2, 0, W / 2].flatMap((x) =>
      [-1, 1].map((s) =>
        b(0.25, H, 0.25, x + (x < 0 ? 0.125 : x > 0 ? -0.125 : 0), H / 2, s * (D / 2 - 0.125), 'steel'),
      ),
    ),
    ...[-1, 1].map((s) => b(W, 0.3, 0.3, 0, H - 0.15, s * (D / 2 - 0.15), 'steel')),
    ...[-1, 1].map((s) => b(0.3, 0.3, D, s * (W / 2 - 0.15), H - 0.15, 0, 'steel')),
    ...range(8, -W / 2 + 1, W / 2 - 1).flatMap((x) =>
      [-1, 1].map((s) => b(0.15, 0.12, 0.2, x, H - 0.4, s * (D / 2 - 0.15), 'graphite')),
    ),
    ...range(6, -D / 2 + 1.5, D / 2 - 1.5).flatMap((z) =>
      [-1, 1].map((s) => b(0.2, 0.12, 0.15, s * (W / 2 - 0.15), H - 0.4, z, 'graphite')),
    ),
    ...range(Math.floor(W / 2) + 1, -W / 2 + 0.5, W / 2 - 0.5).map((x) =>
      b(0.025, 0.004, D - 1, x, 0.002, 0, 'trim'),
    ),
    ...range(Math.floor(D / 2) + 1, -D / 2 + 0.5, D / 2 - 0.5).map((z) =>
      b(W - 1, 0.004, 0.025, 0, 0.002, z, 'trim'),
    ),
  ],
  'water-tank': (W, H, D) => [
    b(W, 0.1, D, 0, 0.05, 0, 'concrete'),
    b(W, 2.2, 0.06, 0, 1.2, D / 2 - 0.03, 'glass'),
    b(W, 2.2, 0.2, 0, 1.2, -D / 2 + 0.1, 'concrete'),
    ...[-1, 1].map((s) => b(0.2, 2.2, D - 0.06, s * (W / 2 - 0.1), 1.2, -0.03, 'concrete')),
    b(W - 0.4, 1.9, D - 0.3, 0, 1.05, -0.05, 'water'),
    b(W, 0.06, 0.25, 0, 2.33, D / 2 - 0.125, 'aluminium'),
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].map((sz) => b(0.25, H, 0.25, sx * (W / 2 - 0.125), H / 2, sz * (D / 2 - 0.125), 'steel')),
    ),
    ...[-1, 1].map((s) => b(W, 0.25, 0.25, 0, H - 0.125, s * (D / 2 - 0.125), 'steel')),
    b(0.35, 0.3, D - 0.5, 1.5, H - 0.15, 0, 'safetyYellow'),
    b(0.4, 0.4, 0.4, 1.5, H - 0.5, 0, 'graphite'),
  ],
  'wind-tunnel': (W, H, D) => {
    const y = 2.1;
    return [
      ...range(6, -W / 2 + 1, W / 2 - 1).flatMap((x) => [
        b(0.3, 0.9, 0.3, x, 0.45, 1.2, 'graphite'),
        b(0.3, 0.9, 0.3, x, 0.45, -1.3, 'graphite'),
      ]),
      b(3, 3.0, 2.0, -5.5, y, 1.2, 'enamel'),
      b(3, 1.4, 1.4, -2.5, y, 1.2, 'glass'),
      ...[-1, 1].flatMap((sy) =>
        [-1, 1].map((sz) => b(3, 0.05, 0.05, -2.5, y + sy * 0.7, 1.2 + sz * 0.7, 'aluminium')),
      ),
      b(4.5, 2.0, 1.8, 1.25, y, 1.2, 'enamel'),
      b(W - 4, 2.4, 1.6, 0, y, -1.3, 'enamel'),
      b(2.2, 2.8, 2.0, 4.5, y, -1.3, 'graphite'),
      ...[-1, 1].map((s) => b(2, 3.2, D, s * (W / 2 - 1), y, 0, 'enamel')),
      b(0.5, 0.35, 0.05, -2.5, 1.0, D / 2 - 0.05, 'screen'),
    ].map((p) =>
      p.pos[1] + p.size[1] / 2 > H
        ? { ...p, size: [p.size[0], H - (p.pos[1] - p.size[1] / 2), p.size[2]] as [number, number, number] }
        : p,
    );
  },
  'projection-cave': (W, H, D) => [
    b(W, 0.02, D, 0, 0.01, 0, 'worktop'),
    b(W, H - 0.3, 0.05, 0, (H - 0.3) / 2, -D / 2 + 0.025, 'screen'),
    ...[-1, 1].map((s) => b(0.05, H - 0.3, D - 0.05, s * (W / 2 - 0.025), (H - 0.3) / 2, 0.025, 'screen')),
    ...frameBox(W, H, D, 0, 'steel', 0.12).slice(4),
    ...[-W / 3, W / 3].map((x) => b(0.4, 0.22, 0.4, x, H - 0.25, D / 2 - 0.3, 'graphite')),
  ],
  'terrain-course': (W, H, D) => [
    ...range(5, -W / 2 + 0.6, -W / 2 + 3.0).map((x, i) =>
      b(0.6, 0.15 * (i + 1), 3, x, 0.075 * (i + 1), -D / 2 + 1.8, 'concrete'),
    ),
    b(4, 0.1, 4, 1.5, 0.05, -D / 2 + 2.2, 'trim'),
    b(4, 0.05, 3.5, -2.5, 0.025, D / 2 - 2.2, 'fabric'),
    b(2, 0.02, 1.5, 3.5, 0.01, D / 2 - 2.0, 'water'),
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].map((sz) => b(0.25, H, 0.25, sx * (W / 2 - 0.125), H / 2, sz * (D / 2 - 0.125), 'steel')),
    ),
    ...[-1, 1].map((s) => b(W, 0.2, 0.2, 0, H - 0.1, s * (D / 2 - 0.125), 'steel')),
    ...range(4, -W / 2 + 1.5, W / 2 - 1.5).map((x) => b(0.15, 0.15, D, x, H - 0.1, 0, 'steel')),
    ...range(4, -D / 2 + 1.5, D / 2 - 1.5).map((z) => b(W - 0.6, 0.05, 0.05, 0, H - 0.35, z, 'aluminium')),
  ],
  'control-desk': (W, _H, D) => [
    b(W, 0.04, D, 0, 0.74, 0, 'worktop'),
    b(W, 0.7, 0.4, 0, 0.35, -D / 2 + 0.2, 'graphite'),
    ...range(4, -W / 2 + 0.6, W / 2 - 0.6).flatMap((x) => monitor(x, 1.02, -0.3, 0.6)),
  ],
};

/** Parts of a furnishing, transformed into its zone frame. Unknown types render nothing. */
export function furnishingParts(f: Furnishing): Part[] {
  if (!isFurnishingType(f.type)) return [];
  const [W, H, D] = f.size ?? FURNISHING_TYPES[f.type].sizeM;
  const cos = Math.cos(f.yaw);
  const sin = Math.sin(f.yaw);
  return RECIPES[f.type](W, H, D).map((p) => ({
    ...p,
    pos: [
      f.position[0] + p.pos[0] * cos + p.pos[2] * sin,
      f.position[1] + p.pos[1],
      f.position[2] - p.pos[0] * sin + p.pos[2] * cos,
    ],
    yaw: (p.yaw ?? 0) + f.yaw,
  }));
}

export const FIXTURE_TYPES_WITH_RECIPES = Object.keys(RECIPES) as FurnishingTypeId[];

/** Groups parts by (shape, material) → one instanced draw call per group. Not pickable. */
export function groupParts(parts: readonly Part[]) {
  const groups = new Map<string, { shape: Part['shape']; m: Part['m']; placements: FixturePlacement[] }>();
  for (const p of parts) {
    const key = `${p.shape}|${materialKey(MATERIALS[p.m])}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { shape: p.shape, m: p.m, placements: [] }));
    g.placements.push({ position: p.pos, yaw: p.yaw ?? 0, scale: p.size });
  }
  return [...groups.entries()].map(([key, g]) => ({ key, ...g }));
}
