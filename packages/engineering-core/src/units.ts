/**
 * FORGE world conventions (see docs/ARCHITECTURE.md):
 *   length metres · angle radians (internal) · mass kilograms · time seconds · temperature kelvin
 *   right-handed coordinates, +Y up, −Z forward (matches three.js and WebXR)
 * Degrees appear only at the user-interface boundary.
 */
export const SI_UNITS = {
  length: 'm',
  angle: 'rad',
  mass: 'kg',
  time: 's',
  temperature: 'K',
} as const;

export type EngineeringUnits = typeof SI_UNITS;

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Format a length in metres for display, choosing mm below 1 m. */
export function formatLength(m: number): string {
  return Math.abs(m) < 1 ? `${(m * 1000).toFixed(1)} mm` : `${m.toFixed(3)} m`;
}
