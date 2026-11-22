import {
  createProject,
  DEFAULT_SOLVER,
  defaultSimulationDefinition,
  worldMatrix,
  type BatchSubCommand,
  type BodySettings,
  type SimulationDefinition,
  type SolverSettings,
} from '@forge/engineering-core';
import { ARM_JOINTS } from '@forge/mechanics';
import { buildPhysicsModel } from './bridge';
import { createRoboticArmSimulationSample, SceneBuilder, simulationOf } from './samples';
import { PhysicsSession, type Rapier } from './session';

/**
 * Numerical reference cases (docs/PHYSICS_VALIDATION.md). Each case states its initial
 * conditions, timestep and solver settings, the reference (analytical or independently
 * established) result, the tolerance chosen BEFORE comparison, the measured value and the
 * error. Tolerances describe what the solver is expected to achieve — they are not machine
 * precision, and passing them does not make the model "verified" for other questions.
 */
export interface ValidationResult {
  id: string;
  title: string;
  category: 'gravity' | 'conservation' | 'pendulum' | 'rotation' | 'joint' | 'contact' | 'arm';
  conditions: string;
  solver: SolverSettings;
  reference: string;
  metrics: {
    name: string;
    reference: number;
    measured: number;
    error: number;
    tolerance: number;
    unit: string;
    relative: boolean;
    pass: boolean;
  }[];
  pass: boolean;
}

const G = 9.80665;
const metric = (
  name: string,
  reference: number,
  measured: number,
  tolerance: number,
  unit: string,
  relative = false,
) => {
  const error = relative
    ? Math.abs(measured - reference) / Math.abs(reference)
    : Math.abs(measured - reference);
  return {
    name,
    reference,
    measured,
    error,
    tolerance,
    unit,
    relative,
    pass: Number.isFinite(measured) && error <= tolerance,
  };
};
const bound = (name: string, measured: number, limit: number, unit: string) => ({
  name,
  reference: 0,
  measured,
  error: Math.abs(measured),
  tolerance: limit,
  unit,
  relative: false,
  pass: Number.isFinite(measured) && Math.abs(measured) <= limit,
});
const result = (r: Omit<ValidationResult, 'pass'>): ValidationResult => ({
  ...r,
  pass: r.metrics.every((m) => m.pass),
});

const body = (nodeId: string, patch: Partial<BodySettings>): BodySettings => ({
  nodeId,
  mode: 'auto',
  mass: { source: 'model' },
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

function freshScene(): SceneBuilder {
  const p = createProject('Validation', new Date('2026-11-22T00:00:00Z'));
  const b = new SceneBuilder(p);
  const root = p.scene.nodes[p.scene.rootId]!;
  for (const c of root.childIds) b.run('scene.node.delete', { nodeId: c });
  return b;
}

const prim = (
  id: string,
  geometry: Record<string, unknown>,
  position: [number, number, number],
  parentId?: string,
): BatchSubCommand => ({
  type: 'scene.node.create',
  payload: {
    node: {
      kind: 'primitive',
      id,
      name: id,
      geometry,
      transform: { position },
      ...(parentId ? { parentId } : {}),
    },
  } as never,
});

function session(R: Rapier, b: SceneBuilder, d: SimulationDefinition) {
  b.run('physics.simulation.create', { definition: d });
  const s = PhysicsSession.fromScene(R, b.graph, b.definition, {
    runId: 'validation',
    now: () => new Date('2026-11-22T00:00:00Z'),
  });
  if (!s.ok) throw new Error(s.model.issues.map((i) => i.message).join('; '));
  return s;
}

function def(patch: Partial<SimulationDefinition> = {}): SimulationDefinition {
  return {
    ...defaultSimulationDefinition('Validation'),
    ground: { enabled: false, heightM: 0, friction: 0.5, restitution: 0 },
    ...patch,
  };
}

// -- cases --------------------------------------------------------------------------------

export function freeFall(R: Rapier): ValidationResult {
  const b = freshScene();
  b.batch([prim('ball', { shape: 'sphere', radius: 0.05 }, [0, 10, 0])]);
  const s = session(
    R,
    b,
    def({
      bodies: [body('ball', { mode: 'dynamic', mass: { source: 'user', massKg: 1, note: 'test mass' } })],
    }),
  );
  const T = 1;
  s.runFor(T);
  const st = s.bodyState(s.model.bodyOfNode['ball']!)!;
  const h = DEFAULT_SOLVER.timestepS / DEFAULT_SOLVER.substeps / DEFAULT_SOLVER.solverIterations;
  return result({
    id: 'gravity-free-fall',
    title: 'Free fall under constant gravity',
    category: 'gravity',
    conditions: `Sphere r = 0.05 m, m = 1 kg, released from rest at y = 10 m; g = ${G} m/s²; no contact, no damping; t = ${T} s.`,
    solver: { ...DEFAULT_SOLVER },
    reference: `y(t) = y₀ − ½gt², v(t) = −gt (analytic). Expected integration error of the sub-stepped semi-implicit Euler scheme ≈ g·t·h_eff/2 = ${((G * T * h) / 2).toExponential(2)} m with h_eff = Δt/(substeps·iterations).`,
    metrics: [
      metric('height at t = 1 s', 10 - 0.5 * G * T * T, st.position[1], 5e-3, 'm'),
      metric('vertical velocity at t = 1 s', -G * T, st.linvel[1], 1e-4, '', true),
    ],
  });
}

export function rotationalDynamics(R: Rapier): ValidationResult {
  const b = freshScene();
  const [a, h, c] = [0.2, 0.1, 0.05];
  b.batch([prim('slab', { shape: 'box', width: a, height: h, depth: c }, [0, 1, 0])]);
  const m = 2;
  const s = session(
    R,
    b,
    def({
      gravityEnabled: false,
      bodies: [body('slab', { mode: 'dynamic', mass: { source: 'user', massKg: m, note: 'test mass' } })],
    }),
  );
  const Iyy = (m * (a * a + c * c)) / 12;
  const tau = 0.01;
  const T = 1;
  const model = s.model.bodies[0]!;
  s.applyTorque('slab', [0, tau, 0], { durationS: T });
  s.runFor(T);
  const st = s.bodyState(model.id)!;
  const theta = 2 * Math.atan2(st.rotation[1], st.rotation[3]);
  return result({
    id: 'rotation-torque',
    title: 'Known torque on a body of known inertia',
    category: 'rotation',
    conditions: `Box ${a}×${h}×${c} m, m = ${m} kg (uniform), no gravity; torque ${tau} N·m about +Y (a principal axis) for ${T} s.`,
    solver: { ...DEFAULT_SOLVER },
    reference: `I_yy = m(a² + c²)/12 = ${Iyy.toExponential(5)} kg·m² (closed form); α = τ/I; ω(t) = αt; θ(t) = ½αt².`,
    metrics: [
      metric('bridge inertia I_yy', Iyy, model.mass!.inertia[4], 1e-12, '', true),
      metric('angular velocity at t = 1 s', (tau * T) / Iyy, st.angvel[1], 5e-3, '', true),
      metric('rotation angle at t = 1 s', (0.5 * tau * T * T) / Iyy, theta, 5e-3, '', true),
    ],
  });
}

/** Pendulum: fixed pivot, bob of radius r on a massless link of length L (revolute joint). */
function pendulumScene(R: Rapier, L: number, r: number, theta0: number, damping = 0) {
  const b = freshScene();
  b.batch([
    { type: 'assembly.create', payload: { id: 'pend', name: 'Pendulum', nodeIds: [] } },
    prim('pivot', { shape: 'box', width: 0.02, height: 0.02, depth: 0.02 }, [0, 2, 0], 'pend'),
    prim('bob', { shape: 'sphere', radius: r }, [0, 2 - L, 0], 'pend'),
    { type: 'assembly.ground', payload: { assemblyId: 'pend', nodeId: 'pivot', grounded: true } },
    {
      type: 'assembly.mate.create',
      payload: {
        assemblyId: 'pend',
        mate: {
          id: 'hinge',
          name: 'Hinge',
          type: 'revolute',
          alignment: 'aligned',
          a: { nodeId: 'pivot', ref: { kind: 'frame', origin: [0, 0, 0], axis: [0, 0, 1], xRef: [1, 0, 0] } },
          b: { nodeId: 'bob', ref: { kind: 'frame', origin: [0, L, 0], axis: [0, 0, 1], xRef: [1, 0, 0] } },
        },
      },
    },
    {
      type: 'assembly.joint.setPosition',
      payload: { assemblyId: 'pend', mateId: 'hinge', coordinates: [theta0] },
    },
  ]);
  const s = session(
    R,
    b,
    def({
      bodies: [
        body('bob', { collider: 'none', mass: { source: 'user', massKg: 1, note: 'test mass' } }),
        body('pivot', { collider: 'none' }),
      ],
      joints: damping ? [{ mateId: 'hinge', damping, friction: 0, actuator: null }] : [],
      recording: { sampleRateHz: 1000, maxSamples: 200_000 },
    }),
  );
  return s;
}

function zeroCrossings(t: Float64Array, v: Float64Array): number[] {
  const out: number[] = [];
  for (let i = 1; i < v.length; i++)
    if (v[i - 1]! < 0 && v[i]! >= 0)
      out.push(t[i - 1]! + ((t[i]! - t[i - 1]!) * -v[i - 1]!) / (v[i]! - v[i - 1]!));
  return out;
}

export function pendulumPeriod(R: Rapier): ValidationResult {
  const L = 1;
  const r = 0.02;
  const theta0 = (3 * Math.PI) / 180;
  const s = pendulumScene(R, L, r, theta0);
  s.runFor(12);
  const q = s.telemetry.series('hinge.q');
  const z = zeroCrossings(q.t, q.v);
  const periods = z.slice(1).map((x, i) => x - z[i]!);
  const measured = periods.reduce((a, b) => a + b, 0) / periods.length;
  const Ip = 0.4 * r * r + L * L; // per unit mass, about the pivot
  const T0 = 2 * Math.PI * Math.sqrt(Ip / (G * L));
  const ref = T0 * (1 + (theta0 * theta0) / 16);
  const drift = Math.max(...s.telemetry.series('hinge.drift').v);
  return result({
    id: 'pendulum-period',
    title: 'Small-angle pendulum period',
    category: 'pendulum',
    conditions: `Bob: sphere r = ${r} m, m = 1 kg on a massless link L = ${L} m (revolute joint to a fixed pivot); θ₀ = 3°, released from rest; ${periods.length} periods measured from upward zero crossings (1 kHz telemetry, interpolated).`,
    solver: { ...DEFAULT_SOLVER },
    reference: `Physical pendulum T = 2π√(I_p/(m g L)) with I_p = m(L² + 2r²/5), finite-amplitude correction × (1 + θ₀²/16): ${ref.toFixed(6)} s.`,
    metrics: [metric('period', ref, measured, 5e-3, '', true), bound('max joint drift', drift, 1e-4, 'm')],
  });
}

export function revoluteUnderGravity(R: Rapier): ValidationResult {
  const L = 0.5;
  const s = pendulumScene(R, L, 0.03, Math.PI / 3);
  const energy = () => {
    const st = s.bodyState(s.model.bodies.find((b) => b.mode === 'dynamic')!.id)!;
    const v2 = st.linvel[0] ** 2 + st.linvel[1] ** 2 + st.linvel[2] ** 2;
    const w2 = st.angvel[2] ** 2;
    return 0.5 * v2 + 0.5 * 0.4 * 0.03 * 0.03 * w2 + G * st.com![1];
  };
  const e0 = energy();
  s.runFor(5);
  const drift = Math.max(...s.telemetry.series('hinge.drift').v);
  const e1 = energy();
  const swing = Math.max(...s.telemetry.series('hinge.q').v.map(Math.abs));
  return result({
    id: 'revolute-gravity',
    title: 'Revolute joint under gravity (large swing)',
    category: 'joint',
    conditions: `Pendulum L = ${L} m, bob sphere r = 0.03 m, m = 1 kg, θ₀ = 60°, no damping, 5 s.`,
    solver: { ...DEFAULT_SOLVER },
    reference:
      'Ideal revolute joint: anchors coincide (drift 0) and, without damping, mechanical energy is conserved; the amplitude cannot exceed θ₀.',
    metrics: [
      bound('max anchor drift', drift, 1e-4, 'm'),
      metric('mechanical energy after 5 s (per kg)', e0, e1, 0.02, '', true),
      bound('amplitude above θ₀', Math.max(0, swing - Math.PI / 3), 0.01, 'rad'),
    ],
  });
}

function collision(R: Rapier, e: number) {
  const b = freshScene();
  b.batch([
    prim('a', { shape: 'sphere', radius: 0.05 }, [0, 1, 0]),
    prim('b', { shape: 'sphere', radius: 0.05 }, [0.3, 1, 0]),
  ]);
  const s = session(
    R,
    b,
    def({
      gravityEnabled: false,
      bodies: [
        body('a', {
          mode: 'dynamic',
          restitution: e,
          friction: 0,
          mass: { source: 'user', massKg: 1, note: 'test' },
          linearVelocity: [1, 0, 0],
        }),
        body('b', {
          mode: 'dynamic',
          restitution: e,
          friction: 0,
          mass: { source: 'user', massKg: 2, note: 'test' },
        }),
      ],
    }),
  );
  s.runFor(1);
  const va = s.bodyState(s.model.bodyOfNode['a']!)!.linvel[0];
  const vb = s.bodyState(s.model.bodyOfNode['b']!)!.linvel[0];
  return { va, vb };
}

export function momentumConservation(R: Rapier): ValidationResult {
  const el = collision(R, 1);
  const pl = collision(R, 0);
  const p0 = 1;
  const ke0 = 0.5;
  return result({
    id: 'collision-momentum',
    title: 'Head-on collision: momentum and energy',
    category: 'conservation',
    conditions:
      'Spheres r = 0.05 m; A: 1 kg at +1 m/s, B: 2 kg at rest; no gravity, no friction; restitution 1 (elastic) and 0 (plastic) runs; 1 s.',
    solver: { ...DEFAULT_SOLVER },
    reference:
      'Momentum conserved in both runs (1 kg·m/s). Elastic: v_A = −1/3, v_B = 2/3 m/s, KE conserved. Plastic: common velocity 1/3 m/s, KE ratio 1/3.',
    metrics: [
      metric('momentum (elastic)', p0, el.va + 2 * el.vb, 5e-3, '', true),
      metric('momentum (plastic)', p0, pl.va + 2 * pl.vb, 5e-3, '', true),
      metric('v_B (elastic)', 2 / 3, el.vb, 0.05, '', true),
      metric('kinetic energy (elastic)', ke0, 0.5 * el.va ** 2 + el.vb ** 2, 0.05, '', true),
      metric('kinetic energy (plastic)', ke0 / 3, 0.5 * pl.va ** 2 + pl.vb ** 2, 0.05, '', true),
    ],
  });
}

export function restingContact(R: Rapier): ValidationResult {
  const b = freshScene();
  b.batch([prim('block', { shape: 'box', width: 0.1, height: 0.1, depth: 0.1 }, [0, 0.05, 0])]);
  const s = session(
    R,
    b,
    def({
      ground: { enabled: true, heightM: 0, friction: 0.5, restitution: 0 },
      bodies: [body('block', { mode: 'dynamic', mass: { source: 'material', materialId: 'steel-1018' } })],
    }),
  );
  const id = s.model.bodies[0]!.id;
  const m = s.model.bodies[0]!.mass!.massKg;
  s.runFor(2);
  const st = s.bodyState(id)!;
  const impulse = st.contacts.reduce((a, c) => a + c.normalImpulse, 0);
  const normalForce = impulse / s.substepDt;
  const raw = normalForce / s.contactForceScale;
  return result({
    id: 'contact-resting',
    title: 'Block resting on the work surface',
    category: 'contact',
    conditions: `Steel cube 0.1 m (volume × handbook density = ${m.toFixed(3)} kg) placed on the static surface y = 0; gravity on; 2 s.`,
    solver: { ...DEFAULT_SOLVER },
    reference: 'Static equilibrium: no motion; total contact normal force = m·g.',
    metrics: [
      bound('settling displacement', st.position[1] - 0.05, 1e-3, 'm'),
      bound('residual speed', Math.hypot(...st.linvel), 1e-3, 'm/s'),
      metric('contact normal force (corrected N/(N+1))', m * G, normalForce, 0.02, '', true),
      {
        ...metric('raw solver-reported contact force', m * G, raw, 1, '', true),
        name: `raw solver-reported contact force (bias, informational; expected (N+1)/N = ${((s.definition.solver.solverIterations + 1) / s.definition.solver.solverIterations).toFixed(4)})`,
      },
    ],
  });
}

export function slidingFriction(R: Rapier): ValidationResult {
  const b = freshScene();
  b.batch([prim('slider', { shape: 'box', width: 0.2, height: 0.04, depth: 0.2 }, [0, 0.02, 0])]);
  const mu = 0.3;
  const v0 = 2;
  const s = session(
    R,
    b,
    def({
      ground: { enabled: true, heightM: 0, friction: mu, restitution: 0 },
      bodies: [
        body('slider', {
          mode: 'dynamic',
          friction: mu,
          mass: { source: 'user', massKg: 1, note: 'test' },
          linearVelocity: [v0, 0, 0],
        }),
      ],
      recording: { sampleRateHz: 240, maxSamples: 20_000 },
    }),
  );
  const id = s.model.bodies[0]!.id;
  s.runFor(1.5);
  const st = s.bodyState(id)!;
  const vx = s.telemetry.series(`${id}.vx`);
  let tStop = Number.NaN;
  for (let i = 0; i < vx.v.length; i++)
    if (vx.v[i]! < 1e-3) {
      tStop = vx.t[i]!;
      break;
    }
  return result({
    id: 'contact-sliding-friction',
    title: 'Sliding block decelerated by Coulomb friction',
    category: 'contact',
    conditions: `Box 0.2 × 0.04 × 0.2 m, 1 kg, on the surface with μ = ${mu} (both surfaces; Rapier averages), initial speed ${v0} m/s, 1.5 s.`,
    solver: { ...DEFAULT_SOLVER },
    reference: `Constant deceleration μg: stopping distance v₀²/(2μg) = ${((v0 * v0) / (2 * mu * G)).toFixed(4)} m, stopping time v₀/(μg) = ${(v0 / (mu * G)).toFixed(4)} s.`,
    metrics: [
      metric('stopping distance', (v0 * v0) / (2 * mu * G), st.position[0], 0.03, '', true),
      metric('stopping time', v0 / (mu * G), tStop, 0.03, '', true),
    ],
  });
}

/** Rigid-arm reference: simulated poses agree with the Phase 4 kinematic solver. */
export function armKinematicReference(R: Rapier): ValidationResult {
  const p = createRoboticArmSimulationSample(new Date('2026-11-22T00:00:00Z'));
  const d = simulationOf(p.scene)!;
  const s = new PhysicsSession(R, buildPhysicsModel(p.scene, { ...d, gravityEnabled: false }));
  // 1. t = 0: every simulated body unit is exactly at its CAD pose (single-precision storage).
  let pos0 = 0;
  let rot0 = 0;
  for (const b of s.model.bodies)
    for (const u of b.unitIds) {
      const M = s.unitWorldMatrix(u)!;
      const W = worldMatrix(p.scene, u);
      pos0 = Math.max(pos0, Math.hypot(M[12]! - W[12]!, M[13]! - W[13]!, M[14]! - W[14]!));
      for (let k = 0; k < 11; k++) if (k % 4 !== 3) rot0 = Math.max(rot0, Math.abs(M[k]! - W[k]!));
    }
  // 2. Drive the shoulder to 30° and the elbow to −60° (no gravity) and compare with the solver's pose.
  const target = { [ARM_JOINTS.shoulder]: Math.PI / 6, [ARM_JOINTS.elbow]: -Math.PI / 3 };
  for (const [mateId, t] of Object.entries(target)) s.setMotorTarget({ mateId, target: t, source: 'test' });
  s.runFor(3);
  const b = new SceneBuilder(p);
  for (const [mateId, t] of Object.entries(target))
    b.run('assembly.joint.setPosition', { assemblyId: 'grp-arm', mateId, coordinates: [t] });
  const Mg = s.unitWorldMatrix('gripper')!;
  const Wg = worldMatrix(b.graph, 'gripper');
  const posErr = Math.hypot(Mg[12]! - Wg[12]!, Mg[13]! - Wg[13]!, Mg[14]! - Wg[14]!);
  let rotErr = 0;
  for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) rotErr = Math.max(rotErr, Math.abs(Mg[k]! - Wg[k]!));
  const js = s.jointStates();
  const q = (id: string) => js.find((j) => j.mateId === id)!.q;
  return result({
    id: 'arm-kinematic-reference',
    title: 'Robotic arm: simulated poses vs the Phase 4 kinematic solver',
    category: 'arm',
    conditions:
      'VEYRIS arm sample with its simulation setup, gravity off. (1) At t = 0, every body unit; (2) after driving shoulder → 30°, elbow → −60° for 3 s, the gripper pose.',
    solver: { ...d.solver },
    reference:
      'Assembly solver (Phase 4, residual ≤ 1e-7) world matrices at the same joint coordinates; measured joint coordinates equal the commanded targets.',
    metrics: [
      bound('t = 0 position error (all units)', pos0, 1e-6, 'm'),
      bound('t = 0 rotation-matrix error', rot0, 1e-6, ''),
      metric(
        'shoulder angle after drive',
        target[ARM_JOINTS.shoulder]!,
        q(ARM_JOINTS.shoulder),
        0.002,
        'rad',
      ),
      metric('elbow angle after drive', target[ARM_JOINTS.elbow]!, q(ARM_JOINTS.elbow), 0.002, 'rad'),
      bound('gripper position vs solver', posErr, 5e-4, 'm'),
      bound('gripper rotation vs solver', rotErr, 5e-3, ''),
    ],
  });
}

/** Arm actuators: speed limit, joint limit and effort saturation under gravity. */
export function armActuatorLimits(R: Rapier): ValidationResult {
  const p = createRoboticArmSimulationSample(new Date('2026-11-22T00:00:00Z'));
  const d = simulationOf(p.scene)!;
  // (a) Speed: a large yaw move (axis vertical: no gravity torque).
  const s = new PhysicsSession(R, buildPhysicsModel(p.scene, d));
  s.setMotorTarget({ mateId: ARM_JOINTS.yaw, target: Math.PI / 2, source: 'test' });
  let maxSpeed = 0;
  for (let i = 0; i < 240; i++) {
    s.step();
    maxSpeed = Math.max(maxSpeed, Math.abs(s.jointStates().find((j) => j.mateId === ARM_JOINTS.yaw)!.qd));
  }
  const speedLimit = s.jointStates().find((j) => j.mateId === ARM_JOINTS.yaw)!.actuator!.speedLimit;
  // (b) Limit: wrist pushed past +90° with full effort; the joint limit holds.
  s.setMotorTarget({ mateId: ARM_JOINTS.wrist, mode: 'effort', targetEffort: 1, source: 'test' });
  s.runFor(1.5);
  const wrist = s.jointStates().find((j) => j.mateId === ARM_JOINTS.wrist)!;
  // (c) Saturation: 1 kg payload, shoulder commanded to 60°: gravity torque > stall torque.
  const heavy = { ...d, payloads: d.payloads.map((x) => ({ ...x, massKg: 1 })) };
  const h = new PhysicsSession(R, buildPhysicsModel(p.scene, heavy));
  h.setMotorTarget({ mateId: ARM_JOINTS.shoulder, target: Math.PI / 3, source: 'test' });
  let maxApplied = 0;
  for (let i = 0; i < 360; i++) {
    h.step();
    const j = h.jointStates().find((x) => x.mateId === ARM_JOINTS.shoulder)!;
    maxApplied = Math.max(maxApplied, Math.abs(j.actuator!.applied));
  }
  const sh = h.jointStates().find((x) => x.mateId === ARM_JOINTS.shoulder)!;
  const saturatedEvent = h.telemetry.events.some(
    (e) => e.kind === 'effort-limit' && e.refs.includes(ARM_JOINTS.shoulder),
  );
  return result({
    id: 'arm-actuator-limits',
    title: 'Robotic arm: speed limit, joint limit and effort saturation',
    category: 'arm',
    conditions:
      '(a) yaw commanded 0 → 90° (vertical axis); (b) wrist driven in effort mode at +1 N·m (above its 0.177 N·m cited limit) into its +90° limit for 1.5 s; (c) 1 kg payload on the gripper, shoulder commanded to 60° for 3 s.',
    solver: { ...d.solver },
    reference:
      'Generic servo model: speed ≤ no-load speed (torque–speed envelope); applied effort ≤ effort limit always; joint stays within limit ± tolerance; a load above stall torque saturates the actuator and the target is not reached.',
    metrics: [
      bound('yaw speed above the no-load limit', Math.max(0, maxSpeed - speedLimit * 1.02), 0, 'rad/s'),
      bound(
        'wrist beyond +90° limit',
        Math.max(0, wrist.q - Math.PI / 2),
        d.thresholds.limitTolerance,
        'rad',
      ),
      bound(
        'wrist applied effort above its limit',
        Math.max(0, Math.abs(wrist.actuator!.applied) - wrist.actuator!.effortLimit),
        1e-12,
        'N·m',
      ),
      bound(
        'shoulder applied effort above its limit',
        Math.max(0, maxApplied - sh.actuator!.effortLimit),
        1e-12,
        'N·m',
      ),
      {
        ...bound('shoulder saturated (1 = yes)', saturatedEvent ? 0 : 1, 0, ''),
        name: 'effort-limit warning raised (0 = yes)',
      },
      {
        ...bound('shoulder short of its target (stall)', Math.max(0, 0.05 - (Math.PI / 3 - sh.q)), 0, 'rad'),
        name: 'shoulder stalls ≥ 0.05 rad short of 60°',
      },
    ],
  });
}

export const VALIDATION_CASES = [
  freeFall,
  rotationalDynamics,
  pendulumPeriod,
  revoluteUnderGravity,
  momentumConservation,
  restingContact,
  slidingFriction,
  armKinematicReference,
  armActuatorLimits,
] as const;

export function runValidationSuite(R: Rapier): ValidationResult[] {
  return VALIDATION_CASES.map((c) => c(R));
}
