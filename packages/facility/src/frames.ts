import {
  compose,
  decompose,
  invert,
  multiply,
  transformPoint,
  type Mat4,
  type NodeTransform,
  type Vec3,
} from '@forge/engineering-core';

/**
 * Coordinate frames (all metres, right-handed, +Y up, −Z forward — the same
 * convention as the engineering core, three.js and WebXR):
 *
 *   F  facility frame     origin at the facility datum (corridor E centre, floor level)
 *   Z  zone frame         a zone's origin, posed in F by `zone.pose` (yaw only, floor-level)
 *   I  item frame         a workspace item (bench, cabinet…), posed in Z by `item.pose`
 *   M  mount frame        a workbench's work-surface mount, offset in I by `equipment.mount`
 *   P  project frame      the engineering project's scene root; P ≡ M when the project is
 *                         mounted on that bench (project coordinates are bench-local)
 *
 * Every frame-to-parent transform is a rigid motion (translation + rotation about +Y,
 * no scale), so conversions are exact inverses of each other and never introduce shear.
 */
export interface FloorPose {
  /** Position of the frame origin in its parent frame (m). y = height above the parent floor. */
  position: Vec3;
  /** Rotation about +Y in radians (counter-clockwise seen from above). */
  yaw: number;
}

export const IDENTITY_POSE: FloorPose = { position: [0, 0, 0], yaw: 0 };

export function poseMatrix(p: FloorPose): Mat4 {
  return compose({
    position: p.position,
    rotation: [0, Math.sin(p.yaw / 2), 0, Math.cos(p.yaw / 2)],
    scale: [1, 1, 1],
  });
}

/** A frame chain from a frame up to the facility frame, innermost first. */
export type FrameChain = readonly FloorPose[];

/** Matrix mapping coordinates in the innermost frame of `chain` to facility coordinates. */
export function chainToFacility(chain: FrameChain): Mat4 {
  // F ← Z ← I ← M : facility = Z · I · M · local, where chain = [M, I, Z].
  let m: Mat4 = poseMatrix(IDENTITY_POSE);
  for (let i = chain.length - 1; i >= 0; i--) m = multiply(m, poseMatrix(chain[i]!));
  return m;
}

export function facilityToChain(chain: FrameChain): Mat4 {
  const inv = invert(chainToFacility(chain));
  if (!inv) throw new Error('frame chain is singular'); // cannot happen for rigid poses
  return inv;
}

export const pointToFacility = (p: Vec3, chain: FrameChain): Vec3 =>
  transformPoint(chainToFacility(chain), p);
export const pointFromFacility = (p: Vec3, chain: FrameChain): Vec3 =>
  transformPoint(facilityToChain(chain), p);

/** Express a point given in frame chain `from` in frame chain `to` (via the facility frame). */
export function convertPoint(p: Vec3, from: FrameChain, to: FrameChain): Vec3 {
  return pointFromFacility(pointToFacility(p, from), to);
}

/** Express a local node transform (in `from`) as a transform in the facility frame. */
export function transformToFacility(t: NodeTransform, chain: FrameChain): NodeTransform {
  const { trs } = decompose(multiply(chainToFacility(chain), compose(t)));
  return trs;
}

export const normalizeYaw = (yaw: number): number => {
  const twoPi = Math.PI * 2;
  let y = ((yaw % twoPi) + twoPi) % twoPi;
  if (y > Math.PI) y -= twoPi;
  return y;
};
