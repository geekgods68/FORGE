import { IDENTITY, type MaterialData, type MeshScene } from '../mesh';
import { err, info, MAX_INPUT_BYTES, MAX_TRIANGLES, warn, type Diagnostic } from '../schemas';

/**
 * STEP (ISO 10303-21; AP203 / AP214 / AP242 B-rep) import.
 *
 *  1. `readStepHeader` (pure TypeScript): schema, file name, originating system, the declared
 *     LENGTH unit, product names, assembly-usage count, B-rep/face counts and content FORGE
 *     does not represent (PMI, tolerances, materials, kinematics). Nothing is executed.
 *  2. `stepToScene`: tessellation by Open CASCADE (OCCT, through the occt-import-js
 *     WebAssembly build — LGPL-2.1; see docs/THIRD_PARTY_NOTICES.md). OCCT reads the exact
 *     B-rep, applies the assembly placements and triangulates every face at the stated
 *     tolerance, converting lengths to METRES.
 *
 * What the user gets is TESSELLATED B-REP: accurate to the tessellation tolerance, with the
 * product hierarchy and names, but no editable B-rep and no feature tree. Placements are
 * baked into vertex positions (the hierarchy is kept; per-part matrices are identity).
 */
declare const TextDecoder: { new (label?: string): { decode(input: Uint8Array): string } };

export interface StepHeader {
  ok: boolean;
  schema: string | null;
  /** e.g. AP214, AP203, AP242 (from the schema identifier). */
  protocol: string | null;
  fileName: string | null;
  timestamp: string | null;
  originatingSystem: string | null;
  preprocessor: string | null;
  lengthUnit: { name: string; toMetres: number } | null;
  products: string[];
  assemblyUsages: number;
  breps: number;
  faces: number;
  entities: number;
  unsupported: string[];
  diagnostics: Diagnostic[];
}

const PREFIX: Record<string, number> = {
  '.EXA.': 1e18,
  '.PETA.': 1e15,
  '.TERA.': 1e12,
  '.GIGA.': 1e9,
  '.MEGA.': 1e6,
  '.KILO.': 1e3,
  '.HECTO.': 1e2,
  '.DECA.': 10,
  '.DECI.': 0.1,
  '.CENTI.': 0.01,
  '.MILLI.': 1e-3,
  '.MICRO.': 1e-6,
  '.NANO.': 1e-9,
  '.PICO.': 1e-12,
};
const CONVERSION: Record<string, number> = {
  INCH: 0.0254,
  FOOT: 0.3048,
  MILE: 1609.344,
  YARD: 0.9144,
  MIL: 2.54e-5,
};

const strArg = (s: string | undefined) => (s ? s.trim().replace(/^'|'$/g, '').replace(/''/g, "'") : null);

export function readStepHeader(bytes: Uint8Array): StepHeader {
  const d: Diagnostic[] = [];
  const empty: StepHeader = {
    ok: false,
    schema: null,
    protocol: null,
    fileName: null,
    timestamp: null,
    originatingSystem: null,
    preprocessor: null,
    lengthUnit: null,
    products: [],
    assemblyUsages: 0,
    breps: 0,
    faces: 0,
    entities: 0,
    unsupported: [],
    diagnostics: d,
  };
  if (bytes.byteLength > MAX_INPUT_BYTES.step) {
    d.push(err('too-large', `STEP file larger than ${MAX_INPUT_BYTES.step / 1048576} MiB.`));
    return empty;
  }
  const text = new TextDecoder('latin1').decode(bytes);
  if (!/^\s*ISO-10303-21\s*;/.test(text)) {
    d.push(err('not-step', 'Missing "ISO-10303-21;" signature (not a STEP Part 21 file).'));
    return empty;
  }
  if (!/END-ISO-10303-21\s*;\s*$/.test(text))
    d.push(warn('step-truncated', 'File does not end with "END-ISO-10303-21;" (possibly truncated).'));
  const header = /HEADER\s*;([\s\S]*?)ENDSEC\s*;/.exec(text)?.[1] ?? '';
  const schemaM = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/.exec(header);
  const schema = schemaM?.[1] ?? null;
  const protocol = schema
    ? /AP242|MANAGED_MODEL_BASED_3D/i.test(schema)
      ? 'AP242'
      : /AUTOMOTIVE_DESIGN|214/i.test(schema)
        ? 'AP214'
        : /CONFIG_CONTROL_DESIGN|203/i.test(schema)
          ? 'AP203'
          : (schema.split(/\s/)[0] ?? null)
    : null;
  if (!schema) d.push(warn('step-schema', 'FILE_SCHEMA is missing.'));
  const fn = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/.exec(header)?.[1];
  const fnArgs = fn ? (fn.match(/'(?:[^']|'')*'|\([^)]*\)|\$/g) ?? []) : [];
  const data = /DATA\s*;([\s\S]*)ENDSEC\s*;/.exec(text)?.[1] ?? '';
  if (!data) d.push(err('step-data', 'No DATA section.'));
  const entities = (data.match(/#\d+\s*=/g) ?? []).length;
  const count = (re: RegExp) => (data.match(re) ?? []).length;
  // Length unit: the LENGTH_UNIT among the units a GLOBAL_UNIT_ASSIGNED_CONTEXT assigns (a
  // conversion-based unit such as INCH refers to another, auxiliary SI unit — not the answer).
  const ent = new Map<string, string>();
  for (const m of data.matchAll(/#(\d+)\s*=\s*([^;]*);/g)) ent.set(`#${m[1]}`, m[2]!);
  const assigned = [...data.matchAll(/GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\(([^)]*)\)/g)].flatMap((m) =>
    m[1]!.split(',').map((x) => x.trim()),
  );
  const candidates = (assigned.length ? assigned.map((r) => ent.get(r) ?? '') : [...ent.values()]).filter(
    (b) => /LENGTH_UNIT\s*\(\s*\)/.test(b),
  );
  let lengthUnit: StepHeader['lengthUnit'] = null;
  for (const body of candidates) {
    const cb = /CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'/.exec(body);
    if (cb) {
      const k = CONVERSION[cb[1]!.toUpperCase()];
      lengthUnit = k ? { name: cb[1]!.toLowerCase(), toMetres: k } : null;
      if (!k) d.push(warn('step-unit', `Unrecognised conversion-based length unit "${cb[1]}".`));
      break;
    }
    const si = /SI_UNIT\s*\(\s*(\.[A-Z]+\.|\$)\s*,\s*\.METRE\.\s*\)/.exec(body);
    if (si) {
      const k = si[1] === '$' ? 1 : (PREFIX[si[1]!] ?? null);
      if (k !== null)
        lengthUnit = {
          name:
            si[1] === '$'
              ? 'm'
              : si[1] === '.MILLI.'
                ? 'mm'
                : `${si[1]!.replace(/\./g, '').toLowerCase()}metre`,
          toMetres: k,
        };
      break;
    }
  }
  if (!lengthUnit) d.push(warn('step-unit', 'No length unit declared; OCCT assumes millimetres.'));
  const products = [...data.matchAll(/=\s*PRODUCT\s*\(\s*'((?:[^']|'')*)'/g)].map((m) =>
    m[1]!.replace(/''/g, "'"),
  );
  const breps = count(/MANIFOLD_SOLID_BREP\s*\(|BREP_WITH_VOIDS\s*\(|FACETED_BREP\s*\(/g);
  const faces = count(/ADVANCED_FACE\s*\(|FACE_SURFACE\s*\(/g);
  const shells = count(/SHELL_BASED_SURFACE_MODEL\s*\(/g);
  const unsupported: string[] = [];
  const flag = (re: RegExp, what: string) => {
    const n = count(re);
    if (n) unsupported.push(`${what} (${n})`);
  };
  flag(
    /GEOMETRIC_TOLERANCE|DATUM_FEATURE|DIMENSIONAL_SIZE|DIMENSIONAL_LOCATION/g,
    'PMI: dimensions, tolerances and datums',
  );
  flag(/MATERIAL_DESIGNATION|MATERIAL_PROPERTY/g, 'material designations');
  flag(/KINEMATIC_|MECHANISM_REPRESENTATION/g, 'kinematic definitions');
  flag(/ANNOTATION_|DRAUGHTING_CALLOUT/g, 'annotations');
  flag(/=\s*PROPERTY_DEFINITION\s*\(/g, 'property definitions (validation properties, mass etc.)');
  if (!breps && !faces && !shells)
    d.push(warn('step-no-brep', 'No B-rep solids or faces found (wireframe-only or PMI-only file?).'));
  if (shells)
    d.push(
      info(
        'step-surface-model',
        `${shells} surface model(s) (open shells) — tessellated as surfaces, not solids.`,
      ),
    );
  return {
    ok: !d.some((x) => x.severity === 'error'),
    schema,
    protocol,
    fileName: strArg(fnArgs[0]),
    timestamp: strArg(fnArgs[1]),
    preprocessor: strArg(fnArgs[4]),
    originatingSystem: strArg(fnArgs[5]),
    lengthUnit,
    products,
    assemblyUsages: count(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g),
    breps,
    faces,
    entities,
    unsupported,
    diagnostics: d,
  };
}

/** The subset of the occt-import-js API FORGE uses. */
export interface OcctMesh {
  name?: string;
  color?: [number, number, number];
  brep_faces?: { first: number; last: number; color: [number, number, number] | null }[];
  attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } };
  index: { array: ArrayLike<number> };
}
export interface OcctNode {
  name: string;
  meshes: number[];
  children: OcctNode[];
}
export interface OcctResult {
  success: boolean;
  root: OcctNode;
  meshes: OcctMesh[];
}
export interface OcctKernel {
  ReadStepFile(content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
}

export interface Tessellation {
  /** Chordal deviation as a fraction of the bounding-box diagonal (OCCT "bounding_box_ratio"). */
  linearDeflectionRatio: number;
  /** Maximum angle between adjacent facet normals on a curved face (rad). */
  angularDeflectionRad: number;
}
export const DEFAULT_TESSELLATION: Tessellation = { linearDeflectionRatio: 0.001, angularDeflectionRad: 0.5 };

export interface StepScene {
  ok: boolean;
  scene: MeshScene | null;
  brepFaces: number;
  diagnostics: Diagnostic[];
}

/** Tessellate a STEP file with OCCT; lengths are returned in METRES. */
export function stepToScene(
  bytes: Uint8Array,
  kernel: OcctKernel,
  tess: Tessellation = DEFAULT_TESSELLATION,
): StepScene {
  const d: Diagnostic[] = [];
  let r: OcctResult;
  try {
    r = kernel.ReadStepFile(bytes, {
      linearUnit: 'meter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: tess.linearDeflectionRatio,
      angularDeflection: tess.angularDeflectionRad,
    });
  } catch (e) {
    return {
      ok: false,
      scene: null,
      brepFaces: 0,
      diagnostics: [err('step-kernel', `OCCT failed to read the file: ${String(e).slice(0, 200)}`)],
    };
  }
  if (!r?.success)
    return {
      ok: false,
      scene: null,
      brepFaces: 0,
      diagnostics: [err('step-read', 'OCCT could not read any shape from this STEP file.')],
    };
  const s: MeshScene = { roots: [], nodes: [], meshes: [], materials: [] };
  const colourIndex = new Map<string, number>();
  const material = (c: [number, number, number] | undefined | null) => {
    if (!c) return null;
    const k = c.map((x) => x.toFixed(4)).join(',');
    let i = colourIndex.get(k);
    if (i === undefined) {
      i = s.materials.length;
      colourIndex.set(k, i);
      s.materials.push({
        name: `STEP colour ${k}`,
        baseColor: [c[0], c[1], c[2], 1],
        metallic: 0,
        roughness: 0.6,
      } satisfies MaterialData);
    }
    return i;
  };
  let tris = 0;
  let faces = 0;
  const meshIndex = r.meshes.map((m, i) => {
    const pos = Float32Array.from(m.attributes.position.array);
    const idx = Uint32Array.from(m.index.array);
    tris += idx.length / 3;
    faces += m.brep_faces?.length ?? 0;
    if (pos.some((x) => !Number.isFinite(x)))
      d.push(err('non-finite', `Shape "${m.name ?? i}" tessellated to non-finite coordinates.`));
    s.meshes.push({
      name: m.name || `shape ${i + 1}`,
      primitives: [
        {
          positions: pos,
          indices: idx,
          normals: m.attributes.normal ? Float32Array.from(m.attributes.normal.array) : null,
          material: material(m.color),
        },
      ],
    });
    return s.meshes.length - 1;
  });
  if (tris > MAX_TRIANGLES)
    return {
      ok: false,
      scene: null,
      brepFaces: faces,
      diagnostics: [
        err(
          'too-many-triangles',
          `${tris} triangles exceed the limit of ${MAX_TRIANGLES}; increase the tessellation tolerance.`,
        ),
      ],
    };
  const visit = (n: OcctNode, depth: number): number => {
    if (depth > 128) throw new Error('STEP assembly deeper than 128 levels.');
    const id = s.nodes.length;
    s.nodes.push({
      name: n.name || 'unnamed',
      matrix: [...IDENTITY],
      mesh: null,
      children: [],
      metadata: { 'step.product': n.name || '' },
    });
    for (const mi of n.meshes) {
      if (n.meshes.length === 1 && !n.children.length) {
        s.nodes[id]!.mesh = meshIndex[mi]!;
        continue;
      }
      const c = s.nodes.length;
      s.nodes.push({
        name: s.meshes[meshIndex[mi]!]!.name,
        matrix: [...IDENTITY],
        mesh: meshIndex[mi]!,
        children: [],
        metadata: {},
      });
      s.nodes[id]!.children.push(c);
    }
    for (const ch of n.children) s.nodes[id]!.children.push(visit(ch, depth + 1));
    return id;
  };
  // OCCT's root is an unnamed document node: start from its children when it has no meshes.
  const top = !r.root.meshes.length && !r.root.name ? r.root.children : [r.root];
  for (const t of top) s.roots.push(visit(t, 0));
  if (!tris) d.push(err('empty', 'OCCT produced no triangles (no solid or surface geometry).'));
  d.push(
    info(
      'step-tessellated',
      `Exact B-rep (${faces} faces) tessellated by OCCT to ${tris} triangles at ${(tess.linearDeflectionRatio * 100).toFixed(2)} % of the bounding-box diagonal / ${((tess.angularDeflectionRad * 180) / Math.PI).toFixed(0)}°; the B-rep itself is not kept.`,
    ),
  );
  return { ok: !d.some((x) => x.severity === 'error'), scene: s, brepFaces: faces, diagnostics: d };
}
