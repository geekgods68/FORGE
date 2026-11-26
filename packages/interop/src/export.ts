import { writeGlb } from './formats/gltf';
import { writeStl } from './formats/stl';
import { frameMatrix, metrics, triangles, type Bounds, type Mat4, type MeshScene } from './mesh';
import { INTEROP_VERSION } from './schemas';

/**
 * Geometry export. Input: a tessellated scene in the FORGE frame (metres, +Y up,
 * right-handed) — produced by the application from what FORGE renders (native parts,
 * primitives, components and imported models alike). Exports never modify the project.
 *
 * What an export is: TESSELLATED MESH geometry. Parametric features, mates, mass
 * properties, simulation and circuit data are not representable in STL/glTF and are listed
 * as discarded. STEP export is not offered: FORGE has no B-rep writer (see the capability
 * matrix), and a mesh must not be presented as a recovered CAD model.
 */
export type ExportFormat = 'stl' | 'stl-ascii' | 'glb';
export const EXPORT_UNITS = { m: 1, mm: 0.001, cm: 0.01, in: 0.0254 } as const;
export type ExportUnit = keyof typeof EXPORT_UNITS;

export interface ExportOptions {
  format: ExportFormat;
  /** STL only (glTF is metres by specification). */
  unit: ExportUnit;
  /** STL only (glTF is +Y up by specification). */
  upAxis: 'Y' | 'Z';
  name: string;
}
export interface ExportResult {
  bytes: Uint8Array;
  mediaType: string;
  fileName: string;
  report: {
    format: ExportFormat;
    triangles: number;
    /** Bounds in the OUTPUT file's units and axes. */
    bounds: Bounds | null;
    unit: string;
    upAxis: 'Y' | 'Z';
    preserved: string[];
    discarded: string[];
    exporter: string;
  };
}

const DISCARDED_ALWAYS = [
  'parametric features and sketches (tessellated)',
  'assembly mates and constraints',
  'mass properties and simulation settings',
  'circuit, firmware and research data',
  'connection interfaces',
];

/** FORGE frame → output frame: the inverse of the import map k·R is (k·R)ᵀ / k². */
function outputMatrix(unit: ExportUnit, upAxis: 'Y' | 'Z'): Mat4 {
  const F = frameMatrix({ toMetres: EXPORT_UNITS[unit], upAxis, handedness: 'right' });
  const k2 = EXPORT_UNITS[unit] ** 2;
  return [F[0]!, F[4]!, F[8]!, 0, F[1]!, F[5]!, F[9]!, 0, F[2]!, F[6]!, F[10]!, 0, 0, 0, 0, 1].map((x, i) =>
    i === 15 ? 1 : x / k2,
  );
}

export function exportMeshScene(scene: MeshScene, o: ExportOptions): ExportResult {
  const safe = o.name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'forge-export';
  if (o.format === 'glb') {
    const bytes = writeGlb(scene, {
      generator: `FORGE ${INTEROP_VERSION}`,
      extras: { 'forge.units': 'm', 'forge.upAxis': 'Y' },
    });
    const m = metrics(triangles(scene).tri);
    return {
      bytes,
      mediaType: 'model/gltf-binary',
      fileName: `${safe}.glb`,
      report: {
        format: 'glb',
        triangles: m.triangles,
        bounds: m.bounds,
        unit: 'm',
        upAxis: 'Y',
        preserved: [
          'node hierarchy and names',
          'node transforms',
          'triangle geometry and normals',
          'PBR colour factors',
        ],
        discarded: [...DISCARDED_ALWAYS, 'textures (FORGE materials are colour factors only)'],
        exporter: INTEROP_VERSION,
      },
    };
  }
  const M = outputMatrix(o.unit, o.upAxis);
  const t = triangles(scene, M);
  const m = metrics(t.tri);
  const bytes = writeStl(t.tri, {
    ascii: o.format === 'stl-ascii',
    name: safe,
    header: `FORGE ${safe} units=${o.unit} up=+${o.upAxis}`,
  });
  return {
    bytes,
    mediaType: 'model/stl',
    fileName: `${safe}.stl`,
    report: {
      format: o.format,
      triangles: m.triangles,
      bounds: m.bounds,
      unit: o.unit,
      upAxis: o.upAxis,
      preserved: ['triangle geometry (world placement baked in)'],
      discarded: [
        ...DISCARDED_ALWAYS,
        'hierarchy, names and colours (STL has none)',
        'units and axes (STL records none: stated in the header text only)',
      ],
      exporter: INTEROP_VERSION,
    },
  };
}
