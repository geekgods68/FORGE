import { createCatalogResolver, evaluate, getDefinition, resolveParameters } from '@forge/components';
import {
  createProject,
  ForgeEngine,
  makeCommand,
  parseProjectFile,
  serializeProject,
  type CommandInput,
  type Feature,
  type SketchConstraint,
} from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { checkFastener } from '../fasteners';
import { createMechanicsService } from '../index';
import {
  assemblyMass,
  axisAngle,
  checkInterference,
  explodeOffsets,
  massProperties,
  pointDistance,
  worldBounds,
} from '../measure';
import { evaluatePart } from '../part';
import { rectangleEntities, solveSketch } from '../sketch';

const rect = (w: number, d: number): [number, number][] => [
  [-w / 2, -d / 2],
  [w / 2, -d / 2],
  [w / 2, d / 2],
  [-w / 2, d / 2],
];
const base = (w = 0.1, d = 0.06, t = 0.01): Feature => ({
  id: 'base',
  type: 'extrude',
  profile: { outer: rect(w, d), holes: [] },
  depth: t,
  sourceSketchId: null,
});
const vol = (features: Feature[]) => {
  const r = evaluatePart(features);
  if (!r.ok) throw new Error(r.message);
  return r.geometry.volumeM3;
};

function engine() {
  let n = 0;
  const e = new ForgeEngine(createProject('CAD'), {
    componentResolver: createCatalogResolver(),
    mechanics: createMechanicsService(),
    newId: () => `id-${++n}`,
  });
  const run = (type: string, payload: unknown) =>
    e.execute(makeCommand(type as never, payload as never, 'desktop-ui') as CommandInput);
  return { e, run };
}

describe('sketch solver', () => {
  it('a dimensioned rectangle is fully constrained and solved to its dimensions', () => {
    const { entities, constraints } = rectangleEntities('r', 0, 0, 0.05, 0.02);
    const dims: SketchConstraint[] = [
      { id: 'fx', type: 'fixed', refs: ['r-p0'], value: 0, value2: 0 },
      { id: 'w', type: 'distance', refs: ['r-l0'], value: 0.08, value2: null },
      { id: 'h', type: 'distance', refs: ['r-l1'], value: 0.03, value2: null },
    ];
    const under = solveSketch(entities, constraints);
    expect(under).toMatchObject({ ok: true, status: 'under-constrained', dof: 4 });
    const s = solveSketch(entities, [...constraints, ...dims]);
    expect(s).toMatchObject({ ok: true, status: 'fully-constrained', dof: 0 });
    const p2 = s.entities.find((x) => x.id === 'r-p2') as { x: number; y: number };
    expect(p2.x).toBeCloseTo(0.08, 9);
    expect(p2.y).toBeCloseTo(0.03, 9);
  });

  it('circle radius/diameter, angles; conflicting constraints are reported, not applied', () => {
    const pts = [{ id: 'c', kind: 'point' as const, x: 0, y: 0 }];
    const circ = { id: 'k', kind: 'circle' as const, center: 'c', r: 0.01 };
    const r = solveSketch(
      [...pts, circ],
      [{ id: 'd', type: 'diameter', refs: ['k'], value: 0.03, value2: null }],
    );
    expect((r.entities.find((x) => x.id === 'k') as { r: number }).r).toBeCloseTo(0.015, 9);
    const { entities, constraints } = rectangleEntities('r', 0, 0, 0.05, 0.02);
    const conflict = solveSketch(entities, [
      ...constraints,
      { id: 'a', type: 'distance', refs: ['r-l0'], value: 0.05, value2: null },
      { id: 'b', type: 'distance', refs: ['r-l2'], value: 0.07, value2: null },
    ]);
    expect(conflict).toMatchObject({ ok: false, status: 'conflicting' });
    const bad = solveSketch(entities, [{ id: 'x', type: 'radius', refs: ['r-l0'], value: 1, value2: null }]);
    expect(bad.ok).toBe(false);
  });

  it('sketch commands: conflicting constraints are rejected and the sketch is unchanged; profile → part', () => {
    const { e, run } = engine();
    const { entities, constraints } = rectangleEntities('r', -0.04, -0.02, 0.08, 0.04);
    expect(run('sketch.create', { id: 'sk', entities, constraints }).ok).toBe(true);
    expect(
      run('sketch.constraint.add', {
        sketchId: 'sk',
        constraint: { type: 'distance', refs: ['r-l0'], value: 0.1, value2: null },
      }).ok,
    ).toBe(true);
    const before = JSON.stringify(e.getNode('sk'));
    expect(
      run('sketch.constraint.add', {
        sketchId: 'sk',
        constraint: { type: 'distance', refs: ['r-l2'], value: 0.05, value2: null },
      }),
    ).toMatchObject({ ok: false, error: { code: 'constraint-conflict' } });
    expect(JSON.stringify(e.getNode('sk'))).toBe(before);
    expect(
      run('part.create', { id: 'p', fromSketchId: 'sk', depth: 0.005, materialId: 'al-6061-t6' }).ok,
    ).toBe(true);
    const r = evaluatePart((e.getNode('p') as { features: Feature[] }).features);
    expect(r.ok && r.geometry.volumeM3).toBeCloseTo(0.1 * 0.04 * 0.005, 12);
    // Sketch round-trips through the file.
    expect(parseProjectFile(serializeProject(e.getProject()))).toMatchObject({ ok: true });
  });
});

describe('prismatic feature kernel', () => {
  it('through and blind holes, cuts, patterns and mirror have exact volumes and hole interfaces', () => {
    const V = 0.1 * 0.06 * 0.01;
    const hole = (id: string, x: number, d = 0.0045, depth: number | null = null): Feature => ({
      id,
      type: 'hole',
      center: [x, 0],
      diameter: d,
      depth,
    });
    const ring = (d: number) => {
      // 32-gon (as built) area.
      const r = d / 2;
      return 0.5 * 32 * r * r * Math.sin((2 * Math.PI) / 32);
    };
    expect(vol([base(), hole('h1', -0.03)])).toBeCloseTo(V - ring(0.0045) * 0.01, 15);
    expect(vol([base(), hole('h1', -0.03, 0.0045, 0.004)])).toBeCloseTo(V - ring(0.0045) * 0.004, 15);
    expect(vol([base(), { id: 'c', type: 'cut', profile: rect(0.02, 0.02), depth: 0.003 }])).toBeCloseTo(
      V - 0.0004 * 0.003,
      15,
    );
    const pat: Feature[] = [
      base(),
      hole('h1', -0.03),
      { id: 'pt', type: 'pattern-rect', target: 'h1', countU: 3, countV: 1, spacingU: 0.03, spacingV: 0 },
    ];
    expect(vol(pat)).toBeCloseTo(V - 3 * ring(0.0045) * 0.01, 15);
    const r = evaluatePart(pat);
    expect(
      r.ok && r.geometry.interfaces.filter((i) => i.type === 'bolt-hole').map((i) => i.compatibility),
    ).toEqual([
      ['hole-4.5mm', 'M4-clearance'],
      ['hole-4.5mm', 'M4-clearance'],
      ['hole-4.5mm', 'M4-clearance'],
    ]);
    const circ: Feature[] = [
      base(0.1, 0.1),
      hole('h1', 0.03),
      { id: 'pc', type: 'pattern-circ', target: 'h1', count: 4, center: [0, 0], totalAngle: 2 * Math.PI },
    ];
    expect(vol(circ)).toBeCloseTo(0.1 * 0.1 * 0.01 - 4 * ring(0.0045) * 0.01, 15);
    const mir: Feature[] = [
      base(),
      hole('h1', 0.02),
      { id: 'm', type: 'mirror', target: 'h1', axis: 'v', offset: 0 },
    ];
    expect(vol(mir)).toBeCloseTo(V - 2 * ring(0.0045) * 0.01, 15);
  });

  it('Boolean union / difference / intersection on the base profile', () => {
    expect(
      vol([
        base(),
        {
          id: 'u',
          type: 'boolean',
          op: 'union',
          profile: [
            [0.04, -0.01],
            [0.08, -0.01],
            [0.08, 0.01],
            [0.04, 0.01],
          ],
        },
      ]),
    ).toBeCloseTo((0.006 + 0.03 * 0.02) * 0.01, 14);
    expect(
      vol([
        base(),
        {
          id: 'd',
          type: 'boolean',
          op: 'difference',
          profile: [
            [0.03, -0.04],
            [0.06, -0.04],
            [0.06, 0.04],
            [0.03, 0.04],
          ],
        },
      ]),
    ).toBeCloseTo(0.08 * 0.06 * 0.01, 14);
    expect(
      vol([base(), { id: 'i', type: 'boolean', op: 'intersection', profile: rect(0.04, 0.04) }]),
    ).toBeCloseTo(0.04 * 0.04 * 0.01, 14);
  });

  it('rejects degenerate, self-intersecting, out-of-part, overlapping, splitting and over-deep features', () => {
    const msg = (f: Feature[]) => {
      const r = evaluatePart(f);
      return r.ok ? '' : r.message;
    };
    expect(
      msg([
        {
          ...base(),
          profile: {
            outer: [
              [0, 0],
              [1, 0],
              [2, 0],
            ],
            holes: [],
          },
        } as Feature,
      ]),
    ).toMatch(/degenerate/);
    expect(
      msg([
        {
          ...base(),
          profile: {
            outer: [
              [0, 0],
              [0.1, 0.1],
              [0.1, 0],
              [0, 0.1],
            ],
            holes: [],
          },
        } as Feature,
      ]),
    ).toMatch(/self-intersecting/);
    expect(msg([base(), { id: 'h', type: 'hole', center: [0.049, 0], diameter: 0.01, depth: null }])).toMatch(
      /outside the part/,
    );
    expect(
      msg([
        base(),
        { id: 'a', type: 'hole', center: [0, 0], diameter: 0.01, depth: null },
        { id: 'b', type: 'hole', center: [0.004, 0], diameter: 0.01, depth: null },
      ]),
    ).toMatch(/overlap/);
    expect(
      msg([
        base(),
        {
          id: 's',
          type: 'boolean',
          op: 'difference',
          profile: [
            [-0.01, -0.05],
            [0.01, -0.05],
            [0.01, 0.05],
            [-0.01, 0.05],
          ],
        },
      ]),
    ).toMatch(/splits the part/);
    expect(msg([base(), { id: 'h', type: 'hole', center: [0, 0], diameter: 0.005, depth: 0.02 }])).toMatch(
      /through feature/,
    );
    expect(
      msg([
        base(),
        { id: 'p', type: 'pattern-rect', target: 'nope', countU: 2, countV: 1, spacingU: 0.01, spacingV: 0 },
      ]),
    ).toMatch(/target/);
  });

  it('feature commands: invalid operations keep the previous valid state; parametric edit regenerates; undo/redo', () => {
    const { e, run } = engine();
    expect(
      run('part.create', {
        id: 'p',
        profile: { outer: rect(0.1, 0.06), holes: [] },
        depth: 0.01,
        materialId: 'al-6061-t6',
      }).ok,
    ).toBe(true);
    expect(
      run('geometry.hole.create', { partId: 'p', id: 'h', center: [0, 0], diameter: 0.006, depth: null }).ok,
    ).toBe(true);
    const before = JSON.stringify(e.getNode('p'));
    expect(
      run('geometry.hole.create', { partId: 'p', id: 'x', center: [0.05, 0], diameter: 0.01, depth: null }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-geometry' } });
    expect(JSON.stringify(e.getNode('p'))).toBe(before);
    expect(
      run('geometry.pattern.create', {
        partId: 'p',
        id: 'pat',
        kind: 'rect',
        target: 'h',
        countU: 2,
        countV: 2,
        spacingU: 0.02,
        spacingV: 0.02,
      }).ok,
    ).toBe(true);
    expect(run('geometry.feature.delete', { partId: 'p', featureId: 'h' })).toMatchObject({ ok: false }); // pattern depends on it
    const m0 = massProperties(e.getProject().scene, 'p').massKg!;
    expect(
      run('geometry.feature.update', {
        partId: 'p',
        feature: { id: 'h', type: 'hole', center: [0, 0], diameter: 0.004, depth: null },
      }).ok,
    ).toBe(true);
    expect(massProperties(e.getProject().scene, 'p').massKg!).toBeGreaterThan(m0);
    e.undo();
    expect(massProperties(e.getProject().scene, 'p').massKg!).toBeCloseTo(m0, 15);
  });
});

describe('measurement, interference, explode, fasteners', () => {
  it('mass and centre of mass come from geometry × material, with honest validity labels', () => {
    const { e, run } = engine();
    run('scene.node.create', {
      node: {
        kind: 'component-instance',
        id: 'plate',
        definitionId: 'aluminium-plate',
        parameters: { length: 0.2, width: 0.1, thickness: 0.005 },
        transform: { position: [1, 0, 0] },
      },
    });
    run('scene.node.create', {
      node: { kind: 'component-instance', id: 'servo', definitionId: 'towerpro-sg90' },
    });
    run('scene.node.create', {
      node: { kind: 'component-instance', id: 'motor', definitionId: 'stepper-nema' },
    });
    const g = e.getProject().scene;
    const p = massProperties(g, 'plate');
    expect(p.massKg).toBeCloseTo(0.2 * 0.1 * 0.005 * 2700, 12);
    expect(p.centerOfMass![0]).toBeCloseTo(1, 12);
    expect(p.centerOfMass![1]).toBeCloseTo(0.0025, 12);
    expect(p.validity).toBe('approximate');
    expect(massProperties(g, 'servo')).toMatchObject({ massKg: 0.009, validity: 'approximate' });
    expect(massProperties(g, 'motor')).toMatchObject({ massKg: null, validity: 'unknown' });
    run('assembly.create', { id: 'asm', nodeIds: ['plate', 'servo', 'motor'] });
    const a = assemblyMass(e.getProject().scene, 'asm');
    expect(a.massKg).toBeCloseTo(0.27 + 0.009, 9);
    expect(a.unknown).toEqual(['Stepper motor (NEMA frame)']);
    const bb = worldBounds(e.getProject().scene, 'plate')!;
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(0.2, 12);
    expect(pointDistance([0, 0, 0], [0.003, 0.004, 0])).toBeCloseTo(0.005, 15);
    expect(axisAngle([1, 0, 0], [0, 1, 0])).toBeCloseTo(Math.PI / 2, 15);
  });

  it('interference: verified box overlap vs touching contact vs preliminary curved-shape warnings', () => {
    const { e, run } = engine();
    const box = (id: string, x: number) =>
      run('scene.node.create', {
        node: {
          kind: 'primitive',
          id,
          geometry: { shape: 'box', width: 0.1, height: 0.1, depth: 0.1 },
          transform: { position: [x, 0, 0] },
        },
      });
    box('a', 0);
    box('b', 0.08); // 20 mm overlap
    box('c', 0.18); // touches b
    run('scene.node.create', {
      node: {
        kind: 'component-instance',
        id: 'rod',
        definitionId: 'precision-shaft',
        transform: { position: [0.5, 0, 0] },
      },
    });
    run('scene.node.create', {
      node: {
        kind: 'component-instance',
        id: 'brg',
        definitionId: 'ball-bearing',
        transform: { position: [0.5, 0, 0] },
      },
    });
    const r = checkInterference(e.getProject().scene, ['a', 'b', 'c', 'rod', 'brg']);
    const find = (x: string, y: string) =>
      r.find((i) => (i.a === x && i.b === y) || (i.a === y && i.b === x));
    expect(find('a', 'b')).toMatchObject({ kind: 'interference' });
    expect(find('a', 'b')!.penetrationM).toBeCloseTo(0.02, 9);
    expect(find('b', 'c')).toMatchObject({ kind: 'contact' });
    expect(find('a', 'c')).toBeUndefined();
    expect(find('rod', 'brg')).toMatchObject({ kind: 'possible' });
  });

  it('exploded offsets are view-only and grow with the factor', () => {
    const { e, run } = engine();
    run('scene.node.create', {
      node: {
        kind: 'primitive',
        id: 'a',
        geometry: { shape: 'box', width: 0.1, height: 0.1, depth: 0.1 },
        transform: { position: [-0.1, 0, 0] },
      },
    });
    run('scene.node.create', {
      node: {
        kind: 'primitive',
        id: 'b',
        geometry: { shape: 'box', width: 0.1, height: 0.1, depth: 0.1 },
        transform: { position: [0.1, 0, 0] },
      },
    });
    run('assembly.create', { id: 'asm', nodeIds: ['a', 'b'] });
    const before = serializeProject(e.getProject());
    const o1 = explodeOffsets(e.getProject().scene, 'asm', 1);
    const o2 = explodeOffsets(e.getProject().scene, 'asm', 2);
    expect(o1.a![0]).toBeLessThan(0);
    expect(o1.b![0]).toBeGreaterThan(0);
    expect(o2.b![0]).toBeCloseTo(2 * o1.b![0]!, 12);
    expect(serializeProject(e.getProject())).toBe(before); // nothing written
  });

  it('fastener checks: designation, hole type and length suitability (no strength claims)', () => {
    const ifc = (id: string) => {
      const d = getDefinition(id.split(':')[0]!)!;
      const params = resolveParameters(d, id.split(':')[1] ?? null).values;
      return evaluate(d, params, d.materialId).interfaces;
    };
    const screw = ifc('machine-screw:m5x20').find((i) => i.id === 'thread')!;
    const plate = evaluate(
      getDefinition('aluminium-plate')!,
      { ...resolveParameters(getDefinition('aluminium-plate')!, null).values, holes: 'M5' },
      null,
    ).interfaces.find((i) => i.id === 'hole-1')!;
    const nut = ifc('hex-nut:m5').find((i) => i.id === 'thread')!;
    const ok = checkFastener(screw, plate, 0.02, 0.005 + 0.0047);
    expect(ok.every((c) => c.ok)).toBe(true);
    const short = checkFastener(screw, plate, 0.006, 0.005 + 0.0047);
    expect(short.find((c) => c.name === 'Length suitability')!.ok).toBe(false);
    const m3 = ifc('hex-nut:m3').find((i) => i.id === 'thread')!;
    expect(checkFastener(screw, m3, null, null).find((c) => c.name === 'Nominal diameter')!.ok).toBe(false);
    expect(checkFastener(screw, nut, null, null).every((c) => c.ok)).toBe(true);
  });
});
