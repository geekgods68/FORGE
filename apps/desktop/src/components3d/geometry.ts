import type { Appearance, Solid } from '@forge/components';
import type { BufferGeometry } from 'three';
import { BoxGeometry, CylinderGeometry, ExtrudeGeometry, Path, Shape, SphereGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Converts portable component solids (metres, component frame) into GPU geometry.
 * All solids of one appearance are MERGED into a single BufferGeometry, so a component
 * costs one draw call per appearance (e.g. a servo: body + white spline + black lead),
 * independent of how many parts its generator emits.
 */
function shapeFrom(outline: [number, number][], holes: [number, number][][] = []): Shape {
  const s = new Shape(outline.map(([x, y]) => ({ x, y }) as never));
  for (const h of holes) s.holes.push(new Path(h.map(([x, y]) => ({ x, y }) as never)));
  return s;
}

/** Extrusion of a 2D (u, v) shape along `axis`, centred on the extrusion, translated to `at`. */
function extrude(
  shape: Shape,
  depth: number,
  axis: 'x' | 'y' | 'z',
  at: [number, number, number],
  curveSegments = 24,
) {
  const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments });
  g.translate(0, 0, -depth / 2);
  if (axis === 'x') g.rotateY(-Math.PI / 2); // u → z, extrusion → x
  if (axis === 'y') g.rotateX(Math.PI / 2); // v → z, extrusion → y
  g.translate(...at);
  return g;
}

export function solidGeometry(s: Solid): BufferGeometry {
  switch (s.type) {
    case 'box': {
      const g = new BoxGeometry(...s.size);
      if (s.yaw) g.rotateY(s.yaw);
      return g.translate(...s.at);
    }
    case 'cylinder': {
      const g = new CylinderGeometry(s.r, s.r, s.h, s.segments ?? 32);
      if (s.axis === 'x') g.rotateZ(Math.PI / 2);
      if (s.axis === 'z') g.rotateX(Math.PI / 2);
      return g.translate(...s.at);
    }
    case 'tube': {
      const ring = new Shape();
      ring.absarc(0, 0, s.ro, 0, Math.PI * 2, false);
      const hole = new Path();
      hole.absarc(0, 0, s.ri, 0, Math.PI * 2, true);
      ring.holes.push(hole);
      // Ring extruded along z then oriented like a cylinder of the same axis.
      const g = new ExtrudeGeometry(ring, { depth: s.h, bevelEnabled: false, curveSegments: 32 });
      g.translate(0, 0, -s.h / 2);
      if (s.axis === 'x') g.rotateY(Math.PI / 2);
      if (s.axis === 'y') g.rotateX(Math.PI / 2);
      return g.translate(...s.at);
    }
    case 'prism':
      return extrude(shapeFrom(s.outline, s.holes), s.depth, s.axis, s.at);
    case 'sphere':
      return new SphereGeometry(s.r, 32, 16).translate(...s.at);
  }
}

/** Merge solids per appearance. Every input geometry is disposed after merging. */
export function buildAppearanceGeometries(solids: readonly Solid[]): Map<Appearance, BufferGeometry> {
  const groups = new Map<Appearance, BufferGeometry[]>();
  for (const s of solids) {
    const g = solidGeometry(s);
    const flat = g.index ? g.toNonIndexed() : g;
    if (flat !== g) g.dispose();
    // ExtrudeGeometry emits uv + normal + position; Box/Cylinder/Sphere too — keep the common set.
    for (const name of Object.keys(flat.attributes))
      if (!['position', 'normal', 'uv'].includes(name)) flat.deleteAttribute(name);
    flat.clearGroups();
    groups.set(s.app, [...(groups.get(s.app) ?? []), flat]);
  }
  const out = new Map<Appearance, BufferGeometry>();
  for (const [app, list] of groups) {
    const merged = list.length === 1 ? list[0]! : mergeGeometries(list, false);
    if (!merged) throw new Error(`Could not merge geometry for appearance ${app}`);
    if (merged !== list[0]) list.forEach((g) => g.dispose());
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    out.set(app, merged);
  }
  return out;
}
