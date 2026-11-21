import type { ComponentInterface, InterfaceType, ParamValues } from '../schemas';
import { circle, regularPolygon, type Appearance, type Solid, type V3 } from './solids';

/**
 * Parametric geometry generators. Each turns resolved parameters (metres/radians) into
 * solids plus parameter-dependent connection interfaces. Pure and deterministic: the
 * same parameters always produce identical output (tested).
 *
 * Conventions: origin = centre of the footprint on the base (bounds min y = 0), +Y up,
 * long axis along +X. Interfaces are in the same frame.
 */
export interface GeneratorOutput {
  solids: Solid[];
  interfaces: ComponentInterface[];
}
export interface Generator {
  id: string;
  description: string;
  /** Unsupported parameter combinations → human-readable problems (empty = valid). */
  check?: (p: ParamValues) => string[];
  generate: (p: ParamValues) => GeneratorOutput;
}

// ------------------------------------------------------------ helpers

const num = (p: ParamValues, k: string, fallback?: number): number => {
  const v = p[k];
  if (typeof v === 'number') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing numeric parameter "${k}"`);
};
const str = (p: ParamValues, k: string, fallback?: string): string => {
  const v = p[k];
  if (typeof v === 'string') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing parameter "${k}"`);
};
const bool = (p: ParamValues, k: string, fallback = false) =>
  typeof p[k] === 'boolean' ? (p[k] as boolean) : fallback;
const app = (p: ParamValues, k: string, fallback: Appearance): Appearance =>
  str(p, k, fallback) as Appearance;

const box = (
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  a: Appearance = 'primary',
  yaw?: number,
): Solid => ({
  type: 'box',
  size: [w, h, d],
  at: [x, y, z],
  app: a,
  ...(yaw ? { yaw } : {}),
});
const cyl = (
  r: number,
  h: number,
  axis: 'x' | 'y' | 'z',
  at: V3,
  a: Appearance = 'primary',
  segments?: number,
): Solid => ({
  type: 'cylinder',
  r,
  h,
  axis,
  at,
  app: a,
  ...(segments ? { segments } : {}),
});

const UP: V3 = [0, 1, 0];
const DOWN: V3 = [0, -1, 0];
const PX: V3 = [1, 0, 0];
const NX: V3 = [-1, 0, 0];
const PZ: V3 = [0, 0, 1];
const NZ: V3 = [0, 0, -1];

export function itf(
  id: string,
  name: string,
  type: InterfaceType,
  position: V3,
  direction: V3,
  gender: ComponentInterface['gender'],
  compatibility: string[],
  signal?: string,
): ComponentInterface {
  return {
    id,
    name,
    type,
    position,
    direction,
    gender,
    compatibility,
    limits: [],
    ...(signal ? { signal } : {}),
  };
}

/** Metric thread designations used by fastener and hole parameters. */
export const METRIC_SIZES = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10'] as const;
const nominal = (m: string) => Number(m.slice(1)) / 1000;
/** ISO 273 medium clearance hole diameters (mm). */
const CLEARANCE: Record<string, number> = {
  M2: 2.4,
  'M2.5': 2.9,
  M3: 3.4,
  M4: 4.5,
  M5: 5.5,
  M6: 6.6,
  M8: 9,
  M10: 11,
};
export const clearanceHole = (m: string) => (CLEARANCE[m] ?? 3.4) / 1000;

/** Bolt-hole interfaces through a part of thickness t (top face at y = t). */
const boltHoles = (
  holes: [number, number][],
  size: string,
  t: number,
  prefix = 'hole',
): ComponentInterface[] =>
  holes.map(([x, z], i) =>
    itf(`${prefix}-${i + 1}`, `${size} clearance hole ${i + 1}`, 'bolt-hole', [x, t, z], UP, 'female', [
      `${size}-clearance`,
    ]),
  );

// ------------------------------------------------------------ standard tables (ISO)

/** ISO 4762 socket head cap screw head: [dk, k] mm. */
const ISO4762: Record<string, [number, number]> = {
  M2: [3.8, 2],
  'M2.5': [4.5, 2.5],
  M3: [5.5, 3],
  M4: [7, 4],
  M5: [8.5, 5],
  M6: [10, 6],
  M8: [13, 8],
  M10: [16, 10],
};
/** ISO 7045 pan head: [dk, k] mm. */
const ISO7045: Record<string, [number, number]> = {
  M2: [4, 1.6],
  'M2.5': [5, 2],
  M3: [5.6, 2.4],
  M4: [8, 3.1],
  M5: [9.5, 3.7],
  M6: [12, 4.6],
  M8: [16, 6],
  M10: [20, 7.5],
};
/** ISO 10642 countersunk: [dk, k] mm. */
const ISO10642: Record<string, [number, number]> = {
  M2: [4.4, 1.2],
  'M2.5': [5.5, 1.5],
  M3: [6.72, 1.86],
  M4: [8.96, 2.48],
  M5: [11.2, 3.1],
  M6: [13.44, 3.72],
  M8: [17.92, 4.96],
  M10: [22.4, 6.2],
};
/** ISO 4017 / 4032 hex: [s across flats, head k or nut m] mm. */
const ISO4017: Record<string, [number, number]> = {
  M2: [4, 1.4],
  'M2.5': [5, 1.7],
  M3: [5.5, 2],
  M4: [7, 2.8],
  M5: [8, 3.5],
  M6: [10, 4],
  M8: [13, 5.3],
  M10: [16, 6.4],
};
const ISO4032: Record<string, [number, number]> = {
  M2: [4, 1.6],
  'M2.5': [5, 2],
  M3: [5.5, 2.4],
  M4: [7, 3.2],
  M5: [8, 4.7],
  M6: [10, 5.2],
  M8: [13, 6.8],
  M10: [16, 8.4],
};
/** ISO 7089 plain washer: [d1, d2, h] mm. */
const ISO7089: Record<string, [number, number, number]> = {
  M2: [2.2, 5, 0.3],
  'M2.5': [2.7, 6, 0.5],
  M3: [3.2, 7, 0.5],
  M4: [4.3, 9, 0.8],
  M5: [5.3, 10, 1],
  M6: [6.4, 12, 1.6],
  M8: [8.4, 16, 1.6],
  M10: [10.5, 20, 2],
};
/** Deep-groove ball bearings (ISO 15 boundary dimensions): [d, D, B] mm. */
export const BEARINGS: Record<string, [number, number, number]> = {
  '623': [3, 10, 4],
  '625': [5, 16, 5],
  '688': [8, 16, 5],
  '608': [8, 22, 7],
  '6800': [10, 19, 5],
  '6000': [10, 26, 8],
  '6001': [12, 28, 8],
  '6200': [10, 30, 9],
  '6201': [12, 32, 10],
  '6202': [15, 35, 11],
  '6203': [17, 40, 12],
};
/** NEMA ICS 16 stepper frames: [face mm, hole spacing mm, shaft Ø mm, pilot Ø mm]. */
const NEMA: Record<string, [number, number, number, number]> = {
  '14': [35.2, 26, 5, 22],
  '17': [42.3, 31, 5, 22],
  '23': [56.4, 47.14, 6.35, 38.1],
};
/** Cylindrical cells: [diameter, length] mm (IEC / industry designations). */
const CELLS: Record<string, [number, number]> = {
  AAA: [10.5, 44.5],
  AA: [14.5, 50.5],
  C: [26.2, 50],
  D: [34.2, 61.5],
  '18650': [18.4, 65],
  '21700': [21, 70],
  '14500': [14.5, 50.5],
  CR2032: [20, 3.2],
};

const mm = (v: number) => v / 1000;

// ------------------------------------------------------------ profiles

/** Simplified T-slot extrusion profile (series = 20/30/40 mm; cells = 1 or 2 along width). */
function tslotOutline(
  series: number,
  cellsW: number,
  cellsH: number,
): { outline: [number, number][]; holes: [number, number][][] } {
  const s = mm(series);
  const W = s * cellsW;
  const H = s * cellsH;
  const slot = mm(series === 20 ? 6.2 : 8.2);
  const depth = mm(series === 20 ? 1.8 : 2.2); // lip depth of the simplified slot notch
  const outline: [number, number][] = [];
  // Walk the rectangle CCW from bottom-left, notching a slot at the centre of every cell edge.
  const edge = (x0: number, y0: number, x1: number, y1: number, n: number, nx: number, ny: number) => {
    for (let i = 0; i < n; i++) {
      const a = i / n;
      const b = (i + 1) / n;
      const cx = x0 + (x1 - x0) * ((a + b) / 2);
      const cy = y0 + (y1 - y0) * ((a + b) / 2);
      const dx = x1 - x0 === 0 ? 0 : Math.sign(x1 - x0);
      const dy = y1 - y0 === 0 ? 0 : Math.sign(y1 - y0);
      outline.push([x0 + (x1 - x0) * a, y0 + (y1 - y0) * a]);
      outline.push([cx - (dx * slot) / 2, cy - (dy * slot) / 2]);
      outline.push([cx - (dx * slot) / 2 - nx * depth, cy - (dy * slot) / 2 - ny * depth]);
      outline.push([cx + (dx * slot) / 2 - nx * depth, cy + (dy * slot) / 2 - ny * depth]);
      outline.push([cx + (dx * slot) / 2, cy + (dy * slot) / 2]);
    }
  };
  edge(-W / 2, 0, W / 2, 0, cellsW, 0, -1); // bottom (outward normal −y)
  edge(W / 2, 0, W / 2, H, cellsH, 1, 0);
  edge(W / 2, H, -W / 2, H, cellsW, 0, 1);
  edge(-W / 2, H, -W / 2, 0, cellsH, -1, 0);
  const bore = mm(series === 20 ? 4.2 : series === 30 ? 6.8 : 8.5) / 2;
  const holes: [number, number][][] = [];
  for (let i = 0; i < cellsW; i++)
    for (let j = 0; j < cellsH; j++) holes.push(circle(-W / 2 + s * (i + 0.5), s * (j + 0.5), bore, 20));
  return { outline, holes };
}

/** Structural section outlines in (u = width, v = height), base at v = 0. */
function sectionOutline(kind: string, h: number, b: number, tw: number, tf: number): [number, number][] {
  switch (kind) {
    case 'i-beam':
      return [
        [-b / 2, 0],
        [b / 2, 0],
        [b / 2, tf],
        [tw / 2, tf],
        [tw / 2, h - tf],
        [b / 2, h - tf],
        [b / 2, h],
        [-b / 2, h],
        [-b / 2, h - tf],
        [-tw / 2, h - tf],
        [-tw / 2, tf],
        [-b / 2, tf],
      ];
    case 'channel':
      return [
        [-b / 2, 0],
        [b / 2, 0],
        [b / 2, tf],
        [-b / 2 + tw, tf],
        [-b / 2 + tw, h - tf],
        [b / 2, h - tf],
        [b / 2, h],
        [-b / 2, h],
      ];
    case 'angle':
      return [
        [-b / 2, 0],
        [b / 2, 0],
        [b / 2, tf],
        [-b / 2 + tw, tf],
        [-b / 2 + tw, h],
        [-b / 2, h],
      ];
    case 't-section':
      return [
        [-tw / 2, 0],
        [tw / 2, 0],
        [tw / 2, h - tf],
        [b / 2, h - tf],
        [b / 2, h],
        [-b / 2, h],
        [-b / 2, h - tf],
        [-tw / 2, h - tf],
      ];
    default:
      return [
        [-b / 2, 0],
        [b / 2, 0],
        [b / 2, h],
        [-b / 2, h],
      ];
  }
}

/** Spur-gear outline with trapezoidal teeth (module m, z teeth): approximate involute. */
function gearOutline(module: number, teeth: number): [number, number][] {
  const rp = (module * teeth) / 2;
  const ra = rp + module;
  const rf = rp - 1.25 * module;
  const pts: [number, number][] = [];
  const pitchAng = (2 * Math.PI) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * pitchAng;
    const f = pitchAng / 4;
    pts.push([rf * Math.cos(a - 1.1 * f), rf * Math.sin(a - 1.1 * f)]);
    pts.push([ra * Math.cos(a - 0.55 * f), ra * Math.sin(a - 0.55 * f)]);
    pts.push([ra * Math.cos(a + 0.55 * f), ra * Math.sin(a + 0.55 * f)]);
    pts.push([rf * Math.cos(a + 1.1 * f), rf * Math.sin(a + 1.1 * f)]);
  }
  return pts;
}

/** Stadium (rounded-end link) outline of length L (hole centre distance) and width w. */
function stadium(L: number, w: number, n = 12): [number, number][] {
  const r = w / 2;
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / n;
    pts.push([L / 2 + r * Math.cos(a), r * Math.sin(a)]);
  }
  for (let i = 0; i <= n; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / n;
    pts.push([-L / 2 + r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

// ------------------------------------------------------------ electronics layouts

/** Header row of n pins at pitch 2.54 mm along X, centred at (x, z); returns solids + gpio interfaces. */
function headerRow(
  names: string[],
  x0: number,
  z: number,
  top: number,
  prefix: string,
  female: boolean,
  type: InterfaceType = 'gpio-pin',
) {
  const pitch = mm(2.54);
  const solids: Solid[] = [];
  const interfaces: ComponentInterface[] = [];
  const n = names.length;
  const h = mm(female ? 8.5 : 2.5);
  solids.push(box(pitch * n, h, pitch, x0 + (pitch * (n - 1)) / 2, top + h / 2, z, 'black'));
  names.forEach((name, i) => {
    const x = x0 + i * pitch;
    if (!female) solids.push(box(mm(0.64), mm(6), mm(0.64), x, top + h + mm(3), z, 'gold'));
    const kind: InterfaceType = /^(5V|3V3|3\.3V|VIN|VCC|GND|V\+|V-|IOREF)$/i.test(name)
      ? 'power-terminal'
      : type;
    interfaces.push(
      itf(
        `${prefix}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}`,
        `${name}`,
        kind,
        [x, top + h, z],
        UP,
        female ? 'female' : 'male',
        ['2.54mm-header'],
        name,
      ),
    );
  });
  return { solids, interfaces };
}

interface BoardLayout {
  w: number;
  d: number;
  pcb: Appearance;
  holes: [number, number][];
  parts: Solid[];
  headers: { names: string[]; x0: number; z: number; female: boolean }[];
  connectors: ComponentInterface[];
}

/**
 * Board layouts. Board outlines/mounting holes for `arduino-uno` follow the published
 * Arduino UNO R3 board drawing (68.6 × 53.4 mm); component placement is approximate.
 * Others are generic layouts at the published board size where noted in the catalogue.
 */
function boardLayout(layout: string): BoardLayout {
  const t = mm(1.6);
  switch (layout) {
    case 'arduino-uno': {
      const w = mm(68.6);
      const d = mm(53.4);
      // Origin at board centre; board-drawing coordinates are from the lower-left corner (x right, y up → −z).
      const at = (xmm: number, ymm: number): [number, number] => [mm(xmm) - w / 2, d / 2 - mm(ymm)];
      const digital = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'];
      const digitalHi = ['D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'GND', 'AREF'];
      const power = ['IOREF', 'RESET', '3V3', '5V', 'GND', 'GND', 'VIN'];
      const analog = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'];
      return {
        w,
        d,
        pcb: 'pcb-blue',
        holes: [at(14.0, 2.5), at(15.3, 50.7), at(66.1, 7.6), at(66.1, 35.5)],
        parts: [
          box(mm(16), mm(11), mm(12), -w / 2 + mm(6.2), t + mm(5.5), d / 2 - mm(38), 'metal'), // USB-B
          box(mm(14), mm(11), mm(9), -w / 2 + mm(5), t + mm(5.5), d / 2 - mm(7.6), 'black'), // DC jack
          box(mm(35), mm(4), mm(8), mm(8), t + mm(2), mm(8), 'black'), // ATmega328P DIP
          box(mm(4.5), mm(3.5), mm(11), -w / 2 + mm(22), t + mm(1.75), d / 2 - mm(40), 'metal'), // crystal
        ],
        headers: [
          { names: [...digital].reverse(), x0: mm(48) - w / 2, z: -d / 2 + mm(2.5), female: true },
          { names: [...digitalHi].reverse(), x0: mm(26) - w / 2, z: -d / 2 + mm(2.5), female: true },
          { names: power, x0: mm(27.9) - w / 2, z: d / 2 - mm(2.5), female: true },
          { names: analog, x0: mm(48.3) - w / 2, z: d / 2 - mm(2.5), female: true },
        ],
        connectors: [
          itf(
            'usb-b',
            'USB-B (USB 2.0 device)',
            'data-connector',
            [-w / 2 - mm(1.8), t + mm(5.5), d / 2 - mm(38)],
            NX,
            'female',
            ['USB-B'],
          ),
          itf(
            'dc-jack',
            'DC barrel jack (2.1 mm)',
            'power-terminal',
            [-w / 2 - mm(2), t + mm(5.5), d / 2 - mm(7.6)],
            NX,
            'female',
            ['barrel-2.1mm'],
          ),
        ],
      };
    }
    case 'arduino-nano':
      return {
        w: mm(45),
        d: mm(18),
        pcb: 'pcb-blue',
        holes: [],
        parts: [
          box(mm(7), mm(2.5), mm(7), 0, t + mm(1.25), 0, 'black'),
          box(mm(8), mm(4), mm(8), -mm(19), t + mm(2), 0, 'metal'),
        ],
        headers: [
          {
            names: [
              'D12',
              'D11',
              'D10',
              'D9',
              'D8',
              'D7',
              'D6',
              'D5',
              'D4',
              'D3',
              'D2',
              'GND',
              'RST',
              'RX0',
              'TX1',
            ],
            x0: -mm(17.8),
            z: -mm(7.6),
            female: false,
          },
          {
            names: [
              'D13',
              '3V3',
              'AREF',
              'A0',
              'A1',
              'A2',
              'A3',
              'A4',
              'A5',
              'A6',
              'A7',
              '5V',
              'RST',
              'GND',
              'VIN',
            ],
            x0: -mm(17.8),
            z: mm(7.6),
            female: false,
          },
        ],
        connectors: [
          itf(
            'usb',
            'USB (mini/micro, revision dependent)',
            'data-connector',
            [-mm(23), t + mm(2), 0],
            NX,
            'female',
            ['USB-mini-B', 'USB-micro-B'],
          ),
        ],
      };
    case 'raspberry-pi-4b':
      return {
        w: mm(85),
        d: mm(56),
        pcb: 'pcb',
        holes: [
          [-mm(39), -mm(24.5)],
          [mm(19), -mm(24.5)],
          [-mm(39), mm(24.5)],
          [mm(19), mm(24.5)],
        ],
        parts: [
          box(mm(15), mm(2.4), mm(15), -mm(10), t + mm(1.2), mm(2), 'metal-dark'),
          box(mm(21), mm(16), mm(16), mm(33), t + mm(8), -mm(18), 'metal'),
          box(mm(17), mm(15), mm(13), mm(35), t + mm(7.5), mm(1), 'metal'),
          box(mm(17), mm(15), mm(13), mm(35), t + mm(7.5), mm(19), 'metal'),
          box(mm(51), mm(8.5), mm(5), -mm(10), t + mm(4.25), -mm(25), 'black'),
        ],
        headers: [],
        connectors: [
          itf('gpio-40', '40-pin GPIO header', 'gpio-pin', [-mm(10), t + mm(8.5), -mm(25)], UP, 'male', [
            '2.54mm-header-2x20',
          ]),
          itf(
            'ethernet',
            'Gigabit Ethernet',
            'data-connector',
            [mm(42.5), t + mm(7.5), -mm(18)],
            PX,
            'female',
            ['RJ45'],
          ),
          itf(
            'usb-c-power',
            'USB-C power input',
            'power-terminal',
            [-mm(31), t + mm(1.6), mm(28)],
            PZ,
            'female',
            ['USB-C'],
          ),
        ],
      };
    case 'raspberry-pi-pico':
      return {
        w: mm(51),
        d: mm(21),
        pcb: 'pcb',
        holes: [
          [-mm(23.5), -mm(5.7)],
          [-mm(23.5), mm(5.7)],
          [mm(23.5), -mm(5.7)],
          [mm(23.5), mm(5.7)],
        ],
        parts: [
          box(mm(7), mm(1), mm(7), 0, t + mm(0.5), 0, 'black'),
          box(mm(8), mm(3), mm(7.5), -mm(22), t + mm(1.5), 0, 'metal'),
        ],
        headers: [],
        connectors: [
          itf('usb', 'Micro-USB', 'data-connector', [-mm(26), t + mm(1.5), 0], NX, 'female', ['USB-micro-B']),
        ],
      };
    default:
      // Generic development board / module of the requested size (fixed w/d supplied by caller).
      return {
        w: mm(50),
        d: mm(25),
        pcb: 'pcb',
        holes: [],
        parts: [box(mm(10), mm(1.5), mm(10), 0, t + mm(0.75), 0, 'black')],
        headers: [],
        connectors: [],
      };
  }
}

// ------------------------------------------------------------ generators

const G: Generator[] = [
  {
    id: 'plate',
    description:
      'Rectangular plate/sheet/block with optional corner clearance holes (holes are cut from the volume).',
    check: (p) => {
      const out: string[] = [];
      if (
        str(p, 'holes', 'none') !== 'none' &&
        2 * num(p, 'holeInset', 0.006) >= Math.min(num(p, 'length'), num(p, 'width'))
      )
        out.push('Hole inset leaves no material between the holes.');
      return out;
    },
    generate: (p) => {
      const L = num(p, 'length');
      const W = num(p, 'width');
      const T = num(p, 'thickness');
      const holes = str(p, 'holes', 'none');
      const pts: [number, number][] = [];
      if (holes !== 'none') {
        const e = num(p, 'holeInset', 0.006);
        pts.push(
          [-L / 2 + e, -W / 2 + e],
          [L / 2 - e, -W / 2 + e],
          [L / 2 - e, W / 2 - e],
          [-L / 2 + e, W / 2 - e],
        );
      }
      const r = clearanceHole(holes) / 2;
      // Prism extruded along y (thickness): outline in (x, z).
      const solid: Solid = {
        type: 'prism',
        outline: [
          [-L / 2, -W / 2],
          [L / 2, -W / 2],
          [L / 2, W / 2],
          [-L / 2, W / 2],
        ],
        holes: holes === 'none' ? [] : pts.map(([x, z]) => circle(x, z, r)),
        depth: T,
        axis: 'y',
        at: [0, T / 2, 0],
        app: 'primary',
      };
      return {
        solids: [solid],
        interfaces:
          holes === 'none'
            ? [itf('face', 'Top face mount', 'mechanical-mount', [0, T, 0], UP, 'neutral', ['flat-face'])]
            : boltHoles(pts, holes, T),
      };
    },
  },
  {
    id: 'rod',
    description: 'Solid round bar/rod/shaft lying along X.',
    generate: (p) => {
      const L = num(p, 'length');
      const r = num(p, 'diameter') / 2;
      return {
        solids: [cyl(r, L, 'x', [0, r, 0])],
        interfaces: [
          itf('end-a', 'End A', 'shaft-coupling', [-L / 2, r, 0], NX, 'male', [
            `shaft-${Math.round(r * 2000 * 100) / 100}mm`,
          ]),
          itf('end-b', 'End B', 'shaft-coupling', [L / 2, r, 0], PX, 'male', [
            `shaft-${Math.round(r * 2000 * 100) / 100}mm`,
          ]),
        ],
      };
    },
  },
  {
    id: 'tube',
    description: 'Round tube/pipe (outer diameter, wall) lying along X.',
    check: (p) =>
      num(p, 'wall') * 2 >= num(p, 'outerDiameter')
        ? ['Wall thickness must be less than half the outer diameter.']
        : [],
    generate: (p) => {
      const L = num(p, 'length');
      const ro = num(p, 'outerDiameter') / 2;
      const ri = ro - num(p, 'wall');
      const od = `${Math.round(ro * 2000 * 100) / 100}mm`;
      return {
        solids: [{ type: 'tube', ro, ri, h: L, axis: 'x', at: [0, ro, 0], app: 'primary' }],
        interfaces: [
          itf('end-a', 'End A', 'fluid-port', [-L / 2, ro, 0], NX, 'neutral', [`tube-od-${od}`]),
          itf('end-b', 'End B', 'fluid-port', [L / 2, ro, 0], PX, 'neutral', [`tube-od-${od}`]),
        ],
      };
    },
  },
  {
    id: 'rect-tube',
    description: 'Rectangular/square hollow section along X (four non-overlapping walls).',
    check: (p) =>
      2 * num(p, 'wall') >= Math.min(num(p, 'width'), num(p, 'height'))
        ? ['Wall thickness must be less than half the smaller side.']
        : [],
    generate: (p) => {
      const L = num(p, 'length');
      const W = num(p, 'width');
      const H = num(p, 'height');
      const t = num(p, 'wall');
      return {
        solids: [
          box(L, t, W, 0, t / 2, 0),
          box(L, t, W, 0, H - t / 2, 0),
          box(L, H - 2 * t, t, 0, H / 2, -W / 2 + t / 2),
          box(L, H - 2 * t, t, 0, H / 2, W / 2 - t / 2),
        ],
        interfaces: [
          itf('face', 'Top face mount', 'mechanical-mount', [0, H, 0], UP, 'neutral', ['flat-face']),
        ],
      };
    },
  },
  {
    id: 'section',
    description: 'Structural section (I-beam, channel, angle, T) extruded along X.',
    check: (p) => {
      const out: string[] = [];
      if (2 * num(p, 'flangeThickness') >= num(p, 'height'))
        out.push('Flanges are thicker than the section height allows.');
      if (num(p, 'webThickness') >= num(p, 'flangeWidth'))
        out.push('Web must be thinner than the flange width.');
      return out;
    },
    generate: (p) => {
      const L = num(p, 'length');
      const H = num(p, 'height');
      return {
        solids: [
          {
            type: 'prism',
            outline: sectionOutline(
              str(p, 'section'),
              H,
              num(p, 'flangeWidth'),
              num(p, 'webThickness'),
              num(p, 'flangeThickness'),
            ),
            depth: L,
            axis: 'x',
            at: [0, 0, 0],
            app: 'primary',
          },
        ],
        interfaces: [itf('top', 'Top flange', 'mechanical-mount', [0, H, 0], UP, 'neutral', ['flat-face'])],
      };
    },
  },
  {
    id: 'tslot',
    description:
      'T-slot aluminium extrusion (simplified profile: slot notches and centre bores; internal cavities omitted).',
    generate: (p) => {
      const L = num(p, 'length');
      const series = Number(str(p, 'series', '20'));
      const cw = num(p, 'cellsWide', 1);
      const ch = num(p, 'cellsHigh', 1);
      const { outline, holes } = tslotOutline(series, cw, ch);
      const s = mm(series);
      const slotTag = `tslot-${series}`;
      const interfaces: ComponentInterface[] = [
        itf('slot-top', 'Top slot', 'slider', [0, s * ch, 0], UP, 'female', [slotTag]),
        itf('slot-side', 'Side slot', 'slider', [0, (s * ch) / 2, (s * cw) / 2], PZ, 'female', [slotTag]),
        itf('end-a', 'End A (tapped bore)', 'bolt-hole', [-L / 2, s / 2, 0], NX, 'female', [
          series === 20 ? 'M5-thread' : series === 30 ? 'M8-thread' : 'M8-thread',
        ]),
        itf('end-b', 'End B (tapped bore)', 'bolt-hole', [L / 2, s / 2, 0], PX, 'female', [
          series === 20 ? 'M5-thread' : 'M8-thread',
        ]),
      ];
      return {
        solids: [
          {
            type: 'prism',
            outline: outline.map(([u, v]) => [u, v] as [number, number]),
            holes,
            depth: L,
            axis: 'x',
            at: [0, 0, 0],
            app: 'primary',
          },
        ],
        interfaces,
      };
    },
  },
  {
    id: 'bracket-l',
    description: 'L-bracket: base leg and upright leg (non-overlapping), with clearance holes.',
    check: (p) =>
      num(p, 'thickness') >= Math.min(num(p, 'legA'), num(p, 'legB'))
        ? ['Thickness must be smaller than both legs.']
        : [],
    generate: (p) => {
      const w = num(p, 'width');
      const a = num(p, 'legA');
      const b = num(p, 'legB');
      const t = num(p, 'thickness');
      const size = str(p, 'holeSize', 'M5');
      return {
        solids: [box(a, t, w, a / 2 - t / 2, t / 2, 0), box(t, b - t, w, 0, t + (b - t) / 2, 0)],
        interfaces: [
          ...boltHoles([[a / 2 + t / 2, 0]], size, t, 'base-hole'),
          itf(
            'upright-hole-1',
            `${size} clearance hole (upright)`,
            'bolt-hole',
            [-t / 2, t + (b - t) / 2, 0],
            NX,
            'female',
            [`${size}-clearance`],
          ),
        ],
      };
    },
  },
  {
    id: 'gear',
    description:
      'Spur gear / pulley / sprocket disc with simplified trapezoidal teeth and a bore (axis vertical).',
    check: (p) => {
      const rf = (num(p, 'module') * num(p, 'teeth')) / 2 - 1.25 * num(p, 'module');
      return num(p, 'bore') / 2 >= rf - 0.0005 ? ['Bore is too large for this module and tooth count.'] : [];
    },
    generate: (p) => {
      const m = num(p, 'module');
      const z = num(p, 'teeth');
      const f = num(p, 'faceWidth');
      const bore = num(p, 'bore');
      return {
        solids: [
          {
            type: 'prism',
            outline: gearOutline(m, z),
            holes: [circle(0, 0, bore / 2)],
            depth: f,
            axis: 'y',
            at: [0, f / 2, 0],
            app: 'primary',
          },
        ],
        interfaces: [
          itf(
            'bore',
            `Bore Ø${Math.round(bore * 1e5) / 100} mm`,
            'shaft-coupling',
            [0, f / 2, 0],
            UP,
            'female',
            [`shaft-${Math.round(bore * 1e5) / 100}mm`],
          ),
          itf(
            'mesh',
            `Gear mesh (module ${Math.round(m * 1e5) / 100})`,
            'revolute-joint',
            [(m * z) / 2, f / 2, 0],
            PX,
            'neutral',
            [`gear-module-${Math.round(m * 1e5) / 100}`],
          ),
        ],
      };
    },
  },
  {
    id: 'screw',
    description:
      'Metric screw/bolt (head per ISO 4762 / 7045 / 10642 / 4017; thread not modelled), standing on its tip.',
    generate: (p) => {
      const size = str(p, 'size');
      const L = num(p, 'length');
      const head = str(p, 'head', 'socket');
      const d = nominal(size);
      const table =
        head === 'pan' ? ISO7045 : head === 'countersunk' ? ISO10642 : head === 'hex' ? ISO4017 : ISO4762;
      const [dk, k] = (table[size] ?? [d * 1.7, d]).map(mm) as [number, number];
      const headSolid: Solid =
        head === 'hex'
          ? {
              type: 'prism',
              outline: regularPolygon(6, dk / Math.sqrt(3)),
              depth: k,
              axis: 'y',
              at: [0, L + k / 2, 0],
              app: 'primary',
            }
          : cyl(dk / 2, k, 'y', [0, L + k / 2, 0]);
      return {
        solids: [cyl(d / 2, L, 'y', [0, L / 2, 0]), headSolid],
        interfaces: [
          itf('thread', `${size} thread`, 'bolt-hole', [0, 0, 0], DOWN, 'male', [
            `${size}-thread`,
            `${size}-clearance`,
          ]),
        ],
      };
    },
  },
  {
    id: 'nut',
    description: 'Hex nut per ISO 4032 (thread not modelled).',
    generate: (p) => {
      const size = str(p, 'size');
      const [s, m] = (ISO4032[size] ?? [8, 4]).map(mm) as [number, number];
      return {
        solids: [
          {
            type: 'prism',
            outline: regularPolygon(6, s / Math.sqrt(3)),
            holes: [circle(0, 0, nominal(size) / 2)],
            depth: m,
            axis: 'y',
            at: [0, m / 2, 0],
            app: 'primary',
          },
        ],
        interfaces: [
          itf('thread', `${size} internal thread`, 'bolt-hole', [0, m, 0], UP, 'female', [`${size}-thread`]),
        ],
      };
    },
  },
  {
    id: 'washer',
    description: 'Plain washer per ISO 7089.',
    generate: (p) => {
      const size = str(p, 'size');
      const [d1, d2, h] = (ISO7089[size] ?? [5.3, 10, 1]).map(mm) as [number, number, number];
      return {
        solids: [{ type: 'tube', ro: d2 / 2, ri: d1 / 2, h, axis: 'y', at: [0, h / 2, 0], app: 'primary' }],
        interfaces: [
          itf('bore', `${size} bore`, 'bolt-hole', [0, h, 0], UP, 'neutral', [`${size}-clearance`]),
        ],
      };
    },
  },
  {
    id: 'ring',
    description: 'Annular part (retaining ring, shaft collar, spacer, insert, bushing) — axis vertical.',
    check: (p) =>
      num(p, 'innerDiameter') >= num(p, 'outerDiameter')
        ? ['Inner diameter must be smaller than the outer diameter.']
        : [],
    generate: (p) => {
      const ro = num(p, 'outerDiameter') / 2;
      const ri = num(p, 'innerDiameter') / 2;
      const h = num(p, 'height');
      return {
        solids: [{ type: 'tube', ro, ri, h, axis: 'y', at: [0, h / 2, 0], app: 'primary' }],
        interfaces: [
          itf('bore', 'Bore', 'shaft-coupling', [0, h / 2, 0], UP, 'female', [
            `shaft-${Math.round(ri * 2e5) / 100}mm`,
          ]),
        ],
      };
    },
  },
  {
    id: 'bearing',
    description: 'Deep-groove ball bearing envelope (ISO 15 boundary dimensions; balls/cage not modelled).',
    generate: (p) => {
      const [d, D, B] = (BEARINGS[str(p, 'series')] ?? [8, 22, 7]).map(mm) as [number, number, number];
      const ringT = (D - d) / 6;
      return {
        solids: [
          { type: 'tube', ro: D / 2, ri: D / 2 - ringT, h: B, axis: 'y', at: [0, B / 2, 0], app: 'metal' },
          { type: 'tube', ro: d / 2 + ringT, ri: d / 2, h: B, axis: 'y', at: [0, B / 2, 0], app: 'metal' },
          {
            type: 'tube',
            ro: D / 2 - ringT,
            ri: d / 2 + ringT,
            h: B * 0.9,
            axis: 'y',
            at: [0, B / 2, 0],
            app: 'black',
          },
        ],
        interfaces: [
          itf('bore', `Bore Ø${d * 1000} mm`, 'shaft-coupling', [0, B / 2, 0], UP, 'female', [
            `shaft-${d * 1000}mm`,
          ]),
          itf('housing', `Housing Ø${D * 1000} mm`, 'mechanical-mount', [D / 2, B / 2, 0], PX, 'male', [
            `bore-${D * 1000}mm`,
          ]),
        ],
      };
    },
  },
  {
    id: 'linear-rail',
    description: 'Linear guide rail with carriage (envelope).',
    generate: (p) => {
      const L = num(p, 'length');
      const w = num(p, 'railWidth');
      const h = w * 0.8;
      return {
        solids: [
          box(L, h, w, 0, h / 2, 0, 'metal'),
          box(w * 2.2, w * 0.9, w * 2.4, 0, h + w * 0.45 - w * 0.3, 0, 'metal-dark'),
        ],
        interfaces: [
          itf('carriage', 'Carriage mounting face', 'slider', [0, h + w * 0.6, 0], UP, 'neutral', [
            `rail-${Math.round(w * 1000)}mm`,
          ]),
          itf('base', 'Rail base', 'mechanical-mount', [0, 0, 0], DOWN, 'neutral', ['flat-face']),
        ],
      };
    },
  },
  {
    id: 'screw-drive',
    description: 'Lead/ball screw with nut block (thread not modelled), along X.',
    generate: (p) => {
      const L = num(p, 'length');
      const d = num(p, 'diameter');
      return {
        solids: [
          cyl(d / 2, L, 'x', [0, d * 1.2, 0], 'metal'),
          box(d * 2, d * 2.4, d * 2.6, 0, d * 1.2, 0, 'metal-dark'),
        ],
        interfaces: [
          itf('end', 'Drive end', 'shaft-coupling', [-L / 2, d * 1.2, 0], NX, 'male', [
            `shaft-${Math.round(d * 1000)}mm`,
          ]),
          itf('nut', 'Nut block', 'slider', [0, d * 2.4, 0], UP, 'neutral', ['flat-face']),
        ],
      };
    },
  },
  {
    id: 'belt',
    description: 'Closed-loop belt/chain envelope (pitch length, width) shown as a flat loop.',
    generate: (p) => {
      const Lp = num(p, 'pitchLength');
      const w = num(p, 'width');
      const t = num(p, 'thickness');
      const span = Lp / 2 - 0.02;
      return {
        solids: [
          box(span, t, w, 0, t / 2, -0.012, app(p, 'color', 'black')),
          box(span, t, w, 0, t / 2, 0.012, app(p, 'color', 'black')),
        ],
        interfaces: [],
      };
    },
  },
  {
    id: 'coupling',
    description: 'Shaft coupling / collar body (cylinder with bore), axis along X.',
    generate: (p) => {
      const D = num(p, 'outerDiameter');
      const L = num(p, 'length');
      const b1 = num(p, 'bore1');
      const b2 = num(p, 'bore2', b1);
      return {
        solids: [
          {
            type: 'tube',
            ro: D / 2,
            ri: Math.max(b1, b2) / 2,
            h: L,
            axis: 'x',
            at: [0, D / 2, 0],
            app: 'primary',
          },
        ],
        interfaces: [
          itf(
            'bore-1',
            `Bore 1 Ø${Math.round(b1 * 1e5) / 100} mm`,
            'shaft-coupling',
            [-L / 2, D / 2, 0],
            NX,
            'female',
            [`shaft-${Math.round(b1 * 1e5) / 100}mm`],
          ),
          itf(
            'bore-2',
            `Bore 2 Ø${Math.round(b2 * 1e5) / 100} mm`,
            'shaft-coupling',
            [L / 2, D / 2, 0],
            PX,
            'female',
            [`shaft-${Math.round(b2 * 1e5) / 100}mm`],
          ),
        ],
      };
    },
  },
  {
    id: 'spring',
    description:
      'Helical spring envelope: coils shown as stacked rings (helix not modelled; volume is approximate).',
    generate: (p) => {
      const D = num(p, 'outerDiameter');
      const d = num(p, 'wireDiameter');
      const L = num(p, 'freeLength');
      const n = Math.max(2, Math.round(num(p, 'coils')));
      const pitch = (L - d) / (n - 1);
      return {
        solids: Array.from({ length: n }, (_, i): Solid => ({
          type: 'tube',
          ro: D / 2,
          ri: D / 2 - d,
          h: d,
          axis: 'y',
          at: [0, d / 2 + i * pitch, 0],
          app: 'primary',
        })),
        interfaces: [
          itf('end-a', 'Seat A', 'mechanical-mount', [0, 0, 0], DOWN, 'neutral', [
            `spring-od-${Math.round(D * 1e4) / 10}mm`,
          ]),
          itf('end-b', 'Seat B', 'mechanical-mount', [0, L, 0], UP, 'neutral', [
            `spring-od-${Math.round(D * 1e4) / 10}mm`,
          ]),
        ],
      };
    },
  },
  {
    id: 'arm-link',
    description: 'Flat robot link with rounded ends and end holes (holes cut from the volume).',
    check: (p) =>
      num(p, 'holeDiameter') >= num(p, 'width') * 0.8
        ? ['Hole diameter leaves too little material around the end holes.']
        : [],
    generate: (p) => {
      const L = num(p, 'centreDistance');
      const w = num(p, 'width');
      const t = num(p, 'thickness');
      const hd = num(p, 'holeDiameter');
      return {
        solids: [
          {
            type: 'prism',
            outline: stadium(L, w),
            holes: [circle(-L / 2, 0, hd / 2), circle(L / 2, 0, hd / 2)],
            depth: t,
            axis: 'y',
            at: [0, t / 2, 0],
            app: 'primary',
          },
        ],
        interfaces: [
          itf('joint-a', 'Joint A', 'revolute-joint', [-L / 2, t / 2, 0], UP, 'female', [
            `pivot-${Math.round(hd * 1e5) / 100}mm`,
            'servo-horn-mount',
          ]),
          itf('joint-b', 'Joint B', 'revolute-joint', [L / 2, t / 2, 0], UP, 'female', [
            `pivot-${Math.round(hd * 1e5) / 100}mm`,
            'servo-horn-mount',
          ]),
        ],
      };
    },
  },
  {
    id: 'gripper',
    description: 'Two-finger parallel gripper (palm, rails, fingers) — illustrative mechanism envelope.',
    generate: (p) => {
      const open = num(p, 'opening');
      const fl = num(p, 'fingerLength');
      const pw = open + 0.03;
      return {
        solids: [
          box(pw, 0.012, 0.03, 0, 0.006, 0),
          box(pw - 0.004, 0.01, 0.012, 0, 0.017, 0, 'metal'),
          box(0.008, fl, 0.02, -open / 2 - 0.004, 0.012 + fl / 2, 0),
          box(0.008, fl, 0.02, open / 2 + 0.004, 0.012 + fl / 2, 0),
          box(0.024, 0.024, 0.024, 0, 0.012 + 0.012, -0.03, 'servo-blue'),
        ],
        interfaces: [
          itf('wrist', 'Wrist mount', 'mechanical-mount', [0, 0, 0], DOWN, 'neutral', [
            'servo-horn-mount',
            'M3-clearance',
          ]),
          itf('finger-a', 'Finger A', 'slider', [-open / 2, 0.012 + fl, 0], UP, null, ['gripper-finger']),
          itf('finger-b', 'Finger B', 'slider', [open / 2, 0.012 + fl, 0], UP, null, ['gripper-finger']),
        ],
      };
    },
  },
  {
    id: 'wheel',
    description: 'Wheel/roller (tyre + hub), axle along Z, resting on the base plane.',
    generate: (p) => {
      const D = num(p, 'diameter');
      const w = num(p, 'width');
      const hub = num(p, 'boreDiameter');
      return {
        solids: [
          { type: 'tube', ro: D / 2, ri: D * 0.36, h: w, axis: 'z', at: [0, D / 2, 0], app: 'rubber' },
          {
            type: 'tube',
            ro: D * 0.36,
            ri: hub / 2,
            h: w * 0.9,
            axis: 'z',
            at: [0, D / 2, 0],
            app: 'primary',
          },
        ],
        interfaces: [
          itf(
            'axle',
            `Axle bore Ø${Math.round(hub * 1e5) / 100} mm`,
            'shaft-coupling',
            [0, D / 2, 0],
            PZ,
            'female',
            [`shaft-${Math.round(hub * 1e5) / 100}mm`],
          ),
        ],
      };
    },
  },
  {
    id: 'motor-can',
    description: 'Round motor envelope (can + shaft), shaft along +X. Windings/magnets not modelled.',
    generate: (p) => {
      const D = num(p, 'diameter');
      const L = num(p, 'bodyLength');
      const sd = num(p, 'shaftDiameter');
      const sl = num(p, 'shaftLength');
      return {
        solids: [
          cyl(D / 2, L, 'x', [0, D / 2, 0], app(p, 'color', 'metal')),
          cyl(sd / 2, sl, 'x', [L / 2 + sl / 2, D / 2, 0], 'metal'),
        ],
        interfaces: [
          itf(
            'shaft',
            `Output shaft Ø${Math.round(sd * 1e5) / 100} mm`,
            'shaft-coupling',
            [L / 2 + sl, D / 2, 0],
            PX,
            'male',
            [`shaft-${Math.round(sd * 1e5) / 100}mm`],
          ),
          itf('face', 'Mounting face', 'mechanical-mount', [L / 2, D / 2, 0], PX, 'neutral', ['motor-face']),
          itf(
            'power-pos',
            'Terminal +',
            'power-terminal',
            [-L / 2, D / 2 + D * 0.2, 0],
            NX,
            'male',
            ['solder-tab'],
            'V+',
          ),
          itf(
            'power-neg',
            'Terminal −',
            'power-terminal',
            [-L / 2, D / 2 - D * 0.2, 0],
            NX,
            'male',
            ['solder-tab'],
            'V-',
          ),
        ],
      };
    },
  },
  {
    id: 'stepper',
    description: 'NEMA-frame stepper motor envelope (face size and hole pattern per NEMA ICS 16), shaft +Y.',
    generate: (p) => {
      const [face, spacing, shaft, pilot] = (NEMA[str(p, 'frame')] ?? NEMA['17']!).map(mm) as [
        number,
        number,
        number,
        number,
      ];
      const L = num(p, 'bodyLength');
      const sl = num(p, 'shaftLength');
      const holes: [number, number][] = [
        [-spacing / 2, -spacing / 2],
        [spacing / 2, -spacing / 2],
        [spacing / 2, spacing / 2],
        [-spacing / 2, spacing / 2],
      ];
      return {
        solids: [
          box(face, L, face, 0, L / 2, 0, 'black'),
          cyl(pilot / 2, mm(2), 'y', [0, L + mm(1), 0], 'metal'),
          cyl(shaft / 2, sl, 'y', [0, L + sl / 2, 0], 'metal'),
        ],
        interfaces: [
          itf(
            'shaft',
            `Shaft Ø${Math.round(shaft * 1e5) / 100} mm`,
            'shaft-coupling',
            [0, L + sl, 0],
            UP,
            'male',
            [`shaft-${Math.round(shaft * 1e5) / 100}mm`],
          ),
          ...holes.map(([x, z], i) =>
            itf(
              `face-hole-${i + 1}`,
              `Face hole ${i + 1} (M3, NEMA 17/14) `,
              'bolt-hole',
              [x, L, z],
              UP,
              'female',
              [str(p, 'frame') === '23' ? 'M5-thread' : 'M3-thread'],
            ),
          ),
          itf(
            'connector',
            'Motor connector (4-wire, bipolar)',
            'electrical-terminal',
            [face / 2, mm(5), 0],
            PX,
            'female',
            ['stepper-4-wire'],
          ),
        ],
      };
    },
  },
  {
    id: 'servo',
    description:
      'Hobby RC servo envelope: case, mounting flange with tabs, top boss and output spline; 3-wire lead.',
    generate: (p) => {
      const L = num(p, 'caseLength');
      const W = num(p, 'caseWidth');
      const H = num(p, 'caseHeight');
      const fy = num(p, 'flangeHeight');
      const fl = num(p, 'flangeLength');
      const total = num(p, 'overallHeight');
      const spline = str(p, 'spline', 'servo-spline-25T');
      const ox = -L / 2 + W / 2; // output shaft sits over one end of the case
      const solids: Solid[] = [
        box(L, H, W, 0, H / 2, 0, app(p, 'color', 'servo-blue')),
        box(fl, mm(2.5), W, 0, fy + mm(1.25), 0, app(p, 'color', 'servo-blue')),
        cyl(
          W / 2 - mm(0.5),
          total - H - mm(3),
          'y',
          [ox, H + (total - H - mm(3)) / 2, 0],
          app(p, 'color', 'servo-blue'),
        ),
        cyl(mm(2.4), mm(3), 'y', [ox, total - mm(1.5), 0], 'white'),
        box(mm(3), mm(1.2), mm(6), L / 2 + mm(1.5), mm(4), 0, 'black'),
      ];
      const tabX = (fl - L) / 4 + L / 2;
      return {
        solids,
        interfaces: [
          itf('output', 'Output spline', 'shaft-coupling', [ox, total, 0], UP, 'male', [
            spline,
            'servo-horn-mount',
          ]),
          itf('output-axis', 'Output rotation axis', 'revolute-joint', [ox, total, 0], UP, 'neutral', [
            'servo-output',
          ]),
          itf('tab-1', 'Mounting tab 1', 'bolt-hole', [-tabX, fy + mm(2.5), 0], UP, 'female', [
            str(p, 'tabScrew', 'M2') + '-clearance',
          ]),
          itf('tab-2', 'Mounting tab 2', 'bolt-hole', [tabX, fy + mm(2.5), 0], UP, 'female', [
            str(p, 'tabScrew', 'M2') + '-clearance',
          ]),
          itf(
            'signal',
            'Signal (PWM)',
            'gpio-pin',
            [L / 2 + mm(3), mm(4), mm(-2)],
            PX,
            'female',
            ['servo-3pin', '2.54mm-header'],
            'PWM',
          ),
          itf(
            'v-plus',
            'Power +',
            'power-terminal',
            [L / 2 + mm(3), mm(4), 0],
            PX,
            'female',
            ['servo-3pin', '2.54mm-header'],
            'V+',
          ),
          itf(
            'ground',
            'Ground',
            'power-terminal',
            [L / 2 + mm(3), mm(4), mm(2)],
            PX,
            'female',
            ['servo-3pin', '2.54mm-header'],
            'GND',
          ),
        ],
      };
    },
  },
  {
    id: 'linear-actuator',
    description: 'Linear actuator / cylinder envelope (body + rod at the given extension), along X.',
    generate: (p) => {
      const D = num(p, 'bodyDiameter');
      const L = num(p, 'bodyLength');
      const stroke = num(p, 'stroke');
      const ext = num(p, 'extensionPct', 0) / 100;
      const rd = D * 0.35;
      const rodL = Math.max(0.005, ext * stroke + 0.01);
      return {
        solids: [
          cyl(D / 2, L, 'x', [0, D / 2, 0], app(p, 'color', 'metal')),
          cyl(rd / 2, rodL, 'x', [L / 2 + rodL / 2, D / 2, 0], 'metal'),
        ],
        interfaces: [
          itf('rod-end', 'Rod end', 'slider', [L / 2 + rodL, D / 2, 0], PX, 'male', ['clevis']),
          itf('base-end', 'Base mount', 'mechanical-mount', [-L / 2, D / 2, 0], NX, 'neutral', ['clevis']),
          ...(str(p, 'drive', 'electric') === 'electric'
            ? [itf('power', 'Power leads', 'power-terminal', [-L / 2, D, 0], NX, 'male', ['wire-leads'])]
            : [
                itf('port', 'Fluid port', 'fluid-port', [-L / 2 + D / 2, D, 0], UP, 'female', [
                  'push-fit-6mm',
                ]),
              ]),
        ],
      };
    },
  },
  {
    id: 'board',
    description:
      'Electronics board: PCB substrate, major components and headers from a layout (or a generic module).',
    generate: (p) => {
      const layoutId = str(p, 'layout', 'generic');
      const t = mm(1.6);
      const L = boardLayout(layoutId);
      const w = layoutId === 'generic' ? num(p, 'length') : L.w;
      const d = layoutId === 'generic' ? num(p, 'width') : L.d;
      const pcbApp = layoutId === 'generic' ? app(p, 'pcbColor', 'pcb') : L.pcb;
      const solids: Solid[] = [
        {
          type: 'prism',
          outline: [
            [-w / 2, -d / 2],
            [w / 2, -d / 2],
            [w / 2, d / 2],
            [-w / 2, d / 2],
          ],
          holes: L.holes.map(([x, z]) => circle(x, z, mm(1.6))),
          depth: t,
          axis: 'y',
          at: [0, t / 2, 0],
          app: pcbApp,
        },
      ];
      const interfaces: ComponentInterface[] = [...L.connectors];
      if (layoutId === 'generic') {
        const ch = num(p, 'componentHeight', 0.003);
        solids.push(box(w * 0.4, ch, d * 0.45, 0, t + ch / 2, 0, app(p, 'componentColor', 'black')));
        const pins = str(p, 'pins', '');
        if (pins) {
          const names = pins
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const r = headerRow(names, -((names.length - 1) * mm(2.54)) / 2, d / 2 - mm(1.5), t, 'pin', false);
          solids.push(...r.solids);
          interfaces.push(...r.interfaces);
        }
      } else {
        solids.push(...L.parts);
        for (const [row, h] of L.headers.entries()) {
          const r = headerRow(h.names, h.x0, h.z, t, `${h.female ? 'header' : 'pin'}${row + 1}`, h.female);
          solids.push(...r.solids);
          interfaces.push(...r.interfaces);
        }
      }
      interfaces.push(
        ...L.holes.map(([x, z], i) =>
          itf(`mount-hole-${i + 1}`, `Mounting hole ${i + 1}`, 'bolt-hole', [x, t, z], UP, 'female', [
            'M3-clearance',
          ]),
        ),
      );
      return { solids, interfaces };
    },
  },
  {
    id: 'ultrasonic',
    description: 'Ultrasonic ranging module: PCB, two transducer cans (front, +Z), crystal, 4-pin header.',
    generate: (p) => {
      const w = num(p, 'length');
      const h = num(p, 'height');
      const t = mm(1.6);
      const td = num(p, 'transducerDiameter');
      const tl = num(p, 'transducerLength');
      const sep = num(p, 'transducerSpacing');
      const pins = str(p, 'pins', 'VCC,Trig,Echo,GND').split(',');
      // The board stands upright (PCB in the XY plane, facing +Z), base edge on the bench.
      const solids: Solid[] = [
        box(w, h, t, 0, h / 2, 0, 'pcb-blue'),
        cyl(td / 2, tl, 'z', [-sep / 2, h / 2, t / 2 + tl / 2], 'metal'),
        cyl(td / 2, tl, 'z', [sep / 2, h / 2, t / 2 + tl / 2], 'metal'),
        box(mm(10), mm(4), mm(3.5), 0, h - mm(3), t / 2 + mm(1.75), 'metal'),
        box(mm(2.54) * pins.length, mm(2.5), mm(2.54), 0, mm(1.25), -t / 2 - mm(1.27), 'black'),
      ];
      return {
        solids,
        interfaces: [
          itf('tx', 'Transmitter (40 kHz)', 'optical-interface', [-sep / 2, h / 2, t / 2 + tl], PZ, null, [
            'ultrasonic-40khz',
          ]),
          itf('rx', 'Receiver (40 kHz)', 'optical-interface', [sep / 2, h / 2, t / 2 + tl], PZ, null, [
            'ultrasonic-40khz',
          ]),
          ...pins.map((name, i) =>
            itf(
              `pin-${name.toLowerCase()}`,
              name,
              /VCC|GND/i.test(name) ? 'power-terminal' : 'gpio-pin',
              [(i - (pins.length - 1) / 2) * mm(2.54), 0, -t / 2 - mm(1.27)],
              DOWN,
              'male',
              ['2.54mm-header'],
              name,
            ),
          ),
        ],
      };
    },
  },
  {
    id: 'ic-package',
    description:
      'Integrated-circuit / discrete package body with leads (DIP, SOIC, QFP, TO-220, TO-92, SOT-23).',
    generate: (p) => {
      const pkg = str(p, 'package', 'DIP');
      const n = Math.max(2, Math.round(num(p, 'pins', 8)));
      const pitch = mm(pkg === 'DIP' ? 2.54 : pkg === 'QFP' ? 0.5 : 1.27);
      const solids: Solid[] = [];
      const interfaces: ComponentInterface[] = [];
      if (pkg === 'TO-220') {
        solids.push(
          box(mm(10), mm(9), mm(4.5), 0, mm(4.5) + mm(13), 0, 'black'),
          box(mm(10), mm(6), mm(1.3), 0, mm(4.5) + mm(13) + mm(7.5), -mm(1.6), 'metal'),
        );
        for (let i = 0; i < 3; i++) {
          const x = (i - 1) * mm(2.54);
          solids.push(box(mm(0.8), mm(13), mm(0.5), x, mm(6.5), 0, 'metal'));
          interfaces.push(
            itf(`lead-${i + 1}`, `Lead ${i + 1}`, 'electrical-terminal', [x, 0, 0], DOWN, 'male', [
              'through-hole-2.54',
            ]),
          );
        }
        interfaces.push(
          itf('tab', 'Heat-sink tab (M3)', 'mechanical-mount', [0, mm(25), -mm(2.2)], NZ, 'neutral', [
            'M3-clearance',
            'heat-sink-tab',
          ]),
        );
        return { solids, interfaces };
      }
      if (pkg === 'TO-92' || pkg === 'axial' || pkg === 'radial' || pkg === 'disc') {
        const bodyD = num(p, 'bodyDiameter', mm(4.8));
        const bodyL = num(p, 'bodyLength', mm(5));
        if (pkg === 'axial')
          solids.push(
            cyl(bodyD / 2, bodyL, 'x', [0, bodyD / 2, 0], app(p, 'color', 'yellow')),
            box(bodyL + mm(10), mm(0.6), mm(0.6), 0, bodyD / 2, 0, 'metal'),
          );
        else if (pkg === 'disc')
          solids.push(
            cyl(bodyD / 2, mm(2.5), 'z', [0, mm(4) + bodyD / 2, 0], app(p, 'color', 'yellow')),
            box(mm(0.5), mm(4), mm(0.5), -mm(1.27), mm(2), 0, 'metal'),
            box(mm(0.5), mm(4), mm(0.5), mm(1.27), mm(2), 0, 'metal'),
          );
        else
          solids.push(
            cyl(
              bodyD / 2,
              bodyL,
              'y',
              [0, mm(3) + bodyL / 2, 0],
              app(p, 'color', pkg === 'TO-92' ? 'black' : 'blue'),
            ),
            ...[-1, 1].map((s) => box(mm(0.5), mm(3), mm(0.5), s * mm(1.27), mm(1.5), 0, 'metal')),
          );
        const leads = pkg === 'TO-92' ? 3 : 2;
        for (let i = 0; i < leads; i++)
          interfaces.push(
            itf(
              `lead-${i + 1}`,
              `Lead ${i + 1}`,
              'electrical-terminal',
              [
                pkg === 'axial' ? (i === 0 ? -1 : 1) * (bodyL / 2 + mm(5)) : (i - (leads - 1) / 2) * mm(2.54),
                0,
                0,
              ],
              DOWN,
              'male',
              ['through-hole-2.54'],
            ),
          );
        return { solids, interfaces };
      }
      const perSide = pkg === 'QFP' ? Math.ceil(n / 4) : Math.ceil(n / 2);
      const bodyL = perSide * pitch + mm(1);
      const bodyW = pkg === 'DIP' ? mm(6.4) : pkg === 'QFP' ? bodyL : mm(3.9);
      const bodyH = pkg === 'DIP' ? mm(3.3) : mm(1.5);
      const y0 = pkg === 'DIP' ? mm(0.5) : mm(0.1);
      solids.push(box(bodyL, bodyH, bodyW, 0, y0 + bodyH / 2, 0, 'black'));
      const sides = pkg === 'QFP' ? 4 : 2;
      let k = 0;
      for (let s = 0; s < sides && k < n; s++)
        for (let i = 0; i < perSide && k < n; i++, k++) {
          const along = (i - (perSide - 1) / 2) * pitch;
          const out = (s % 2 === 0 ? -1 : 1) * (bodyW / 2 + mm(0.5));
          const pos: V3 = s < 2 ? [along, y0, out] : [out, y0, along];
          solids.push(
            box(s < 2 ? mm(0.3) : mm(1), mm(0.3), s < 2 ? mm(1) : mm(0.3), pos[0], mm(0.15), pos[2], 'metal'),
          );
          interfaces.push(
            itf(`pin-${k + 1}`, `Pin ${k + 1}`, 'electrical-terminal', [pos[0], 0, pos[2]], DOWN, 'male', [
              pkg === 'DIP' ? 'through-hole-2.54' : `smd-${pkg.toLowerCase()}`,
            ]),
          );
        }
      return { solids, interfaces };
    },
  },
  {
    id: 'breadboard',
    description: 'Solderless breadboard (generic): body with tie-point field and power rails.',
    generate: (p) => {
      const L = num(p, 'length');
      const W = num(p, 'width');
      const H = num(p, 'height');
      return {
        solids: [
          box(L, H, W, 0, H / 2, 0, 'white'),
          box(L * 0.95, mm(0.3), mm(2), 0, H + mm(0.15), 0, 'grey'),
          box(L * 0.9, mm(0.3), mm(1), 0, H + mm(0.15), -W / 2 + mm(4), 'red'),
          box(L * 0.9, mm(0.3), mm(1), 0, H + mm(0.15), W / 2 - mm(4), 'blue'),
        ],
        interfaces: [
          itf(
            'tie-points',
            'Tie-point field (2.54 mm grid)',
            'electrical-terminal',
            [0, H, -W / 4],
            UP,
            'female',
            ['2.54mm-header', 'jumper-wire'],
          ),
          itf('rail', 'Power rail', 'power-terminal', [0, H, W / 2 - mm(4)], UP, 'female', [
            '2.54mm-header',
            'jumper-wire',
          ]),
        ],
      };
    },
  },
  {
    id: 'wire',
    description: 'Wire / cable / jumper lead lying along X with optional end housings.',
    generate: (p) => {
      const L = num(p, 'length');
      const d = num(p, 'diameter');
      const ends = str(p, 'ends', 'none');
      const color = app(p, 'color', 'red');
      const hs = Math.max(mm(2.6), d + mm(0.4));
      const housingL = ends === 'none' ? 0 : mm(14);
      const cy = ends === 'none' ? d / 2 : hs / 2;
      const solids: Solid[] = [cyl(d / 2, L - 2 * housingL, 'x', [0, cy, 0], color)];
      const interfaces: ComponentInterface[] = [];
      if (ends !== 'none') {
        for (const s of [-1, 1])
          solids.push(box(housingL, hs, hs, s * (L / 2 - housingL / 2), hs / 2, 0, 'black'));
        const g = (e: string): ComponentInterface['gender'] => (e === 'female' ? 'female' : 'male');
        const [ea, eb] =
          ends === 'male-female'
            ? ['male', 'female']
            : [ends.split('-')[0]!, ends.split('-')[1] ?? ends.split('-')[0]!];
        interfaces.push(
          itf('end-a', `End A (${ea})`, 'electrical-terminal', [-L / 2, cy, 0], NX, g(ea!), [
            '2.54mm-header',
            'jumper-wire',
          ]),
          itf('end-b', `End B (${eb})`, 'electrical-terminal', [L / 2, cy, 0], PX, g(eb!), [
            '2.54mm-header',
            'jumper-wire',
          ]),
        );
      } else {
        interfaces.push(
          itf('end-a', 'End A', 'electrical-terminal', [-L / 2, cy, 0], NX, null, ['bare-wire']),
          itf('end-b', 'End B', 'electrical-terminal', [L / 2, cy, 0], PX, null, ['bare-wire']),
        );
      }
      return { solids, interfaces };
    },
  },
  {
    id: 'cell',
    description:
      'Battery cell (cylindrical designations per IEC/industry, prismatic/pouch, coin), lying along X.',
    generate: (p) => {
      const kind = str(p, 'format', '18650');
      if (kind === 'pouch' || kind === '9V') {
        const L = kind === '9V' ? mm(48.5) : num(p, 'length');
        const W = kind === '9V' ? mm(26.5) : num(p, 'width');
        const T = kind === '9V' ? mm(17.5) : num(p, 'thickness');
        return {
          solids: [box(L, T, W, 0, T / 2, 0, app(p, 'color', kind === '9V' ? 'black' : 'metal'))],
          interfaces: [
            itf(
              'pos',
              'Positive terminal',
              'power-terminal',
              [L / 2, T / 2, -W / 4],
              PX,
              null,
              [kind === '9V' ? '9V-snap' : 'pouch-tab'],
              'V+',
            ),
            itf(
              'neg',
              'Negative terminal',
              'power-terminal',
              [L / 2, T / 2, W / 4],
              PX,
              null,
              [kind === '9V' ? '9V-snap' : 'pouch-tab'],
              'V-',
            ),
          ],
        };
      }
      const [D, L] = (CELLS[kind] ?? CELLS['18650']!).map(mm) as [number, number];
      if (kind === 'CR2032')
        return {
          solids: [cyl(D / 2, L, 'y', [0, L / 2, 0], 'metal')],
          interfaces: [
            itf(
              'pos',
              'Positive (+) face',
              'power-terminal',
              [0, L, 0],
              UP,
              null,
              ['coin-holder-20mm'],
              'V+',
            ),
            itf(
              'neg',
              'Negative (−) face',
              'power-terminal',
              [0, 0, 0],
              DOWN,
              null,
              ['coin-holder-20mm'],
              'V-',
            ),
          ],
        };
      return {
        solids: [
          cyl(D / 2, L, 'x', [0, D / 2, 0], app(p, 'color', 'blue')),
          cyl(D * 0.2, mm(1), 'x', [L / 2 + mm(0.5), D / 2, 0], 'metal'),
        ],
        interfaces: [
          itf(
            'pos',
            'Positive terminal',
            'power-terminal',
            [L / 2 + mm(1), D / 2, 0],
            PX,
            null,
            [`cell-${kind}`],
            'V+',
          ),
          itf(
            'neg',
            'Negative terminal',
            'power-terminal',
            [-L / 2, D / 2, 0],
            NX,
            null,
            [`cell-${kind}`],
            'V-',
          ),
        ],
      };
    },
  },
  {
    id: 'cell-pack',
    description: 'Battery pack or holder: an S×P arrangement of cylindrical cells in a tray, with leads.',
    generate: (p) => {
      const kind = str(p, 'format', 'AA');
      const s = Math.round(num(p, 'series'));
      const par = Math.round(num(p, 'parallel', 1));
      const [D, L] = (CELLS[kind] ?? CELLS.AA!).map(mm) as [number, number];
      const n = s * par;
      const W = n * (D + mm(1)) + mm(2);
      const solids: Solid[] = [box(L + mm(6), mm(2), W, 0, mm(1), 0, 'black')];
      for (let i = 0; i < n; i++)
        solids.push(
          cyl(
            D / 2,
            L,
            'x',
            [0, mm(2) + D / 2, -W / 2 + mm(1) + (D + mm(1)) * (i + 0.5)],
            bool(p, 'cellsFitted', true) ? app(p, 'color', 'blue') : 'black',
          ),
        );
      return {
        solids,
        interfaces: [
          itf(
            'pos',
            'Pack + lead',
            'power-terminal',
            [-L / 2 - mm(3), mm(2), -W / 2],
            NX,
            'male',
            ['wire-leads', 'jst-ph-2'],
            'V+',
          ),
          itf(
            'neg',
            'Pack − lead',
            'power-terminal',
            [-L / 2 - mm(3), mm(2), W / 2],
            NX,
            'male',
            ['wire-leads', 'jst-ph-2'],
            'V-',
          ),
        ],
      };
    },
  },
  {
    id: 'enclosure',
    description: 'Open-top box enclosure (floor + four walls, non-overlapping) with an optional lid.',
    check: (p) =>
      2 * num(p, 'wall') >= Math.min(num(p, 'length'), num(p, 'width'))
        ? ['Walls are too thick for the enclosure size.']
        : [],
    generate: (p) => {
      const L = num(p, 'length');
      const W = num(p, 'width');
      const H = num(p, 'height');
      const t = num(p, 'wall');
      const solids: Solid[] = [
        box(L, t, W, 0, t / 2, 0),
        box(L, H - t, t, 0, t + (H - t) / 2, -W / 2 + t / 2),
        box(L, H - t, t, 0, t + (H - t) / 2, W / 2 - t / 2),
        box(t, H - t, W - 2 * t, -L / 2 + t / 2, t + (H - t) / 2, 0),
        box(t, H - t, W - 2 * t, L / 2 - t / 2, t + (H - t) / 2, 0),
      ];
      if (bool(p, 'lid', false)) solids.push(box(L, t, W, 0, H + t / 2, 0));
      return {
        solids,
        interfaces: [
          itf('floor', 'Internal floor (PCB mount)', 'mechanical-mount', [0, t, 0], UP, 'neutral', [
            'pcb-standoff',
            'M3-clearance',
          ]),
          itf('lid-seat', 'Lid seat', 'mechanical-mount', [0, H, 0], UP, 'neutral', ['enclosure-lid']),
        ],
      };
    },
  },
  {
    id: 'heatsink',
    description: 'Finned heat sink (base + rectangular fins).',
    generate: (p) => {
      const L = num(p, 'length');
      const W = num(p, 'width');
      const H = num(p, 'height');
      const n = Math.max(2, Math.round(num(p, 'fins')));
      const base = Math.min(H * 0.25, mm(4));
      const ft = Math.min(mm(1.5), (W / n) * 0.4);
      const solids: Solid[] = [box(L, base, W, 0, base / 2, 0)];
      for (let i = 0; i < n; i++)
        solids.push(
          box(L, H - base, ft, 0, base + (H - base) / 2, -W / 2 + ft / 2 + ((W - ft) * i) / (n - 1)),
        );
      return {
        solids,
        interfaces: [
          itf('base', 'Thermal contact face', 'mechanical-mount', [0, 0, 0], DOWN, 'neutral', [
            'thermal-interface',
          ]),
        ],
      };
    },
  },
  {
    id: 'fan',
    description: 'Axial fan (square frame, hub) — standard frame sizes; blades not modelled.',
    generate: (p) => {
      const s = num(p, 'size');
      const d = num(p, 'depth');
      return {
        solids: [
          {
            type: 'prism',
            outline: [
              [-s / 2, -s / 2],
              [s / 2, -s / 2],
              [s / 2, s / 2],
              [-s / 2, s / 2],
            ],
            holes: [circle(0, 0, s * 0.47, 32)],
            depth: d,
            axis: 'z',
            at: [0, s / 2, 0],
            app: 'black',
          },
          cyl(s * 0.18, d, 'z', [0, s / 2, 0], 'black'),
        ],
        interfaces: [
          itf('airflow', 'Airflow direction', 'fluid-port', [0, s / 2, d / 2], PZ, null, [
            `fan-${Math.round(s * 1000)}mm`,
          ]),
          itf('power', 'Fan connector', 'power-terminal', [s / 2, mm(5), 0], PX, 'female', ['fan-2-3-4-pin']),
        ],
      };
    },
  },
  {
    id: 'propeller',
    description:
      'Two/three-blade propeller envelope (diameter; pitch is metadata, blade twist not modelled).',
    generate: (p) => {
      const D = num(p, 'diameter');
      const blades = Math.round(num(p, 'blades', 2));
      const hub = mm(6);
      const solids: Solid[] = [cyl(hub, mm(7), 'y', [0, mm(3.5), 0], 'black')];
      for (let i = 0; i < blades; i++) {
        const a = (2 * Math.PI * i) / blades;
        solids.push(
          box(
            D / 2 - hub,
            mm(2),
            D * 0.08,
            Math.cos(a) * (D / 4 + hub / 2),
            mm(4),
            -Math.sin(a) * (D / 4 + hub / 2),
            app(p, 'color', 'black'),
            a,
          ),
        );
      }
      return {
        solids,
        interfaces: [itf('hub', 'Hub bore', 'shaft-coupling', [0, 0, 0], DOWN, 'female', ['prop-adapter'])],
      };
    },
  },
  {
    id: 'lens',
    description:
      'Round optical element (lens/mirror/filter/window) with optical axis along +Z, standing upright.',
    generate: (p) => {
      const D = num(p, 'diameter');
      const t = num(p, 'thickness');
      return {
        solids: [cyl(D / 2, t, 'z', [0, D / 2, 0], app(p, 'color', 'glass'))],
        interfaces: [
          itf('optical-axis', 'Optical axis', 'optical-interface', [0, D / 2, t / 2], PZ, null, [
            `optic-${Math.round(D * 1e4) / 10}mm`,
          ]),
          itf('mount', 'Edge mount', 'mechanical-mount', [0, 0, 0], DOWN, 'neutral', [
            `optic-${Math.round(D * 1e4) / 10}mm`,
            'lens-mount',
          ]),
        ],
      };
    },
  },
  {
    id: 'specimen',
    description:
      'Flat dog-bone tensile specimen (overall length, grip and gauge widths, gauge length, thickness).',
    check: (p) =>
      num(p, 'gaugeWidth') >= num(p, 'gripWidth')
        ? ['Gauge width must be narrower than the grip width.']
        : num(p, 'gaugeLength') >= num(p, 'length') * 0.8
          ? ['Gauge length too long for the specimen length.']
          : [],
    generate: (p) => {
      const L = num(p, 'length');
      const G = num(p, 'gripWidth');
      const g = num(p, 'gaugeWidth');
      const gl = num(p, 'gaugeLength');
      const t = num(p, 'thickness');
      const grip = L * 0.25;
      const outline: [number, number][] = [
        [-L / 2, -G / 2],
        [-L / 2 + grip, -G / 2],
        [-gl / 2, -g / 2],
        [gl / 2, -g / 2],
        [L / 2 - grip, -G / 2],
        [L / 2, -G / 2],
        [L / 2, G / 2],
        [L / 2 - grip, G / 2],
        [gl / 2, g / 2],
        [-gl / 2, g / 2],
        [-L / 2 + grip, G / 2],
        [-L / 2, G / 2],
      ];
      return {
        solids: [{ type: 'prism', outline, depth: t, axis: 'y', at: [0, t / 2, 0], app: 'primary' }],
        interfaces: [
          itf('grip-a', 'Grip end A', 'mechanical-mount', [-L / 2 + grip / 2, t, 0], UP, 'neutral', [
            'wedge-grip',
          ]),
          itf('grip-b', 'Grip end B', 'mechanical-mount', [L / 2 - grip / 2, t, 0], UP, 'neutral', [
            'wedge-grip',
          ]),
        ],
      };
    },
  },
  {
    id: 'shape',
    description: 'Basic shape (box, cylinder or sphere) — custom parametric geometry and test objects.',
    generate: (p) => {
      const shape = str(p, 'shape', 'box');
      const a = num(p, 'sizeX');
      const b = num(p, 'sizeY', a);
      const c = num(p, 'sizeZ', a);
      const solid: Solid =
        shape === 'sphere'
          ? { type: 'sphere', r: a / 2, at: [0, a / 2, 0], app: 'primary' }
          : shape === 'cylinder'
            ? cyl(a / 2, b, 'y', [0, b / 2, 0])
            : box(a, b, c, 0, b / 2, 0);
      return {
        solids: [solid],
        interfaces: [itf('base', 'Base', 'mechanical-mount', [0, 0, 0], DOWN, 'neutral', ['flat-face'])],
      };
    },
  },
  {
    id: 'generic-package',
    description:
      'Generic labelled block for catalogue entries awaiting a specialised model (honest placeholder, not a product replica).',
    generate: (p) => {
      const L = num(p, 'length');
      const W = num(p, 'width');
      const H = num(p, 'height');
      return {
        solids: [
          box(L, H, W, 0, H / 2, 0, app(p, 'color', 'grey')),
          box(L * 0.6, mm(0.2), W * 0.4, 0, H + mm(0.1), 0, 'label'),
        ],
        interfaces: [
          itf('base', 'Base (generic mount)', 'mechanical-mount', [0, 0, 0], DOWN, 'neutral', ['flat-face']),
        ],
      };
    },
  },
];

export const GENERATORS: ReadonlyMap<string, Generator> = new Map(G.map((g) => [g.id, g]));
export const getGenerator = (id: string) => GENERATORS.get(id);
