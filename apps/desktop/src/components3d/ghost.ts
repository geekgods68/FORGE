/** Ghost-placement constants, footprint test and read-only diagnostics (for tests). */
export const BUILD_AREA_HALF_M = 1;

export interface GhostDiagnostics {
  active: boolean;
  valid: boolean;
  position: [number, number, number] | null;
  surface: 'bench' | 'build-area' | 'none';
  /** World point at the centre of the active surface. */
  surfaceCentre: [number, number, number] | null;
}
export const ghostDiagnostics: GhostDiagnostics = {
  active: false,
  valid: false,
  position: null,
  surface: 'none',
  surfaceCentre: null,
};

/** undefined = ghost removed; null = active but no surface. */
export function publishSurface(
  s: { kind: 'bench' | 'build-area'; centre: [number, number, number] } | null | undefined,
) {
  ghostDiagnostics.active = s !== undefined;
  ghostDiagnostics.surface = s ? s.kind : 'none';
  ghostDiagnostics.surfaceCentre = s ? s.centre : null;
  if (s === undefined) {
    ghostDiagnostics.position = null;
    ghostDiagnostics.valid = false;
  }
}
export function publishGhost(p: { position: [number, number, number]; valid: boolean } | null) {
  ghostDiagnostics.position = p?.position ?? null;
  ghostDiagnostics.valid = p?.valid ?? false;
}

function footprintHalf(size: [number, number, number], yaw: number): [number, number] {
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  return [(c * size[0] + s * size[2]) / 2, (s * size[0] + c * size[2]) / 2];
}

/** Rotated footprint inside the surface half-extents (project frame). */
export function fitsSurface(
  half: [number, number],
  size: [number, number, number],
  p: [number, number, number],
  yaw: number,
) {
  const [hx, hz] = footprintHalf(size, yaw);
  return Math.abs(p[0]) + hx <= half[0] + 1e-9 && Math.abs(p[2]) + hz <= half[1] + 1e-9;
}
