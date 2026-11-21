/**
 * Lightweight glTF 2.0 / GLB validation (no CAD kernel; STEP/IGES are a later phase).
 * Checks container structure and declares what FORGE will NOT trust: imported models
 * never acquire mass, material properties or connection interfaces automatically, and
 * their dimensions are only meaningful once the user confirms the source unit.
 */
// Available in browsers and Node; declared locally because this package does not load DOM types.
declare const TextDecoder: { new (): { decode(input: Uint8Array): string } };
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };

export const MAX_MODEL_BYTES = 16 * 1024 * 1024;
export const MODEL_UNITS = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254 } as const;
export type ModelUnit = keyof typeof MODEL_UNITS;

export interface ModelCheck {
  ok: boolean;
  format: 'glb' | 'gltf' | 'unknown';
  issues: string[];
  /** Parsed glTF JSON (when structurally valid). */
  json?: {
    asset?: { version?: string; generator?: string };
    meshes?: unknown[];
    buffers?: { uri?: string }[];
    images?: { uri?: string }[];
  };
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function checkJson(json: ModelCheck['json'], issues: string[]) {
  if (!json || typeof json !== 'object') return issues.push('glTF JSON is not an object.');
  if (json.asset?.version !== '2.0')
    issues.push(`Unsupported glTF version "${json.asset?.version ?? 'missing'}" (2.0 required).`);
  if (!Array.isArray(json.meshes) || json.meshes.length === 0) issues.push('The file contains no meshes.');
  // Stable, self-contained assets only: external files are never fetched (CSP + reproducibility).
  for (const b of [...(json.buffers ?? []), ...(json.images ?? [])])
    if (b.uri !== undefined && !b.uri.startsWith('data:'))
      issues.push(`External resource "${b.uri}" is not allowed; embed resources (GLB or data URIs).`);
}

export function checkModelBytes(bytes: Uint8Array): ModelCheck {
  const issues: string[] = [];
  if (bytes.byteLength > MAX_MODEL_BYTES)
    return {
      ok: false,
      format: 'unknown',
      issues: [`File is larger than ${MAX_MODEL_BYTES / 1048576} MiB.`],
    };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 12 && view.getUint32(0, true) === GLB_MAGIC) {
    const version = view.getUint32(4, true);
    const length = view.getUint32(8, true);
    if (version !== 2) issues.push(`GLB container version ${version} is not supported (2 required).`);
    if (length !== bytes.byteLength)
      issues.push(`GLB header length ${length} does not match the file size ${bytes.byteLength}.`);
    if (bytes.byteLength < 20)
      return { ok: false, format: 'glb', issues: [...issues, 'Missing JSON chunk.'] };
    const jsonLen = view.getUint32(12, true);
    if (view.getUint32(16, true) !== CHUNK_JSON)
      return { ok: false, format: 'glb', issues: [...issues, 'First chunk is not JSON.'] };
    if (20 + jsonLen > bytes.byteLength)
      return { ok: false, format: 'glb', issues: [...issues, 'JSON chunk overruns the file.'] };
    let json: ModelCheck['json'];
    try {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
    } catch {
      return { ok: false, format: 'glb', issues: [...issues, 'JSON chunk is not valid JSON.'] };
    }
    const binStart = 20 + jsonLen;
    if (binStart + 8 <= bytes.byteLength && view.getUint32(binStart + 4, true) !== CHUNK_BIN)
      issues.push('Second chunk is not a BIN chunk.');
    checkJson(json, issues);
    return { ok: issues.length === 0, format: 'glb', issues, json };
  }
  // Text glTF.
  let json: ModelCheck['json'];
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, format: 'unknown', issues: ['Not a GLB file and not valid glTF JSON.'] };
  }
  checkJson(json, issues);
  return { ok: issues.length === 0, format: 'gltf', issues, json };
}

/**
 * Convert a measured bounding-box size from model units/axes to FORGE metres, Y-up.
 * Z-up sources swap the vertical and depth extents.
 */
export function modelSizeToMetres(
  size: [number, number, number],
  unit: ModelUnit,
  upAxis: 'Y' | 'Z',
): [number, number, number] {
  const s = MODEL_UNITS[unit];
  const [x, y, z] = size;
  return upAxis === 'Z' ? [x * s, z * s, y * s] : [x * s, y * s, z * s];
}

/** Minimal valid GLB (one triangle) — used by tests and as a documented reference. */
export function minimalGlb(positions: number[] = [0, 0, 0, 1, 0, 0, 0, 1, 0]): Uint8Array {
  const bin = new Float32Array(positions);
  const min = [0, 1, 2].map((i) => Math.min(...positions.filter((_, k) => k % 3 === i)));
  const max = [0, 1, 2].map((i) => Math.max(...positions.filter((_, k) => k % 3 === i)));
  const json = {
    asset: { version: '2.0', generator: 'FORGE test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max }],
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const binBytes = new Uint8Array(bin.buffer);
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, GLB_MAGIC, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jsonBytes.length, true);
  v.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  v.setUint32(20 + jsonBytes.length, binBytes.length, true);
  v.setUint32(24 + jsonBytes.length, CHUNK_BIN, true);
  out.set(binBytes, 28 + jsonBytes.length);
  return out;
}
