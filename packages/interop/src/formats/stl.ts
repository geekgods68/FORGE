import { facetNormals, IDENTITY, type MeshScene } from '../mesh';
import { err, info, MAX_INPUT_BYTES, MAX_TRIANGLES, warn, type Diagnostic } from '../schemas';

/**
 * STL (stereolithography) — binary and ASCII.
 *
 * STL carries only a triangle soup: no units, no axes, no hierarchy, no materials, no
 * features. Units and the up axis are therefore confirmed by the user, never guessed.
 * Each ASCII `solid … endsolid` block becomes its own node (multiple disconnected objects).
 * Stored facet normals are compared with the vertex winding and reported, not trusted.
 */
declare const TextDecoder: { new (label?: string): { decode(input: Uint8Array): string } };
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };

export interface StlParse {
  ok: boolean;
  variant: 'binary' | 'ascii' | null;
  scene: MeshScene | null;
  header: string;
  diagnostics: Diagnostic[];
}

export function isBinaryStl(b: Uint8Array): boolean {
  if (b.byteLength < 84) return false;
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
  return 84 + n * 50 === b.byteLength;
}

function soupToScene(solids: { name: string; tri: Float32Array }[]): MeshScene {
  const s: MeshScene = { roots: [], nodes: [], meshes: [], materials: [] };
  for (const sol of solids) {
    const positions = sol.tri;
    const indices = new Uint32Array(positions.length / 3).map((_, i) => i);
    s.meshes.push({ name: sol.name, primitives: [{ positions, indices, normals: null, material: null }] });
    s.nodes.push({
      name: sol.name,
      matrix: [...IDENTITY],
      mesh: s.meshes.length - 1,
      children: [],
      metadata: {},
    });
    s.roots.push(s.nodes.length - 1);
  }
  return s;
}

/** Compare stored facet normals with the winding (majority disagreement = inverted file). */
function checkNormals(tri: Float32Array, stored: Float32Array, d: Diagnostic[]) {
  const computed = facetNormals(Float64Array.from(tri));
  let opposite = 0;
  let zero = 0;
  const n = tri.length / 9;
  for (let t = 0; t < n; t++) {
    const sx = stored[t * 3]!,
      sy = stored[t * 3 + 1]!,
      sz = stored[t * 3 + 2]!;
    if (sx === 0 && sy === 0 && sz === 0) {
      zero++;
      continue;
    }
    const dot = sx * computed[t * 9]! + sy * computed[t * 9 + 1]! + sz * computed[t * 9 + 2]!;
    if (dot < 0) opposite++;
  }
  if (opposite)
    d.push(
      warn(
        'stl-normals-disagree',
        `${opposite} of ${n} stored facet normals point against the vertex winding; FORGE uses the winding (right-hand rule).`,
      ),
    );
  if (zero)
    d.push(info('stl-normals-missing', `${zero} facets have no stored normal; computed from the winding.`));
}

export function parseStl(bytes: Uint8Array, name = 'STL'): StlParse {
  const d: Diagnostic[] = [];
  if (bytes.byteLength > MAX_INPUT_BYTES.stl)
    return {
      ok: false,
      variant: null,
      scene: null,
      header: '',
      diagnostics: [err('too-large', `STL larger than ${MAX_INPUT_BYTES.stl / 1048576} MiB.`)],
    };
  if (isBinaryStl(bytes)) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = v.getUint32(80, true);
    if (n === 0)
      return {
        ok: false,
        variant: 'binary',
        scene: null,
        header: '',
        diagnostics: [err('empty', 'The STL file contains no triangles.')],
      };
    if (n > MAX_TRIANGLES)
      return {
        ok: false,
        variant: 'binary',
        scene: null,
        header: '',
        diagnostics: [err('too-many-triangles', `${n} triangles exceed the limit of ${MAX_TRIANGLES}.`)],
      };
    const header = new TextDecoder('latin1').decode(bytes.subarray(0, 80)).replace(/\0+$/, '').trim();
    const tri = new Float32Array(n * 9);
    const normals = new Float32Array(n * 3);
    let attr = 0;
    let bad = 0;
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50;
      for (let k = 0; k < 3; k++) normals[t * 3 + k] = v.getFloat32(o + k * 4, true);
      for (let k = 0; k < 9; k++) {
        const x = v.getFloat32(o + 12 + k * 4, true);
        if (!Number.isFinite(x)) bad++;
        tri[t * 9 + k] = x;
      }
      if (v.getUint16(o + 48, true) !== 0) attr++;
    }
    if (bad)
      return {
        ok: false,
        variant: 'binary',
        scene: null,
        header,
        diagnostics: [err('non-finite', `${bad} vertex coordinates are NaN or infinite.`)],
      };
    if (attr)
      d.push(
        warn(
          'stl-attributes',
          `${attr} facets carry non-zero attribute bytes (vendor colour extensions); not represented, ignored.`,
        ),
      );
    if (/^solid/i.test(header))
      d.push(
        info(
          'stl-header-solid',
          'Binary STL whose header starts with "solid" (detected as binary by its exact size).',
        ),
      );
    checkNormals(tri, normals, d);
    return {
      ok: true,
      variant: 'binary',
      scene: soupToScene([{ name: header || name, tri }]),
      header,
      diagnostics: d,
    };
  }
  // ASCII.
  const text = new TextDecoder('utf-8').decode(bytes);
  if (!/^\s*solid\b/i.test(text))
    return {
      ok: false,
      variant: null,
      scene: null,
      header: '',
      diagnostics: [
        err('not-stl', 'Neither a binary STL (size mismatch) nor an ASCII STL (no "solid" keyword).'),
      ],
    };
  const solids: { name: string; tri: Float32Array }[] = [];
  const re = /solid\s*([^\r\n]*)\r?\n([\s\S]*?)endsolid[^\r\n]*/gi;
  let m: RegExpExecArray | null;
  let total = 0;
  while ((m = re.exec(text))) {
    const body = m[2]!;
    const verts: number[] = [];
    const norms: number[] = [];
    const facets = body.split(/endfacet/i);
    for (const f of facets) {
      if (!/facet/i.test(f)) continue;
      const nm = /facet\s+normal\s+(\S+)\s+(\S+)\s+(\S+)/i.exec(f);
      const vs = [...f.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)];
      if (vs.length !== 3) {
        d.push(
          err('stl-facet', `A facet in solid "${m[1]!.trim()}" has ${vs.length} vertices (3 required).`),
        );
        continue;
      }
      norms.push(...(nm ? [Number(nm[1]), Number(nm[2]), Number(nm[3])] : [0, 0, 0]));
      for (const x of vs) verts.push(Number(x[1]), Number(x[2]), Number(x[3]));
    }
    if (verts.some((x) => !Number.isFinite(x)))
      d.push(err('non-finite', `Solid "${m[1]!.trim()}" has non-numeric or infinite coordinates.`));
    total += verts.length / 9;
    if (total > MAX_TRIANGLES)
      return {
        ok: false,
        variant: 'ascii',
        scene: null,
        header: '',
        diagnostics: [err('too-many-triangles', `More than ${MAX_TRIANGLES} triangles.`)],
      };
    const tri = Float32Array.from(verts);
    if (tri.length) checkNormals(tri, Float32Array.from(norms), d);
    solids.push({ name: m[1]!.trim() || `${name} ${solids.length + 1}`, tri });
  }
  if (!solids.length)
    return {
      ok: false,
      variant: 'ascii',
      scene: null,
      header: '',
      diagnostics: [...d, err('not-stl', 'No complete "solid … endsolid" block found.')],
    };
  if (total === 0)
    return {
      ok: false,
      variant: 'ascii',
      scene: null,
      header: '',
      diagnostics: [...d, err('empty', 'The STL file contains no triangles.')],
    };
  if (solids.length > 1)
    d.push(info('stl-multiple-solids', `${solids.length} solids: each becomes a separate node.`));
  const ok = !d.some((x) => x.severity === 'error');
  return {
    ok,
    variant: 'ascii',
    scene: ok ? soupToScene(solids.filter((s) => s.tri.length)) : null,
    header: solids[0]!.name,
    diagnostics: d,
  };
}

/**
 * Write a world-space triangle soup as STL. Binary by default; ASCII on request. The caller
 * chooses units and axes (STL itself records neither); the header states them.
 */
export function writeStl(
  tri: Float64Array | Float32Array,
  opts: { ascii?: boolean; name?: string; header?: string } = {},
): Uint8Array {
  const n = tri.length / 9;
  const normals = facetNormals(Float64Array.from(tri));
  const name = (opts.name ?? 'forge').replace(/\s+/g, '_');
  if (opts.ascii) {
    const f = (x: number) => x.toExponential(7);
    const L = [`solid ${name}`];
    for (let t = 0; t < n; t++) {
      L.push(
        `  facet normal ${f(normals[t * 9]!)} ${f(normals[t * 9 + 1]!)} ${f(normals[t * 9 + 2]!)}`,
        '    outer loop',
      );
      for (let v = 0; v < 3; v++)
        L.push(
          `      vertex ${f(tri[t * 9 + v * 3]!)} ${f(tri[t * 9 + v * 3 + 1]!)} ${f(tri[t * 9 + v * 3 + 2]!)}`,
        );
      L.push('    endloop', '  endfacet');
    }
    L.push(`endsolid ${name}`, '');
    return new TextEncoder().encode(L.join('\n'));
  }
  const out = new Uint8Array(84 + n * 50);
  const v = new DataView(out.buffer);
  const head = new TextEncoder().encode((opts.header ?? `FORGE STL ${name}`).slice(0, 79));
  // Binary headers must not start with "solid" (some readers would treat the file as ASCII).
  out.set(
    head[0] === 0x73 ? new TextEncoder().encode('FORGE ' + (opts.header ?? '')).subarray(0, 79) : head,
    0,
  );
  v.setUint32(80, n, true);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50;
    for (let k = 0; k < 3; k++) v.setFloat32(o + k * 4, normals[t * 9 + k]!, true);
    for (let k = 0; k < 9; k++) v.setFloat32(o + 12 + k * 4, tri[t * 9 + k]!, true);
    v.setUint16(o + 48, 0, true);
  }
  return out;
}
