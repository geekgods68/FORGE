import { degToRad } from '../units';

/**
 * Snapping settings are an editor preference (not engineering data):
 * they shape how a user's input is quantised before it becomes a command.
 * Authoritative coordinates are never rounded for display.
 */
export interface SnapSettings {
  enabled: boolean;
  /** Translation grid step in metres. */
  translationM: number;
  /** Rotation step in radians. */
  rotationRad: number;
}

export const DEFAULT_SNAP: SnapSettings = { enabled: true, translationM: 0.01, rotationRad: degToRad(15) };

/** Round `value` to the nearest multiple of `step` (no-op for non-positive steps). */
export function snap(value: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(value)) return value;
  const snapped = Math.round(value / step) * step;
  // Strip binary noise (0.30000000000000004 → 0.3) at 15 significant digits — below
  // float64 resolution, so non-decimal steps (radians) are not distorted.
  return Number(snapped.toPrecision(15));
}
