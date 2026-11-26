import { z } from 'zod';
import { IdSchema } from '../schemas';

/**
 * Phase 8: provenance of externally imported engineering data, stored on the project root
 * (`imports`). One record per import transaction; it travels with the project file and is
 * created inside the same atomic batch as the imported nodes (undo removes both).
 *
 * The record describes what FORGE received and what it did with it — never more: geometry
 * class, unit and axis conversion, every unsupported attribute and every warning shown at
 * import time. `nodesFingerprint` lets the UI tell whether the imported nodes have since
 * been modified in FORGE.
 */
const Text = (n: number) => z.string().max(n);
export const IMPORT_FORMATS = [
  'stl',
  'gltf',
  'glb',
  'step',
  'urdf',
  'spice',
  'kicad-netlist',
  'kicad-pcb',
  'kicad-schematic',
] as const;

export const ImportRecordSchema = z.object({
  id: IdSchema,
  format: z.enum(IMPORT_FORMATS),
  /** Version stated by the source (e.g. STEP schema, glTF asset version, KiCad export version). */
  formatVersion: Text(200).nullable(),
  fileName: z.string().trim().min(1).max(260),
  byteLength: z.number().int().min(0),
  /** SHA-256 of the exact source bytes ("sha256-<hex>"). */
  sourceHash: z.string().regex(/^sha256-[0-9a-f]{64}$/),
  /** Additional files resolved during import (e.g. URDF meshes), by name and hash. */
  referencedFiles: z
    .array(z.object({ name: Text(260), sourceHash: z.string().regex(/^sha256-[0-9a-f]{64}$/) }))
    .max(500),
  importedAt: z.iso.datetime(),
  importer: Text(64),
  /** Source length unit as stated or confirmed, and its factor to metres. */
  sourceUnit: Text(32),
  toMetres: z.number().finite().positive(),
  upAxis: z.enum(['Y', 'Z']),
  handedness: z.enum(['right', 'left']),
  geometryClass: z.enum([
    'parametric',
    'brep',
    'tessellated-brep',
    'mesh',
    'primitive',
    'visual-only',
    'collision',
    'none',
  ]),
  /** Nodes created by this import. */
  nodeIds: z.array(IdSchema).max(10_000),
  /** Derived assets written by this import (content hashes of converted GLB data). */
  assetHashes: z.array(z.string().regex(/^sha256-[0-9a-f]{64}$/)).max(1000),
  /** Counts and measurements reported in the preview (plain values). */
  summary: z.record(z.string().min(1).max(64), z.union([z.string().max(500), z.number().finite()])),
  /** Ordered conversion steps applied (e.g. "STL binary → indexed GLB", "mm → m"). */
  conversions: z.array(Text(500)).max(100),
  /** Source attributes FORGE does not represent (reported, not silently dropped). */
  unsupported: z.array(Text(500)).max(500),
  warnings: z.array(Text(1000)).max(500),
  /** Hash of the imported nodes' content at import time (modification detection). */
  nodesFingerprint: z.string().regex(/^sha256-[0-9a-f]{64}$/),
});
export type ImportRecord = z.infer<typeof ImportRecordSchema>;
