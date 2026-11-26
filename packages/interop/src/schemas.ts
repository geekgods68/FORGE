import { ImportRecordSchema, type ImportRecord } from '@forge/engineering-core';

export { ImportRecordSchema, type ImportRecord };

/** Importer identity written into every record (bump when conversions change meaningfully). */
export const INTEROP_VERSION = 'forge-interop 1';

export type Severity = 'error' | 'warning' | 'info';
export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
}
export const err = (code: string, message: string): Diagnostic => ({ severity: 'error', code, message });
export const warn = (code: string, message: string): Diagnostic => ({ severity: 'warning', code, message });
export const info = (code: string, message: string): Diagnostic => ({ severity: 'info', code, message });
export const hasErrors = (d: readonly Diagnostic[]) => d.some((x) => x.severity === 'error');

/** Formats FORGE detects. Detection never implies support: see CAPABILITIES. */
export const FORMAT_IDS = [
  'stl',
  'gltf',
  'glb',
  'step',
  'urdf',
  'spice',
  'kicad-netlist',
  'kicad-pcb',
  'kicad-schematic',
  'forge-electrical',
  'forge-project',
  'forge-bundle',
] as const;
export type FormatId = (typeof FORMAT_IDS)[number];

/**
 * How faithfully geometry is represented (shown to the user for every import):
 *  - parametric: FORGE's own feature-based parts (editable features);
 *  - brep: exact boundary representation (not stored by FORGE: STEP B-rep is tessellated);
 *  - tessellated-brep: triangles produced from a B-rep at a stated tolerance;
 *  - mesh: triangles as supplied (STL, glTF); no features, no exact surfaces;
 *  - primitive: analytic box/cylinder/sphere (URDF primitives → FORGE primitives);
 *  - visual-only: rendered, not used for mass or contact;
 *  - collision: used for contact only.
 */
export const GEOMETRY_CLASSES = [
  'parametric',
  'brep',
  'tessellated-brep',
  'mesh',
  'primitive',
  'visual-only',
  'collision',
] as const;
export type GeometryClass = (typeof GEOMETRY_CLASSES)[number];

/** File-size limits (bytes) per format; parsing refuses larger inputs before reading them. */
export const MAX_INPUT_BYTES: Record<FormatId, number> = {
  stl: 64 * 1024 * 1024,
  gltf: 16 * 1024 * 1024,
  glb: 16 * 1024 * 1024,
  step: 32 * 1024 * 1024,
  urdf: 2 * 1024 * 1024,
  spice: 1024 * 1024,
  'kicad-netlist': 8 * 1024 * 1024,
  'kicad-pcb': 32 * 1024 * 1024,
  'kicad-schematic': 16 * 1024 * 1024,
  'forge-electrical': 2 * 1024 * 1024,
  'forge-project': 10 * 1024 * 1024,
  'forge-bundle': 64 * 1024 * 1024,
};
/** Upper bound on triangles accepted from any single import (resource guard). */
export const MAX_TRIANGLES = 2_000_000;

export interface FileInput {
  name: string;
  bytes: Uint8Array;
}
