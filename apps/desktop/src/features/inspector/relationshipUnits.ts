import {
  degToRad,
  radToDeg,
  worldMatrix,
  type AssemblyConstraint,
  type FrameRef,
  type SceneGraph,
} from '@forge/engineering-core';
import { dot, len3, makeRefResolver, mul, origin, sub, zAxis } from '@forge/mechanics';

/** Display units for assembly editing: degrees and millimetres in the UI only (radians/metres stored). */
export type Kind = 'angle' | 'length';

export const toUi = (kind: Kind, v: number) => (kind === 'angle' ? radToDeg(v) : v * 1000);
export const fromUi = (kind: Kind, v: number) => (kind === 'angle' ? degToRad(v) : v / 1000);
export const unitOf = (kind: Kind) => (kind === 'angle' ? '°' : 'mm');
export const fmt = (v: number) => String(+v.toFixed(6));
export const num = (s: string) => {
  const t = s.trim().replace(',', '.');
  const v = t === '' ? NaN : Number(t);
  return Number.isFinite(v) ? v : null;
};

/** Body-origin axes offered as constraint references when no interface is wanted. */
export const ORIGIN_AXES: Record<
  string,
  { label: string; axis: [number, number, number]; xRef: [number, number, number] }
> = {
  'origin:+Y': { label: 'body origin, +Y axis', axis: [0, 1, 0], xRef: [1, 0, 0] },
  'origin:+X': { label: 'body origin, +X axis', axis: [1, 0, 0], xRef: [0, 0, 1] },
  'origin:+Z': { label: 'body origin, +Z axis', axis: [0, 0, 1], xRef: [1, 0, 0] },
};
export function refFromKey(key: string): FrameRef | null {
  if (key.startsWith('ifc:')) return { kind: 'interface', interfaceId: key.slice(4) };
  const o = ORIGIN_AXES[key];
  return o ? { kind: 'frame', origin: [0, 0, 0], axis: o.axis, xRef: o.xRef } : null;
}
export function keyFromRef(ref: FrameRef): string {
  if (ref.kind === 'interface') return `ifc:${ref.interfaceId}`;
  const hit = Object.entries(ORIGIN_AXES).find(
    ([, o]) =>
      ref.origin.every((v) => v === 0) &&
      o.axis.every((v, i) => v === ref.axis[i]) &&
      o.xRef.every((v, i) => v === ref.xRef[i]),
  );
  return hit ? hit[0] : 'frame:custom';
}

/** Present value of a distance (m) or angle (rad) between two references, or null. */
export function currentValue(
  scene: SceneGraph,
  type: AssemblyConstraint['type'],
  a: string,
  refA: FrameRef,
  b: string,
  refB: FrameRef,
): number | null {
  const resolve = makeRefResolver(scene);
  const fa = resolve(a, refA);
  const fb = resolve(b, refB);
  if (typeof fa === 'string' || typeof fb === 'string') return null;
  const FA = mul(worldMatrix(scene, a), fa);
  const FB = mul(worldMatrix(scene, b), fb);
  if (type === 'distance') return len3(sub(origin(FB), origin(FA)));
  return Math.acos(Math.max(-1, Math.min(1, dot(zAxis(FA), zAxis(FB)))));
}
