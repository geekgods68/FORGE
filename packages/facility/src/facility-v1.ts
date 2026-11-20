import type { Equipment, Facility, Zone } from './schemas';

/**
 * FORGE facility content, revision 1 (read-only; shipped with the application).
 *
 * Site plan (facility frame F, metres, +Y up, −Z "north"):
 *   - Corridor E runs along X at the datum (z = 0), 54 m long, 3 m wide.
 *   - Wing E laboratories 20–22 sit north of the corridor (zone origins z = −7.5).
 *   - Wings A–D occupy reserved rows to the south; the six experimental environments
 *     occupy a reserved row further north. Only reserved footprints exist for them.
 *
 * Implemented in this slice: Zone 20 (Central Conjuring & Integration Workshop) and
 * Corridor E. Everything else is `planned`: registered, addressable, never rendered.
 */

const LAB_FOOTPRINT = { min: [-9, -6] as [number, number], max: [9, 6] as [number, number] };
const ENV_FOOTPRINT = { min: [-12, -12] as [number, number], max: [12, 12] as [number, number] };

function plannedLab(labNumber: number, id: string, name: string, wingId: string, x: number, z: number): Zone {
  return {
    id,
    name,
    kind: 'laboratory',
    labNumber,
    wingId,
    status: 'planned',
    pose: { position: [x, 0, z], yaw: 0 },
    footprint: LAB_FOOTPRINT,
    ceilingHeightM: 4.5,
    portals: [],
    placementAreas: [],
    moduleKey: null,
    summary: 'Planned laboratory (not yet built).',
  };
}

function plannedEnvironment(id: string, name: string, x: number): Zone {
  return {
    id,
    name,
    kind: 'environment',
    labNumber: null,
    wingId: 'wing-e',
    status: 'planned',
    pose: { position: [x, 0, -40], yaw: 0 },
    footprint: ENV_FOOTPRINT,
    ceilingHeightM: 8,
    portals: [],
    placementAreas: [],
    moduleKey: null,
    summary: 'Planned configurable research environment (not yet built).',
  };
}

export const CENTRAL_WORKSHOP_ID = 'lab-20-central-conjuring-workshop';
export const CORRIDOR_E_ID = 'corridor-e-main';

const centralWorkshop: Zone = {
  id: CENTRAL_WORKSHOP_ID,
  name: 'Central Conjuring & Integration Workshop',
  kind: 'laboratory',
  labNumber: 20,
  wingId: 'wing-e',
  status: 'implemented',
  pose: { position: [0, 0, -7.5], yaw: 0 },
  footprint: LAB_FOOTPRINT, // 18 m × 12 m interior
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
};

const corridorE: Zone = {
  id: CORRIDOR_E_ID,
  name: 'Wing E Main Corridor',
  kind: 'corridor',
  labNumber: null,
  wingId: 'wing-e',
  status: 'implemented',
  pose: { position: [0, 0, 0], yaw: 0 },
  footprint: { min: [-27, -1.5], max: [27, 1.5] },
  ceilingHeightM: 3.5,
  portals: [
    { id: 'pc-20', toZoneId: CENTRAL_WORKSHOP_ID, position: [0, 0, -1.5], widthM: 3, heightM: 3, open: true },
    {
      id: 'pc-21',
      toZoneId: 'lab-21-research-validation',
      position: [-18, 0, -1.5],
      widthM: 2,
      heightM: 2.6,
      open: false,
    },
    {
      id: 'pc-22',
      toZoneId: 'lab-22-documentation-review',
      position: [18, 0, -1.5],
      widthM: 2,
      heightM: 2.6,
      open: false,
    },
  ],
  placementAreas: [],
  moduleKey: 'corridor-e',
  summary: 'Circulation spine of Wing E. Architecture only — no configurable equipment.',
};

const zones: Zone[] = [
  // Wing A — AI & Computational Intelligence (reserved row z = +20)
  plannedLab(1, 'lab-01-central-intelligence', 'Central Intelligence Research Lab', 'wing-a', -36, 20),
  plannedLab(2, 'lab-02-computer-vision', 'Computer Vision & Perception Lab', 'wing-a', -18, 20),
  plannedLab(
    3,
    'lab-03-autonomous-robot-learning',
    'Autonomous Systems & Robot Learning Lab',
    'wing-a',
    0,
    20,
  ),
  plannedLab(4, 'lab-04-research-computing', 'Research Computing & Systems Lab', 'wing-a', 18, 20),
  plannedLab(5, 'lab-05-human-ai-immersive', 'Human–AI Interaction & Immersive Lab', 'wing-a', 36, 20),
  // Wing B — Robotics & Mechatronics (z = +40)
  plannedLab(6, 'lab-06-robotic-manipulation', 'Robotic Manipulation Laboratory', 'wing-b', -27, 40),
  plannedLab(7, 'lab-07-mobile-robotics', 'Mobile Robotics & Navigation Arena', 'wing-b', -9, 40),
  plannedLab(8, 'lab-08-embedded-systems', 'Embedded Systems & Computer Engineering Lab', 'wing-b', 9, 40),
  plannedLab(9, 'lab-09-sensors-controls', 'Sensors, Controls & Instrumentation Lab', 'wing-b', 27, 40),
  // Wing C — Mechanical & Manufacturing (z = +60)
  plannedLab(10, 'lab-10-mechanical-design', 'Mechanical Design & Assembly Studio', 'wing-c', -36, 60),
  plannedLab(11, 'lab-11-precision-fabrication', 'Precision Fabrication & Machine Shop', 'wing-c', -18, 60),
  plannedLab(12, 'lab-12-additive-manufacturing', 'Advanced Additive Manufacturing Centre', 'wing-c', 0, 60),
  plannedLab(13, 'lab-13-materials-testing', 'Materials Science & Mechanical Testing Lab', 'wing-c', 18, 60),
  plannedLab(
    14,
    'lab-14-structures-multiphysics',
    'Structures, Dynamics & Multiphysics Lab',
    'wing-c',
    36,
    60,
  ),
  // Wing D — Electronics & Physical Sciences (z = +80)
  plannedLab(15, 'lab-15-electronics-pcb', 'Electronics & PCB Engineering Lab', 'wing-d', -36, 80),
  plannedLab(16, 'lab-16-cleanroom', 'Microelectronics & Nanofabrication Cleanroom', 'wing-d', -18, 80),
  plannedLab(17, 'lab-17-power-energy', 'Power, Energy & Electric Machines Lab', 'wing-d', 0, 80),
  plannedLab(18, 'lab-18-photonics-optics', 'Photonics, Imaging & Optics Lab', 'wing-d', 18, 80),
  plannedLab(19, 'lab-19-aerospace-fluid', 'Aerospace, Fluid & Environmental Test Arena', 'wing-d', 36, 80),
  // Wing E — Research Operations (along the corridor)
  centralWorkshop,
  plannedLab(
    21,
    'lab-21-research-validation',
    'Research Experimentation & Validation Centre',
    'wing-e',
    -18,
    -7.5,
  ),
  plannedLab(
    22,
    'lab-22-documentation-review',
    'Engineering Documentation & Design Review Studio',
    'wing-e',
    18,
    -7.5,
  ),
  corridorE,
  // Six configurable research environments (reserved row z = −40)
  plannedEnvironment('env-robotic-manipulation-arena', 'Robotic Manipulation Arena', -75),
  plannedEnvironment('env-motion-capture-navigation', 'Motion Capture & Navigation Arena', -45),
  plannedEnvironment('env-underwater-tank', 'Underwater Robotics Tank', -15),
  plannedEnvironment('env-wind-tunnel-bay', 'Aerodynamics & Wind Tunnel Bay', 15),
  plannedEnvironment('env-immersive-design-chamber', 'Immersive Design Chamber', 45),
  plannedEnvironment('env-real-world-simulator', 'Real-World Environment Simulator', 75),
];

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
  revision: 1,
  wings: [
    { id: 'wing-a', letter: 'A', name: 'AI & Computational Intelligence' },
    { id: 'wing-b', letter: 'B', name: 'Robotics & Mechatronics' },
    { id: 'wing-c', letter: 'C', name: 'Mechanical & Manufacturing' },
    { id: 'wing-d', letter: 'D', name: 'Electronics & Physical Sciences' },
    { id: 'wing-e', letter: 'E', name: 'Research Operations' },
  ],
  zones,
  equipment,
};
