import { devicePins, type ElectricalPart, type Wire } from '@forge/engineering-core';

/**
 * Schematic symbol geometry (grid units; 1 unit = 10 px at 100 % zoom). Each symbol defines
 * its pin anchor points relative to the part origin; rotation is applied about the origin.
 * Geometry only — connectivity never depends on where anything is drawn.
 */
export type Pt = [number, number];
export interface SymbolLayout {
  kind: 'two' | 'ground' | 'junction' | 'three' | 'box';
  pins: Map<string, Pt>;
  /** Box symbols: half-width / half-height. */
  w: number;
  h: number;
}

const TWO_PINS: Record<string, [string, string]> = {
  resistor: ['p1', 'p2'],
  inductor: ['p1', 'p2'],
  switch: ['p1', 'p2'],
  vsource: ['pos', 'neg'],
  isource: ['pos', 'neg'],
  diode: ['a', 'k'],
  led: ['a', 'k'],
};

export function symbolLayout(part: ElectricalPart): SymbolLayout {
  const d = part.device;
  const pins = new Map<string, Pt>();
  if (d.type === 'capacitor') {
    const [a, b] = d.polarized ? ['pos', 'neg'] : ['p1', 'p2'];
    pins.set(a, [-3, 0]).set(b, [3, 0]);
    return { kind: 'two', pins, w: 3, h: 1 };
  }
  const two = TWO_PINS[d.type];
  if (two) {
    pins.set(two[0], [-3, 0]).set(two[1], [3, 0]);
    return { kind: 'two', pins, w: 3, h: 1.5 };
  }
  if (d.type === 'ground') return { kind: 'ground', pins: pins.set('gnd', [0, -1]), w: 1.5, h: 1.5 };
  if (d.type === 'junction') return { kind: 'junction', pins: pins.set('j', [0, 0]), w: 0.5, h: 0.5 };
  if (d.type === 'npn' || d.type === 'nmos') {
    const [c, b, e] = d.type === 'npn' ? ['c', 'b', 'e'] : ['d', 'g', 's'];
    pins.set(b, [-3, 0]).set(c, [2, -3]).set(e, [2, 3]);
    return { kind: 'three', pins, w: 2.5, h: 3 };
  }
  if (d.type === 'potentiometer') {
    pins.set('a', [-3, 0]).set('b', [3, 0]).set('w', [0, -3]);
    return { kind: 'three', pins, w: 3, h: 3 };
  }
  // Boxes: inputs/power/ground on the left, outputs on the right (MCU: digital pins right).
  const all = devicePins(d);
  const right = all.filter((p) =>
    d.type === 'mcu' ? p.id.startsWith('D') : p.direction === 'output' || p.id === 'out+' || p.id === 'out-',
  );
  const left = all.filter((p) => !right.includes(p));
  const rows = Math.max(left.length, right.length);
  const h = rows + 1;
  const w = d.type === 'mcu' ? 6 : 4;
  left.forEach((p, i) => pins.set(p.id, [-w - 2, -rows + 1 + i * 2]));
  right.forEach((p, i) => pins.set(p.id, [w + 2, -rows + 1 + i * 2]));
  return { kind: 'box', pins, w, h };
}

const rot = (p: Pt, deg: number): Pt => {
  switch (deg) {
    case 90:
      return [-p[1], p[0]];
    case 180:
      return [-p[0], -p[1]];
    case 270:
      return [p[1], -p[0]];
    default:
      return p;
  }
};

/** Absolute schematic position of a part's pin. */
export function pinPoint(part: ElectricalPart, pin: string, layout = symbolLayout(part)): Pt | null {
  const local = layout.pins.get(pin);
  if (!local) return null;
  const [x, y] = rot(local, part.schematic.rotation);
  return [part.schematic.x + x, part.schematic.y + y];
}

/** Wire polyline: explicit route points, or an automatic orthogonal (L-shaped) route. */
export function wirePath(wire: Wire, a: Pt, b: Pt): Pt[] {
  if (wire.route.length) return [a, ...wire.route, b];
  if (a[0] === b[0] || a[1] === b[1]) return [a, b];
  return [a, [b[0], a[1]], b];
}

export const snap = (v: number) => Math.round(v);
