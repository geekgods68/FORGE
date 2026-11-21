import { createCatalogResolver } from '@forge/components';
import {
  createProject,
  ForgeEngine,
  makeCommand,
  parseProjectFile,
  serializeProject,
  worldMatrix,
  type CommandInput,
  type FrameRef,
} from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { createMechanicsService } from '../index';
import { transformPoint, type V3 } from '../pose';

const deg = (d: number) => (d * Math.PI) / 180;
const F = (
  origin: V3,
  axis: V3 = [0, 0, 1],
  xRef: V3 = axis[0] === 0 && axis[1] === 0 ? [1, 0, 0] : [0, 0, 1],
): FrameRef => ({ kind: 'frame', origin, axis, xRef });

function setup() {
  let n = 0;
  const e = new ForgeEngine(createProject('Mechanics'), {
    componentResolver: createCatalogResolver(),
    mechanics: createMechanicsService(),
    newId: () => `id-${++n}`,
  });
  const root = e.getProject().scene.rootId;
  const run = (type: string, payload: unknown) =>
    e.execute(makeCommand(type as never, payload as never, 'desktop-ui') as CommandInput);
  const box = (id: string, w = 0.1) => {
    const r = run('scene.node.create', {
      node: { kind: 'primitive', id, geometry: { shape: 'box', width: w, height: 0.02, depth: 0.02 } },
    });
    if (!r.ok) throw new Error(r.error.message);
    return id;
  };
  const asm = (ids: string[]) => {
    const r = run('assembly.create', { id: 'asm', name: 'Test assembly', nodeIds: ids });
    if (!r.ok) throw new Error(r.error.message);
    return 'asm';
  };
  const world = (id: string, p: V3 = [0, 0, 0]) => transformPoint(worldMatrix(e.getProject().scene, id), p);
  return { e, run, box, asm, world, root };
}
const close = (a: readonly number[], b: readonly number[], eps = 1e-9) =>
  a.every((v, i) => Math.abs(v - b[i]!) <= eps);

describe('assembly solver — reference cases', () => {
  it('two-link planar arm matches closed-form forward kinematics', () => {
    const { e, run, box, asm, world } = setup();
    box('base');
    box('l1');
    box('l2');
    asm(['base', 'l1', 'l2']);
    const L1 = 0.12;
    const L2 = 0.08;
    expect(run('assembly.ground', { assemblyId: 'asm', nodeId: 'base', grounded: true }).ok).toBe(true);
    expect(
      run('assembly.mate.create', {
        assemblyId: 'asm',
        mate: {
          id: 'j1',
          type: 'revolute',
          a: { nodeId: 'base', ref: F([0, 0, 0]) },
          b: { nodeId: 'l1', ref: F([0, 0, 0]) },
          alignment: 'aligned',
        },
      }).ok,
    ).toBe(true);
    expect(
      run('assembly.mate.create', {
        assemblyId: 'asm',
        mate: {
          id: 'j2',
          type: 'revolute',
          a: { nodeId: 'l1', ref: F([L1, 0, 0]) },
          b: { nodeId: 'l2', ref: F([0, 0, 0]) },
          alignment: 'aligned',
        },
      }).ok,
    ).toBe(true);
    const t1 = deg(30);
    const t2 = deg(45);
    expect(run('assembly.joint.setPosition', { assemblyId: 'asm', mateId: 'j1', coordinates: [t1] }).ok).toBe(
      true,
    );
    expect(run('assembly.joint.setPosition', { assemblyId: 'asm', mateId: 'j2', coordinates: [t2] }).ok).toBe(
      true,
    );
    const tip = world('l2', [L2, 0, 0]);
    expect(
      close(
        tip,
        [L1 * Math.cos(t1) + L2 * Math.cos(t1 + t2), L1 * Math.sin(t1) + L2 * Math.sin(t1 + t2), 0],
        1e-12,
      ),
    ).toBe(true);
    // DOF: two free revolutes → mobility 2, under-constrained, both coordinates free.
    const a = e.analyzeAssembly('asm')!;
    expect(a.ok && a.report).toMatchObject({ status: 'under-constrained', mobility: 2, redundancy: 0 });
    expect(a.ok && a.report.relationships.map((r) => r.freeCoordinates)).toEqual([[true], [true]]);
    // Undo/redo of a joint move restores the dependent link exactly.
    e.undo();
    expect(
      close(
        world('l2', [L2, 0, 0]),
        [L1 * Math.cos(t1) + L2 * Math.cos(t1), L1 * Math.sin(t1) + L2 * Math.sin(t1), 0],
        1e-12,
      ),
    ).toBe(true);
    e.redo();
    expect(close(world('l2', [L2, 0, 0]), tip, 1e-15)).toBe(true);
  });

  it('prismatic travel, fixed face-to-face mounting, and grounded motion propagate exactly', () => {
    const { run, box, asm, world } = setup();
    box('rail', 0.4);
    box('carriage');
    box('bracket', 0.03);
    asm(['rail', 'carriage', 'bracket']);
    run('assembly.ground', { assemblyId: 'asm', nodeId: 'rail', grounded: true });
    expect(
      run('assembly.mate.create', {
        assemblyId: 'asm',
        mate: {
          id: 'slide',
          type: 'prismatic',
          a: { nodeId: 'rail', ref: F([0, 0.01, 0], [1, 0, 0], [0, 1, 0]) },
          b: { nodeId: 'carriage', ref: F([0, -0.01, 0], [1, 0, 0], [0, 1, 0]) },
          alignment: 'aligned',
          limits: [{ min: -0.15, max: 0.15 }],
        },
      }).ok,
    ).toBe(true);
    expect(close(world('carriage'), [0, 0.02, 0])).toBe(true);
    // Fixed, opposed (face-to-face): bracket bottom (−Y face) on carriage top (+Y face).
    expect(
      run('assembly.mate.create', {
        assemblyId: 'asm',
        mate: {
          id: 'mount',
          type: 'fixed',
          a: { nodeId: 'carriage', ref: F([0, 0.01, 0], [0, 1, 0], [1, 0, 0]) },
          b: { nodeId: 'bracket', ref: F([0, -0.01, 0], [0, -1, 0], [1, 0, 0]) },
        },
      }).ok,
    ).toBe(true);
    expect(close(world('bracket'), [0, 0.04, 0])).toBe(true);
    expect(close(world('bracket', [0, 1, 0]), [0, 1.04, 0])).toBe(true); // still upright
    expect(
      run('assembly.joint.setPosition', { assemblyId: 'asm', mateId: 'slide', coordinates: [0.1] }).ok,
    ).toBe(true);
    expect(close(world('bracket'), [0.1, 0.04, 0])).toBe(true);
    // Limits are enforced.
    expect(
      run('assembly.joint.setPosition', { assemblyId: 'asm', mateId: 'slide', coordinates: [0.2] }),
    ).toMatchObject({ ok: false, error: { code: 'out-of-limits' } });
    // A mate-driven body cannot be dragged; moving the grounded rail carries everything.
    expect(run('scene.node.transform', { nodeId: 'bracket', position: [1, 1, 1] })).toMatchObject({
      ok: false,
      error: { code: 'invalid-operation' },
    });
    expect(run('scene.node.transform', { nodeId: 'rail', position: [0, 0, 0.5] }).ok).toBe(true);
    expect(close(world('bracket'), [0.1, 0.04, 0.5])).toBe(true);
  });

  it('consistent redundant loop → over-constrained; contradictory mates are rejected atomically', () => {
    const { e, run, box, asm } = setup();
    box('g');
    box('b');
    asm(['g', 'b']);
    run('assembly.ground', { assemblyId: 'asm', nodeId: 'g', grounded: true });
    run('assembly.mate.create', {
      assemblyId: 'asm',
      mate: {
        id: 'r1',
        type: 'revolute',
        a: { nodeId: 'g', ref: F([0, 0, 0]) },
        b: { nodeId: 'b', ref: F([0, 0, 0]) },
        alignment: 'aligned',
      },
    });
    // Second hinge on the same axis, 20 mm further along it: geometrically consistent (closure).
    expect(
      run('assembly.mate.create', {
        assemblyId: 'asm',
        mate: {
          id: 'r2',
          type: 'revolute',
          a: { nodeId: 'g', ref: F([0, 0, 0.02]) },
          b: { nodeId: 'b', ref: F([0, 0, 0.02]) },
          alignment: 'aligned',
        },
      }).ok,
    ).toBe(true);
    const a = e.analyzeAssembly('asm')!;
    expect(a.ok && a.report).toMatchObject({ status: 'over-constrained', mobility: 1 });
    expect(a.ok && a.report.redundancy).toBeGreaterThan(0);
    // A parallel, offset axis contradicts the first hinge: rejected, nothing changes.
    const rev = e.getProject().revision;
    const bad = run('assembly.mate.create', {
      assemblyId: 'asm',
      mate: {
        id: 'r3',
        type: 'revolute',
        a: { nodeId: 'g', ref: F([0.05, 0, 0]) },
        b: { nodeId: 'b', ref: F([0, 0, 0]) },
        alignment: 'aligned',
      },
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'constraint-conflict' } });
    expect(e.getProject().revision).toBe(rev);
  });

  it('a driving distance constraint positions a free slider (fully constrained afterwards)', () => {
    const { e, run, box, asm, world } = setup();
    box('g', 0.4);
    box('s');
    asm(['g', 's']);
    run('assembly.ground', { assemblyId: 'asm', nodeId: 'g', grounded: true });
    run('assembly.mate.create', {
      assemblyId: 'asm',
      mate: {
        id: 'p',
        type: 'prismatic',
        a: { nodeId: 'g', ref: F([0, 0, 0], [1, 0, 0], [0, 1, 0]) },
        b: { nodeId: 's', ref: F([0, 0, 0], [1, 0, 0], [0, 1, 0]) },
        alignment: 'aligned',
        coordinates: [0.03],
      },
    });
    expect(
      run('assembly.constraint.add', {
        assemblyId: 'asm',
        constraint: {
          id: 'd',
          type: 'distance',
          a: { nodeId: 'g', ref: F([-0.2, 0, 0]) },
          b: { nodeId: 's', ref: F([0, 0, 0]) },
          value: 0.25,
          driving: true,
        },
      }).ok,
    ).toBe(true);
    expect(world('s')[0]).toBeCloseTo(0.05, 8);
    const a = e.analyzeAssembly('asm')!;
    expect(a.ok && a.report).toMatchObject({ status: 'fully-constrained', mobility: 0 });
  });

  it('idealised joint DOF and global mobility for each mate type', () => {
    const cases: [string, number][] = [
      ['fixed', 0],
      ['revolute', 1],
      ['prismatic', 1],
      ['cylindrical', 2],
      ['ball', 3],
      ['planar', 3],
    ];
    for (const [type, dof] of cases) {
      const { e, run, box, asm } = setup();
      box('g');
      box('b');
      asm(['g', 'b']);
      run('assembly.ground', { assemblyId: 'asm', nodeId: 'g', grounded: true });
      expect(
        run('assembly.mate.create', {
          assemblyId: 'asm',
          mate: {
            id: 'm',
            type,
            a: { nodeId: 'g', ref: F([0, 0, 0]) },
            b: { nodeId: 'b', ref: F([0, 0, 0]) },
          },
        }).ok,
        type,
      ).toBe(true);
      const a = e.analyzeAssembly('asm')!;
      expect(a.ok && a.report.mobility, type).toBe(dof);
      expect(a.ok && a.report.relationships[0]!.jointDof, type).toBe(dof);
    }
  });

  it('an unconstrained body has 6 DOF; no ground → implicit reference is reported', () => {
    const { e, run, box, asm } = setup();
    box('a');
    box('b');
    box('free');
    asm(['a', 'b', 'free']);
    run('assembly.mate.create', {
      assemblyId: 'asm',
      mate: {
        id: 'm',
        type: 'fixed',
        a: { nodeId: 'a', ref: F([0, 0, 0]) },
        b: { nodeId: 'b', ref: F([0.1, 0, 0]) },
      },
    });
    const a = e.analyzeAssembly('asm')!;
    expect(a.ok && a.report).toMatchObject({
      implicitGround: true,
      freeBodies: ['free'],
      mobility: 6,
      status: 'under-constrained',
    });
  });

  it('deleting a body removes its relationships; duplicating an assembly remaps them; both undoable', () => {
    const { e, run, box, asm } = setup();
    box('g');
    box('b');
    asm(['g', 'b']);
    run('assembly.mate.create', {
      assemblyId: 'asm',
      mate: {
        id: 'm',
        type: 'revolute',
        a: { nodeId: 'g', ref: F([0, 0, 0]) },
        b: { nodeId: 'b', ref: F([0, 0, 0]) },
      },
    });
    const dup = run('scene.node.duplicate', { nodeId: 'asm' });
    expect(dup.ok).toBe(true);
    const copy = e.getNode(dup.ok ? dup.affectedIds[0]! : '')!;
    expect(copy.kind === 'assembly' && copy.mechanical.mates[0]!.a.nodeId).toBe(copy.childIds[0]);
    expect(copy.kind === 'assembly' && copy.mechanical.mates[0]!.id).not.toBe('m');
    expect(run('scene.node.delete', { nodeId: 'b' }).ok).toBe(true);
    const a = e.getNode('asm')!;
    expect(a.kind === 'assembly' && a.mechanical.mates).toEqual([]);
    e.undo();
    const back = e.getNode('asm')!;
    expect(back.kind === 'assembly' && back.mechanical.mates.map((m) => m.id)).toEqual(['m']);
    // Structural moves of constrained bodies are refused.
    expect(run('scene.node.group', { nodeIds: ['b'] })).toMatchObject({ ok: false });
    expect(run('assembly.removeComponent', { assemblyId: 'asm', nodeId: 'b' })).toMatchObject({ ok: false });
  });

  it('mates on component interfaces: a parameter change that removes a referenced interface is rejected', () => {
    const { e, run, asm } = setup();
    run('scene.node.create', {
      node: {
        kind: 'component-instance',
        id: 'plate',
        definitionId: 'aluminium-plate',
        parameters: { holes: 'M5' },
      },
    });
    run('scene.node.create', {
      node: { kind: 'component-instance', id: 'screw', definitionId: 'machine-screw', variantId: 'm5x20' },
    });
    asm(['plate', 'screw']);
    run('assembly.ground', { assemblyId: 'asm', nodeId: 'plate', grounded: true });
    // Screw tip (thread, pointing −Y) into the plate's hole 1 (top face, +Y): opposed axes.
    expect(
      run('assembly.mate.create', {
        assemblyId: 'asm',
        mate: {
          id: 'fast',
          type: 'fixed',
          a: { nodeId: 'plate', ref: { kind: 'interface', interfaceId: 'hole-1' } },
          b: { nodeId: 'screw', ref: { kind: 'interface', interfaceId: 'thread' } },
        },
      }).ok,
    ).toBe(true);
    const rev = e.getProject().revision;
    const r = run('component.parameters.update', { nodeId: 'plate', parameters: { holes: 'none' } });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error.message).toMatch(/no interface "hole-1"/);
    expect(e.getProject().revision).toBe(rev);
    // A compatible change (thicker plate) re-solves: the screw follows the moved hole.
    expect(run('component.parameters.update', { nodeId: 'plate', parameters: { thickness: 0.01 } }).ok).toBe(
      true,
    );
  });

  it('assemblies, mates and joint coordinates round-trip through the project file; invalid relationships are rejected on load', () => {
    const { e, run, box, asm } = setup();
    box('g');
    box('b');
    asm(['g', 'b']);
    run('assembly.ground', { assemblyId: 'asm', nodeId: 'g', grounded: true });
    run('assembly.mate.create', {
      assemblyId: 'asm',
      mate: {
        id: 'm',
        type: 'revolute',
        a: { nodeId: 'g', ref: F([0, 0, 0]) },
        b: { nodeId: 'b', ref: F([0, 0, 0]) },
        limits: [{ min: -1, max: 1 }],
        home: [0],
      },
    });
    run('assembly.joint.setPosition', { assemblyId: 'asm', mateId: 'm', coordinates: [0.5] });
    const text = serializeProject(e.getProject());
    const r = parseProjectFile(text);
    expect(r.ok && r.project).toEqual(e.getProject());
    const doc = JSON.parse(text);
    doc.scene.nodes.asm.mechanical.mates[0].b.nodeId = 'ghost';
    expect(parseProjectFile(JSON.stringify(doc))).toMatchObject({ ok: false });
    const doc2 = JSON.parse(text);
    doc2.scene.nodes.asm.mechanical.mates[0].coordinates = [2];
    expect(parseProjectFile(JSON.stringify(doc2))).toMatchObject({ ok: false }); // outside its limits
  });
});
