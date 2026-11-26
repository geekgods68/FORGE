import {
  ForgeEngine,
  makeCommand,
  type CommandInput,
  type Project,
  type SceneNode,
} from '@forge/engineering-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseGltf, writeGlb } from '../formats/gltf';
import { readStepHeader, stepToScene, type OcctKernel } from '../formats/step';
import { parseStl, writeStl } from '../formats/stl';
import { analyseGeometry, planGeometryImport, previewGeometry, type GeometryAnalysis } from '../geometry';
import { fromTRS, metrics, mul, scaleM, translateM, triangles, Z_UP_TO_Y_UP } from '../mesh';
import { importOf, importStatus, nodesFingerprint } from '../provenance';
import { AT, boxSoup, emptyProject, idGen, loadOcct, sceneOf, TETRA_ASCII } from './fixtures';
import { stepAssembly } from './step-fixtures';

/**
 * Tolerances (fixed before measuring): geometry is stored as float32 (STL, glTF and the
 * converted GLB), ~7 significant digits, so dimensions are compared to 1e-6 relative (1e-6 of
 * one unit for zero targets). OCCT tessellates PLANAR faces exactly, so STEP boxes are held
 * to the same float32 bound; areas and volumes follow from the dimensions.
 */
const REL = 1e-6;
const enc = new TextEncoder();
/** |a − b| ≤ rel·|b|, with an absolute floor of rel × 1 unit for targets at zero. */
const close = (a: number, b: number, rel = REL) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(Math.abs(b), 1));

let occt: OcctKernel;
beforeAll(async () => {
  occt = await loadOcct();
});

function apply(project: Project, commands: unknown[]) {
  const e = new ForgeEngine(project, { now: () => AT });
  const r = e.execute(makeCommand('scene.batch', { commands } as never, 'test') as CommandInput);
  return { engine: e, result: r };
}

describe('STL', () => {
  it('parses binary STL and measures a 10 × 20 × 30 mm box in the FORGE frame (Z-up → Y-up)', () => {
    const bin = writeStl(boxSoup([10, 20, 30]));
    expect(bin.byteLength).toBe(84 + 12 * 50);
    const a = analyseGeometry({ name: 'box.stl', bytes: bin }, 'stl');
    expect(a.ok).toBe(true);
    expect(a.variant).toBe('binary');
    const p = previewGeometry(a, { toMetres: 0.001, upAxis: 'Z', handedness: 'right' })!;
    // Source Z (30 mm) becomes FORGE Y; source Y (20 mm) becomes FORGE −Z.
    close(p.metrics.bounds!.size[0], 0.01);
    close(p.metrics.bounds!.size[1], 0.03);
    close(p.metrics.bounds!.size[2], 0.02);
    close(p.metrics.bounds!.min[2], -0.02);
    close(p.metrics.volume, 0.01 * 0.02 * 0.03);
    close(p.metrics.surfaceAreaM2, 2 * (0.01 * 0.02 + 0.01 * 0.03 + 0.02 * 0.03));
    expect(p.metrics.closed).toBe(true);
    expect(p.metrics.components).toBe(1);
    expect(p.metrics.triangles).toBe(12);
    expect(p.metrics.vertices).toBe(8);
  });

  it('parses hand-written ASCII STL independently of the writer (tetrahedron volume 1/6)', () => {
    const r = parseStl(enc.encode(TETRA_ASCII));
    expect(r.ok && r.variant).toBe('ascii');
    const m = metrics(triangles(r.scene!).tri);
    close(m.volume, 1 / 6);
    close(m.surfaceAreaM2, 1.5 + Math.sqrt(3) / 2);
    expect(m.closed).toBe(true);
    expect(r.diagnostics.find((d) => d.code === 'stl-normals-disagree')).toBeUndefined();
  });

  it('keeps multiple ASCII solids as separate nodes and counts disconnected components', () => {
    const t1 = new TextDecoder().decode(writeStl(boxSoup([1, 1, 1]), { ascii: true, name: 'a' }));
    const t2 = new TextDecoder().decode(writeStl(boxSoup([1, 1, 1], [5, 0, 0]), { ascii: true, name: 'b' }));
    const r = parseStl(enc.encode(t1 + t2));
    expect(r.scene!.nodes.map((n) => n.name)).toEqual(['a', 'b']);
    expect(metrics(triangles(r.scene!).tri).components).toBe(2);
  });

  it('treats a binary file whose header starts with "solid" as binary (exact size rule)', () => {
    const bin = writeStl(boxSoup([1, 1, 1]));
    bin.set(enc.encode('solid fake header'), 0);
    const r = parseStl(bin);
    expect(r.variant).toBe('binary');
    expect(r.diagnostics.some((d) => d.code === 'stl-header-solid')).toBe(true);
  });

  it('refuses malformed, empty and non-finite STL and reports inverted normals', () => {
    expect(parseStl(new Uint8Array(30)).ok).toBe(false);
    const empty = new Uint8Array(84);
    expect(parseStl(empty).diagnostics[0]!.code).toBe('empty');
    const bad = writeStl(boxSoup([1, 1, 1]));
    new DataView(bad.buffer).setFloat32(84 + 12, NaN, true);
    expect(parseStl(bad).diagnostics.some((d) => d.code === 'non-finite')).toBe(true);
    const truncated = writeStl(boxSoup([1, 1, 1])).subarray(0, 84 + 50 * 5);
    expect(parseStl(truncated).ok).toBe(false);
    const flipped = TETRA_ASCII.replace('facet normal 0 0 -1', 'facet normal 0 0 1');
    expect(parseStl(enc.encode(flipped)).diagnostics.some((d) => d.code === 'stl-normals-disagree')).toBe(
      true,
    );
    const missing = TETRA_ASCII.replace('      vertex 1 0 0\n    endloop', '    endloop');
    expect(parseStl(enc.encode(missing)).ok).toBe(false);
  });

  it('handles a left-handed source: mirrored and re-wound, volume stays positive', () => {
    const a = analyseGeometry({ name: 'box.stl', bytes: writeStl(boxSoup([1, 2, 3])) }, 'stl');
    const p = previewGeometry(a, { toMetres: 1, upAxis: 'Y', handedness: 'left' })!;
    close(p.metrics.volume, 6);
    close(p.metrics.bounds!.min[2], -3);
  });

  it('measures very large and very small geometry and warns about likely unit errors', () => {
    const big = analyseGeometry({ name: 'big.stl', bytes: writeStl(boxSoup([200000, 1000, 1000])) }, 'stl');
    const pb = previewGeometry(big, { toMetres: 1, upAxis: 'Y', handedness: 'right' })!;
    close(pb.metrics.bounds!.size[0], 200000);
    expect(pb.warnings.some((w) => w.code === 'very-large')).toBe(true);
    const small = analyseGeometry({ name: 'small.stl', bytes: writeStl(boxSoup([0.05, 0.05, 0.05])) }, 'stl');
    const ps = previewGeometry(small, { toMetres: 0.001, upAxis: 'Y', handedness: 'right' })!;
    close(ps.metrics.bounds!.size[0], 5e-5, 1e-5);
    expect(ps.warnings.some((w) => w.code === 'very-small')).toBe(true);
  });

  it('reports degenerate triangles and open meshes', () => {
    const soup = Float32Array.from([...boxSoup([1, 1, 1]).subarray(0, 9 * 10), 0, 0, 0, 1, 1, 1, 2, 2, 2]);
    const a = analyseGeometry({ name: 'open.stl', bytes: writeStl(soup) }, 'stl');
    const p = previewGeometry(a, { toMetres: 1, upAxis: 'Y', handedness: 'right' })!;
    expect(p.metrics.degenerateTriangles).toBe(1);
    expect(p.metrics.closed).toBe(false);
    expect(p.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['degenerate', 'open-mesh']));
  });
});

describe('glTF / GLB', () => {
  it('preserves hierarchy, nested transforms, rotation and non-uniform scale (write → read)', () => {
    // Parent: translate (1, 0, 0) and rotate 90° about +Y. Child: scale (2, 1, 1), translate (0, 1, 0).
    const q = [0, Math.SQRT1_2, 0, Math.SQRT1_2] as [number, number, number, number];
    const s = sceneOf(
      [
        { name: 'parent', matrix: fromTRS([1, 0, 0], q, [1, 1, 1]), children: [1] },
        { name: 'child', matrix: fromTRS([0, 1, 0], [0, 0, 0, 1], [2, 1, 1]), soup: boxSoup([1, 1, 1]) },
        { name: 'loose', matrix: translateM([10, 0, 0]), soup: boxSoup([1, 1, 1]) },
      ],
      [0, 2],
    );
    const g = parseGltf(writeGlb(s));
    expect(g.ok).toBe(true);
    expect(g.scene!.nodes.map((n) => n.name)).toEqual(['parent', 'child', 'loose']);
    expect(g.scene!.nodes[0]!.children).toEqual([1]);
    expect(g.scene!.materials[0]!.name).toBe('steel');
    const m = metrics(triangles({ ...g.scene!, roots: [0] }).tri);
    // Child box: x∈[0,2], y∈[1,2], z∈[0,1]; rotated 90° about Y: x' = z, z' = −x; then +1 in x.
    close(m.bounds!.min[0], 1);
    close(m.bounds!.max[0], 2);
    close(m.bounds!.min[1], 1);
    close(m.bounds!.min[2], -2);
    close(m.bounds!.max[2], 0);
    close(m.volume, 2);
    expect(m.closed).toBe(true);
  });

  it('re-winds mirrored node transforms so volume and normals stay outward', () => {
    const s = sceneOf([{ name: 'mirrored', matrix: scaleM(-1), soup: boxSoup([1, 2, 3]) }], [0]);
    const m = metrics(triangles(s).tri);
    close(m.volume, 6);
  });

  it('refuses external references, compressed geometry, cycles and bad accessors', () => {
    const base = {
      asset: { version: '2.0' },
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
    };
    const ext = parseGltf(
      enc.encode(JSON.stringify({ ...base, buffers: [{ uri: 'http://example.com/a.bin', byteLength: 36 }] })),
    );
    expect(ext.diagnostics[0]!.code).toBe('gltf-external');
    const draco = parseGltf(
      enc.encode(
        JSON.stringify({ ...base, extensionsRequired: ['KHR_draco_mesh_compression'], buffers: [] }),
      ),
    );
    expect(draco.diagnostics.some((d) => d.code === 'gltf-compressed')).toBe(true);
    const glb = writeGlb(
      sceneOf(
        [
          { name: 'a', soup: boxSoup([1, 1, 1]), children: [1] },
          { name: 'b', children: [0] },
        ],
        [0],
      ),
    );
    expect(parseGltf(glb).diagnostics.some((d) => d.code === 'gltf-graph')).toBe(true);
    const oob = parseGltf(
      enc.encode(
        JSON.stringify({
          ...base,
          accessors: [{ bufferView: 0, componentType: 5126, count: 300, type: 'VEC3' }],
          buffers: [{ uri: 'data:application/octet-stream;base64,' + 'A'.repeat(48), byteLength: 36 }],
        }),
      ),
    );
    expect(oob.diagnostics.some((d) => d.code === 'gltf-accessor')).toBe(true);
    expect(parseGltf(enc.encode('{"asset":{"version":"1.0"}}')).diagnostics[0]!.code).toBe('gltf-version');
  });
});

describe('STEP (OCCT)', () => {
  it('reads header, schema and declared unit (mm, m, inch)', () => {
    for (const [unit, k] of [
      ['mm', 1e-3],
      ['m', 1],
      ['inch', 0.0254],
    ] as const) {
      const h = readStepHeader(
        enc.encode(stepAssembly([{ name: 'P', size: [1, 1, 1], at: [0, 0, 0] }], unit)),
      );
      expect(h.ok).toBe(true);
      expect(h.protocol).toBe('AP214');
      expect(h.lengthUnit!.toMetres).toBeCloseTo(k, 12);
      expect(h.products).toEqual(['ASM', 'P']);
      expect(h.breps).toBe(1);
      expect(h.faces).toBe(6);
    }
    expect(readStepHeader(enc.encode('hello')).ok).toBe(false);
  });

  it('tessellates an assembly: names, hierarchy, placements and units exact for planar B-reps', () => {
    const text = stepAssembly(
      [
        { name: 'Plate', size: [100, 50, 20], at: [0, 0, 0] },
        { name: 'Block', size: [10, 10, 10], at: [200, 0, 0] },
      ],
      'mm',
    );
    const r = stepToScene(enc.encode(text), occt);
    expect(r.ok).toBe(true);
    expect(r.brepFaces).toBe(12);
    const s = r.scene!;
    expect(s.nodes[s.roots[0]!]!.name).toBe('ASM');
    expect(s.nodes[s.roots[0]!]!.children.map((c) => s.nodes[c]!.name)).toEqual(['Plate', 'Block']);
    const m = metrics(triangles(s).tri);
    close(m.bounds!.size[0], 0.21);
    close(m.bounds!.size[1], 0.05);
    close(m.volume, 0.1 * 0.05 * 0.02 + 0.01 ** 3, 1e-5);
    expect(m.components).toBe(2);
    // Inch file: 1 × 2 × 3 in → metres.
    const inch = stepToScene(
      enc.encode(stepAssembly([{ name: 'P', size: [1, 2, 3], at: [0, 0, 0] }], 'inch')),
      occt,
    );
    const mi = metrics(triangles(inch.scene!).tri);
    close(mi.bounds!.size[2], 3 * 0.0254);
  });

  it('refuses malformed STEP without crashing', () => {
    const r = analyseGeometry(
      {
        name: 'bad.step',
        bytes: enc.encode('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=GARBAGE(;\nENDSEC;\nEND-ISO-10303-21;'),
      },
      'step',
      occt,
    );
    expect(r.ok).toBe(false);
    const noKernel = analyseGeometry(
      { name: 'a.step', bytes: enc.encode(stepAssembly([{ name: 'P', size: [1, 1, 1], at: [0, 0, 0] }])) },
      'step',
      null,
    );
    expect(noKernel.diagnostics.some((d) => d.code === 'step-kernel-unavailable')).toBe(true);
  });
});

describe('import transactions', () => {
  const plan = (
    a: GeometryAnalysis,
    project: Project,
    extra: Partial<Parameters<typeof planGeometryImport>[1]> = {},
  ) =>
    planGeometryImport(
      a,
      {
        frame: { ...a.defaultFrame },
        name: 'Imported',
        categoryId: 'complete-modules-assemblies',
        split: false,
        importId: 'imp-1',
        newId: idGen(),
        now: AT,
        ...extra,
      },
      project,
    );

  it('inserts an STL as one undoable step with its provenance; undo removes both', () => {
    const project = emptyProject();
    const a = analyseGeometry({ name: 'box.stl', bytes: writeStl(boxSoup([10, 20, 30])) }, 'stl');
    const p = plan(a, project);
    expect(p.ok).toBe(true);
    expect(p.assets).toHaveLength(1);
    expect(parseGltf(p.assets[0]!.bytes).ok).toBe(true);
    const { engine, result } = apply(project, p.commands);
    expect(result.ok).toBe(true);
    const g = engine.getProject().scene;
    const node = g.nodes[p.nodeIds[0]!]!;
    expect(node.kind).toBe('model-instance');
    if (node.kind === 'model-instance') {
      close(node.model.boundsM[1], 0.03);
      expect(node.model.unitScale).toBe(0.001);
      expect(node.model.upAxis).toBe('Z');
      // Base on y = 0.
      close(node.transform.position[1] + node.model.minM[1], 0, 1e-9);
    }
    const rec = importOf(g, p.nodeIds[0]!)!;
    expect(rec.format).toBe('stl');
    expect(rec.sourceHash).toBe(a.sourceHash);
    expect(rec.conversions.join(' ')).toContain('mm → m');
    // The predicted fingerprint matches the nodes the engine actually created.
    expect(importStatus(rec, g)).toBe('unmodified');
    expect(nodesFingerprint([node])).toBe(rec.nodesFingerprint);
    engine.execute(
      makeCommand('scene.node.transform', { nodeId: node.id, position: [1, 0, 0] }, 'test') as CommandInput,
    );
    expect(importStatus(rec, engine.getProject().scene)).toBe('modified');
    engine.undo();
    engine.undo();
    expect(engine.getProject().scene.nodes[node.id]).toBeUndefined();
    const root = engine.getProject().scene.nodes[engine.getProject().scene.rootId]!;
    expect(root.kind === 'root' && (root.imports ?? []).length).toBe(0);
  });

  it('is atomic: a failing step leaves the project untouched', () => {
    const project = emptyProject();
    const a = analyseGeometry({ name: 'box.stl', bytes: writeStl(boxSoup([1, 1, 1])) }, 'stl');
    const p = plan(a, project);
    const broken = [
      ...p.commands.slice(0, -1),
      { type: 'scene.node.rename', payload: { nodeId: 'does-not-exist', name: 'x' } },
      p.commands.at(-1),
    ];
    const { engine, result } = apply(project, broken);
    expect(result.ok).toBe(false);
    expect(engine.getProject()).toEqual(new ForgeEngine(project).getProject());
    expect(plan(a, project, { parentId: 'nope' }).ok).toBe(false);
  });

  it('splits a STEP assembly into parts that keep their exact relative placement', () => {
    const project = emptyProject();
    const text = stepAssembly([
      { name: 'Plate', size: [100, 50, 20], at: [0, 0, 0] },
      { name: 'Block', size: [10, 10, 10], at: [200, 0, 0] },
    ]);
    const a = analyseGeometry({ name: 'asm.step', bytes: enc.encode(text) }, 'step', occt);
    expect(a.ok).toBe(true);
    const p = plan(a, project, { split: true });
    expect(p.ok).toBe(true);
    expect(p.assets).toHaveLength(2);
    const { engine, result } = apply(project, p.commands);
    expect(result.ok).toBe(true);
    const g = engine.getProject().scene;
    const [grp, plate, block] = p.nodeIds.map((id) => g.nodes[id]!) as [SceneNode, SceneNode, SceneNode];
    expect(grp.kind).toBe('group');
    expect(grp.childIds).toEqual([plate.id, block.id]);
    expect([plate.kind, block.kind]).toEqual(['model-instance', 'model-instance']);
    const pm = (plate as Extract<SceneNode, { kind: 'model-instance' }>).model;
    const bm = (block as Extract<SceneNode, { kind: 'model-instance' }>).model;
    // Z-up: STEP x stays x; block starts 200 mm along x; STEP Z (20 mm) becomes up.
    expect(Math.abs(bm.minM[0] - 0.2)).toBeLessThan(1e-7);
    expect(Math.abs(pm.boundsM[0] - 0.1)).toBeLessThan(1e-7);
    expect(Math.abs(pm.boundsM[1] - 0.02)).toBeLessThan(1e-7);
    const rec = importOf(g, block.id)!;
    expect(rec.geometryClass).toBe('tessellated-brep');
    expect(rec.unsupported.join(' ')).toContain('feature tree');
  });

  it('round-trips STL → FORGE asset → STL → reimport with float32-level dimensional error', () => {
    const src = writeStl(boxSoup([12.5, 7.25, 3]));
    const a = analyseGeometry({ name: 'part.stl', bytes: src }, 'stl');
    const p = plan(a, emptyProject());
    // Export path: the stored asset's triangles, in the source frame (mm, Z-up), back to STL.
    const glb = parseGltf(p.assets[0]!.bytes).scene!;
    const out = writeStl(triangles(glb).tri);
    const back = analyseGeometry({ name: 'part2.stl', bytes: out }, 'stl');
    const m1 = previewGeometry(a, { toMetres: 0.001, upAxis: 'Z', handedness: 'right' })!.metrics;
    const m2 = previewGeometry(back, { toMetres: 0.001, upAxis: 'Z', handedness: 'right' })!.metrics;
    for (let k = 0; k < 3; k++) close(m2.bounds!.size[k]!, m1.bounds!.size[k]!);
    close(m2.volume, m1.volume);
    expect(m2.triangles).toBe(m1.triangles);
  });

  it('round-trips GLB hierarchy (write → import → stored original byte-for-byte)', () => {
    const glb = writeGlb(
      sceneOf(
        [
          { name: 'root', children: [1, 2] },
          { name: 'a', soup: boxSoup([1, 1, 1]) },
          { name: 'b', matrix: mul(translateM([3, 0, 0]), Z_UP_TO_Y_UP), soup: boxSoup([1, 2, 3]) },
        ],
        [0],
      ),
    );
    const a = analyseGeometry({ name: 'scene.glb', bytes: glb }, 'glb');
    const p = plan(a, emptyProject());
    expect(p.assets[0]!.bytes).toBe(glb);
    const sp = plan(a, emptyProject(), { split: true });
    expect(sp.nodeIds).toHaveLength(3); // group + 2 parts
  });
});

describe('export', () => {
  it('writes STL in mm / +Z up and GLB in m / +Y up, and the frames invert the import exactly', async () => {
    const { exportMeshScene } = await import('../export');
    // A FORGE-frame box 0.1 (x) × 0.03 (y, up) × 0.02 (z) m.
    const forge = sceneOf([{ name: 'part', soup: boxSoup([0.1, 0.03, 0.02]) }], [0]);
    const stl = exportMeshScene(forge, { format: 'stl', unit: 'mm', upAxis: 'Z', name: 'part' });
    const b = stl.report.bounds!;
    close(b.size[0], 100);
    close(b.size[1], 20); // FORGE z → file y (depth)
    close(b.size[2], 30); // FORGE y (up) → file z (up)
    expect(stl.report.discarded.join(' ')).toContain('parametric features');
    // Re-import with the same convention recovers the FORGE frame.
    const again = previewGeometry(analyseGeometry({ name: 'part.stl', bytes: stl.bytes }, 'stl'), {
      toMetres: 0.001,
      upAxis: 'Z',
      handedness: 'right',
    })!;
    close(again.metrics.bounds!.size[1], 0.03);
    close(again.metrics.bounds!.min[2], 0);
    const glb = exportMeshScene(forge, { format: 'glb', unit: 'mm', upAxis: 'Z', name: 'part' });
    expect(glb.report.unit).toBe('m');
    const g = parseGltf(glb.bytes);
    expect(g.ok).toBe(true);
    close(metrics(triangles(g.scene!).tri).bounds!.size[1], 0.03);
    const ascii = exportMeshScene(forge, { format: 'stl-ascii', unit: 'm', upAxis: 'Y', name: 'part' });
    expect(new TextDecoder().decode(ascii.bytes)).toMatch(/^solid part/);
  });
});
