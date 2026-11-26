import { createProject, type Project } from '@forge/engineering-core';
import { createRequire } from 'node:module';
import type { OcctKernel } from '../formats/step';
import { IDENTITY, type MeshScene } from '../mesh';

/** Outward-wound triangle soup of an axis-aligned box [o, o + s]. */
export function boxSoup(s: [number, number, number], o: [number, number, number] = [0, 0, 0]): Float32Array {
  const [a, b, c] = s;
  const P = [
    [0, 0, 0],
    [a, 0, 0],
    [a, b, 0],
    [0, b, 0],
    [0, 0, c],
    [a, 0, c],
    [a, b, c],
    [0, b, c],
  ].map((p) => [p[0]! + o[0], p[1]! + o[1], p[2]! + o[2]]);
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const out: number[] = [];
  for (const [p, q, r, t] of quads) for (const v of [p, q, r, p, r, t]) out.push(...P[v!]!);
  return Float32Array.from(out);
}

/** Hand-written ASCII STL of a unit right-angled tetrahedron (independent of the writer). */
export const TETRA_ASCII = `solid tetra
  facet normal 0 0 -1
    outer loop
      vertex 0 0 0
      vertex 0 1 0
      vertex 1 0 0
    endloop
  endfacet
  facet normal 0 -1 0
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 0 1
    endloop
  endfacet
  facet normal -1 0 0
    outer loop
      vertex 0 0 0
      vertex 0 0 1
      vertex 0 1 0
    endloop
  endfacet
  facet normal 0.577 0.577 0.577
    outer loop
      vertex 1 0 0
      vertex 0 1 0
      vertex 0 0 1
    endloop
  endfacet
endsolid tetra
`;

export function sceneOf(
  nodes: { name: string; matrix?: number[]; soup?: Float32Array; children?: number[] }[],
  roots: number[],
): MeshScene {
  const s: MeshScene = {
    roots,
    nodes: [],
    meshes: [],
    materials: [{ name: 'steel', baseColor: [0.6, 0.6, 0.65, 1], metallic: 1, roughness: 0.4 }],
  };
  for (const n of nodes) {
    let mesh: number | null = null;
    if (n.soup) {
      s.meshes.push({
        name: n.name,
        primitives: [
          {
            positions: n.soup,
            indices: new Uint32Array(n.soup.length / 3).map((_, i) => i),
            normals: null,
            material: 0,
          },
        ],
      });
      mesh = s.meshes.length - 1;
    }
    s.nodes.push({
      name: n.name,
      matrix: n.matrix ?? [...IDENTITY],
      mesh,
      children: n.children ?? [],
      metadata: {},
    });
  }
  return s;
}

let occt: OcctKernel | null = null;
export async function loadOcct(): Promise<OcctKernel> {
  if (occt) return occt;
  const require = createRequire(import.meta.url);
  const factory = require('occt-import-js') as () => Promise<OcctKernel>;
  occt = await factory();
  return occt;
}

export const AT = new Date('2026-11-26T00:00:00Z');
export function emptyProject(): Project {
  return createProject('Interop test', AT);
}
export function idGen(prefix = 'n') {
  let i = 0;
  return () => `${prefix}-${++i}`;
}
