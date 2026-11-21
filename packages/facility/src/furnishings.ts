/**
 * Fixed furnishing catalogue (architecture layer: read-only, never pickable, never part
 * of a workspace layout or engineering project). Each type has a default size
 * [width (local x), height, depth (local z)] in metres; origin = footprint centre on
 * the floor; local +Z is the "front" (the side people work from). Furnishings are
 * illustrative room dressing that makes each discipline recognisable — they carry no
 * engineering behaviour and are not simulation assets.
 */
export interface FurnishingType {
  name: string;
  sizeM: [number, number, number];
  /** Mounted on a wall (thin footprint, raised); still validated as a floor rectangle. */
  wallMounted?: boolean;
}

export const FURNISHING_TYPES = {
  // General research-lab dressing
  'wall-bench': { name: 'Perimeter bench with reagent shelf', sizeM: [3.0, 2.0, 0.75] },
  'storage-wall': { name: 'Storage wall', sizeM: [2.4, 2.2, 0.6] },
  whiteboard: { name: 'Whiteboard', sizeM: [2.4, 1.2, 0.06], wallMounted: true },
  'desk-cluster': { name: 'Researcher desk cluster', sizeM: [3.2, 1.2, 1.6] },
  'meeting-table': { name: 'Meeting table', sizeM: [3.6, 0.75, 1.4] },
  'display-wall': { name: 'Large display wall', sizeM: [4.8, 2.6, 0.3] },
  'flammables-cabinet': { name: 'Flammables safety cabinet', sizeM: [1.2, 1.8, 0.6] },
  'directory-kiosk': { name: 'Wayfinding kiosk', sizeM: [0.6, 1.6, 0.4] },
  // Computing & AI
  'server-rack-row': { name: 'Server rack row (8 racks)', sizeM: [4.8, 2.1, 1.1] },
  'gpu-cluster': { name: 'GPU compute cabinets', sizeM: [2.4, 2.1, 1.2] },
  'camera-rig': { name: 'Multi-camera calibration rig', sizeM: [3.0, 2.6, 2.6] },
  'vr-tracking-space': { name: 'Tracked immersive interaction space', sizeM: [5.0, 2.8, 4.0] },
  // Robotics & mechatronics
  'robot-arm-cell': { name: 'Guarded robot-arm cell', sizeM: [2.4, 2.2, 2.4] },
  'mobile-robot-arena': { name: 'Mobile-robot test arena', sizeM: [8.0, 0.4, 6.0] },
  'charging-dock': { name: 'Robot charging dock', sizeM: [1.2, 0.6, 0.6] },
  'electronics-bench': { name: 'Electronics bench with instrument shelf', sizeM: [2.4, 1.6, 0.9] },
  'control-rig': { name: 'Control & DAQ test rig', sizeM: [1.8, 1.5, 0.9] },
  // Mechanical & manufacturing
  'cnc-mill': { name: 'CNC machining centre', sizeM: [2.2, 2.3, 1.8] },
  lathe: { name: 'Toolroom lathe', sizeM: [2.6, 1.6, 1.0] },
  'printer-row': { name: 'Additive manufacturing printer row', sizeM: [4.0, 1.8, 0.9] },
  'tensile-tester': { name: 'Universal testing machine', sizeM: [1.0, 2.6, 0.8] },
  'shaker-table': { name: 'Vibration shaker table', sizeM: [1.6, 1.0, 1.6] },
  'fume-hood': { name: 'Fume hood', sizeM: [1.8, 2.4, 0.9] },
  'microscope-station': { name: 'Microscopy station', sizeM: [1.6, 1.4, 0.8] },
  // Electronics & physical sciences
  'reflow-line': { name: 'Pick-and-place & reflow line', sizeM: [3.2, 1.4, 1.0] },
  'laminar-flow-bench': { name: 'Laminar-flow clean bench', sizeM: [1.8, 2.2, 0.9] },
  'lithography-tool': { name: 'Lithography tool', sizeM: [1.8, 2.0, 1.6] },
  'air-shower': { name: 'Cleanroom air shower', sizeM: [1.4, 2.4, 1.4] },
  'motor-dyno': { name: 'Motor dynamometer bay', sizeM: [3.0, 1.4, 1.4] },
  'battery-cabinet': { name: 'Battery test cabinet', sizeM: [1.2, 2.0, 0.7] },
  'switchgear-panel': { name: 'Switchgear & power-supply panel', sizeM: [2.4, 2.2, 0.6] },
  'optical-table': { name: 'Vibration-isolated optical table', sizeM: [3.0, 0.9, 1.5] },
  'laser-enclosure': { name: 'Laser safety enclosure', sizeM: [2.0, 1.8, 1.2] },
  'bench-wind-tunnel': { name: 'Bench-scale wind tunnel', sizeM: [7.0, 2.0, 1.6] },
  'environmental-chamber': { name: 'Environmental test chamber', sizeM: [2.4, 2.4, 2.0] },
  // Research operations
  'daq-console': { name: 'Data-acquisition console', sizeM: [2.4, 1.2, 1.0] },
  'large-format-plotter': { name: 'Large-format plotter', sizeM: [1.8, 1.2, 0.8] },
  // Environments (sizes usually overridden per zone)
  conveyor: { name: 'Conveyor line', sizeM: [6.0, 0.9, 0.8] },
  'mocap-truss': { name: 'Motion-capture camera truss', sizeM: [16, 6, 14] },
  'water-tank': { name: 'Test tank with gantry', sizeM: [12, 3.0, 8] },
  'wind-tunnel': { name: 'Closed-return wind tunnel', sizeM: [18, 4.2, 4.5] },
  'projection-cave': { name: 'Projection CAVE', sizeM: [6, 3.0, 6] },
  'terrain-course': { name: 'Terrain & weather course', sizeM: [12, 4.5, 9] },
  'control-desk': { name: 'Operator control desk', sizeM: [3.6, 1.2, 1.2] },
} as const satisfies Record<string, FurnishingType>;

export type FurnishingTypeId = keyof typeof FURNISHING_TYPES;

export const isFurnishingType = (t: string): t is FurnishingTypeId => t in FURNISHING_TYPES;
