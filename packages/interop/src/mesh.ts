/**
 * Canonical tessellated scene used by every geometry format in FORGE interop.
 *
 * - Matrices are column-major 4×4 (glTF / three.js convention).
 * - A MeshScene stays in its SOURCE units and axes; `normalise()` produces the FORGE frame
 *   (metres, +Y up, right-handed) explicitly, so nothing is converted silently.
 * - It is tessellated geometry: it never carries a parametric feature tree or an editable
 *   B-rep, whatever format it came from.
 */
export type Mat4 = number[]; // length 16, column-major
export type V3 = [number, number, number];

export interface MeshPrimitive {
  positions: Float32Array; // xyz triples
  indices: Uint32Array; // triangle list
  normals: Float32Array | null;
  material: number | null;
}
export interface MeshData {
  name: string;
  primitives: MeshPrimitive[];
}
export interface MaterialData {
  name: string;
  /** Linear RGBA, 0–1. */
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
}
export interface SceneNodeData {
  name: string;
  /** Local transform relative to the parent (column-major). */
  matrix: Mat4;
  mesh: number | null;
  children: number[];
  /** Plain-string attributes carried from the source (e.g. STEP product id). */
  metadata: Record<string, string>;
}
export interface MeshScene {
  roots: number[];
  nodes: SceneNodeData[];
  meshes: MeshData[];
  materials: MaterialData[];
}

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  return o;
}
export function apply(m: Mat4, x: number, y: number, z: number): V3 {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}
/** Determinant of the upper-left 3×3 block (negative = the transform mirrors). */
export function det3(m: Mat4): number {
  return (
    m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) -
    m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) +
    m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!)
  );
}
export function fromTRS(t: V3, q: [number, number, number, number], s: V3): Mat4 {
  const [x, y, z, w] = q;
  const xx = x * x,
    yy = y * y,
    zz = z * z,
    xy = x * y,
    xz = x * z,
    yz = y * z,
    wx = w * x,
    wy = w * y,
    wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0],
    2 * (xy + wz) * s[0],
    2 * (xz - wy) * s[0],
    0,
    2 * (xy - wz) * s[1],
    (1 - 2 * (xx + zz)) * s[1],
    2 * (yz + wx) * s[1],
    0,
    2 * (xz + wy) * s[2],
    2 * (yz - wx) * s[2],
    (1 - 2 * (xx + yy)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}
export const scaleM = (k: number): Mat4 => [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1];
export const translateM = (t: V3): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
/** Rotation taking a +Z-up source to FORGE +Y-up: (x, y, z) → (x, z, −y) (−90° about X). */
export const Z_UP_TO_Y_UP: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
/** Mirror of the Z axis: converts a left-handed source to right-handed. */
export const MIRROR_Z: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

export interface Frame {
  /** Source length unit → metres. */
  toMetres: number;
  upAxis: 'Y' | 'Z';
  handedness: 'right' | 'left';
}
/** Matrix from the source frame to the FORGE frame (metres, +Y up, right-handed). */
export function frameMatrix(f: Frame): Mat4 {
  let m = scaleM(f.toMetres);
  if (f.handedness === 'left') m = mul(m, MIRROR_Z);
  if (f.upAxis === 'Z') m = mul(Z_UP_TO_Y_UP, m);
  return m;
}

/** World matrix of every node (parents first). */
export function worldMatrices(s: MeshScene, root: Mat4 = IDENTITY): Mat4[] {
  const out: Mat4[] = new Array(s.nodes.length);
  const visit = (i: number, parent: Mat4, depth: number) => {
    if (depth > 256) throw new Error('Scene hierarchy deeper than 256 levels (cycle?).');
    const n = s.nodes[i]!;
    out[i] = mul(parent, n.matrix);
    for (const c of n.children) visit(c, out[i]!, depth + 1);
  };
  for (const r of s.roots) visit(r, root, 0);
  return out;
}

export interface Triangles {
  /** World-space triangle soup (9 floats per triangle), mirrored transforms already re-wound. */
  tri: Float64Array;
  /** Owning node per triangle. */
  node: Uint32Array;
}
/** Flatten a scene into world-space triangles (optionally through an extra root transform). */
export function triangles(s: MeshScene, root: Mat4 = IDENTITY): Triangles {
  const W = worldMatrices(s, root);
  let count = 0;
  // Only nodes reachable from the roots contribute (unreachable nodes have no world matrix).
  s.nodes.forEach((n, ni) => {
    if (n.mesh !== null && W[ni]) for (const p of s.meshes[n.mesh]!.primitives) count += p.indices.length / 3;
  });
  const tri = new Float64Array(count * 9);
  const node = new Uint32Array(count);
  let k = 0;
  s.nodes.forEach((n, ni) => {
    if (n.mesh === null || !W[ni]) return;
    const m = W[ni]!;
    const flip = det3(m) < 0;
    for (const p of s.meshes[n.mesh]!.primitives) {
      const P = p.positions;
      for (let t = 0; t < p.indices.length; t += 3) {
        const ids = flip
          ? [p.indices[t]!, p.indices[t + 2]!, p.indices[t + 1]!]
          : [p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!];
        for (let v = 0; v < 3; v++) {
          const i = ids[v]! * 3;
          const w = apply(m, P[i]!, P[i + 1]!, P[i + 2]!);
          tri[k * 9 + v * 3] = w[0];
          tri[k * 9 + v * 3 + 1] = w[1];
          tri[k * 9 + v * 3 + 2] = w[2];
        }
        node[k] = ni;
        k++;
      }
    }
  });
  return { tri, node };
}

export interface Bounds {
  min: V3;
  max: V3;
  size: V3;
}
export function boundsOf(tri: Float64Array): Bounds | null {
  if (!tri.length) return null;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tri.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = tri[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

export interface MeshMetrics {
  triangles: number;
  vertices: number;
  bounds: Bounds | null;
  surfaceAreaM2: number;
  /** Signed-tetrahedron volume; meaningful only when the mesh is closed and consistently wound. */
  volume: number;
  closed: boolean;
  /** Edges shared by more than two triangles. */
  nonManifoldEdges: number;
  /** Edges used by exactly one triangle. */
  boundaryEdges: number;
  /** Zero-area (collapsed) triangles. */
  degenerateTriangles: number;
  /** Connected components (by shared vertex positions). */
  components: number;
}

/**
 * Geometry metrics over a world-space triangle soup. Vertices are welded by exact position
 * after quantising to `weld` (in the soup's units) so topology is independent of how the
 * source split its vertex arrays.
 */
export function metrics(tri: Float64Array, weld = 1e-9): MeshMetrics {
  const n = tri.length / 9;
  const ids = new Map<string, number>();
  const key = (i: number) =>
    `${Math.round(tri[i]! / weld)},${Math.round(tri[i + 1]! / weld)},${Math.round(tri[i + 2]! / weld)}`;
  const vid = new Uint32Array(n * 3);
  for (let i = 0; i < n * 3; i++) {
    const k = key(i * 3);
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    vid[i] = id;
  }
  const parent = new Uint32Array(ids.size).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  const edges = new Map<string, number>();
  let area = 0;
  let volume = 0;
  let degenerate = 0;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = tri[o]!,
      ay = tri[o + 1]!,
      az = tri[o + 2]!;
    const bx = tri[o + 3]! - ax,
      by = tri[o + 4]! - ay,
      bz = tri[o + 5]! - az;
    const cx = tri[o + 6]! - ax,
      cy = tri[o + 7]! - ay,
      cz = tri[o + 8]! - az;
    const nx = by * cz - bz * cy,
      ny = bz * cx - bx * cz,
      nz = bx * cy - by * cx;
    const a2 = Math.hypot(nx, ny, nz);
    area += a2 / 2;
    // Signed volume of the tetrahedron (origin, a, b, c) = a · (b × c) / 6.
    volume +=
      (tri[o]! * (tri[o + 4]! * tri[o + 8]! - tri[o + 5]! * tri[o + 7]!) -
        tri[o + 1]! * (tri[o + 3]! * tri[o + 8]! - tri[o + 5]! * tri[o + 6]!) +
        tri[o + 2]! * (tri[o + 3]! * tri[o + 7]! - tri[o + 4]! * tri[o + 6]!)) /
      6;
    const v = [vid[t * 3]!, vid[t * 3 + 1]!, vid[t * 3 + 2]!];
    if (a2 === 0 || v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) {
      degenerate++;
      continue;
    }
    for (let e = 0; e < 3; e++) {
      const p = v[e]!,
        q = v[(e + 1) % 3]!;
      const k = p < q ? `${p},${q}` : `${q},${p}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
      const rp = find(p),
        rq = find(q);
      if (rp !== rq) parent[rp] = rq;
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const c of edges.values()) {
    if (c === 1) boundary++;
    else if (c > 2) nonManifold++;
  }
  const used = new Set<number>();
  for (let i = 0; i < vid.length; i++) used.add(find(vid[i]!));
  return {
    triangles: n,
    vertices: ids.size,
    bounds: boundsOf(tri),
    surfaceAreaM2: area,
    volume,
    closed: n > 0 && boundary === 0 && nonManifold === 0,
    nonManifoldEdges: nonManifold,
    boundaryEdges: boundary,
    degenerateTriangles: degenerate,
    components: used.size,
  };
}

/** Facet normals (unit) for a triangle soup; zero for degenerate triangles. */
export function facetNormals(tri: Float64Array): Float32Array {
  const out = new Float32Array(tri.length);
  for (let t = 0; t < tri.length / 9; t++) {
    const o = t * 9;
    const bx = tri[o + 3]! - tri[o]!,
      by = tri[o + 4]! - tri[o + 1]!,
      bz = tri[o + 5]! - tri[o + 2]!;
    const cx = tri[o + 6]! - tri[o]!,
      cy = tri[o + 7]! - tri[o + 1]!,
      cz = tri[o + 8]! - tri[o + 2]!;
    const nx = by * cz - bz * cy,
      ny = bz * cx - bx * cz,
      nz = bx * cy - by * cx;
    const l = Math.hypot(nx, ny, nz) || 1;
    for (let v = 0; v < 3; v++) {
      out[t * 9 + v * 3] = nx / l;
      out[t * 9 + v * 3 + 1] = ny / l;
      out[t * 9 + v * 3 + 2] = nz / l;
    }
  }
  return out;
}

/** Single-node scene from a triangle soup (used by STL and by exports of baked geometry). */
export function sceneFromTriangles(
  name: string,
  tri: Float64Array | Float32Array,
  material: MaterialData | null = null,
): MeshScene {
  const positions = Float32Array.from(tri);
  const indices = new Uint32Array(positions.length / 3).map((_, i) => i);
  return {
    roots: [0],
    nodes: [{ name, matrix: [...IDENTITY], mesh: 0, children: [], metadata: {} }],
    meshes: [{ name, primitives: [{ positions, indices, normals: null, material: material ? 0 : null }] }],
    materials: material ? [material] : [],
  };
}

/** Count summary used in previews and provenance. */
export function sceneSummary(s: MeshScene) {
  let tris = 0;
  let verts = 0;
  for (const m of s.meshes)
    for (const p of m.primitives) {
      tris += p.indices.length / 3;
      verts += p.positions.length / 3;
    }
  const depth = (i: number, d: number): number =>
    Math.max(d, ...s.nodes[i]!.children.map((c) => depth(c, d + 1)));
  return {
    nodes: s.nodes.length,
    meshNodes: s.nodes.filter((n) => n.mesh !== null).length,
    meshes: s.meshes.length,
    materials: s.materials.length,
    triangles: tris,
    vertices: verts,
    depth: s.roots.length ? Math.max(...s.roots.map((r) => depth(r, 1))) : 0,
  };
}
