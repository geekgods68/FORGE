import type { ScreenPair } from './snapLogic';

/** Drag-to-snap renderer diagnostics (read by the debug probe; never engineering state). */
export const snapDiagnostics = {
  dragging: false,
  candidates: [] as ScreenPair[],
  ghost: false,
  targets: 0,
};
