import { statfsSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { DEFAULT_SCENARIO, encode, syntheticStream, TelemetryPipeline } from '@forge/digital-twin';
import {
  buildPhysicsModel,
  createRoboticArmSimulationSample,
  loadRapier,
  PhysicsSession,
  SceneBuilder,
  simulationOf,
} from '@forge/physics';
import { describe, expect, it } from 'vitest';
import { exportMeshScene } from '../export';
import { importKicad } from '../formats/kicad';
import { parseGltf, writeGlb } from '../formats/gltf';
import { parseSpice } from '../formats/spice';
import { writeStl } from '../formats/stl';
import { planUrdfImport } from '../formats/urdf';
import { analyseGeometry, planGeometryImport, previewGeometry } from '../geometry';
import { sceneFromTriangles } from '../mesh';
import { AT, boxSoup, emptyProject, idGen, loadOcct } from './fixtures';
import { stepAssembly } from './step-fixtures';

/**
 * Phase 8 benchmark (opt-in: FORGE_BENCH=1; docs/PERFORMANCE_BASELINE.md). In memory only:
 * the only file written is the small JSON record. Free disk is recorded; the run refuses
 * to start below 1 GiB so it can never exhaust the disk.
 */
const RUN = process.env.FORGE_BENCH === '1';
const now = () => performance.now();
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const heapMB = () => +(process.memoryUsage().heapUsed / 1048576).toFixed(1);
const ms = (x: number) => +x.toFixed(2);
const time = <T>(f: () => T): [T, number] => {
  const t0 = now();
  const r = f();
  return [r, now() - t0];
};

/** A triangle soup of n boxes (12 triangles each) on a grid. */
function boxes(n: number): Float32Array {
  const out = new Float32Array(n * 108);
  for (let i = 0; i < n; i++)
    out.set(boxSoup([1, 1, 1], [(i % 100) * 2, Math.floor(i / 100) * 2, 0]), i * 108);
  return out;
}

describe.skipIf(!RUN)('Phase 8 interoperability and telemetry benchmark', () => {
  it('measures import, export, tessellation, circuits, URDF, telemetry and simulation costs', async () => {
    const disk = statfsSync('/');
    const freeGiB = +((disk.bavail * disk.bsize) / 2 ** 30).toFixed(1);
    expect(freeGiB).toBeGreaterThan(1);
    const results: Record<string, unknown> = {
      when: new Date().toISOString(),
      machine: {
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        memGB: +(totalmem() / 2 ** 30).toFixed(1),
        node: process.version,
      },
      freeDiskGiB: freeGiB,
      note: 'Single runs in memory; indicative, not guarantees.',
    };
    // 1. STL import (parse + analyse + preview + plan incl. GLB conversion) by size.
    results.stl = [1_000, 100_000, 500_000].map((tris) => {
      const bin = writeStl(boxes(Math.ceil(tris / 12)).subarray(0, tris * 9));
      gc();
      const h0 = heapMB();
      const [a, tA] = time(() => analyseGeometry({ name: 'big.stl', bytes: bin }, 'stl'));
      const [p, tP] = time(() => previewGeometry(a, a.defaultFrame));
      const [plan, tPlan] = time(() =>
        planGeometryImport(
          a,
          {
            frame: a.defaultFrame,
            name: 'big',
            categoryId: 'complete-modules-assemblies',
            split: false,
            importId: 'i',
            newId: idGen(),
          },
          emptyProject(),
        ),
      );
      const out = {
        triangles: tris,
        fileMB: +(bin.byteLength / 1048576).toFixed(2),
        parseMs: ms(tA),
        previewMs: ms(tP),
        planMs: ms(tPlan),
        glbMB: plan.assets[0] ? +(plan.assets[0].bytes.byteLength / 1048576).toFixed(2) : null,
        planOk: plan.ok,
        heapGrowthMB: +(heapMB() - h0).toFixed(1),
        components: p!.metrics.components,
      };
      return out;
    });
    // 2. glTF read and STL/GLB export of a 100k-triangle scene.
    const soup = boxes(Math.ceil(100_000 / 12));
    const scene = sceneFromTriangles('bench', soup);
    const [glb, tWriteGlb] = time(() => writeGlb(scene));
    const [, tReadGlb] = time(() => parseGltf(glb));
    const [stlOut, tStl] = time(() =>
      exportMeshScene(scene, { format: 'stl', unit: 'mm', upAxis: 'Z', name: 'b' }),
    );
    const [glbOut, tGlb] = time(() =>
      exportMeshScene(scene, { format: 'glb', unit: 'm', upAxis: 'Y', name: 'b' }),
    );
    results.gltf = {
      triangles: soup.length / 9,
      writeGlbMs: ms(tWriteGlb),
      readGlbMs: ms(tReadGlb),
      exportStlMs: ms(tStl),
      exportStlMB: +(stlOut.bytes.byteLength / 1048576).toFixed(2),
      exportGlbMs: ms(tGlb),
      exportGlbMB: +(glbOut.bytes.byteLength / 1048576).toFixed(2),
    };
    // 3. STEP: OCCT tessellation of assemblies (kernel load timed separately).
    const [occtP, tLoad] = time(() => loadOcct());
    const occt = await occtP;
    const enc = new TextEncoder();
    results.step = {
      kernelLoadMs: ms(tLoad),
      assemblies: [1, 20, 100].map((parts) => {
        const text = stepAssembly(
          Array.from({ length: parts }, (_, i) => ({
            name: `P${i}`,
            size: [20, 10, 5] as [number, number, number],
            at: [(i % 10) * 25, Math.floor(i / 10) * 15, 0] as [number, number, number],
          })),
        );
        const [a, t] = time(() => analyseGeometry({ name: 'a.step', bytes: enc.encode(text) }, 'step', occt));
        return {
          parts,
          fileKB: +(text.length / 1024).toFixed(1),
          analyseMs: ms(t),
          ok: a.ok,
          triangles: a.scene
            ? a.scene.meshes.reduce((s, m) => s + m.primitives[0]!.indices.length / 3, 0)
            : 0,
        };
      }),
    };
    // 4. Circuits: SPICE ladder and KiCad netlist.
    const N = 1000;
    const ladder = [
      'ladder',
      'V1 n0 0 DC 5',
      ...Array.from({ length: N }, (_, i) => `R${i + 1} n${i} n${i + 1} 1k`),
      ...Array.from({ length: N }, (_, i) => `C${i + 1} n${i + 1} 0 1n`),
      '.tran 1u 1m',
      '.end',
    ].join('\n');
    const [sp, tSp] = time(() => parseSpice(enc.encode(ladder)));
    const comps = Array.from(
      { length: 500 },
      (_, i) => `(comp (ref "R${i + 1}") (value "1k") (libsource (lib "Device") (part "R")))`,
    ).join('\n');
    const nets = Array.from(
      { length: 501 },
      (_, i) =>
        `(net (code "${i + 1}") (name "${i === 0 ? 'GND' : `N${i}`}") ${i > 0 ? `(node (ref "R${i}") (pin "2"))` : ''} ${i < 500 ? `(node (ref "R${i + 1}") (pin "1"))` : ''})`,
    ).join('\n');
    const [kc, tKc] = time(() =>
      importKicad(enc.encode(`(export (version "E") (components ${comps}) (nets ${nets}))`), 'kicad-netlist'),
    );
    results.circuits = {
      spice: { elements: 2 * N + 1, parseVerifyMs: ms(tSp), ok: sp.ok },
      kicad: { components: 500, importVerifyMs: ms(tKc), ok: kc.ok },
    };
    // 5. URDF: a 30-link chain → plan → physics model.
    const links = 30;
    const urdf = `<robot name="chain">${Array.from({ length: links }, (_, i) => `<link name="l${i}"><visual><origin xyz="0 0 0.025"/><geometry><box size="0.02 0.02 0.05"/></geometry></visual><inertial><origin xyz="0 0 0.025"/><mass value="0.05"/><inertia ixx="1.2e-5" iyy="1.2e-5" izz="3.3e-6" ixy="0" ixz="0" iyz="0"/></inertial></link>`).join('')}${Array.from({ length: links - 1 }, (_, i) => `<joint name="j${i}" type="revolute"><parent link="l${i}"/><child link="l${i + 1}"/><origin xyz="0 0 0.05"/><axis xyz="0 1 0"/><limit lower="-1" upper="1" effort="1" velocity="2"/></joint>`).join('')}</robot>`;
    const b = new SceneBuilder(emptyProject());
    const [plan, tPlan] = time(() =>
      planUrdfImport(
        { name: 'c.urdf', bytes: enc.encode(urdf) },
        {
          files: [],
          createSimulation: true,
          actuators: 'hold-initial',
          importId: 'u',
          idPrefix: 'c',
          now: AT,
        },
        b.engine.getProject(),
      ),
    );
    const [, tApply] = time(() => b.batch(plan.commands));
    const [model, tModel] = time(() => buildPhysicsModel(b.graph, simulationOf(b.graph)!));
    results.urdf = {
      links,
      planMs: ms(tPlan),
      applyMs: ms(tApply),
      physicsModelMs: ms(tModel),
      bodies: model.bodies.length,
      joints: model.joints.length,
    };
    // 6. Sustained telemetry: 1 h at 20 Hz and 60 s at 1 kHz (with faults).
    results.telemetry = [
      { label: '20 Hz for 1 hour (nominal)', sc: { ...DEFAULT_SCENARIO, durationS: 3600, rateHz: 20 } },
      {
        label: '1 kHz for 60 s (3 % drops, 3 % duplicates, 5 % reordering)',
        sc: {
          ...DEFAULT_SCENARIO,
          durationS: 60,
          rateHz: 1000,
          faults: { ...DEFAULT_SCENARIO.faults, dropRate: 0.03, duplicateRate: 0.03, reorderRate: 0.05 },
        },
      },
    ].map(({ label, sc }) => {
      const s = syntheticStream(sc);
      gc();
      const h0 = heapMB();
      const p = new TelemetryPipeline(0);
      p.setTransport(true, 0);
      const t0 = now();
      for (const l of s.lines) p.ingestLine(l.line, l.hostMs);
      p.flush(Infinity);
      const dt = now() - t0;
      const t1 = now();
      const series = p.series.get('d')!;
      const tSeries = now() - t1;
      return {
        label,
        lines: s.lines.length,
        ingestMs: ms(dt),
        linesPerS: Math.round(s.lines.length / (dt / 1000)),
        usPerLine: +((dt * 1000) / s.lines.length).toFixed(2),
        seriesBuildMs: ms(tSeries),
        samples: series.t.length,
        missingMessages: p.stats.missingMessages,
        duplicates: p.stats.duplicates,
        driftPpm: +p.clock.driftPpm.toFixed(1),
        heapGrowthMB: +(heapMB() - h0).toFixed(1),
        recordingKBPerMin: +(
          (s.lines.reduce((k, l) => k + l.line.length + 12, 0) / 1024) *
          (60 / sc.durationS)
        ).toFixed(1),
      };
    });
    // 7. Simulation with imported geometry, and simultaneous observation + simulation.
    const R = await loadRapier();
    const arm = new SceneBuilder(createRoboticArmSimulationSample(AT));
    const stepCost = (g: typeof arm.graph, withTelemetry: boolean) => {
      const s = PhysicsSession.fromScene(R, g, simulationOf(g)!);
      const p = new TelemetryPipeline(0);
      p.setTransport(true, 0);
      const lines = syntheticStream({ ...DEFAULT_SCENARIO, durationS: 5, rateHz: 20 }).lines;
      let li = 0;
      s.step(60);
      const t0 = now();
      for (let k = 0; k < 600; k++) {
        s.step(1);
        if (withTelemetry)
          while (li < lines.length && lines[li]!.hostMs <= (k + 1) * (1000 / 120))
            p.ingestLine(lines[li]!.line, lines[li++]!.hostMs);
      }
      const dt = now() - t0;
      s.dispose();
      return +(dt / 600).toFixed(4);
    };
    const base = stepCost(arm.graph, false);
    const bracket = analyseGeometry({ name: 'b.stl', bytes: writeStl(boxes(1000)) }, 'stl');
    const asm = Object.values(arm.graph.nodes).find(
      (n) => n.kind === 'assembly' && n.childIds.includes('gripper'),
    )!;
    arm.batch(
      planGeometryImport(
        bracket,
        {
          frame: bracket.defaultFrame,
          name: 'Imported',
          categoryId: 'complete-modules-assemblies',
          split: false,
          importId: 'x',
          newId: idGen('x'),
          attach: { assemblyId: asm.id, bodyId: 'gripper', offsetM: [0, 0.02, 0] },
          physics: { massKg: 0.05, note: 'bench', collider: 'bounds-box' },
        },
        arm.engine.getProject(),
      ).commands,
    );
    const withImport = stepCost(arm.graph, false);
    const withBoth = stepCost(arm.graph, true);
    results.simulation = {
      armMsPerStep: base,
      withImportedPartMsPerStep: withImport,
      withImportedPartAndTelemetryMsPerStep: withBoth,
      note: 'Imported meshes use a bounding-box collider: their triangle count does not enter the physics step.',
    };
    void encode;
    writeFileSync(
      new URL('../../../../docs/archive/phase8-interop-benchmarks.json', import.meta.url),
      JSON.stringify(results, null, 2) + '\n',
    );
    console.log(JSON.stringify(results, null, 2));
  }, 900_000);
});
