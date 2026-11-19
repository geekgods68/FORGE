/** Vector [x, y, z] in metres. */
export type Vec3 = [number, number, number];
/** Unit quaternion [x, y, z, w]. */
export type Quat = [number, number, number, number];

/**
 * Placement of an instance relative to its scene origin.
 * No scale: real size belongs to the component definition, never to a placed instance.
 */
export interface Transform {
  position: Vec3;
  rotation: Quat;
}

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

export function identityTransform(position: Vec3 = [0, 0, 0]): Transform {
  return { position: [...position], rotation: [...IDENTITY_QUAT] };
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(...q);
  if (!Number.isFinite(n) || n < 1e-12) return [...IDENTITY_QUAT];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotate about world +Y by `radians` (right-handed: positive is counter-clockwise seen from above). */
export function rotateAboutWorldY(q: Quat, radians: number): Quat {
  const half = radians / 2;
  return quatNormalize(quatMultiply([0, Math.sin(half), 0, Math.cos(half)], q));
}

/** Yaw about +Y in radians, for display. */
export function yawOf(q: Quat): number {
  const [x, y, z, w] = q;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x));
}
