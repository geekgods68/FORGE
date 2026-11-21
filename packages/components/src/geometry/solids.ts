/**
 * Portable solid primitives produced by geometry generators (metres, component-local
 * frame: origin at the footprint centre of the base, +Y up, long axis along +X).
 * Renderer-agnostic: the desktop app turns them into GPU geometry; this package
 * computes exact volumes and bounding boxes from them.
 */
export type V3 = [number, number, number];
export type Axis = 'x' | 'y' | 'z';

/** Visual appearance slot. `primary` takes the instance's assigned material. */
export const APPEARANCES = [
  'primary',
  'metal',
  'metal-dark',
  'black',
  'white',
  'grey',
  'pcb',
  'pcb-blue',
  'copper',
  'gold',
  'rubber',
  'blue',
  'red',
  'yellow',
  'green',
  'glass',
  'screen',
  'label',
  'servo-blue',
  'connector',
] as const;
export type Appearance = (typeof APPEARANCES)[number];

export type Solid =
  | { type: 'box'; size: V3; at: V3; yaw?: number; app: Appearance }
  | { type: 'cylinder'; r: number; h: number; axis: Axis; at: V3; app: Appearance; segments?: number }
  | { type: 'tube'; ro: number; ri: number; h: number; axis: Axis; at: V3; app: Appearance }
  | {
      type: 'prism';
      /** Outline (CCW) in the plane ⟂ axis: axis z → (x, y); axis x → (z, y); axis y → (x, z). */
      outline: [number, number][];
      holes?: [number, number][][];
      depth: number;
      axis: Axis;
      /** Centre of the extrusion along the axis; outline coordinates are relative to it. */
      at: V3;
      app: Appearance;
    }
  | { type: 'sphere'; r: number; at: V3; app: Appearance };

export const polygonArea = (pts: [number, number][]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
};

/** Exact volume of a solid (m³). Prisms subtract their holes. */
export function solidVolume(s: Solid): number {
  switch (s.type) {
    case 'box':
      return s.size[0] * s.size[1] * s.size[2];
    case 'cylinder':
      return Math.PI * s.r * s.r * s.h;
    case 'tube':
      return Math.PI * (s.ro * s.ro - s.ri * s.ri) * s.h;
    case 'prism':
      return (polygonArea(s.outline) - (s.holes ?? []).reduce((n, h) => n + polygonArea(h), 0)) * s.depth;
    case 'sphere':
      return (4 / 3) * Math.PI * s.r ** 3;
  }
}

export interface Bounds {
  min: V3;
  max: V3;
}

/** Extents along (x, y, z) of an axis-aligned shape of radius r and length h along `axis`. */
const axial = (r: number, h: number, axis: Axis): V3 =>
  axis === 'x' ? [h / 2, r, r] : axis === 'y' ? [r, h / 2, r] : [r, r, h / 2];

/** Axis-aligned bounds of one solid in the component frame. */
export function solidBounds(s: Solid): Bounds {
  let half: V3;
  let centre: V3 = s.at;
  switch (s.type) {
    case 'box': {
      const c = Math.abs(Math.cos(s.yaw ?? 0));
      const n = Math.abs(Math.sin(s.yaw ?? 0));
      half = [(c * s.size[0] + n * s.size[2]) / 2, s.size[1] / 2, (n * s.size[0] + c * s.size[2]) / 2];
      break;
    }
    case 'cylinder':
      half = axial(s.r, s.h, s.axis);
      break;
    case 'tube':
      half = axial(s.ro, s.h, s.axis);
      break;
    case 'sphere':
      half = [s.r, s.r, s.r];
      break;
    case 'prism': {
      const us = s.outline.map((p) => p[0]);
      const vs = s.outline.map((p) => p[1]);
      const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
      const uc = (u0 + u1) / 2;
      const vc = (v0 + v1) / 2;
      const hu = (u1 - u0) / 2;
      const hv = (v1 - v0) / 2;
      const d = s.depth / 2;
      if (s.axis === 'z') {
        half = [hu, hv, d];
        centre = [s.at[0] + uc, s.at[1] + vc, s.at[2]];
      } else if (s.axis === 'x') {
        half = [d, hv, hu];
        centre = [s.at[0], s.at[1] + vc, s.at[2] + uc];
      } else {
        half = [hu, d, hv];
        centre = [s.at[0] + uc, s.at[1], s.at[2] + vc];
      }
      break;
    }
  }
  return {
    min: [centre[0] - half[0], centre[1] - half[1], centre[2] - half[2]],
    max: [centre[0] + half[0], centre[1] + half[1], centre[2] + half[2]],
  };
}

export function unionBounds(solids: readonly Solid[]): Bounds {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const s of solids) {
    const b = solidBounds(s);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, b.min[i]!);
      max[i] = Math.max(max[i]!, b.max[i]!);
    }
  }
  return { min, max };
}

/** Regular polygon outline (CCW), e.g. hexagon for nuts (`acrossFlats` → circumradius). */
export function regularPolygon(n: number, circumradius: number, phase = 0): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / n;
    return [circumradius * Math.cos(a), circumradius * Math.sin(a)] as [number, number];
  });
}

/** Circle approximated by an n-gon (for prism holes). */
export const circle = (cx: number, cy: number, r: number, n = 24): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
  }).reverse(); // holes clockwise
