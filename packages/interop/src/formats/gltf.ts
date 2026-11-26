import { fromTRS, IDENTITY, type MaterialData, type MeshPrimitive, type MeshScene, type V3 } from '../mesh';
import { err, info, MAX_INPUT_BYTES, MAX_TRIANGLES, warn, type Diagnostic } from '../schemas';

/**
 * glTF 2.0 / GLB reader and writer (pure TypeScript; no network, no code execution).
 *
 * Read: node hierarchy (matrix or TRS), triangle mesh primitives (POSITION, NORMAL, indices),
 * PBR metallic-roughness factors and names. glTF is metres and +Y up by specification.
 * Everything else present in the file is REPORTED: textures/UVs (kept in the stored original
 * for display, not used by engineering), skins, animations, cameras, morph targets,
 * non-triangle modes, sparse accessors and extensions. External URIs are refused (never
 * fetched); compressed geometry (Draco, meshopt) cannot be decoded and is refused.
 *
 * Write: MeshScene → GLB 2.0 (float32 positions with min/max, optional normals, uint32
 * indices, PBR factors, node matrices).
 */
declare const TextDecoder: { new (): { decode(input: Uint8Array): string } };
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };
declare const atob: (s: string) => string;

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const UNDECODABLE = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_mesh_quantization'];

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface GltfParse {
  ok: boolean;
  container: 'glb' | 'gltf' | null;
  version: string | null;
  generator: string | null;
  scene: MeshScene | null;
  /** Names of features present but not represented in the engineering scene. */
  unsupported: string[];
  diagnostics: Diagnostic[];
}

function decodeDataUri(uri: string): Uint8Array | null {
  const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(uri);
  if (!m || !m[1]) return null;
  const s = atob(m[2]!);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function parseGltf(bytes: Uint8Array): GltfParse {
  const d: Diagnostic[] = [];
  const unsupported: string[] = [];
  const fail = (container: GltfParse['container'], e: Diagnostic): GltfParse => ({
    ok: false,
    container,
    version: null,
    generator: null,
    scene: null,
    unsupported,
    diagnostics: [...d, e],
  });
  if (bytes.byteLength > MAX_INPUT_BYTES.glb)
    return fail(null, err('too-large', `Model larger than ${MAX_INPUT_BYTES.glb / 1048576} MiB.`));
  let json: Json;
  let bin: Uint8Array | null = null;
  let container: 'glb' | 'gltf';
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 12 && v.getUint32(0, true) === GLB_MAGIC) {
    container = 'glb';
    if (v.getUint32(4, true) !== 2) return fail('glb', err('glb-version', 'GLB container version is not 2.'));
    if (v.getUint32(8, true) !== bytes.byteLength)
      return fail('glb', err('glb-length', 'GLB header length does not match the file size.'));
    if (bytes.byteLength < 20 || v.getUint32(16, true) !== CHUNK_JSON)
      return fail('glb', err('glb-json', 'First GLB chunk is not JSON.'));
    const jl = v.getUint32(12, true);
    if (20 + jl > bytes.byteLength) return fail('glb', err('glb-json', 'JSON chunk overruns the file.'));
    try {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jl)));
    } catch {
      return fail('glb', err('glb-json', 'JSON chunk is not valid JSON.'));
    }
    const bs = 20 + jl;
    if (bs + 8 <= bytes.byteLength) {
      const bl = v.getUint32(bs, true);
      if (v.getUint32(bs + 4, true) !== CHUNK_BIN)
        return fail('glb', err('glb-bin', 'Second GLB chunk is not BIN.'));
      if (bs + 8 + bl > bytes.byteLength) return fail('glb', err('glb-bin', 'BIN chunk overruns the file.'));
      bin = bytes.subarray(bs + 8, bs + 8 + bl);
    }
  } else {
    container = 'gltf';
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return fail(null, err('not-gltf', 'Neither GLB nor glTF JSON.'));
    }
  }
  if (!json || typeof json !== 'object')
    return fail(container, err('not-gltf', 'glTF root is not an object.'));
  const version = typeof json.asset?.version === 'string' ? json.asset.version : null;
  const generator = typeof json.asset?.generator === 'string' ? json.asset.generator : null;
  if (
    version !== '2.0' &&
    !(typeof json.asset?.minVersion === 'string' && json.asset.minVersion.startsWith('2.'))
  )
    return fail(
      container,
      err('gltf-version', `glTF version "${version ?? 'missing'}" is not supported (2.0 required).`),
    );
  for (const ext of (json.extensionsRequired ?? []) as string[])
    if (UNDECODABLE.includes(ext))
      return fail(
        container,
        err('gltf-compressed', `Required extension ${ext} (compressed geometry) cannot be decoded by FORGE.`),
      );
  for (const ext of (json.extensionsUsed ?? []) as string[]) unsupported.push(`extension ${ext}`);

  // Buffers: GLB BIN chunk or base64 data URIs only.
  const buffers: Uint8Array[] = [];
  for (const [i, b] of ((json.buffers ?? []) as Json[]).entries()) {
    if (b.uri === undefined) {
      if (i !== 0 || !bin) return fail(container, err('gltf-buffer', `Buffer ${i} has no data.`));
      buffers.push(bin);
    } else if (typeof b.uri === 'string' && b.uri.startsWith('data:')) {
      const data = decodeDataUri(b.uri);
      if (!data) return fail(container, err('gltf-buffer', `Buffer ${i} data URI is not base64.`));
      buffers.push(data);
    } else
      return fail(
        container,
        err(
          'gltf-external',
          `Buffer ${i} refers to an external file "${String(b.uri).slice(0, 80)}" (never fetched; embed it or use GLB).`,
        ),
      );
  }
  for (const im of (json.images ?? []) as Json[])
    if (typeof im.uri === 'string' && !im.uri.startsWith('data:'))
      return fail(
        container,
        err(
          'gltf-external',
          `Image refers to an external file "${String(im.uri).slice(0, 80)}" (never fetched).`,
        ),
      );

  const accessor = (idx: number, want: 'float' | 'index'): Float32Array | Uint32Array | null => {
    const a = json.accessors?.[idx];
    if (!a) return null;
    if (a.sparse) {
      unsupported.push('sparse accessors');
      return null;
    }
    const comps = COMPONENTS[a.type];
    if (!comps || a.bufferView === undefined) return null;
    const bv = json.bufferViews?.[a.bufferView];
    const buf = bv ? buffers[bv.buffer] : undefined;
    if (!bv || !buf) return null;
    const ct = a.componentType as number;
    const size = ct === 5126 || ct === 5125 ? 4 : ct === 5123 || ct === 5122 ? 2 : 1;
    const stride = bv.byteStride ?? comps * size;
    const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const count = a.count as number;
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      start + (count - 1) * stride + comps * size > buf.byteLength ||
      (bv.byteOffset ?? 0) + bv.byteLength > buf.byteLength
    )
      return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = want === 'float' ? new Float32Array(count * comps) : new Uint32Array(count * comps);
    for (let i = 0; i < count; i++)
      for (let c = 0; c < comps; c++) {
        const o = start + i * stride + c * size;
        let x: number;
        if (ct === 5126) x = dv.getFloat32(o, true);
        else if (ct === 5125) x = dv.getUint32(o, true);
        else if (ct === 5123) x = dv.getUint16(o, true);
        else if (ct === 5121) x = dv.getUint8(o);
        else if (ct === 5122) x = dv.getInt16(o, true);
        else x = dv.getInt8(o);
        if (want === 'float' && ct !== 5126 && a.normalized)
          x =
            ct === 5123
              ? x / 65535
              : ct === 5121
                ? x / 255
                : ct === 5122
                  ? Math.max(x / 32767, -1)
                  : Math.max(x / 127, -1);
        out[i * comps + c] = x;
      }
    return out;
  };

  const materials: MaterialData[] = ((json.materials ?? []) as Json[]).map((m, i) => {
    const p = m.pbrMetallicRoughness ?? {};
    if (p.baseColorTexture || m.normalTexture || m.occlusionTexture || m.emissiveTexture)
      unsupported.push('material textures (kept for display only)');
    const c =
      Array.isArray(p.baseColorFactor) && p.baseColorFactor.length === 4
        ? p.baseColorFactor.map(Number)
        : [1, 1, 1, 1];
    return {
      name: typeof m.name === 'string' ? m.name : `material ${i}`,
      baseColor: c as [number, number, number, number],
      metallic: typeof p.metallicFactor === 'number' ? p.metallicFactor : 1,
      roughness: typeof p.roughnessFactor === 'number' ? p.roughnessFactor : 1,
    };
  });

  let tris = 0;
  const meshes = ((json.meshes ?? []) as Json[]).map((m, mi) => {
    const prims: MeshPrimitive[] = [];
    for (const p of (m.primitives ?? []) as Json[]) {
      const mode = p.mode ?? 4;
      if (mode !== 4) {
        unsupported.push(`primitive mode ${mode} (only triangle lists are geometry)`);
        continue;
      }
      if (p.targets) unsupported.push('morph targets');
      if (p.extensions)
        for (const k of Object.keys(p.extensions))
          if (UNDECODABLE.includes(k)) {
            d.push(
              err('gltf-compressed', `Mesh ${mi} uses ${k} (compressed geometry) which FORGE cannot decode.`),
            );
            continue;
          }
      if (p.attributes?.POSITION === undefined) {
        d.push(warn('gltf-no-position', `A primitive of mesh "${m.name ?? mi}" has no POSITION; skipped.`));
        continue;
      }
      const pos = accessor(p.attributes.POSITION, 'float') as Float32Array | null;
      if (!pos) {
        d.push(
          err('gltf-accessor', `POSITION accessor of mesh "${m.name ?? mi}" is invalid or out of bounds.`),
        );
        continue;
      }
      if (pos.some((x) => !Number.isFinite(x)))
        d.push(err('non-finite', `Mesh "${m.name ?? mi}" has non-finite positions.`));
      let idx: Uint32Array;
      if (p.indices !== undefined) {
        const ix = accessor(p.indices, 'index') as Uint32Array | null;
        if (!ix) {
          d.push(err('gltf-accessor', `Index accessor of mesh "${m.name ?? mi}" is invalid.`));
          continue;
        }
        idx = ix;
      } else idx = new Uint32Array(pos.length / 3).map((_, i) => i);
      if (idx.length % 3)
        d.push(err('gltf-indices', `Mesh "${m.name ?? mi}" index count is not a multiple of 3.`));
      if (idx.some((i) => i >= pos.length / 3))
        d.push(err('gltf-indices', `Mesh "${m.name ?? mi}" has indices beyond its vertex count.`));
      if (p.attributes.TEXCOORD_0 !== undefined) unsupported.push('texture coordinates (display only)');
      if (p.attributes.JOINTS_0 !== undefined) unsupported.push('skinning weights');
      tris += idx.length / 3;
      const nrm =
        p.attributes.NORMAL !== undefined
          ? (accessor(p.attributes.NORMAL, 'float') as Float32Array | null)
          : null;
      prims.push({
        positions: pos,
        indices: idx,
        normals: nrm,
        material: typeof p.material === 'number' && materials[p.material] ? p.material : null,
      });
    }
    return { name: typeof m.name === 'string' ? m.name : `mesh ${mi}`, primitives: prims };
  });
  if (tris > MAX_TRIANGLES)
    return fail(
      container,
      err('too-many-triangles', `${tris} triangles exceed the limit of ${MAX_TRIANGLES}.`),
    );
  if (json.skins?.length) unsupported.push(`${json.skins.length} skin(s)`);
  if (json.animations?.length) unsupported.push(`${json.animations.length} animation(s)`);
  if (json.cameras?.length) unsupported.push(`${json.cameras.length} camera(s)`);

  const nodesJ = (json.nodes ?? []) as Json[];
  const nodes = nodesJ.map((n, i) => {
    let matrix = [...IDENTITY];
    if (Array.isArray(n.matrix) && n.matrix.length === 16) matrix = n.matrix.map(Number);
    else if (n.translation || n.rotation || n.scale)
      matrix = fromTRS(
        (n.translation ?? [0, 0, 0]) as V3,
        (n.rotation ?? [0, 0, 0, 1]) as [number, number, number, number],
        (n.scale ?? [1, 1, 1]) as V3,
      );
    if (matrix.some((x: number) => !Number.isFinite(x)))
      d.push(err('non-finite', `Node ${i} has a non-finite transform.`));
    const metadata: Record<string, string> = {};
    if (n.extras && typeof n.extras === 'object')
      for (const [k, val] of Object.entries(n.extras).slice(0, 32))
        if (typeof val === 'string' || typeof val === 'number')
          metadata[k.slice(0, 64)] = String(val).slice(0, 500);
    return {
      name: typeof n.name === 'string' ? n.name : `node ${i}`,
      matrix,
      mesh: typeof n.mesh === 'number' && meshes[n.mesh] ? n.mesh : null,
      children: Array.isArray(n.children)
        ? (n.children as number[]).filter((c) => Number.isInteger(c) && c >= 0 && c < nodesJ.length)
        : [],
      metadata,
    };
  });
  // Every node must have at most one parent (a tree); cycles are refused.
  const parentCount = new Array(nodes.length).fill(0);
  nodes.forEach((n) => n.children.forEach((c) => parentCount[c]++));
  if (parentCount.some((c) => c > 1))
    return fail(container, err('gltf-graph', 'A node has more than one parent (not a tree).'));
  const sceneIdx = typeof json.scene === 'number' ? json.scene : 0;
  let roots: number[] =
    json.scenes?.[sceneIdx]?.nodes ?? nodes.map((_, i) => i).filter((i) => parentCount[i] === 0);
  roots = roots.filter((r) => Number.isInteger(r) && r >= 0 && r < nodes.length);
  if ((json.scenes?.length ?? 0) > 1)
    unsupported.push(`${json.scenes.length - 1} additional scene(s) (only the default scene is imported)`);
  const scene: MeshScene = { roots, nodes, meshes, materials };
  try {
    // Detect cycles by walking the default scene.
    const seen = new Set<number>();
    const walk = (i: number, depth: number) => {
      if (depth > 256 || seen.has(i)) throw new Error('cycle');
      seen.add(i);
      nodes[i]!.children.forEach((c) => walk(c, depth + 1));
    };
    roots.forEach((r) => walk(r, 0));
  } catch {
    return fail(container, err('gltf-graph', 'The node hierarchy contains a cycle.'));
  }
  if (!tris) d.push(err('empty', 'The model contains no triangle geometry.'));
  const uniq = [...new Set(unsupported)];
  if (uniq.length)
    d.push(info('gltf-unsupported', `Not represented in the engineering scene: ${uniq.join('; ')}.`));
  return {
    ok: !d.some((x) => x.severity === 'error'),
    container,
    version,
    generator,
    scene,
    unsupported: uniq,
    diagnostics: d,
  };
}

/** Write a MeshScene as GLB 2.0. */
export function writeGlb(
  s: MeshScene,
  opts: { generator?: string; extras?: Record<string, string> } = {},
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: Json[] = [];
  const accessors: Json[] = [];
  const push = (data: Uint8Array, target: number) => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      offset += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target });
    chunks.push(data);
    offset += data.byteLength;
    return bufferViews.length - 1;
  };
  const meshes = s.meshes.map((m) => ({
    name: m.name,
    primitives: m.primitives.map((p) => {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, p.positions[i + k]!);
          max[k] = Math.max(max[k]!, p.positions[i + k]!);
        }
      const pv = push(
        new Uint8Array(
          p.positions.buffer.slice(p.positions.byteOffset, p.positions.byteOffset + p.positions.byteLength),
        ),
        34962,
      );
      accessors.push({
        bufferView: pv,
        componentType: 5126,
        count: p.positions.length / 3,
        type: 'VEC3',
        min,
        max,
      });
      const attributes: Json = { POSITION: accessors.length - 1 };
      if (p.normals) {
        const nv = push(
          new Uint8Array(
            p.normals.buffer.slice(p.normals.byteOffset, p.normals.byteOffset + p.normals.byteLength),
          ),
          34962,
        );
        accessors.push({ bufferView: nv, componentType: 5126, count: p.normals.length / 3, type: 'VEC3' });
        attributes.NORMAL = accessors.length - 1;
      }
      const iv = push(
        new Uint8Array(
          p.indices.buffer.slice(p.indices.byteOffset, p.indices.byteOffset + p.indices.byteLength),
        ),
        34963,
      );
      accessors.push({ bufferView: iv, componentType: 5125, count: p.indices.length, type: 'SCALAR' });
      return {
        attributes,
        indices: accessors.length - 1,
        mode: 4,
        ...(p.material !== null ? { material: p.material } : {}),
      };
    }),
  }));
  const isIdentity = (m: number[]) => m.every((x, i) => Math.abs(x - IDENTITY[i]!) < 1e-15);
  const json: Json = {
    asset: {
      version: '2.0',
      generator: opts.generator ?? 'FORGE interop',
      ...(opts.extras ? { extras: opts.extras } : {}),
    },
    scene: 0,
    scenes: [{ nodes: s.roots }],
    nodes: s.nodes.map((n) => ({
      name: n.name,
      ...(isIdentity(n.matrix) ? {} : { matrix: n.matrix }),
      ...(n.mesh !== null ? { mesh: n.mesh } : {}),
      ...(n.children.length ? { children: n.children } : {}),
      ...(Object.keys(n.metadata).length ? { extras: n.metadata } : {}),
    })),
    meshes,
    ...(s.materials.length
      ? {
          materials: s.materials.map((m) => ({
            name: m.name,
            pbrMetallicRoughness: {
              baseColorFactor: m.baseColor,
              metallicFactor: m.metallic,
              roughnessFactor: m.roughness,
            },
            ...(m.baseColor[3] < 1 ? { alphaMode: 'BLEND' } : {}),
          })),
        }
      : {}),
    buffers: [{ byteLength: offset }],
    bufferViews,
    accessors,
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const jb = new TextEncoder().encode(text);
  const binPad = (4 - (offset % 4)) % 4;
  const binLen = offset + binPad;
  const total = 12 + 8 + jb.length + 8 + binLen;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, GLB_MAGIC, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jb.length, true);
  v.setUint32(16, CHUNK_JSON, true);
  out.set(jb, 20);
  v.setUint32(20 + jb.length, binLen, true);
  v.setUint32(24 + jb.length, CHUNK_BIN, true);
  let o = 28 + jb.length;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/**
 * Weld vertices that share BOTH position and normal (exact float equality). Flat-shaded facet
 * meshes keep their sharp edges (a vertex on a crease keeps one copy per facet normal) while
 * coplanar regions collapse to shared vertices. Without normals, positions alone are welded.
 */
export function weld(p: MeshPrimitive): MeshPrimitive {
  const map = new Map<string, number>();
  const pos: number[] = [];
  const nrm: number[] = [];
  const N = p.normals;
  const idx = new Uint32Array(p.indices.length);
  for (let i = 0; i < p.indices.length; i++) {
    const v = p.indices[i]! * 3;
    const k = N
      ? `${p.positions[v]},${p.positions[v + 1]},${p.positions[v + 2]},${N[v]},${N[v + 1]},${N[v + 2]}`
      : `${p.positions[v]},${p.positions[v + 1]},${p.positions[v + 2]}`;
    let id = map.get(k);
    if (id === undefined) {
      id = pos.length / 3;
      map.set(k, id);
      pos.push(p.positions[v]!, p.positions[v + 1]!, p.positions[v + 2]!);
      if (N) nrm.push(N[v]!, N[v + 1]!, N[v + 2]!);
    }
    idx[i] = id;
  }
  return {
    positions: Float32Array.from(pos),
    indices: idx,
    normals: N ? Float32Array.from(nrm) : null,
    material: p.material,
  };
}
