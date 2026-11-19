import type { Quat, Transform, Vec3 } from './types';

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
  if (!Number.isFinite(n) || n < 1e-9) return [0, 0, 0, 1];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function quatFromAxisAngle(axis: Vec3, radians: number): Quat {
  const n = Math.hypot(...axis);
  const s = Math.sin(radians / 2) / n;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(radians / 2)];
}

/** Rotation about world +Y (right-handed: positive = counter-clockwise seen from above). */
export function rotateAboutY(q: Quat, radians: number): Quat {
  return quatNormalize(quatMultiply(quatFromAxisAngle([0, 1, 0], radians), q));
}

/** Yaw in degrees for display (rotation about +Y of the local -Z/+X frame). */
export function yawDegrees(q: Quat): number {
  const [x, y, z, w] = q;
  const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x));
  return (yaw * 180) / Math.PI;
}

export function transformsEqual(a: Transform, b: Transform, eps = 1e-9): boolean {
  for (let i = 0; i < 3; i++) if (Math.abs(a.position[i]! - b.position[i]!) > eps) return false;
  // q and -q are the same rotation.
  const dot = a.rotation.reduce((s, v, i) => s + v * b.rotation[i]!, 0);
  return Math.abs(Math.abs(dot) - 1) <= eps;
}

export function cloneTransform(t: Transform): Transform {
  return { position: [...t.position], rotation: [...t.rotation] };
}
