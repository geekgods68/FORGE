import {
  createProject,
  defaultSimulationDefinition,
  type BodySettings,
  type SimulationDefinition,
} from '@forge/engineering-core';
import { ARM_JOINTS } from '@forge/mechanics';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildPhysicsModel,
  createRoboticArmSimulationSample,
  loadRapier,
  PhysicsSession,
  SceneBuilder,
  simulationOf,
  type Rapier,
} from '../index';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});
const at = new Date('2026-11-22T00:00:00Z');
const opts = { runId: 'test-run', now: () => at };

function armSession(patch: Partial<SimulationDefinition> = {}) {
  const p = createRoboticArmSimulationSample(at);
  const d = { ...simulationOf(p.scene)!, ...patch };
  return { p, d, s: new PhysicsSession(R, buildPhysicsModel(p.scene, d), opts) };
}
const body = (nodeId: string, patch: Partial<BodySettings>): BodySettings => ({
  nodeId,
  mode: 'dynamic',
  mass: { source: 'user', massKg: 1, note: 'test' },
  collider: 'auto',
  friction: 0.5,
  restitution: 0,
  linearDamping: 0,
  angularDamping: 0,
  ccd: false,
  linearVelocity: [0, 0, 0],
  angularVelocity: [0, 0, 0],
  contactLoadRatingN: null,
  ...patch,
});
function blockSession(def: Partial<SimulationDefinition>, size = 0.1, y = 1) {
  const b = new SceneBuilder(createProject('Blocks', at));
  for (const c of b.graph.nodes[b.graph.rootId]!.childIds) b.run('scene.node.delete', { nodeId: c });
  b.run('scene.node.create', {
    node: {
      kind: 'primitive',
      id: 'blk',
      name: 'Block',
      geometry: { shape: 'box', width: size, height: size, depth: size },
      transform: { position: [0, y, 0] },
    },
  });
  b.run('physics.simulation.create', {
    definition: { ...defaultSimulationDefinition(), bodies: [body('blk', {})], ...def },
  });
  return { b, s: PhysicsSession.fromScene(R, b.graph, b.definition, opts) };
}
const joint = (s: PhysicsSession, id: string) => s.jointStates().find((j) => j.mateId === id)!;

describe('simulation state is isolated from the CAD model', () => {
  it('running, forcing and resetting never touches the engineering project', () => {
    const p = createRoboticArmSimulationSample(at);
    const b = new SceneBuilder(p);
    const before = JSON.stringify(b.engine.getProject());
    const s = PhysicsSession.fromScene(R, b.graph, simulationOf(b.graph)!, opts);
    s.setMotorTarget({ mateId: ARM_JOINTS.shoulder, target: 0.6, source: 'test' });
    s.applyForce('gripper', [0, -1, 0], { durationS: 0.2 });
    s.runFor(1);
    expect(joint(s, ARM_JOINTS.shoulder).q).toBeGreaterThan(0.3);
    s.reset();
    expect(JSON.stringify(b.engine.getProject())).toBe(before);
    expect(b.engine.getHistory().canUndo).toBe(false);
  });

  it('reset restores the exact initial state, time 0, fresh telemetry; runs are deterministic', () => {
    const { s } = armSession();
    const pose0 = s.bodyPose('body-2');
    s.setMotorTarget({ mateId: ARM_JOINTS.elbow, target: -0.5, source: 'test' });
    s.runFor(1);
    const q1 = s.telemetry.series(`${ARM_JOINTS.elbow}.q`).v;
    s.reset();
    expect(s.time).toBe(0);
    expect(s.telemetry.size).toBe(1);
    expect(s.bodyPose('body-2')).toEqual(pose0);
    expect(joint(s, ARM_JOINTS.elbow).actuator!.target).toBeCloseTo(-Math.PI / 2, 12); // runtime command discarded
    s.setMotorTarget({ mateId: ARM_JOINTS.elbow, target: -0.5, source: 'test' });
    s.runFor(1);
    expect(Array.from(s.telemetry.series(`${ARM_JOINTS.elbow}.q`).v)).toEqual(Array.from(q1));
  });
});

describe('fixed-timestep scheduling', () => {
  it('runs whole fixed steps from real time, scaled by speed, with a bounded catch-up', () => {
    const { s } = blockSession({ ground: { enabled: false, heightM: 0, friction: 0.5, restitution: 0 } });
    expect(s.advance(1 / 60)).toBe(0); // not running
    s.run();
    expect(s.advance(1 / 60)).toBe(2); // 120 Hz physics at a 60 Hz display
    s.speed = 0.5;
    expect(s.advance(1 / 60) + s.advance(1 / 60)).toBe(2);
    s.speed = 1;
    expect(s.advance(0.25)).toBe(16); // capped at maxCatchUpSteps
    expect(s.stats.lagFrames).toBe(1);
    s.pause();
    expect(s.advance(1)).toBe(0);
    expect(s.step(3)).toBe(3); // explicit stepping works while paused
  });
});

describe('forces, torques and guards', () => {
  it('impulse–momentum: F·t = m·Δv for a free body; invalid loads are refused', () => {
    const { s } = blockSession({
      gravityEnabled: false,
      ground: { enabled: false, heightM: 0, friction: 0.5, restitution: 0 },
    });
    expect(s.applyForce('blk', [2, 0, 0], { durationS: 0.5 }).ok).toBe(true);
    s.runFor(1);
    const st = s.bodyState(s.model.bodyOfNode['blk']!)!;
    expect(st.linvel[0]).toBeCloseTo(1, 4); // 2 N × 0.5 s / 1 kg
    expect(s.applyForce('blk', [Number.NaN, 0, 0]).ok).toBe(false);
    expect(s.applyForce('blk', [1e7, 0, 0]).ok).toBe(false);
    expect(s.applyForce('nope', [1, 0, 0]).ok).toBe(false);
    expect(s.applyTorque('blk', [0, 0, 1], { durationS: -1 }).ok).toBe(false);
  });

  it('forces on a fixed body are refused', () => {
    const { s } = armSession();
    expect(s.applyForce('base-plate', [0, 1, 0])).toEqual({
      ok: false,
      error: 'Forces can only be applied to dynamic bodies.',
    });
  });

  it('a numerically unstable run is stopped safely and reset recovers', () => {
    const { s } = blockSession(
      {
        gravityEnabled: false,
        ground: { enabled: false, heightM: 0, friction: 0.5, restitution: 0 },
        bodies: [body('blk', { mass: { source: 'user', massKg: 1e-6, note: 'tiny' } })],
      },
      0.001,
    );
    s.applyTorque('blk', [1e5, 0, 0], { durationS: 1 });
    s.run();
    s.runFor(1);
    expect(s.state).toBe('faulted');
    expect(s.fault).toMatch(/instability|non-finite/);
    expect(s.telemetry.events.some((e) => e.severity === 'fault')).toBe(true);
    expect(s.step(10)).toBe(0);
    s.reset();
    expect(s.state).toBe('ready');
    expect(s.step(5)).toBe(5);
  });
});

describe('actuators, payload and emergency stop', () => {
  it('a heavier payload needs more shoulder effort; the change applies live', () => {
    const { s } = armSession();
    s.setMotorTarget({ mateId: ARM_JOINTS.shoulder, target: Math.PI / 4, source: 'test' });
    s.runFor(2);
    const light = Math.abs(joint(s, ARM_JOINTS.shoulder).actuator!.applied);
    expect(s.setPayloadMass('payload-ee', 0.1).ok).toBe(true);
    s.runFor(2);
    const heavy = Math.abs(joint(s, ARM_JOINTS.shoulder).actuator!.applied);
    expect(heavy).toBeGreaterThan(light + 0.05);
    expect(joint(s, ARM_JOINTS.shoulder).q).toBeCloseTo(Math.PI / 4, 2); // still holds (integral action)
    expect(s.setPayloadMass('payload-ee', -1).ok).toBe(false);
  });

  it('emergency stop removes all actuator effort; the arm then falls under gravity', () => {
    const { s } = armSession();
    s.runFor(0.5);
    const q0 = joint(s, ARM_JOINTS.shoulder).q;
    s.emergencyStop();
    s.runFor(0.5);
    expect(s.jointStates().every((j) => j.actuator!.applied === 0)).toBe(true);
    expect(Math.abs(joint(s, ARM_JOINTS.shoulder).q - q0)).toBeGreaterThan(0.05);
    expect(s.telemetry.events.some((e) => e.kind === 'emergency-stop')).toBe(true);
  });

  it('motor commands are validated and independent of their source', () => {
    const { s } = armSession();
    expect(s.setMotorTarget({ mateId: 'm-base-servo', target: 1, source: 'test' }).ok).toBe(false);
    expect(
      s.setMotorTarget({ mateId: ARM_JOINTS.yaw, target: Number.POSITIVE_INFINITY, source: 'test' }).ok,
    ).toBe(false);
    expect(
      s.setMotorTarget({ mateId: ARM_JOINTS.yaw, mode: 'velocity', targetVelocity: 1, source: 'electronics' })
        .ok,
    ).toBe(true);
    s.runFor(1);
    expect(joint(s, ARM_JOINTS.yaw).qd).toBeCloseTo(1, 1);
  });

  it('structural setup changes wait for a reset; live parameters apply immediately', () => {
    const { s, d } = armSession();
    s.updateDefinition({ ...d, gravity: [0, -1.62, 0] });
    expect(s.needsReset).toBe(false);
    expect(s.step(5)).toBe(5); // stepping continues after a live update (regression)
    const free = blockSession({ ground: { enabled: false, heightM: 0, friction: 0.5, restitution: 0 } });
    free.s.updateDefinition({ ...free.b.definition, gravityEnabled: false });
    free.s.runFor(0.5);
    expect(free.s.bodyState(free.s.model.bodies[0]!.id)!.linvel[1]).toBe(0); // gravity switched off live
    s.updateDefinition({ ...d, selfCollision: true });
    expect(s.needsReset).toBe(true);
  });
});

describe('diagnostics and overload warnings (threshold checks, not failure predictions)', () => {
  it('contact force above a threshold raises a contact-overload warning', () => {
    const { s } = blockSession(
      { thresholds: { maxAngularSpeed: 50, contactForceN: 20, limitTolerance: 0.01 } },
      0.1,
      0.3,
    );
    s.runFor(1);
    const e = s.telemetry.events.find((x) => x.kind === 'contact-overload');
    expect(e?.message).toContain('not a failure prediction');
  });

  it('excessive angular velocity is reported', () => {
    const { s } = blockSession({
      gravityEnabled: false,
      ground: { enabled: false, heightM: 0, friction: 0.5, restitution: 0 },
      bodies: [body('blk', { angularVelocity: [0, 80, 0] })],
    });
    s.step(2);
    expect(s.telemetry.events.some((e) => e.kind === 'excessive-angular-velocity')).toBe(true);
  });

  it('a non-converging solver configuration is detected (arm at 4 × 4 iterations)', () => {
    const { s, d } = armSession();
    s.reinitialize(createRoboticArmSimulationSample(at).scene, {
      ...d,
      solver: { ...d.solver, solverIterations: 4 },
    });
    s.setMotorTarget({ mateId: ARM_JOINTS.yaw, target: Math.PI / 2, source: 'test' });
    s.runFor(0.5);
    expect(s.telemetry.events.some((e) => e.kind === 'solver-convergence')).toBe(true);
    const good = armSession().s;
    good.setMotorTarget({ mateId: ARM_JOINTS.yaw, target: Math.PI / 2, source: 'test' });
    good.runFor(0.5);
    expect(good.telemetry.events.some((e) => e.kind === 'solver-convergence')).toBe(false);
  });

  it('sleeping is off by default and opt-in', () => {
    const { s } = blockSession({}, 0.1, 0.05);
    s.runFor(3);
    expect(s.bodyState(s.model.bodies[0]!.id)!.sleeping).toBe(false);
    const sl = blockSession({ allowSleeping: true }, 0.1, 0.05).s;
    sl.runFor(3);
    expect(sl.bodyState(sl.model.bodies[0]!.id)!.sleeping).toBe(true);
  });
});

describe('telemetry', () => {
  it('is bounded, and exports CSV and JSON with run metadata', () => {
    const { s } = armSession({ recording: { sampleRateHz: 120, maxSamples: 100 } });
    s.runFor(2);
    const t = s.telemetry;
    expect(t.size).toBe(100);
    expect(t.dropped).toBeGreaterThan(100);
    const meta = s.meta;
    expect(meta.engine.version).toBe(R.version());
    expect(meta.runId).toBe('test-run');
    const csv = t.toCSV(meta);
    expect(csv.split('\n')[4]).toContain('Shoulder joint applied effort [N·m] (applied)');
    expect(csv.split('\n').filter((l) => l && !l.startsWith('#')).length).toBe(101);
    const json = t.toJSON(meta);
    expect(json.format).toBe('forge-telemetry');
    expect(json.meta.solver.solverIterations).toBe(8);
    expect(json.t.length).toBe(100);
    expect(json.values[`${ARM_JOINTS.shoulder}.q`]!.length).toBe(100);
    expect(json.meta.assumptions.length).toBeGreaterThan(3);
    expect(t.bytes).toBe(100 * (t.channels.length + 1) * 8);
  });
});

describe('solver error handling', () => {
  it('an exception inside a step faults the session safely instead of escaping', () => {
    const { s } = armSession();
    const world = (s as unknown as { world: { step: () => void } }).world;
    const original = world.step.bind(world);
    world.step = () => {
      throw new Error('injected solver failure');
    };
    expect(s.step(3)).toBe(0);
    expect(s.state).toBe('faulted');
    expect(s.fault).toContain('injected solver failure');
    world.step = original;
    s.reset();
    expect(s.step(2)).toBe(2);
  });
});

describe('sensing queries (Phase 6)', () => {
  it('castRay returns the geometric distance to the first collider; moving a fixed body changes it', () => {
    // A fixed 10 cm block centred at (0, 0.05, 0.5): its near face is at z = 0.45.
    const { s } = blockSession(
      {
        ground: { enabled: false, heightM: 0, friction: 0.5, restitution: 0 },
        bodies: [body('blk', { mode: 'fixed' })],
      },
      0.1,
      0.05,
    );
    const id = s.model.bodyOfNode['blk']!;
    expect(s.setBodyTranslation(id, [0, 0.05, 0.5]).ok).toBe(true);
    const hit = s.castRay([0, 0.05, 0], [0, 0, 1], 4);
    expect(hit?.bodyId).toBe(id);
    expect(hit!.distance).toBeCloseTo(0.45, 6);
    expect(s.castRay([0, 0.05, 0], [0, 0, 1], 4, [id])).toBeNull(); // excluded body
    expect(s.castRay([0, 0.05, 0], [0, 0, -1], 4)).toBeNull(); // nothing behind
    s.setBodyTranslation(id, [0, 0.05, 0.8]);
    expect(s.castRay([0, 0.05, 0], [0, 0, 1], 4)!.distance).toBeCloseTo(0.75, 6);
    s.step(1);
    expect(s.castRay([0, 0.05, 0], [0, 0, 1], 4)!.distance).toBeCloseTo(0.75, 6);
    s.reset();
  });
});
