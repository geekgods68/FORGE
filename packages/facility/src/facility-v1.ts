import { FURNISHING_TYPES, type FurnishingTypeId } from './furnishings';
import type { Equipment, Facility, Furnishing, PlacementArea, Portal, Zone } from './schemas';

/**
 * FORGE facility content (schema v1), revision 2 — read-only, shipped with the app.
 *
 * Site plan (facility frame F, metres, +Y up, −Z "north"):
 *
 *   z = −7.5   Wing E labs 21 · 20 · 22 (north of Corridor E)
 *   z =  0     Corridor E (datum; unchanged since revision 1)
 *   z = 16     Wing A corridor — labs 1–4 north, lab 5 south
 *   z = 44     Wing B corridor — labs 6–9 north
 *   z = 72     Wing C corridor — labs 10–13 north, lab 14 south
 *   z = 100    Wing D corridor — labs 15–18 north, lab 19 south
 *   z = 116    Environments corridor — six 24 × 24 m environments south
 *   x ∈ [−2, 2] Central concourse: five segments joining the corridors above.
 *
 * Every lab is 18 × 12 m (zone frame ±9 × ±6) with its door at local (0, 0, +6), so
 * labs south of a corridor use yaw π. Portals are generated in pairs (lab ↔ corridor),
 * guaranteeing reciprocity. Revision 1 identities (Lab 20, Corridor E, all zone ids,
 * equipment) are unchanged, so layouts authored against revision 1 stay valid.
 */

export const CENTRAL_WORKSHOP_ID = 'lab-20-central-conjuring-workshop';
export const CORRIDOR_E_ID = 'corridor-e-main';

const LAB_HALF: [number, number] = [9, 6];
const ENV_HALF: [number, number] = [12, 12];
const LAB_X = [-31, -11.5, 11.5, 31];
const CORRIDOR_H = 3.5;
const DOOR = { widthM: 2, heightM: 2.6 };
const ENV_DOOR = { widthM: 4, heightM: 3.2 };
const SPINE_W = 4;

// ------------------------------------------------------------ furnishing helpers

type F = Furnishing;
const size = (t: FurnishingTypeId, s?: [number, number, number]) => s ?? FURNISHING_TYPES[t].sizeM;
const GAP = 0.15;
/** Against the back wall (local −z), facing into the room. */
const back = (t: FurnishingTypeId, x: number, s?: [number, number, number], half = LAB_HALF): F => {
  const d = size(t, s)[2];
  const inset = 'wallMounted' in FURNISHING_TYPES[t] ? 0.01 : GAP;
  return { type: t, position: [x, 0, -half[1] + d / 2 + inset], yaw: 0, ...(s ? { size: s } : {}) };
};
/** Against the front (door) wall, facing in. */
const front = (t: FurnishingTypeId, x: number, s?: [number, number, number], half = LAB_HALF): F => {
  const d = size(t, s)[2];
  const inset = 'wallMounted' in FURNISHING_TYPES[t] ? 0.01 : GAP;
  return { type: t, position: [x, 0, half[1] - d / 2 - inset], yaw: Math.PI, ...(s ? { size: s } : {}) };
};
/** Against the left (−x) wall, facing +x. */
const left = (t: FurnishingTypeId, z: number, half = LAB_HALF): F => {
  const d = size(t)[2];
  const inset = 'wallMounted' in FURNISHING_TYPES[t] ? 0.01 : GAP;
  return { type: t, position: [-half[0] + d / 2 + inset, 0, z], yaw: Math.PI / 2 };
};
/** Against the right (+x) wall, facing −x. */
const right = (t: FurnishingTypeId, z: number, half = LAB_HALF): F => {
  const d = size(t)[2];
  const inset = 'wallMounted' in FURNISHING_TYPES[t] ? 0.01 : GAP;
  return { type: t, position: [half[0] - d / 2 - inset, 0, z], yaw: -Math.PI / 2 };
};
const at = (t: FurnishingTypeId, x: number, z: number, yaw = 0, s?: [number, number, number]): F => ({
  type: t,
  position: [x, 0, z],
  yaw,
  ...(s ? { size: s } : {}),
});

const BENCH_FLOOR: PlacementArea = {
  id: 'bench-floor',
  name: 'Bench floor',
  rect: { min: [-5.4, -2.6], max: [5.4, 3.6] },
  allowedCategories: ['workbench', 'storage', 'instrument'],
};

// ------------------------------------------------------------ zone builders

interface LabSpec {
  n: number;
  id: string;
  name: string;
  discipline: string;
  summary: string;
  furnishings: F[];
  placementAreas?: PlacementArea[];
  ceilingHeightM?: number;
}

/** A laboratory zone whose door (local +z wall) opens onto `corridor` at facility point (x, cz ± 1.5). */
function lab(
  spec: LabSpec,
  wingId: string,
  corridorId: string,
  x: number,
  corridorZ: number,
  side: 'north' | 'south',
): Zone {
  const z = side === 'north' ? corridorZ - 1.5 - LAB_HALF[1] : corridorZ + 1.5 + LAB_HALF[1];
  return {
    id: spec.id,
    name: spec.name,
    kind: 'laboratory',
    labNumber: spec.n,
    wingId,
    status: 'implemented',
    pose: { position: [x, 0, z], yaw: side === 'north' ? 0 : Math.PI },
    footprint: { min: [-LAB_HALF[0], -LAB_HALF[1]], max: [LAB_HALF[0], LAB_HALF[1]] },
    ceilingHeightM: spec.ceilingHeightM ?? 4.5,
    portals: [
      { id: `p${spec.n}-door`, toZoneId: corridorId, position: [0, 0, LAB_HALF[1]], ...DOOR, open: true },
    ],
    placementAreas: spec.placementAreas ?? [BENCH_FLOOR],
    moduleKey: 'lab-room',
    summary: spec.summary,
    discipline: spec.discipline,
    furnishings: spec.furnishings,
  };
}

function corridor(
  id: string,
  name: string,
  wingId: string,
  z: number,
  halfX: number,
  furnishings: F[],
  summary: string,
): Zone {
  return {
    id,
    name,
    kind: 'corridor',
    labNumber: null,
    wingId,
    status: 'implemented',
    pose: { position: [0, 0, z], yaw: 0 },
    footprint: { min: [-halfX, -1.5], max: [halfX, 1.5] },
    ceilingHeightM: CORRIDOR_H,
    portals: [],
    placementAreas: [],
    moduleKey: 'corridor',
    summary,
    discipline: 'Circulation',
    furnishings,
  };
}

/** Zone-frame point of a facility point for a yaw-0 or yaw-π zone. */
function toLocal(zone: Zone, p: [number, number, number]): [number, number, number] {
  const [x0, , z0] = zone.pose.position;
  const c = Math.round(Math.cos(zone.pose.yaw));
  const dx = p[0] - x0;
  const dz = p[2] - z0;
  return [+(c * dx).toFixed(9), 0, +(c * dz).toFixed(9)];
}
function toFacility(zone: Zone, p: readonly [number, number, number]): [number, number, number] {
  const [x0, , z0] = zone.pose.position;
  const c = Math.round(Math.cos(zone.pose.yaw));
  return [+(x0 + c * p[0]).toFixed(9), 0, +(z0 + c * p[2]).toFixed(9)];
}

/** Adds the reciprocal portal for each of `a`'s portals that leads into `b`. */
function mirrorPortals(a: Zone, b: Zone) {
  for (const p of a.portals.filter((q) => q.toZoneId === b.id)) {
    const back: Portal = {
      ...p,
      id: `${b.id}--${a.id}`,
      toZoneId: a.id,
      position: toLocal(b, toFacility(a, p.position)),
    };
    if (
      !b.portals.some(
        (q) => q.toZoneId === a.id && q.position.every((v, i) => Math.abs(v - back.position[i]!) < 1e-9),
      )
    )
      b.portals.push(back);
  }
}

// ------------------------------------------------------------ Wing E (revision 1 slice + 21/22)

const centralWorkshop: Zone = {
  id: CENTRAL_WORKSHOP_ID,
  name: 'Central Conjuring & Integration Workshop',
  kind: 'laboratory',
  labNumber: 20,
  wingId: 'wing-e',
  status: 'implemented',
  pose: { position: [0, 0, -7.5], yaw: 0 },
  footprint: { min: [-9, -6], max: [9, 6] }, // 18 m × 12 m interior
  ceilingHeightM: 4.5,
  portals: [
    { id: 'p20-south', toZoneId: CORRIDOR_E_ID, position: [0, 0, 6], widthM: 3, heightM: 3, open: true },
  ],
  placementAreas: [
    {
      id: 'bench-floor',
      name: 'Bench floor',
      // Keeps 0.8 m from side/back walls and 1.8 m clear in front of the corridor door.
      rect: { min: [-8.2, -5.2], max: [8.2, 4.2] },
      allowedCategories: ['workbench', 'storage', 'instrument'],
    },
    {
      id: 'conjuring-dais',
      name: 'Conjuring dais',
      rect: { min: [-1.5, -1.5], max: [1.5, 1.5] },
      allowedCategories: ['fixture'],
    },
  ],
  moduleKey: 'central-workshop',
  summary:
    'Integration hub where components are conjured, assembled and staged. Configurable workbenches; projects mount on bench work surfaces.',
  discipline: 'Integration · assembly · staging',
  furnishings: [
    at('storage-wall', -3, -5.55),
    at('storage-wall', 3, -5.55),
    at('whiteboard', -8.96, -1.5, Math.PI / 2),
    at('display-wall', 8.8, -1.5, -Math.PI / 2),
  ],
};

const corridorE: Zone = {
  ...corridor(
    CORRIDOR_E_ID,
    'Wing E Main Corridor',
    'wing-e',
    0,
    27,
    [at('directory-kiosk', 3.3, 1.25, Math.PI)],
    'Circulation spine of Wing E. Architecture only — no configurable equipment.',
  ),
  moduleKey: 'corridor-e',
  portals: [
    { id: 'pc-20', toZoneId: CENTRAL_WORKSHOP_ID, position: [0, 0, -1.5], widthM: 3, heightM: 3, open: true },
  ],
};

const WING_E_LABS: { spec: LabSpec; x: number }[] = [
  {
    x: -18,
    spec: {
      n: 21,
      id: 'lab-21-research-validation',
      name: 'Research Experimentation & Validation Centre',
      discipline: 'Test campaigns · verification · data acquisition',
      summary: 'Instrumented test cells for validating designs against requirements.',
      furnishings: [
        back('environmental-chamber', -5),
        back('shaker-table', -2),
        back('daq-console', 1.5),
        back('server-rack-row', 5.5),
        left('electronics-bench', 0.5),
        right('desk-cluster', 0.5),
        front('storage-wall', -5),
        front('whiteboard', 5),
      ],
    },
  },
  {
    x: 18,
    spec: {
      n: 22,
      id: 'lab-22-documentation-review',
      name: 'Engineering Documentation & Design Review Studio',
      discipline: 'Design reviews · drawings · technical documentation',
      summary: 'Review displays, drawing output and collaborative documentation space.',
      furnishings: [
        back('display-wall', -3),
        back('display-wall', 3),
        back('large-format-plotter', 7),
        left('desk-cluster', 0.5),
        right('desk-cluster', 0.5),
        front('meeting-table', -5),
        front('storage-wall', 5),
      ],
    },
  },
];

// ------------------------------------------------------------ Wings A–D

interface WingRow {
  wingId: string;
  letter: string;
  z: number;
  north: LabSpec[];
  south: LabSpec[];
}

const WINGS: WingRow[] = [
  {
    wingId: 'wing-a',
    letter: 'A',
    z: 16,
    north: [
      {
        n: 1,
        id: 'lab-01-central-intelligence',
        name: 'Central Intelligence Research Lab',
        discipline: 'Machine learning · model training · reasoning systems',
        summary: 'Compute-backed research floor for learning and reasoning systems.',
        furnishings: [
          back('server-rack-row', -4.2),
          back('gpu-cluster', 3.6),
          back('storage-wall', 6.6),
          left('desk-cluster', 0.5),
          right('desk-cluster', 0.5),
          front('meeting-table', -5),
          front('display-wall', 5),
        ],
      },
      {
        n: 2,
        id: 'lab-02-computer-vision',
        name: 'Computer Vision & Perception Lab',
        discipline: 'Cameras · calibration · perception datasets',
        summary: 'Camera rigs and calibration targets for perception research.',
        furnishings: [
          back('camera-rig', -4.5),
          back('display-wall', 2),
          back('storage-wall', 6.6),
          left('desk-cluster', 0.5),
          right('electronics-bench', 0.5),
          front('whiteboard', -5),
          front('gpu-cluster', 5),
        ],
      },
      {
        n: 3,
        id: 'lab-03-autonomous-robot-learning',
        name: 'Autonomous Systems & Robot Learning Lab',
        discipline: 'Robot learning · autonomy · sim-to-real',
        summary: 'Guarded robot cells with on-site compute for learning experiments.',
        furnishings: [
          back('robot-arm-cell', -5.5),
          back('robot-arm-cell', -2.5),
          back('gpu-cluster', 3.6),
          back('storage-wall', 6.6),
          left('desk-cluster', 0.5),
          right('electronics-bench', 1),
          front('whiteboard', -5),
          front('meeting-table', 5),
        ],
      },
      {
        n: 4,
        id: 'lab-04-research-computing',
        name: 'Research Computing & Systems Lab',
        discipline: 'HPC · distributed systems · research infrastructure',
        summary: 'Server rows and systems engineering workspace.',
        furnishings: [
          back('server-rack-row', -4.2),
          back('server-rack-row', 3),
          back('switchgear-panel', 7.3),
          left('desk-cluster', 0.5),
          right('desk-cluster', 0.5),
          front('display-wall', -5),
          front('storage-wall', 5),
        ],
      },
    ],
    south: [
      {
        n: 5,
        id: 'lab-05-human-ai-immersive',
        name: 'Human–AI Interaction & Immersive Lab',
        discipline: 'Human factors · immersive interfaces · user studies',
        summary: 'Tracked interaction space and observation area for user studies.',
        placementAreas: [{ ...BENCH_FLOOR, rect: { min: [-5.4, -1.6], max: [5.4, 3.6] } }],
        furnishings: [
          back('vr-tracking-space', -3.2),
          back('display-wall', 3),
          back('storage-wall', 6.9),
          left('desk-cluster', 1.5),
          right('desk-cluster', 1),
          front('meeting-table', -5),
          front('whiteboard', 5),
        ],
      },
    ],
  },
  {
    wingId: 'wing-b',
    letter: 'B',
    z: 44,
    north: [
      {
        n: 6,
        id: 'lab-06-robotic-manipulation',
        name: 'Robotic Manipulation Laboratory',
        discipline: 'Manipulators · grasping · end effectors',
        summary: 'Three guarded manipulator cells with fixture and tooling benches.',
        furnishings: [
          back('robot-arm-cell', -5),
          back('robot-arm-cell', -2),
          back('robot-arm-cell', 1),
          back('electronics-bench', 5.2),
          left('control-rig', 0.5),
          right('desk-cluster', 0.5),
          front('storage-wall', -5),
          front('whiteboard', 5),
        ],
      },
      {
        n: 7,
        id: 'lab-07-mobile-robotics',
        name: 'Mobile Robotics & Navigation Arena',
        discipline: 'Mobile robots · localisation · navigation',
        summary: 'Walled floor arena with charging docks; benches along both sides.',
        ceilingHeightM: 6,
        placementAreas: [
          {
            ...BENCH_FLOOR,
            id: 'bench-west',
            name: 'West benches',
            rect: { min: [-8.3, -5.2], max: [-4.4, 3.6] },
          },
          {
            ...BENCH_FLOOR,
            id: 'bench-east',
            name: 'East benches',
            rect: { min: [4.4, -5.2], max: [8.3, 3.6] },
          },
        ],
        furnishings: [
          at('mobile-robot-arena', 0, -1.5),
          back('charging-dock', -2),
          back('charging-dock', 0),
          back('charging-dock', 2),
          front('desk-cluster', 4.5),
          front('storage-wall', -4.5),
        ],
      },
      {
        n: 8,
        id: 'lab-08-embedded-systems',
        name: 'Embedded Systems & Computer Engineering Lab',
        discipline: 'Microcontrollers · firmware · hardware-in-the-loop',
        summary: 'Instrumented electronics benches for embedded development.',
        furnishings: [
          back('electronics-bench', -5.5),
          back('electronics-bench', -2.7),
          back('electronics-bench', 0.2),
          back('storage-wall', 5),
          left('electronics-bench', 0.5),
          right('desk-cluster', 0.5),
          front('reflow-line', -5),
          front('whiteboard', 5),
        ],
      },
      {
        n: 9,
        id: 'lab-09-sensors-controls',
        name: 'Sensors, Controls & Instrumentation Lab',
        discipline: 'Sensing · control loops · instrumentation',
        summary: 'Control test rigs, vibration table and acquisition benches.',
        furnishings: [
          back('control-rig', -5),
          back('control-rig', -2.6),
          back('electronics-bench', 1.5),
          back('shaker-table', 5.5),
          left('electronics-bench', 0.5),
          right('desk-cluster', 0.5),
          front('storage-wall', -5),
          front('daq-console', 5),
        ],
      },
    ],
    south: [],
  },
  {
    wingId: 'wing-c',
    letter: 'C',
    z: 72,
    north: [
      {
        n: 10,
        id: 'lab-10-mechanical-design',
        name: 'Mechanical Design & Assembly Studio',
        discipline: 'CAD · mechanism design · assembly',
        summary: 'Design desks, review display and assembly benches.',
        furnishings: [
          back('wall-bench', -5),
          back('wall-bench', -1.5),
          back('display-wall', 3),
          back('storage-wall', 7),
          left('desk-cluster', 0.5),
          right('desk-cluster', 0.5),
          front('meeting-table', -5),
          front('whiteboard', 5),
        ],
      },
      {
        n: 11,
        id: 'lab-11-precision-fabrication',
        name: 'Precision Fabrication & Machine Shop',
        discipline: 'Machining · tooling · precision fabrication',
        summary: 'CNC machining centres and lathes with tooling storage.',
        furnishings: [
          back('cnc-mill', -5.5),
          back('cnc-mill', -2),
          back('lathe', 2),
          back('storage-wall', 6),
          left('wall-bench', 0.5),
          right('lathe', 0.5),
          front('flammables-cabinet', -5),
          front('storage-wall', 5),
        ],
      },
      {
        n: 12,
        id: 'lab-12-additive-manufacturing',
        name: 'Advanced Additive Manufacturing Centre',
        discipline: 'Additive manufacturing · materials · post-processing',
        summary: 'Printer rows, fume extraction and post-processing.',
        furnishings: [
          back('printer-row', -4),
          back('printer-row', 1),
          back('fume-hood', 6),
          left('printer-row', 0.5),
          right('desk-cluster', 0.5),
          front('flammables-cabinet', -5),
          front('storage-wall', 5),
        ],
      },
      {
        n: 13,
        id: 'lab-13-materials-testing',
        name: 'Materials Science & Mechanical Testing Lab',
        discipline: 'Material properties · mechanical testing · microscopy',
        summary: 'Universal testing machines, microscopy and sample preparation.',
        furnishings: [
          back('tensile-tester', -6),
          back('tensile-tester', -3.5),
          back('fume-hood', 0),
          back('microscope-station', 3.5),
          back('microscope-station', 6.5),
          left('wall-bench', 0.5),
          right('desk-cluster', 0.5),
          front('flammables-cabinet', -5),
          front('storage-wall', 5),
        ],
      },
    ],
    south: [
      {
        n: 14,
        id: 'lab-14-structures-multiphysics',
        name: 'Structures, Dynamics & Multiphysics Lab',
        discipline: 'Structural dynamics · coupled physics · test correlation',
        summary: 'Vibration and load testing alongside simulation compute.',
        furnishings: [
          back('shaker-table', -5),
          back('tensile-tester', -2.5),
          back('server-rack-row', 2.2),
          back('storage-wall', 7),
          left('control-rig', 0.5),
          right('desk-cluster', 0.5),
          front('display-wall', -5),
          front('whiteboard', 5),
        ],
      },
    ],
  },
  {
    wingId: 'wing-d',
    letter: 'D',
    z: 100,
    north: [
      {
        n: 15,
        id: 'lab-15-electronics-pcb',
        name: 'Electronics & PCB Engineering Lab',
        discipline: 'Circuit design · PCB assembly · rework',
        summary: 'Assembly line, rework benches and extraction.',
        furnishings: [
          back('reflow-line', -4.5),
          back('electronics-bench', -0.5),
          back('electronics-bench', 2.5),
          back('fume-hood', 6.5),
          left('electronics-bench', 0.5),
          right('electronics-bench', 0.5),
          front('storage-wall', -5),
          front('desk-cluster', 5),
        ],
      },
      {
        n: 16,
        id: 'lab-16-cleanroom',
        name: 'Microelectronics & Nanofabrication Cleanroom',
        discipline: 'Lithography · thin films · cleanroom processing',
        summary: 'Cleanroom bays with lithography, clean benches and gowning air shower.',
        furnishings: [
          back('lithography-tool', -5),
          back('laminar-flow-bench', -2),
          back('laminar-flow-bench', 1),
          back('fume-hood', 4),
          back('microscope-station', 7),
          left('storage-wall', 0.5),
          right('microscope-station', 0.5),
          front('air-shower', -4),
          front('storage-wall', 4),
        ],
      },
      {
        n: 17,
        id: 'lab-17-power-energy',
        name: 'Power, Energy & Electric Machines Lab',
        discipline: 'Power electronics · energy storage · electric machines',
        summary: 'Motor dynamometer, battery cabinets and switchgear.',
        furnishings: [
          back('motor-dyno', -5),
          back('battery-cabinet', -1),
          back('battery-cabinet', 1),
          back('switchgear-panel', 4.5),
          left('control-rig', 0.5),
          right('desk-cluster', 0.5),
          front('electronics-bench', -5),
          front('storage-wall', 5),
        ],
      },
      {
        n: 18,
        id: 'lab-18-photonics-optics',
        name: 'Photonics, Imaging & Optics Lab',
        discipline: 'Optics · lasers · imaging',
        summary: 'Isolated optical tables and laser enclosures.',
        furnishings: [
          back('optical-table', -5),
          back('optical-table', -1),
          back('laser-enclosure', 3),
          back('storage-wall', 6.5),
          left('optical-table', 0.5),
          right('desk-cluster', 0.5),
          front('microscope-station', -5),
          front('whiteboard', 5),
        ],
      },
    ],
    south: [
      {
        n: 19,
        id: 'lab-19-aerospace-fluid',
        name: 'Aerospace, Fluid & Environmental Test Arena',
        discipline: 'Aerodynamics · fluids · environmental testing',
        summary: 'Bench-scale wind tunnel, environmental chamber and acquisition.',
        ceilingHeightM: 6,
        furnishings: [
          back('bench-wind-tunnel', -3.5),
          back('environmental-chamber', 3),
          back('fume-hood', 6.8),
          left('daq-console', 0.5),
          right('control-rig', 0.5),
          front('storage-wall', -5),
          front('desk-cluster', 5),
        ],
      },
    ],
  },
];

// ------------------------------------------------------------ environments

const ENV_CORRIDOR_ID = 'corridor-environments';
const ENV_CORRIDOR_Z = 116;
const ENV_X = [-65, -39, -13, 13, 39, 65];
const OPERATOR = (rect: PlacementArea['rect']): PlacementArea[] => [
  {
    id: 'operator-floor',
    name: 'Operator floor',
    rect,
    allowedCategories: ['workbench', 'storage', 'instrument'],
  },
];
const desk = at('control-desk', -6, 12 - 0.6 - GAP - 1.2, Math.PI);

interface EnvSpec {
  id: string;
  name: string;
  discipline: string;
  summary: string;
  furnishings: F[];
  placementAreas: PlacementArea[];
}
const ENVIRONMENTS: EnvSpec[] = [
  {
    id: 'env-robotic-manipulation-arena',
    name: 'Robotic Manipulation Arena',
    discipline: 'Configurable environment · multi-robot manipulation',
    summary: 'High bay with a conveyor line and six guarded manipulator cells.',
    furnishings: [
      at('conveyor', 0, -4, 0, [12, 0.9, 0.8]),
      ...[-4, 0, 4].flatMap((x) => [at('robot-arm-cell', x, -6.6), at('robot-arm-cell', x, -1.4, Math.PI)]),
      desk,
    ],
    placementAreas: OPERATOR({ min: [2.5, 2], max: [10.5, 9.5] }),
  },
  {
    id: 'env-motion-capture-navigation',
    name: 'Motion Capture & Navigation Arena',
    discipline: 'Configurable environment · tracked navigation',
    summary: 'Open floor under a motion-capture camera truss.',
    furnishings: [
      at('mocap-truss', 0, -3),
      at('charging-dock', 5, 10.4, Math.PI),
      at('charging-dock', 7, 10.4, Math.PI),
      desk,
    ],
    placementAreas: OPERATOR({ min: [2.5, 5], max: [10.5, 9.6] }),
  },
  {
    id: 'env-underwater-tank',
    name: 'Underwater Robotics Tank',
    discipline: 'Configurable environment · underwater robotics',
    summary: 'Glass-walled test tank with an overhead gantry.',
    furnishings: [at('water-tank', 0, -4), desk],
    placementAreas: OPERATOR({ min: [2.5, 2], max: [10.5, 9.5] }),
  },
  {
    id: 'env-wind-tunnel-bay',
    name: 'Aerodynamics & Wind Tunnel Bay',
    discipline: 'Configurable environment · aerodynamics',
    summary: 'Closed-return wind tunnel with a glazed test section.',
    furnishings: [at('wind-tunnel', 0, -6), desk],
    placementAreas: OPERATOR({ min: [2.5, 0], max: [10.5, 9.5] }),
  },
  {
    id: 'env-immersive-design-chamber',
    name: 'Immersive Design Chamber',
    discipline: 'Configurable environment · immersive design review',
    summary: 'Three-wall projection CAVE and a large review display.',
    furnishings: [at('projection-cave', 0, -4), at('display-wall', 0, -11.7, 0, [12, 4, 0.3]), desk],
    placementAreas: OPERATOR({ min: [2.5, 0.5], max: [10.5, 9.5] }),
  },
  {
    id: 'env-real-world-simulator',
    name: 'Real-World Environment Simulator',
    discipline: 'Configurable environment · terrain & weather conditions',
    summary: 'Modular terrain course under an overhead weather-effects truss.',
    furnishings: [at('terrain-course', 0, -4), desk],
    placementAreas: OPERATOR({ min: [2.5, 2], max: [10.5, 9.5] }),
  },
];

function environment(spec: EnvSpec, x: number): Zone {
  return {
    id: spec.id,
    name: spec.name,
    kind: 'environment',
    labNumber: null,
    wingId: 'wing-e',
    status: 'implemented',
    pose: { position: [x, 0, ENV_CORRIDOR_Z + 1.5 + ENV_HALF[1]], yaw: Math.PI },
    footprint: { min: [-ENV_HALF[0], -ENV_HALF[1]], max: [ENV_HALF[0], ENV_HALF[1]] },
    ceilingHeightM: 8,
    portals: [
      {
        id: `${spec.id}-door`,
        toZoneId: ENV_CORRIDOR_ID,
        position: [0, 0, ENV_HALF[1]],
        ...ENV_DOOR,
        open: true,
      },
    ],
    placementAreas: spec.placementAreas,
    moduleKey: 'environment',
    summary: spec.summary,
    discipline: spec.discipline,
    furnishings: spec.furnishings,
  };
}

// ------------------------------------------------------------ assembly

function build(): Zone[] {
  const kiosk = at('directory-kiosk', 3.3, -1.25);
  const wingCorridors = WINGS.map((w) =>
    corridor(
      `corridor-${w.letter.toLowerCase()}-main`,
      `Wing ${w.letter} Main Corridor`,
      w.wingId,
      w.z,
      41,
      [kiosk],
      `Circulation corridor of Wing ${w.letter}.`,
    ),
  );
  const envCorridor = corridor(
    ENV_CORRIDOR_ID,
    'Environments Corridor',
    'wing-e',
    ENV_CORRIDOR_Z,
    78,
    [kiosk],
    'Corridor serving the six configurable research environments.',
  );

  const labs: Zone[] = [];
  WINGS.forEach((w, i) => {
    const c = wingCorridors[i]!;
    w.north.forEach((s, k) => labs.push(lab(s, w.wingId, c.id, LAB_X[k]!, w.z, 'north')));
    w.south.forEach((s, k) => labs.push(lab(s, w.wingId, c.id, LAB_X[k]!, w.z, 'south')));
  });
  const wingE = WING_E_LABS.map((l) => lab(l.spec, 'wing-e', CORRIDOR_E_ID, l.x, 0, 'north'));
  const envs = ENVIRONMENTS.map((e, i) => environment(e, ENV_X[i]!));

  // Concourse: segments between consecutive east–west corridors (each corridor owns the junction).
  const chain = [corridorE, ...wingCorridors, envCorridor];
  const concourse: Zone[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i]!;
    const b = chain[i + 1]!;
    const z0 = a.pose.position[2] + 1.5;
    const z1 = b.pose.position[2] - 1.5;
    const half = (z1 - z0) / 2;
    const toName = (z: Zone) => z.name.replace(' Main Corridor', '').replace(' Corridor', '');
    const seg: Zone = {
      ...corridor(
        `concourse-${i + 1}`,
        `Central Concourse ${i + 1} (${toName(a)} – ${toName(b)})`,
        b.wingId,
        z0 + half,
        SPINE_W / 2,
        [],
        'Segment of the north–south central concourse.',
      ),
      footprint: { min: [-SPINE_W / 2, -half], max: [SPINE_W / 2, half] },
      portals: [
        {
          id: `concourse-${i + 1}-north`,
          toZoneId: a.id,
          position: [0, 0, -half],
          widthM: SPINE_W,
          heightM: CORRIDOR_H,
          open: true,
        },
        {
          id: `concourse-${i + 1}-south`,
          toZoneId: b.id,
          position: [0, 0, half],
          widthM: SPINE_W,
          heightM: CORRIDOR_H,
          open: true,
        },
      ],
    };
    concourse.push(seg);
  }

  const all = [
    centralWorkshop,
    ...wingE,
    corridorE,
    ...labs,
    ...wingCorridors,
    envCorridor,
    ...concourse,
    ...envs,
  ];
  const byId = new Map(all.map((z) => [z.id, z]));
  // Rooms → corridors, concourse → corridors: mirror every portal into its target zone.
  for (const z of all) for (const p of [...z.portals]) mirrorPortals(z, byId.get(p.toZoneId)!);
  // Stable portal ordering (by id) for deterministic output.
  for (const z of all) z.portals.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  // Order: wings A–D labs by number, Wing E labs, environments, corridors.
  const rooms = all.filter((z) => z.kind === 'laboratory').sort((p, q) => p.labNumber! - q.labNumber!);
  return [...rooms, ...envs, corridorE, ...wingCorridors, envCorridor, ...concourse];
}

const equipment: Equipment[] = [
  {
    id: 'bench-standard',
    name: 'Workbench 1800 × 800',
    category: 'workbench',
    sizeM: [1.8, 0.9, 0.8],
    mount: { position: [0, 0.9, 0], yaw: 0 },
    workSurfaceM: [1.8, 0.8],
    visual: 'bench-standard',
  },
  {
    id: 'bench-heavy',
    name: 'Heavy assembly bench 2400 × 1000',
    category: 'workbench',
    sizeM: [2.4, 0.95, 1.0],
    mount: { position: [0, 0.95, 0], yaw: 0 },
    workSurfaceM: [2.4, 1.0],
    visual: 'bench-heavy',
  },
  {
    id: 'tool-cabinet',
    name: 'Tool cabinet 1000 × 500',
    category: 'storage',
    sizeM: [1.0, 1.9, 0.5],
    mount: null,
    workSurfaceM: null,
    visual: 'cabinet',
  },
  {
    id: 'instrument-rack',
    name: 'Instrument rack 600 × 800',
    category: 'instrument',
    sizeM: [0.6, 2.0, 0.8],
    mount: null,
    workSurfaceM: null,
    visual: 'rack',
  },
  {
    id: 'conjuring-pedestal',
    name: 'Conjuring pedestal',
    category: 'fixture',
    sizeM: [1.2, 0.6, 1.2],
    mount: null,
    workSurfaceM: null,
    visual: 'pedestal',
  },
];

export const FACILITY_V1: Facility = {
  facilitySchemaVersion: 1,
  revision: 2,
  wings: [
    { id: 'wing-a', letter: 'A', name: 'AI & Computational Intelligence' },
    { id: 'wing-b', letter: 'B', name: 'Robotics & Mechatronics' },
    { id: 'wing-c', letter: 'C', name: 'Mechanical & Manufacturing' },
    { id: 'wing-d', letter: 'D', name: 'Electronics & Physical Sciences' },
    { id: 'wing-e', letter: 'E', name: 'Research Operations' },
  ],
  zones: build(),
  equipment,
};
