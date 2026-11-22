import {
  createProject,
  defaultSimulationDefinition,
  type SimulationDefinition,
} from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { buildPhysicsModel, createRoboticArmSimulationSample, SceneBuilder, simulationOf } from '../index';

const at = new Date('2026-11-22T00:00:00Z');
const arm = () => createRoboticArmSimulationSample(at);

describe('CAD → physics bridge: robotic arm', () => {
  it('welds fixed-mated parts into rigid links and maps the four revolute joints with their limits', () => {
    const p = arm();
    const m = buildPhysicsModel(p.scene, simulationOf(p.scene)!);
    expect(m.ok).toBe(true);
    const armBodies = m.bodies.filter((b) => b.assemblyId === 'grp-arm');
    expect(armBodies.map((b) => b.mode)).toEqual(['fixed', 'dynamic', 'dynamic', 'dynamic', 'dynamic']);
    const link = armBodies.find((b) => b.unitIds.includes('upper-link'))!;
    expect(new Set(link.unitIds)).toEqual(
      new Set(['upper-link', 'shoulder-shaft', 'shoulder-bearing', 'elbow-servo']),
    );
    expect(armBodies[0]!.unitIds).toContain('base-plate');
    expect(m.joints.map((j) => [j.mateId, j.mapping])).toEqual([
      ['j-yaw', 'revolute'],
      ['j-shoulder', 'revolute'],
      ['j-elbow', 'revolute'],
      ['j-wrist', 'revolute'],
    ]);
    const elbow = m.joints.find((j) => j.mateId === 'j-elbow')!;
    expect(elbow.q0[0]).toBeCloseTo(-Math.PI / 2, 12);
    expect(elbow.limits[0]).toEqual({ min: (-135 * Math.PI) / 180, max: (135 * Math.PI) / 180 });
    // Electronics are loose bodies → fixed obstacles by default.
    expect(m.bodies.find((b) => b.unitIds.includes('arduino'))!.mode).toBe('fixed');
    // Every joint actuator carries the servo's cited limits (not invented values).
    const a = m.joints.find((j) => j.mateId === 'j-shoulder')!.settings.actuator!;
    expect(a.source).toBe('datasheet-cited');
    expect(a.effortLimit).toBeCloseTo(9.4 * 0.0980665, 12);
    expect(a.speedLimit).toBeCloseTo(Math.PI / 3 / 0.17, 12);
    expect(m.joints.find((j) => j.mateId === 'j-wrist')!.settings.actuator!.effortLimit).toBeCloseTo(
      1.8 * 0.0980665,
      12,
    );
  });

  it('unknown masses are errors (never inferred); the demonstration values are explicit, labelled user inputs', () => {
    const p = arm();
    const d = simulationOf(p.scene)!;
    const bare: SimulationDefinition = { ...d, bodies: [] };
    const m = buildPhysicsModel(p.scene, bare);
    expect(m.ok).toBe(false);
    const unknown = m.issues.filter((i) => i.code === 'mass-unknown').map((i) => i.refs[0]);
    expect(new Set(unknown)).toEqual(new Set(['gripper', 'shoulder-bearing']));
    const ok = buildPhysicsModel(p.scene, d);
    const g = ok.bodies.find((b) => b.unitIds.includes('gripper'))!.massSources[0]!;
    expect(g.source).toBe('user');
    expect(g.note).toContain('not measured');
  });

  it('records the collider approximations and the modelling assumptions', () => {
    const p = arm();
    const m = buildPhysicsModel(p.scene, simulationOf(p.scene)!);
    const approximations = m.bodies.flatMap((b) => b.colliders.map((c) => c.approximation).filter(Boolean));
    expect(approximations.some((a) => a!.includes('solid cylinder'))).toBe(true); // bearing tube
    expect(approximations.some((a) => a!.includes('convex hull'))).toBe(true); // holed plate / links
    const topics = m.assumptions.map((a) => a.topic);
    for (const t of ['Rigid bodies', 'Solver', 'Mass properties', 'Collision geometry', 'Actuators'])
      expect(topics).toContain(t);
    expect(m.assumptions.every((a) => a.status !== 'verified')).toBe(true);
  });

  it('initial pose "home" starts from each mate’s home coordinates', () => {
    const p = arm();
    const b = new SceneBuilder(p);
    b.run('assembly.joint.setPosition', { assemblyId: 'grp-arm', mateId: 'j-shoulder', coordinates: [0.4] });
    const cur = buildPhysicsModel(b.graph, b.definition);
    const home = buildPhysicsModel(b.graph, { ...b.definition, initialPose: 'home' });
    expect(cur.joints.find((j) => j.mateId === 'j-shoulder')!.q0[0]).toBeCloseTo(0.4, 12);
    expect(home.joints.find((j) => j.mateId === 'j-shoulder')!.q0[0]).toBe(0);
  });
});

describe('CAD → physics bridge: explicit refusals and approvals', () => {
  const base = () => {
    const b = new SceneBuilder(createProject('Bridge', at));
    const root = b.graph.nodes[b.graph.rootId]!;
    for (const c of root.childIds) b.run('scene.node.delete', { nodeId: c });
    b.batch([
      { type: 'assembly.create', payload: { id: 'asm', name: 'Mechanism', nodeIds: [] } },
      ...(['p', 'q'] as const).map((id, i) => ({
        type: 'scene.node.create' as const,
        payload: {
          node: {
            kind: 'primitive' as const,
            id,
            name: id,
            parentId: 'asm',
            geometry: { shape: 'box' as const, width: 0.1, height: 0.1, depth: 0.1 },
            transform: { position: [i * 0.2, 0.5, 0] as [number, number, number] },
          },
        },
      })),
      { type: 'assembly.ground', payload: { assemblyId: 'asm', nodeId: 'p', grounded: true } },
    ]);
    return b;
  };
  const withSetup = (b: SceneBuilder, patch: Partial<SimulationDefinition> = {}) => {
    b.run('physics.simulation.create', {
      definition: {
        ...defaultSimulationDefinition(),
        bodies: [
          {
            nodeId: 'q',
            mode: 'auto',
            mass: { source: 'material', materialId: 'al-6061-t6' },
            collider: 'auto',
            friction: 0.5,
            restitution: 0,
            linearDamping: 0,
            angularDamping: 0,
            ccd: false,
            linearVelocity: [0, 0, 0],
            angularVelocity: [0, 0, 0],
            contactLoadRatingN: null,
          },
        ],
        ...patch,
      },
    });
    return b;
  };

  it('a primitive without material needs an explicit mass model; a material model gives volume × density', () => {
    const b = base();
    b.run('physics.simulation.create', {});
    expect(
      buildPhysicsModel(b.graph, b.definition).issues.some(
        (i) => i.code === 'mass-unknown' && i.refs[0] === 'q',
      ),
    ).toBe(true);
    const set = withSetup(base());
    const ok = buildPhysicsModel(set.graph, set.definition);
    const q = ok.bodies.find((x) => x.unitIds.includes('q'))!;
    expect(q.mass!.massKg).toBeCloseTo(1e-3 * 2700, 9);
    expect(q.massSources[0]!.status).toBe('approximate');
  });

  it('ball-joint limits are refused unless the user approves dropping them; driving constraints likewise', () => {
    const b = withSetup(base());
    b.run('assembly.mate.create', {
      assemblyId: 'asm',
      mate: {
        id: 'ball',
        name: 'Ball',
        type: 'ball',
        a: { nodeId: 'p', ref: { kind: 'frame', origin: [0.1, 0, 0], axis: [1, 0, 0], xRef: [0, 1, 0] } },
        b: { nodeId: 'q', ref: { kind: 'frame', origin: [-0.1, 0, 0], axis: [-1, 0, 0], xRef: [0, 1, 0] } },
        limits: [{ min: -0.5, max: 0.5 }, null, null],
      },
    });
    const refused = buildPhysicsModel(b.graph, b.definition);
    expect(refused.ok).toBe(false);
    expect(refused.issues.find((i) => i.code === 'limits-unsupported')!.message).toContain('Ball');
    const approved = buildPhysicsModel(b.graph, {
      ...b.definition,
      approvals: { ignoreDrivingConstraints: false, ignoreUnsupportedLimits: true },
    });
    expect(approved.ok).toBe(true);
    expect(approved.joints[0]!.mapping).toBe('spherical');
    expect(approved.joints[0]!.droppedLimits).toBe(true);
    expect(approved.issues.some((i) => i.code === 'limits-dropped')).toBe(true);
  });

  it('imported models get no collider unless the bounding box is selected; deleted references are reported', () => {
    const b = base();
    b.run('model.instance.create', {
      id: 'mdl',
      model: {
        assetHash: `sha256-${'a'.repeat(64)}`,
        byteLength: 100,
        mediaType: 'model/gltf-binary',
        name: 'Imported',
        categoryId: 'enclosures-product-design',
        description: '',
        unitScale: 0.001,
        upAxis: 'Y',
        boundsM: [0.1, 0.05, 0.1],
        minM: [-0.05, 0, -0.05],
        metadata: {},
      },
    });
    b.run('physics.simulation.create', {});
    b.run('physics.body.set', { nodeId: 'mdl', settings: { mode: 'fixed' } });
    const m = buildPhysicsModel(b.graph, b.definition);
    expect(m.bodies.find((x) => x.unitIds.includes('mdl'))!.colliders).toEqual([]);
    expect(m.issues.some((i) => i.code === 'no-collider')).toBe(true);
    b.run('physics.body.set', { nodeId: 'mdl', settings: { collider: 'bounds-box' } });
    const boxed = buildPhysicsModel(b.graph, b.definition).bodies.find((x) => x.unitIds.includes('mdl'))!;
    expect(boxed.colliders[0]!.approximation).toContain('bounding box');
    b.run('scene.node.delete', { nodeId: 'mdl' });
    expect(buildPhysicsModel(b.graph, b.definition).issues.some((i) => i.code === 'stale-setting')).toBe(
      true,
    );
  });
});
