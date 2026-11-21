import {
  assemblyCommands,
  AssemblyTemplateSchema,
  checkCompatibility,
  createCatalogResolver,
  templateFromGroup,
} from '@forge/components';
import {
  canConvertMate,
  convertMate,
  createProject,
  ForgeEngine,
  isMateDriven,
  makeCommand,
  ModelInterfaceSchema,
  ModelRefSchema,
  parseProjectFile,
  serializeProject,
  worldMatrix,
  type CommandInput,
  type FrameRef,
  type Mate,
  type ModelInterface,
  type SceneNode,
} from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { bodyInterfaces, createMechanicsService } from '../index';
import { transformDir, transformPoint, type V3 } from '../pose';

/**
 * Phase 4.1: the commands behind the new assembly interactions — mate editing (safe type
 * conversion, alignment, offset, limits, home, suppression), constraint editing, and
 * user-declared interfaces on imported models — validated, atomic and undoable.
 */
const deg = (d: number) => (d * Math.PI) / 180;
const F = (origin: V3, axis: V3 = [0, 0, 1], xRef: V3 = [1, 0, 0]): FrameRef => ({
  kind: 'frame',
  origin,
  axis,
  xRef,
});
const close = (a: readonly number[], b: readonly number[], eps = 1e-9) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= eps);

function setup() {
  let n = 0;
  const e = new ForgeEngine(createProject('Interaction'), {
    componentResolver: createCatalogResolver(),
    mechanics: createMechanicsService(),
    newId: () => `id-${++n}`,
  });
  const run = (type: string, payload: unknown) =>
    e.execute(makeCommand(type as never, payload as never, 'desktop-ui') as CommandInput);
  const ok = (type: string, payload: unknown) => {
    const r = run(type, payload);
    if (!r.ok) throw new Error(r.error.message);
    return r;
  };
  const box = (id: string, position: V3 = [0, 0, 0]) =>
    ok('scene.node.create', {
      node: {
        kind: 'primitive',
        id,
        geometry: { shape: 'box', width: 0.1, height: 0.02, depth: 0.02 },
        transform: { position },
      },
    });
  const world = (id: string, p: V3 = [0, 0, 0]) => transformPoint(worldMatrix(e.getProject().scene, id), p);
  const asm = () => e.getProject().scene.nodes.asm as Extract<SceneNode, { kind: 'assembly' }>;
  const mate = (id: string) => asm().mechanical.mates.find((m) => m.id === id)!;
  return { e, run, ok, box, world, asm, mate };
}

/** Ground A, revolute joint A → B about A's +Z at x = 0.1. */
function hinge() {
  const s = setup();
  s.box('a');
  s.box('b', [0.3, 0, 0]);
  s.ok('assembly.create', { id: 'asm', nodeIds: ['a', 'b'] });
  s.ok('assembly.ground', { assemblyId: 'asm', nodeId: 'a', grounded: true });
  s.ok('assembly.mate.create', {
    assemblyId: 'asm',
    mate: {
      id: 'j',
      name: 'Hinge',
      type: 'revolute',
      a: { nodeId: 'a', ref: F([0.1, 0, 0]) },
      b: { nodeId: 'b', ref: F([-0.05, 0, 0]) },
      alignment: 'aligned',
      limits: [{ min: deg(-90), max: deg(90) }],
      coordinates: [deg(30)],
      home: [0],
    },
  });
  return s;
}

describe('safe mate-type conversion', () => {
  it('converts within {fixed, revolute, prismatic, cylindrical}, carrying coordinates by kind', () => {
    const m = {
      type: 'revolute' as const,
      coordinates: [0.4],
      home: [0.1],
      limits: [{ min: -1, max: 1 }],
    };
    expect(convertMate(m, 'cylindrical')).toEqual({
      ok: true,
      coordinates: [0.4, 0],
      home: [0.1, 0],
      limits: [{ min: -1, max: 1 }, null],
    });
    expect(convertMate(m, 'fixed')).toEqual({ ok: true, coordinates: [], home: [], limits: [] });
    expect(
      convertMate(
        { type: 'cylindrical', coordinates: [0.4, 0.02], home: [0, 0], limits: [null, null] },
        'prismatic',
      ),
    ).toEqual({ ok: true, coordinates: [0.02], home: [0], limits: [null] });
    for (const t of ['ball', 'planar'] as const) {
      expect(canConvertMate('revolute', t)).toBe(false);
      expect(canConvertMate(t, 'fixed')).toBe(false);
      expect(convertMate(m, t).ok).toBe(false);
    }
  });
});

describe('assembly.mate.update (mate editor)', () => {
  it('alignment, offset, type, limits, home and suppression edits re-solve; each is one undoable step', () => {
    const s = hinge();
    const p0 = s.world('b', [0.05, 0, 0]);
    const rev0 = s.e.getProject().revision;

    // Alignment flip: B's frame axis reverses, so B rotates π about its frame x-axis.
    s.ok('assembly.mate.update', { assemblyId: 'asm', mateId: 'j', patch: { alignment: 'opposed' } });
    expect(s.mate('j').alignment).toBe('opposed');
    const zB = transformDir(worldMatrix(s.e.getProject().scene, 'b'), [0, 0, 1]);
    expect(close(zB, [0, 0, -1])).toBe(true);
    s.e.undo();
    expect(close(s.world('b', [0.05, 0, 0]), p0)).toBe(true);
    s.e.redo();
    expect(s.mate('j').alignment).toBe('opposed');
    s.e.undo();

    // Offset: an extra fixed rotation about the axis (30° + 15° total).
    s.ok('assembly.mate.update', { assemblyId: 'asm', mateId: 'j', patch: { offsetRad: deg(15) } });
    const tip = s.world('b', [0.05, 0, 0]);
    // Body B's origin sits 0.05 from the joint; its +X tip is 0.1 from the joint at 45°.
    expect(close(tip, [0.1 + 0.1 * Math.cos(deg(45)), 0.1 * Math.sin(deg(45)), 0])).toBe(true);
    s.e.undo();

    // Safe type conversion: revolute → cylindrical keeps the angle, limit and home.
    s.ok('assembly.mate.update', { assemblyId: 'asm', mateId: 'j', patch: { type: 'cylindrical' } });
    expect(s.mate('j')).toMatchObject({
      type: 'cylindrical',
      limits: [{ min: deg(-90), max: deg(90) }, null],
      home: [0, 0],
    });
    expect(s.mate('j').coordinates[0]).toBeCloseTo(deg(30), 12);
    expect(close(s.world('b', [0.05, 0, 0]), p0)).toBe(true); // same pose: nothing jumps
    s.e.undo();
    expect(s.mate('j').type).toBe('revolute');
    // Unsafe conversion is refused and changes nothing.
    const r = s.run('assembly.mate.update', { assemblyId: 'asm', mateId: 'j', patch: { type: 'ball' } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('unsupported');

    // Limits / home: valid edits apply; home outside limits and limits excluding the current
    // coordinate are refused.
    s.ok('assembly.mate.update', {
      assemblyId: 'asm',
      mateId: 'j',
      patch: { limits: [{ min: deg(-45), max: deg(45) }], home: [deg(10)] },
    });
    expect(s.mate('j').home[0]).toBeCloseTo(deg(10), 12);
    const badHome = s.run('assembly.mate.update', {
      assemblyId: 'asm',
      mateId: 'j',
      patch: { home: [deg(60)] },
    });
    expect(!badHome.ok && badHome.error.code).toBe('out-of-limits');
    const badLim = s.run('assembly.mate.update', {
      assemblyId: 'asm',
      mateId: 'j',
      patch: { limits: [{ min: deg(40), max: deg(45) }] },
    });
    expect(!badLim.ok && badLim.error.code).toBe('out-of-limits');
    s.e.undo();

    // Suppression: the mate stops driving B (B keeps its pose but becomes free: +6 − 1 DOF).
    const before = s.e.analyzeAssembly('asm')!;
    s.ok('assembly.mate.update', { assemblyId: 'asm', mateId: 'j', patch: { suppressed: true } });
    expect(close(s.world('b', [0.05, 0, 0]), p0)).toBe(true);
    const after = s.e.analyzeAssembly('asm')!;
    expect(before.ok && before.report.mobility).toBe(1);
    expect(after.ok && after.report.freeBodies).toEqual(['b']);
    s.e.undo();
    expect(s.mate('j').suppressed).toBe(false);
    expect(s.e.getProject().revision).toBeGreaterThan(rev0);
  });

  it('suppressed mates and check-only constraints do not drive a body (it can be moved directly)', () => {
    const s = hinge();
    const g = () => s.e.getProject().scene;
    expect(isMateDriven(g(), 'b')).toBe(true);
    expect(s.run('scene.node.transform', { nodeId: 'b', position: [0.5, 0, 0] }).ok).toBe(false);
    s.ok('assembly.mate.update', { assemblyId: 'asm', mateId: 'j', patch: { suppressed: true } });
    expect(isMateDriven(g(), 'b')).toBe(false);
    expect(s.run('scene.node.transform', { nodeId: 'b', position: [0.5, 0, 0] }).ok).toBe(true);
    s.ok('assembly.constraint.add', {
      assemblyId: 'asm',
      constraint: {
        id: 'chk',
        type: 'parallel',
        a: { nodeId: 'a', ref: F([0, 0, 0]) },
        b: { nodeId: 'b', ref: F([0, 0, 0]) },
        driving: false,
      },
    });
    expect(isMateDriven(g(), 'b')).toBe(false);
    s.ok('assembly.constraint.update', { assemblyId: 'asm', constraintId: 'chk', patch: { driving: true } });
    expect(isMateDriven(g(), 'b')).toBe(true);
  });

  it('an alignment edit that contradicts a loop is rejected atomically (invalid alignment)', () => {
    const s = hinge();
    // Lock the hinge with a consistent fixed closure (a loop: redundant but satisfied).
    // A revolute closure would not do: a hinge axis has no sign, so flipping it is not a
    // contradiction — a fixed closure's orientation is.
    s.ok('assembly.joint.setPosition', { assemblyId: 'asm', mateId: 'j', coordinates: [0] });
    s.ok('assembly.mate.create', {
      assemblyId: 'asm',
      mate: {
        id: 'j2',
        name: 'Lock',
        type: 'fixed',
        a: { nodeId: 'a', ref: F([0.1, 0, 0.01]) },
        b: { nodeId: 'b', ref: F([-0.05, 0, 0.01]) },
        alignment: 'aligned',
      },
    });
    const snapshot = JSON.stringify(s.e.getProject());
    const r = s.run('assembly.mate.update', {
      assemblyId: 'asm',
      mateId: 'j2',
      patch: { alignment: 'opposed' },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('constraint-conflict');
    expect(JSON.stringify(s.e.getProject())).toBe(snapshot); // nothing changed
    // The dry run (what the editor's preview uses) reports the same refusal and commits nothing.
    const dry = s.e.preview(
      makeCommand(
        'assembly.mate.update',
        { assemblyId: 'asm', mateId: 'j2', patch: { alignment: 'opposed' } },
        'desktop-ui',
      ) as never,
    );
    expect(dry.result.ok).toBe(false);
    expect(JSON.stringify(s.e.getProject())).toBe(snapshot);
  });
});

describe('assembly.constraint.update (constraint editor)', () => {
  /** Grounded rail + prismatic slider along +X (axis = rail frame +Z rotated onto X). */
  function slider() {
    const s = setup();
    s.box('rail');
    s.box('car', [0.2, 0.1, 0]);
    s.ok('assembly.create', { id: 'asm', nodeIds: ['rail', 'car'] });
    s.ok('assembly.ground', { assemblyId: 'asm', nodeId: 'rail', grounded: true });
    s.ok('assembly.mate.create', {
      assemblyId: 'asm',
      mate: {
        id: 'p',
        type: 'prismatic',
        a: { nodeId: 'rail', ref: F([0, 0, 0], [1, 0, 0], [0, 0, 1]) },
        b: { nodeId: 'car', ref: F([0, 0, 0], [1, 0, 0], [0, 0, 1]) },
        alignment: 'aligned',
        // Start off the singular point of a distance (coincident origins: zero gradient).
        coordinates: [0.02],
      },
    });
    return s;
  }

  it('adds a driving distance, edits its value, toggles check-only, deletes — all undoable', () => {
    const s = slider();
    s.ok('assembly.constraint.add', {
      assemblyId: 'asm',
      constraint: {
        id: 'd',
        type: 'distance',
        a: { nodeId: 'rail', ref: F([0, 0, 0]) },
        b: { nodeId: 'car', ref: F([0, 0, 0]) },
        value: 0.05,
      },
    });
    expect(s.world('car')[0]).toBeCloseTo(0.05, 9);
    s.ok('assembly.constraint.update', { assemblyId: 'asm', constraintId: 'd', patch: { value: 0.12 } });
    expect(s.world('car')[0]).toBeCloseTo(0.12, 9);
    expect(s.asm().mechanical.constraints[0]!.value).toBe(0.12);
    s.e.undo();
    expect(s.world('car')[0]).toBeCloseTo(0.05, 9);
    s.e.redo();
    expect(s.world('car')[0]).toBeCloseTo(0.12, 9);

    // Check-only: no longer drives; the report keeps checking it.
    s.ok('assembly.constraint.update', { assemblyId: 'asm', constraintId: 'd', patch: { driving: false } });
    const rep = s.e.analyzeAssembly('asm')!;
    expect(rep.ok && rep.report.relationships.find((r) => r.id === 'd')).toMatchObject({
      role: 'check',
      satisfied: true,
    });
    // Invalid values are refused before solving.
    for (const patch of [{ value: -0.01 }, { value: null }]) {
      const r = s.run('assembly.constraint.update', { assemblyId: 'asm', constraintId: 'd', patch });
      expect(!r.ok && r.error.code).toBe('invalid-command');
    }
    s.ok('assembly.constraint.delete', { assemblyId: 'asm', constraintId: 'd' });
    expect(s.asm().mechanical.constraints).toEqual([]);
    s.e.undo();
    expect(s.asm().mechanical.constraints.map((c) => c.id)).toEqual(['d']);
  });

  it('a contradictory constraint (add or edit) is rejected without modifying the assembly', () => {
    const s = slider();
    // The car slides only along X; a coincident with a point off that line cannot be met.
    const snapshot = JSON.stringify(s.e.getProject());
    const bad = s.run('assembly.constraint.add', {
      assemblyId: 'asm',
      constraint: {
        type: 'coincident',
        a: { nodeId: 'rail', ref: F([0, 0.05, 0]) },
        b: { nodeId: 'car', ref: F([0, 0, 0]) },
      },
    });
    expect(!bad.ok && bad.error.code).toBe('constraint-conflict');
    expect(JSON.stringify(s.e.getProject())).toBe(snapshot);

    s.ok('assembly.constraint.add', {
      assemblyId: 'asm',
      constraint: {
        id: 'ang',
        type: 'angle',
        a: { nodeId: 'rail', ref: F([0, 0, 0], [1, 0, 0], [0, 0, 1]) },
        b: { nodeId: 'car', ref: F([0, 0, 0], [1, 0, 0], [0, 0, 1]) },
        value: 0,
      },
    });
    const snap2 = JSON.stringify(s.e.getProject());
    // The prismatic joint forbids rotation: any non-zero angle contradicts it.
    const r = s.run('assembly.constraint.update', {
      assemblyId: 'asm',
      constraintId: 'ang',
      patch: { value: deg(30) },
    });
    expect(!r.ok && r.error.code).toBe('constraint-conflict');
    expect(JSON.stringify(s.e.getProject())).toBe(snap2);
    const r2 = s.run('assembly.constraint.update', {
      assemblyId: 'asm',
      constraintId: 'ang',
      patch: { value: deg(181) },
    });
    expect(!r2.ok && r2.error.code).toBe('invalid-command');
  });
});

describe('imported-model connection interfaces', () => {
  const HASH = `sha256-${'ab'.repeat(32)}`;
  const legacyRef = {
    assetHash: HASH,
    byteLength: 1234,
    mediaType: 'model/gltf-binary',
    name: 'Bracket',
    categoryId: 'enclosures-product-design',
    description: '',
    unitScale: 0.001,
    upAxis: 'Y',
    boundsM: [0.1, 0.02, 0.05],
    minM: [0, 0, 0],
    metadata: {},
  };
  const mount: ModelInterface = {
    id: 'mount',
    name: 'Mounting face',
    type: 'bolt-hole',
    gender: 'female',
    position: [0.05, 0.02, 0.025],
    direction: [0, 1, 0],
    xRef: [0, 0, 1],
    compatibility: ['M4-clearance'],
    dimensions: { diameter: 0.0045 },
  };

  it('legacy model references (no interfaces) still parse; declarations are validated', () => {
    const r = ModelRefSchema.parse(legacyRef);
    expect(r.interfaces).toEqual([]);
    expect(ModelInterfaceSchema.safeParse(mount).success).toBe(true);
    // Orientation reference must be perpendicular to the mounting axis.
    expect(ModelInterfaceSchema.safeParse({ ...mount, xRef: [0, 1, 0] }).success).toBe(false);
    expect(ModelInterfaceSchema.safeParse({ ...mount, direction: [0, 2, 0] }).success).toBe(false);
    expect(ModelInterfaceSchema.safeParse({ ...mount, compatibility: [] }).success).toBe(false);
    expect(ModelInterfaceSchema.safeParse({ ...mount, id: 'Has Space' }).success).toBe(false);
    expect(ModelRefSchema.safeParse({ ...legacyRef, interfaces: [mount, mount] }).success).toBe(false);
  });

  it('declared interfaces make an imported model mateable; edits re-solve; used interfaces are protected', () => {
    const s = setup();
    s.ok('model.instance.create', { id: 'glb', model: legacyRef, transform: { position: [0.3, 0, 0] } });
    s.ok('scene.node.create', {
      node: { kind: 'component-instance', id: 'screw', definitionId: 'machine-screw', variantId: 'm4x12' },
    });
    // Without declarations the model has none (never inferred).
    expect(typeof bodyInterfaces(s.e.getProject().scene, 'glb')).toBe('string');
    s.ok('model.instance.interfaces.set', { nodeId: 'glb', interfaces: [mount] });
    const list = bodyInterfaces(s.e.getProject().scene, 'glb');
    expect(Array.isArray(list) && list.map((i) => i.id)).toEqual(['mount']);
    const screwIfc = (bodyInterfaces(s.e.getProject().scene, 'screw') as { id: string }[])[0] as never;
    expect(checkCompatibility((list as never[])[0]!, screwIfc).compatible).toBe(true);
    s.e.undo();
    expect(
      (s.e.getProject().scene.nodes.glb as Extract<SceneNode, { kind: 'model-instance' }>).model.interfaces,
    ).toEqual([]);
    s.e.redo();

    // Mate a screw to the declared interface: its thread frame lands on the declared point.
    s.ok('assembly.create', { id: 'asm', nodeIds: ['glb', 'screw'] });
    s.ok('assembly.ground', { assemblyId: 'asm', nodeId: 'glb', grounded: true });
    s.ok('assembly.mate.create', {
      assemblyId: 'asm',
      mate: {
        id: 'm',
        type: 'fixed',
        a: { nodeId: 'glb', ref: { kind: 'interface', interfaceId: 'mount' } },
        b: { nodeId: 'screw', ref: { kind: 'interface', interfaceId: 'thread' } },
      },
    });
    const target = s.world('glb', mount.position);
    expect(close(s.world('screw'), target)).toBe(true);
    // The declared orientation (xRef) is honoured: the screw's frame x-axis follows it.
    const W = worldMatrix(s.e.getProject().scene, 'screw');
    expect(Math.abs(transformDir(W, [0, -1, 0])[1] + 1)).toBeLessThan(1e-9); // thread axis opposes +Y

    // Moving the interface moves what is mated to it (one undoable step).
    const moved = { ...mount, position: [0.02, 0.02, 0.025] as V3 };
    s.ok('model.instance.interfaces.set', { nodeId: 'glb', interfaces: [moved] });
    expect(close(s.world('screw'), s.world('glb', moved.position))).toBe(true);
    s.e.undo();
    expect(close(s.world('screw'), target)).toBe(true);

    // Removing an interface a mate uses is refused.
    const r = s.run('model.instance.interfaces.set', { nodeId: 'glb', interfaces: [] });
    expect(!r.ok && r.error.message).toContain('in use');

    // Persistence: interfaces and the mate survive a save/load round trip.
    const back = parseProjectFile(serializeProject(s.e.getProject()));
    expect(back.ok).toBe(true);
    const n = back.ok ? back.project.scene.nodes.glb : null;
    expect(n?.kind === 'model-instance' && n.model.interfaces).toEqual([mount]);
    const a = back.ok ? back.project.scene.nodes.asm : null;
    expect(a?.kind === 'assembly' && a.mechanical.mates.map((m: Mate) => m.id)).toEqual(['m']);
  });

  it('a reusable assembly keeps the declared interfaces and the mate on them (template round trip)', () => {
    const s = setup();
    s.ok('model.instance.create', { id: 'glb', model: legacyRef });
    s.ok('model.instance.interfaces.set', { nodeId: 'glb', interfaces: [mount] });
    s.ok('scene.node.create', {
      node: { kind: 'component-instance', id: 'screw', definitionId: 'machine-screw', variantId: 'm4x12' },
    });
    s.ok('assembly.create', { id: 'asm', nodeIds: ['glb', 'screw'] });
    s.ok('assembly.ground', { assemblyId: 'asm', nodeId: 'glb', grounded: true });
    s.ok('assembly.mate.create', {
      assemblyId: 'asm',
      mate: {
        type: 'fixed',
        a: { nodeId: 'glb', ref: { kind: 'interface', interfaceId: 'mount' } },
        b: { nodeId: 'screw', ref: { kind: 'interface', interfaceId: 'thread' } },
      },
    });
    const t = templateFromGroup(s.e.getProject(), 'asm', 'tpl', new Date('2026-11-22T00:00:00Z'));
    if (!t.ok) throw new Error(t.message);
    const parsed = AssemblyTemplateSchema.parse(JSON.parse(JSON.stringify(t.template)));
    let n = 0;
    const { rootId, commands } = assemblyCommands(
      parsed,
      s.e.getProject().scene.rootId,
      [0.5, 0, 0],
      () => `c-${++n}`,
    );
    s.ok('scene.batch', { commands });
    const copy = s.e.getProject().scene.nodes[rootId] as Extract<SceneNode, { kind: 'assembly' }>;
    const model = copy.childIds
      .map((id) => s.e.getProject().scene.nodes[id]!)
      .find((x) => x.kind === 'model-instance');
    expect(model?.kind === 'model-instance' && model.model.interfaces).toEqual([mount]);
    expect(copy.mechanical.mates).toHaveLength(1);
    expect(copy.mechanical.mates[0]!.a.ref).toEqual({ kind: 'interface', interfaceId: 'mount' });
    const r = s.e.analyzeAssembly(rootId);
    expect(r?.ok && r.report.maxResidual).toBeLessThan(1e-9);
  });

  it('a project file written before Phase 4.1 (model without interfaces) loads unchanged', () => {
    const s = setup();
    s.ok('model.instance.create', { id: 'glb', model: legacyRef });
    const json = JSON.parse(serializeProject(s.e.getProject())) as {
      scene: { nodes: Record<string, { model?: { interfaces?: unknown } }> };
    };
    delete json.scene.nodes.glb!.model!.interfaces;
    const back = parseProjectFile(JSON.stringify(json));
    expect(back.ok).toBe(true);
    const n = back.ok ? back.project.scene.nodes.glb : null;
    expect(n?.kind === 'model-instance' && n.model.interfaces).toEqual([]);
  });
});
