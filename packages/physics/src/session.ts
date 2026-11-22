import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Collider, EventQueue, ImpulseJoint, RigidBody, World } from '@dimforge/rapier3d-compat';
import type { Actuator, Mat4, SimulationDefinition } from '@forge/engineering-core';
import { compose, multiply } from '@forge/engineering-core';
import {
  actuatorStep,
  controllerStabilityProblem,
  gainsFor,
  initialActuatorState,
  passiveEffort,
  type ActuatorState,
  type Gains,
  type MotorCommand,
} from './actuator';
import {
  buildPhysicsModel,
  effectiveInertia,
  massWithPayloads,
  type ModelBody,
  type ModelJoint,
  type PhysicsModel,
} from './bridge';
import { eigenSym3, quatFromMat3, type V3 } from './mass';
import { TelemetryRecorder, type Channel, type RunMetadata, type SimEvent } from './telemetry';

export type Rapier = typeof RAPIER_NS;
type Quat = [number, number, number, number];

let rapierPromise: Promise<Rapier> | null = null;
/** Load and initialise Rapier once (WASM is embedded in the compat build; no network). */
export function loadRapier(): Promise<Rapier> {
  rapierPromise ??= import('@dimforge/rapier3d-compat').then(async (m) => {
    const R = (m as unknown as { default?: Rapier }).default ?? (m as unknown as Rapier);
    await R.init();
    return R;
  });
  return rapierPromise;
}

export type SessionState = 'ready' | 'running' | 'paused' | 'faulted';

export interface BodyState {
  id: string;
  name: string;
  mode: ModelBody['mode'];
  unitIds: string[];
  position: V3;
  rotation: Quat;
  linvel: V3;
  angvel: V3;
  sleeping: boolean;
  massKg: number | null;
  /** World centre of mass (m). */
  com: V3 | null;
  /** Principal moments (kg·m²), body frame. */
  inertia: V3 | null;
  /** External (user) force/torque and actuator reaction currently applied, world frame. */
  force: V3;
  torque: V3;
  /** Contacting bodies: points and the (corrected) normal impulse of the last sub-step (N·s). */
  contacts: { bodyId: string; points: number; normalImpulse: number }[];
}

export interface JointState {
  mateId: string;
  name: string;
  mapping: ModelJoint['mapping'];
  unit: 'rad' | 'm';
  /** Primary coordinate (rad or m) and its rate — measured from the simulated bodies. */
  q: number;
  qd: number;
  limits: ModelJoint['limits'];
  atLimit: 'min' | 'max' | null;
  /** Constraint drift measured from the body poses: anchor separation (m) and axis misalignment (rad). */
  driftPos: number;
  driftAng: number;
  actuator: null | {
    enabled: boolean;
    mode: Actuator['mode'];
    target: number;
    targetVelocity: number;
    targetEffort: number;
    setpoint: number;
    command: number;
    applied: number;
    saturated: boolean;
    effortLimit: number;
    speedLimit: number;
    ratedEffort: number | null;
    gains: Gains;
    inertia: number;
    source: Actuator['source'];
  };
  passive: number;
}

export interface SessionStats {
  lastStepMs: number;
  meanStepMs: number;
  maxStepMs: number;
  fixedSteps: number;
  /** Displayed frames that needed more catch-up steps than allowed (simulation slower than real time). */
  lagFrames: number;
  contactPairs: number;
}

export interface SessionOptions {
  runId?: string;
  now?: () => Date;
  project?: { id: string; name: string; revision: number };
}

interface JointRuntime {
  m: ModelJoint;
  rA: RigidBody;
  rB: RigidBody;
  joint: ImpulseJoint;
  actuator: Actuator | null;
  gains: Gains;
  inertia: number;
  state: ActuatorState | null;
  q: number;
  qd: number;
  lastAngle: number;
  passive: number;
  controlEvery: number;
  counter: number;
  driftPos: number;
  driftAng: number;
  /** Axial anchor offset at t = 0 (prismatic zero reference). */
  d0: number;
  /** Solver-convergence diagnostic: previous step's coordinate/rate and a mismatch counter. */
  prevQ: number;
  prevQd: number;
  mismatch: number;
  convergenceWarned: boolean;
  /** Whether this run's telemetry has actuator channels for the joint (fixed at build). */
  channels: boolean;
  flags: { sat: boolean; rated: boolean; atLimit: boolean; violation: boolean; satSince: number };
}

interface ExternalLoad {
  bodyId: string;
  force: V3 | null;
  torque: V3 | null;
  point: V3 | null;
  remaining: number;
}

// -- small quaternion/vector helpers ------------------------------------------------------
const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
function qrot(q: Quat, v: V3): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const addV = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subV = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scaleV = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const lenV = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const vec = (v: { x: number; y: number; z: number }): V3 => [v.x, v.y, v.z];
const quat = (r: { x: number; y: number; z: number; w: number }): Quat => [r.x, r.y, r.z, r.w];
const xyz = (v: V3) => ({ x: v[0], y: v[1], z: v[2] });
const wrapPi = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));

/** Limits on user-applied loads and on what counts as a numerically sane state. */
export const GUARDS = {
  maxForceN: 1e6,
  maxTorqueNm: 1e5,
  maxSpeed: 1e3,
  maxAngularSpeed: 1e5,
  maxDistance: 1e4,
};

/**
 * A running physics experiment: an isolated Rapier world built from a PhysicsModel.
 * It never writes to the engineering project: the CAD scene is read once (by the bridge)
 * and simulated poses are exposed for DISPLAY only. Runtime operations (step, run, pause,
 * reset, forces, motor targets) are not engine commands and never enter the undo history.
 */
export class PhysicsSession {
  readonly R: Rapier;
  model: PhysicsModel;
  /** Live copy of the definition (runtime motor targets modify this copy only). */
  definition: SimulationDefinition;
  state: SessionState = 'ready';
  time = 0;
  steps = 0;
  speed = 1;
  stopped = false;
  fault: string | null = null;
  needsReset = false;
  telemetry!: TelemetryRecorder;
  meta!: RunMetadata;
  readonly stats: SessionStats = {
    lastStepMs: 0,
    meanStepMs: 0,
    maxStepMs: 0,
    fixedSteps: 0,
    lagFrames: 0,
    contactPairs: 0,
  };

  private world!: World;
  private queue!: EventQueue;
  private bodies = new Map<string, RigidBody>();
  private colliderBody = new Map<number, string>();
  private joints: JointRuntime[] = [];
  private loads: ExternalLoad[] = [];
  private acc = 0;
  private nextSample = 0;
  private excluded = new Set<string>();
  private contactCooldown = new Map<string, number>();
  private bodyFlags = new Map<string, { spin: boolean }>();
  private applied = new Map<string, { f: V3; t: V3 }>();
  private stepTotalMs = 0;
  private payloadMass = new Map<string, number>();
  private readonly opts: SessionOptions;
  private structural: string;

  constructor(R: Rapier, model: PhysicsModel, opts: SessionOptions = {}) {
    this.R = R;
    this.model = model;
    this.opts = opts;
    this.definition = clone(model.definition);
    this.structural = structuralKey(model.definition);
    if (!model.ok) {
      this.state = 'faulted';
      this.fault = model.issues
        .filter((i) => i.severity === 'error')
        .map((i) => i.message)
        .join(' ');
    }
    this.build();
  }

  /** Create from the engineering scene in one call (validated by the bridge). */
  static fromScene(
    R: Rapier,
    graph: Parameters<typeof buildPhysicsModel>[0],
    definition: SimulationDefinition,
    opts?: SessionOptions,
  ) {
    return new PhysicsSession(R, buildPhysicsModel(graph, definition), opts);
  }

  get ok(): boolean {
    return this.model.ok;
  }
  get rapierVersion(): string {
    return this.R.version();
  }
  /**
   * Rapier reports contact impulses accumulated over its N solver iterations plus one
   * stabilisation pass: in static equilibrium the reported force is (N + 1)/N × m·g
   * (measured for N = 4, 8, 16; docs/PHYSICS_VALIDATION.md). Contact forces used by FORGE
   * are scaled by N/(N + 1) — an empirical, documented correction (approximate).
   */
  get contactForceScale(): number {
    const n = this.definition.solver.solverIterations;
    return n / (n + 1);
  }
  get substepDt(): number {
    return this.definition.solver.timestepS / this.definition.solver.substeps;
  }

  // -- construction -------------------------------------------------------------------
  private build(): void {
    const R = this.R;
    const d = this.definition;
    this.world?.free();
    this.queue?.free();
    this.bodies.clear();
    this.colliderBody.clear();
    this.joints = [];
    this.loads = [];
    this.applied.clear();
    this.excluded.clear();
    this.contactCooldown.clear();
    this.bodyFlags.clear();
    this.time = 0;
    this.steps = 0;
    this.acc = 0;
    this.nextSample = 0;
    for (const p of this.model.payloads)
      if (!this.payloadMass.has(p.id)) this.payloadMass.set(p.id, p.massKg);
    this.world = new R.World(this.gravityVector());
    this.world.timestep = this.substepDt;
    this.world.numSolverIterations = d.solver.solverIterations;
    this.world.integrationParameters.lengthUnit = d.solver.lengthUnitM;
    this.queue = new R.EventQueue(true);
    if (!this.model.ok) {
      this.initTelemetry();
      return;
    }

    for (const b of this.model.bodies) {
      const desc =
        b.mode === 'dynamic'
          ? R.RigidBodyDesc.dynamic()
          : b.mode === 'kinematic'
            ? R.RigidBodyDesc.kinematicVelocityBased()
            : R.RigidBodyDesc.fixed();
      desc.setTranslation(b.origin[0], b.origin[1], b.origin[2]);
      if (b.mode !== 'fixed') {
        desc.setLinvel(...b.settings.linearVelocity);
        desc.setAngvel(xyz(b.settings.angularVelocity));
      }
      if (b.mode === 'dynamic') {
        desc.setCanSleep(d.allowSleeping);
        desc.setLinearDamping(b.settings.linearDamping).setAngularDamping(b.settings.angularDamping);
        desc.setCcdEnabled(b.settings.ccd);
        const mp = this.massOf(b);
        if (mp) {
          const p = principal(mp.inertia);
          desc.setAdditionalMassProperties(mp.massKg, xyz(mp.com), xyz(p.values), p.frame);
        }
      }
      const rb = this.world.createRigidBody(desc);
      this.bodies.set(b.id, rb);
      this.applied.set(b.id, { f: [0, 0, 0], t: [0, 0, 0] });
      this.bodyFlags.set(b.id, { spin: false });
      for (const c of b.colliders) {
        let cd: ReturnType<typeof R.ColliderDesc.cuboid> | null;
        switch (c.shape.type) {
          case 'cuboid':
            cd = R.ColliderDesc.cuboid(...c.shape.half);
            break;
          case 'ball':
            cd = R.ColliderDesc.ball(c.shape.radius);
            break;
          case 'cylinder':
            cd = R.ColliderDesc.cylinder(c.shape.halfHeight, c.shape.radius);
            break;
          case 'convex':
            cd = R.ColliderDesc.convexHull(new Float32Array(c.shape.points));
            if (!cd) cd = boxOfPoints(R, c.shape.points);
            break;
        }
        cd.setTranslation(...c.position)
          .setRotation({ x: c.rotation[0], y: c.rotation[1], z: c.rotation[2], w: c.rotation[3] })
          .setDensity(0)
          .setFriction(b.settings.friction)
          .setRestitution(b.settings.restitution)
          .setCollisionGroups(b.collisionGroups)
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS | R.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(this.forceThreshold(b));
        if (d.selfCollision && b.assemblyId) cd.setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS);
        const col = this.world.createCollider(cd, rb);
        this.colliderBody.set(col.handle, b.id);
      }
    }
    if (d.ground.enabled) {
      const g = this.world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(0, d.ground.heightM - 0.05, 0),
      );
      const col = this.world.createCollider(
        R.ColliderDesc.cuboid(50, 0.05, 50)
          .setFriction(d.ground.friction)
          .setRestitution(d.ground.restitution)
          .setCollisionGroups((1 << 16) | 0xffff)
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS),
        g,
      );
      this.colliderBody.set(col.handle, 'ground');
    }

    // Joints.
    const subRate = 1 / this.substepDt;
    for (const m of this.model.joints) {
      const rA = this.bodies.get(m.bodyA)!;
      const rB = this.bodies.get(m.bodyB)!;
      const a = xyz(m.anchorA);
      const b = xyz(m.anchorB);
      const ax = xyz(m.axis);
      let data;
      const M = R.JointAxesMask;
      switch (m.mapping) {
        case 'revolute':
          data = R.JointData.revolute(a, b, ax);
          break;
        case 'prismatic':
          data = R.JointData.prismatic(a, b, ax);
          break;
        case 'spherical':
          data = R.JointData.spherical(a, b);
          break;
        case 'cylindrical':
          data = R.JointData.generic(a, b, ax, M.LinY | M.LinZ | M.AngY | M.AngZ);
          break;
        case 'planar':
          data = R.JointData.generic(a, b, ax, M.LinX | M.AngY | M.AngZ);
          break;
      }
      const joint = this.world.createImpulseJoint(data, rA, rB, true);
      joint.setContactsEnabled(false); // jointed neighbours never collide with each other
      const lim = m.limits[0];
      if (lim && (m.mapping === 'revolute' || m.mapping === 'prismatic'))
        (joint as RAPIER_NS.UnitImpulseJoint).setLimits(lim.min - m.q0[0]!, lim.max - m.q0[0]!);
      const act = this.liveActuator(m.mateId);
      const inertia = effectiveInertia(this.modelWithLivePayloads(), m);
      const gains = act ? gainsFor(act, inertia) : { kp: 0, kd: 0, ki: 0 };
      const every = act ? Math.max(1, Math.round(subRate / Math.min(act.controlRateHz, subRate))) : 1;
      const q = m.q0[0] ?? 0;
      const A0 = this.model.bodies.find((x) => x.id === m.bodyA)!.origin;
      const B0 = this.model.bodies.find((x) => x.id === m.bodyB)!.origin;
      const d0 = dot(subV(addV(B0, m.anchorB), addV(A0, m.anchorA)), m.axis);
      this.joints.push({
        m,
        rA,
        rB,
        joint,
        actuator: act,
        gains,
        inertia,
        state: act ? { ...initialActuatorState(q) } : null,
        q,
        qd: 0,
        lastAngle: 0,
        passive: 0,
        controlEvery: every,
        counter: 0,
        driftPos: 0,
        driftAng: 0,
        d0,
        prevQ: q,
        prevQd: 0,
        mismatch: 0,
        convergenceWarned: false,
        channels: !!act,
        flags: { sat: false, rated: false, atLimit: false, violation: false, satSince: 0 },
      });
    }

    // Self-collision: body pairs that already interpenetrate in the CAD pose are excluded (reported).
    if (d.selfCollision) this.excludeInitialOverlaps();
    this.initTelemetry();
    for (const j of this.joints) {
      if (!j.actuator) continue;
      const p = controllerStabilityProblem(j.gains, j.inertia, j.controlEvery * this.substepDt);
      if (p) this.event('controller-stability', 'warning', `${j.m.name}: ${p}.`, [j.m.mateId]);
    }
    for (const i of this.model.issues)
      if (i.severity !== 'info') this.event(`setup:${i.code}`, 'warning', i.message, i.refs);
    this.sample();
  }

  private excludeInitialOverlaps(): void {
    const adjacent = new Set(this.model.joints.map((j) => pairKey(j.bodyA, j.bodyB)));
    const cols: { c: Collider; body: string; asm: string }[] = [];
    this.world.colliders.forEach((c) => {
      const body = this.colliderBody.get(c.handle);
      const asm = body ? this.model.bodies.find((b) => b.id === body)?.assemblyId : null;
      if (body && asm) cols.push({ c, body, asm });
    });
    for (let i = 0; i < cols.length; i++)
      for (let k = i + 1; k < cols.length; k++) {
        const a = cols[i]!;
        const b = cols[k]!;
        if (a.body === b.body || a.asm !== b.asm) continue;
        const key = pairKey(a.body, b.body);
        if (adjacent.has(key) || this.excluded.has(key)) continue;
        const contact = a.c.contactCollider(b.c, 0);
        if (contact && contact.distance < -1e-4) {
          this.excluded.add(key);
          const na = this.model.bodies.find((x) => x.id === a.body)!.name;
          const nb = this.model.bodies.find((x) => x.id === b.body)!.name;
          this.event(
            'self-collision-excluded',
            'warning',
            `"${na}" and "${nb}" already interpenetrate in the CAD pose (${(-contact.distance * 1000).toFixed(2)} mm); contact between them is disabled.`,
            [a.body, b.body],
          );
        }
      }
  }

  private gravityVector() {
    const d = this.definition;
    return d.gravityEnabled ? xyz(d.gravity) : { x: 0, y: 0, z: 0 };
  }

  private forceThreshold(b: ModelBody): number {
    const t = [this.definition.thresholds.contactForceN, b.settings.contactLoadRatingN].filter(
      (x): x is number => x != null,
    );
    return t.length ? Math.min(...t) / this.contactForceScale : 3.0e38;
  }

  private liveActuator(mateId: string): Actuator | null {
    return this.definition.joints.find((j) => j.mateId === mateId)?.actuator ?? null;
  }

  private modelWithLivePayloads() {
    return {
      ...this.model,
      payloads: this.model.payloads.map((p) => ({ ...p, massKg: this.payloadMass.get(p.id) ?? p.massKg })),
    };
  }

  private massOf(b: ModelBody) {
    return massWithPayloads(b, this.modelWithLivePayloads().payloads);
  }

  private initTelemetry(): void {
    const ch: Channel[] = [];
    for (const m of this.model.joints) {
      const unit = m.mapping === 'prismatic' ? 'm' : 'rad';
      const eff = m.mapping === 'prismatic' ? 'N' : 'N·m';
      const rate = m.mapping === 'prismatic' ? 'm/s' : 'rad/s';
      const g = `joint:${m.mateId}`;
      ch.push(
        { key: `${m.mateId}.q`, label: `${m.name} position`, unit, kind: 'measured', group: g },
        { key: `${m.mateId}.qd`, label: `${m.name} velocity`, unit: rate, kind: 'measured', group: g },
        {
          key: `${m.mateId}.drift`,
          label: `${m.name} constraint drift`,
          unit: 'm',
          kind: 'measured',
          group: g,
        },
      );
      if (this.liveActuator(m.mateId))
        ch.push(
          { key: `${m.mateId}.target`, label: `${m.name} target`, unit, kind: 'commanded', group: g },
          { key: `${m.mateId}.setpoint`, label: `${m.name} setpoint`, unit, kind: 'commanded', group: g },
          {
            key: `${m.mateId}.cmd`,
            label: `${m.name} commanded effort`,
            unit: eff,
            kind: 'commanded',
            group: g,
          },
          {
            key: `${m.mateId}.effort`,
            label: `${m.name} applied effort`,
            unit: eff,
            kind: 'applied',
            group: g,
          },
          { key: `${m.mateId}.sat`, label: `${m.name} saturated`, unit: '0/1', kind: 'applied', group: g },
        );
    }
    const dyn = this.model.bodies.filter((b) => b.mode !== 'fixed');
    if (dyn.length <= 32)
      for (const b of dyn) {
        const g = `body:${b.id}`;
        for (const [k, l, u] of [
          ['x', 'x', 'm'],
          ['y', 'y', 'm'],
          ['z', 'z', 'm'],
          ['qx', 'orientation qx', '1'],
          ['qy', 'orientation qy', '1'],
          ['qz', 'orientation qz', '1'],
          ['qw', 'orientation qw', '1'],
          ['vx', 'velocity x', 'm/s'],
          ['vy', 'velocity y', 'm/s'],
          ['vz', 'velocity z', 'm/s'],
          ['wx', 'angular velocity x', 'rad/s'],
          ['wy', 'angular velocity y', 'rad/s'],
          ['wz', 'angular velocity z', 'rad/s'],
        ] as const)
          ch.push({ key: `${b.id}.${k}`, label: `${b.name} ${l}`, unit: u, kind: 'measured', group: g });
      }
    for (const p of this.model.payloads)
      ch.push({
        key: `${p.id}.mass`,
        label: `${p.name} mass`,
        unit: 'kg',
        kind: 'configured',
        group: `payload:${p.id}`,
      });
    ch.push({
      key: 'contacts',
      label: 'Active contact pairs',
      unit: 'count',
      kind: 'measured',
      group: 'world',
    });
    const prev = this.telemetry;
    const same =
      prev &&
      prev.capacity === this.definition.recording.maxSamples &&
      prev.channels.length === ch.length &&
      prev.channels.every((c, i) => c.key === ch[i]!.key);
    // Reuse the preallocated buffer across resets (no allocation churn); otherwise allocate.
    if (same) prev.clear();
    else this.telemetry = new TelemetryRecorder(ch, this.definition.recording.maxSamples);
    const now = (this.opts.now ?? (() => new Date()))();
    this.meta = {
      runId:
        this.opts.runId ??
        `run-${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now.toISOString(),
      engine: { name: 'rapier3d-compat', version: this.R.version() },
      solver: { ...this.definition.solver },
      gravity: this.definition.gravityEnabled ? [...this.definition.gravity] : null,
      project: this.opts.project ?? { id: 'unknown', name: 'unknown', revision: 0 },
      simulationName: this.definition.name,
      sampleRateHz: this.definition.recording.sampleRateHz,
      assumptions: this.model.assumptions.map((a) => ({ ...a })),
      status: 'approximate',
    };
  }

  private event(kind: string, severity: SimEvent['severity'], message: string, refs: string[] = []) {
    this.telemetry?.event({ t: this.time, kind, severity, message, refs });
  }

  // -- control ------------------------------------------------------------------------
  run(): void {
    if (this.state === 'faulted') return;
    this.state = 'running';
  }
  pause(): void {
    if (this.state === 'running') this.state = 'paused';
  }
  /** Rebuild the world from the model: time 0, original pose, fresh telemetry and run id. */
  reset(): void {
    this.fault = this.model.ok ? null : this.fault;
    this.state = this.model.ok ? 'ready' : 'faulted';
    this.stopped = false;
    this.definition = clone(this.model.definition);
    this.payloadMass.clear();
    this.build();
  }
  /** Re-bridge from new CAD/definition (after a structural change) and reset. */
  reinitialize(
    graph: Parameters<typeof buildPhysicsModel>[0],
    definition: SimulationDefinition,
    project?: SessionOptions['project'],
  ): void {
    this.model = buildPhysicsModel(graph, definition);
    if (project) this.opts.project = project;
    this.structural = structuralKey(definition);
    this.needsReset = false;
    this.fault = this.model.ok
      ? null
      : this.model.issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .join(' ');
    this.state = this.model.ok ? 'ready' : 'faulted';
    this.stopped = false;
    this.definition = clone(definition);
    this.payloadMass.clear();
    this.build();
  }
  emergencyStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.event(
      'emergency-stop',
      'warning',
      'Emergency stop: every actuator is switched off (zero effort). Release or reset to continue.',
    );
  }
  releaseStop(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const j of this.joints) if (j.state) j.state = initialActuatorState(j.q);
    this.event('emergency-stop-released', 'info', 'Emergency stop released.');
  }

  /**
   * Advance by real elapsed time (display loop). Runs whole fixed steps only, at most
   * maxCatchUpSteps per call AND within a wall-clock budget (default 12 ms, at least one
   * step): excess time is dropped and counted in stats.lagFrames, so a heavy scene runs
   * slower than real time instead of freezing the display (no catch-up spiral). Results do
   * not depend on this: every step is the same fixed step.
   */
  advance(realDtS: number, budgetMs = 12): number {
    if (this.state !== 'running' || !(realDtS > 0)) return 0;
    const h = this.definition.solver.timestepS;
    this.acc += Math.min(realDtS, 0.25) * this.speed;
    const wanted = Math.floor(this.acc / h + 1e-9);
    const n = Math.min(wanted, this.definition.solver.maxCatchUpSteps);
    const start = performanceNow();
    let done = 0;
    while (done < n && (done === 0 || performanceNow() - start < budgetMs)) {
      if (this.step(1) === 0) break;
      done++;
    }
    if (done < wanted) {
      this.acc = 0;
      this.stats.lagFrames++;
    } else this.acc -= done * h;
    return done;
  }

  /** Run `n` fixed steps (bounded) regardless of the run state (paused stepping, tests). */
  step(n = 1): number {
    if (this.state === 'faulted' || !this.model.ok) return 0;
    const count = Math.max(0, Math.min(Math.floor(n), 100_000));
    let done = 0;
    for (let i = 0; i < count; i++) {
      let ok: boolean;
      try {
        ok = this.fixedStep();
      } catch (e) {
        // Solver/engine error: stop safely and report; reset rebuilds a fresh world.
        this.fault = `Physics engine error at t = ${this.time.toFixed(4)} s: ${e instanceof Error ? e.message : String(e)}. The simulation was stopped; reset to recover (the CAD design is unaffected).`;
        this.state = 'faulted';
        this.event('fault', 'fault', this.fault);
        ok = false;
      }
      if (!ok) break;
      done++;
    }
    return done;
  }

  /** Simulate `seconds` of simulated time (bounded by a step budget). */
  runFor(seconds: number, maxSteps = 200_000): number {
    return this.step(Math.min(maxSteps, Math.round(seconds / this.definition.solver.timestepS)));
  }

  private fixedStep(): boolean {
    const t0 = performanceNow();
    const sub = this.definition.solver.substeps;
    const h = this.substepDt;
    const hooks = this.excluded.size ? this.hooks() : undefined;
    for (let s = 0; s < sub; s++) {
      for (const [id, rb] of this.bodies) {
        if (!rb.isDynamic()) continue;
        rb.resetForces(false);
        rb.resetTorques(false);
        const ap = this.applied.get(id)!;
        ap.f = [0, 0, 0];
        ap.t = [0, 0, 0];
      }
      for (const j of this.joints) this.driveJoint(j, h);
      this.applyLoads(h);
      this.world.step(this.queue, hooks);
      this.drainEvents();
    }
    this.time += this.definition.solver.timestepS;
    this.steps++;
    const ms = performanceNow() - t0;
    this.stats.lastStepMs = ms;
    this.stats.fixedSteps++;
    this.stepTotalMs += ms;
    this.stats.meanStepMs = this.stepTotalMs / this.stats.fixedSteps;
    this.stats.maxStepMs = Math.max(this.stats.maxStepMs, ms);
    if (!this.checkSanity()) return false;
    this.monitor();
    if (this.time + 1e-9 >= this.nextSample) this.sample();
    return true;
  }

  private hooks() {
    const excluded = this.excluded;
    const cb = this.colliderBody;
    const R = this.R;
    return {
      filterContactPair: (c1: number, c2: number) => {
        const a = cb.get(c1);
        const b = cb.get(c2);
        return a && b && excluded.has(pairKey(a, b)) ? null : R.SolverFlags.COMPUTE_IMPULSE;
      },
      filterIntersectionPair: () => true,
    };
  }

  /** Measure the joint coordinate/rate/drift from the bodies; actuator + passive efforts. */
  private measure(j: JointRuntime): void {
    const qa = quat(j.rA.rotation());
    const qb = quat(j.rB.rotation());
    const ta = vec(j.rA.translation());
    const tb = vec(j.rB.translation());
    const axisW = qrot(qa, j.m.axis);
    const pa = addV(ta, qrot(qa, j.m.anchorA));
    const pb = addV(tb, qrot(qb, j.m.anchorB));
    const va = addV(vec(j.rA.linvel()), crossV(vec(j.rA.angvel()), subV(pa, ta)));
    const vb = addV(vec(j.rB.linvel()), crossV(vec(j.rB.angvel()), subV(pb, tb)));
    const wa = vec(j.rA.angvel());
    const wb = vec(j.rB.angvel());
    const sep = subV(pb, pa);
    const axisB = qrot(qb, j.m.axis);
    const mis = Math.acos(Math.max(-1, Math.min(1, dot(axisW, axisB))));
    switch (j.m.mapping) {
      case 'revolute':
      case 'cylindrical': {
        const rel = qmul(qconj(qa), qb);
        const s = dot([rel[0], rel[1], rel[2]], j.m.axis);
        let ang = wrapPi(2 * Math.atan2(s, rel[3]));
        while (ang - j.lastAngle > Math.PI) ang -= 2 * Math.PI;
        while (ang - j.lastAngle < -Math.PI) ang += 2 * Math.PI;
        j.lastAngle = ang;
        j.q = j.m.q0[0]! + ang;
        j.qd = dot(subV(wb, wa), axisW);
        const along = dot(sep, axisW);
        j.driftPos = j.m.mapping === 'revolute' ? lenV(sep) : lenV(subV(sep, scaleV(axisW, along)));
        j.driftAng = mis;
        break;
      }
      case 'prismatic': {
        const along = dot(sep, axisW);
        j.q = j.m.q0[0]! + along - j.d0;
        j.qd = dot(subV(vb, va), axisW);
        j.driftPos = lenV(subV(sep, scaleV(axisW, along)));
        const rel = qmul(qconj(qa), qb);
        j.driftAng = 2 * Math.acos(Math.min(1, Math.abs(rel[3])));
        break;
      }
      case 'spherical':
        j.q = 0;
        j.qd = lenV(subV(wb, wa));
        j.driftPos = lenV(sep);
        j.driftAng = 0;
        break;
      case 'planar':
        j.q = dot(sep, qrot(qa, j.m.xRef));
        j.qd = dot(subV(vb, va), qrot(qa, j.m.xRef));
        j.driftPos = Math.abs(dot(sep, axisW));
        j.driftAng = mis;
        break;
    }
  }

  private driveJoint(j: JointRuntime, h: number): void {
    const hasPassive = j.m.settings.damping > 0 || j.m.settings.friction > 0;
    if (!j.actuator && !hasPassive) return;
    this.measure(j);
    if (j.actuator && j.state) {
      if (j.counter % j.controlEvery === 0)
        j.state = actuatorStep(j.state, {
          q: j.q,
          qd: j.qd,
          h: h * j.controlEvery,
          actuator: j.actuator,
          gains: j.gains,
          stopped: this.stopped,
          limits: j.m.limits[0] ?? null,
        });
      j.counter++;
    }
    j.passive = hasPassive ? passiveEffort(j.qd, j.m.settings.damping, j.m.settings.friction) : 0;
    const effort = (j.state?.applied ?? 0) + j.passive;
    if (effort === 0) return;
    const axisW = qrot(quat(j.rA.rotation()), j.m.axis);
    const A = this.applied.get(j.m.bodyA)!;
    const B = this.applied.get(j.m.bodyB)!;
    if (j.m.mapping === 'prismatic') {
      // Equal and opposite forces at the (shared) anchor point: no parasitic couple.
      const f = scaleV(axisW, effort);
      const p = addV(vec(j.rB.translation()), qrot(quat(j.rB.rotation()), j.m.anchorB));
      if (j.rB.isDynamic()) j.rB.addForceAtPoint(xyz(f), xyz(p), true);
      if (j.rA.isDynamic()) j.rA.addForceAtPoint(xyz(scaleV(f, -1)), xyz(p), true);
      B.f = addV(B.f, f);
      A.f = subV(A.f, f);
    } else {
      const t = scaleV(axisW, effort);
      if (j.rB.isDynamic()) j.rB.addTorque(xyz(t), true);
      if (j.rA.isDynamic()) j.rA.addTorque(xyz(scaleV(t, -1)), true);
      B.t = addV(B.t, t);
      A.t = subV(A.t, t);
    }
  }

  private applyLoads(h: number): void {
    for (const l of this.loads) {
      const rb = this.bodies.get(l.bodyId);
      if (!rb || l.remaining <= 0) continue;
      const ap = this.applied.get(l.bodyId)!;
      if (l.force) {
        const p = l.point ?? vec(rb.worldCom());
        rb.addForceAtPoint(xyz(l.force), xyz(p), true);
        ap.f = addV(ap.f, l.force);
        ap.t = addV(ap.t, crossV(subV(p, vec(rb.worldCom())), l.force));
      }
      if (l.torque) {
        rb.addTorque(xyz(l.torque), true);
        ap.t = addV(ap.t, l.torque);
      }
      l.remaining -= h;
    }
    this.loads = this.loads.filter((l) => l.remaining > 1e-12);
  }

  private drainEvents(): void {
    const th = this.definition.thresholds.contactForceN;
    this.queue.drainContactForceEvents((e) => {
      const a = this.colliderBody.get(e.collider1());
      const b = this.colliderBody.get(e.collider2());
      if (!a || !b) return;
      const f = e.totalForceMagnitude() * this.contactForceScale;
      const key = pairKey(a, b);
      const last = this.contactCooldown.get(key) ?? -1;
      if (this.time - last < 0.25) return;
      const name = (id: string) =>
        id === 'ground' ? 'work surface' : (this.model.bodies.find((x) => x.id === id)?.name ?? id);
      let raised = false;
      if (th != null && f > th) {
        this.event(
          'contact-overload',
          'warning',
          `Contact force ${f.toFixed(2)} N between "${name(a)}" and "${name(b)}" exceeds the ${th} N threshold (threshold warning, not a failure prediction).`,
          [a, b],
        );
        raised = true;
      }
      for (const id of [a, b]) {
        const r = this.model.bodies.find((x) => x.id === id)?.settings.contactLoadRatingN;
        if (r != null && f > r) {
          this.event(
            'load-rating-exceeded',
            'warning',
            `"${name(id)}": contact force ${f.toFixed(2)} N exceeds its user-defined load rating ${r} N (rating check, not a failure prediction).`,
            [id],
          );
          raised = true;
        }
      }
      if (raised) this.contactCooldown.set(key, this.time);
    });
    this.queue.drainCollisionEvents(() => {});
  }

  private checkSanity(): boolean {
    for (const [id, rb] of this.bodies) {
      if (!rb.isDynamic()) continue;
      const p = vec(rb.translation());
      const v = vec(rb.linvel());
      const w = vec(rb.angvel());
      const bad = [...p, ...v, ...w].some((x) => !Number.isFinite(x));
      const extreme =
        lenV(v) > GUARDS.maxSpeed || lenV(w) > GUARDS.maxAngularSpeed || lenV(p) > GUARDS.maxDistance;
      if (bad || extreme) {
        const name = this.model.bodies.find((b) => b.id === id)?.name ?? id;
        this.fault = bad
          ? `Numerical failure: "${name}" reached a non-finite state at t = ${this.time.toFixed(4)} s. The simulation was stopped; reset to recover (the CAD design is unaffected).`
          : `Solver instability suspected: "${name}" exceeded the sanity limits (|v| ≤ ${GUARDS.maxSpeed} m/s, |ω| ≤ ${GUARDS.maxAngularSpeed} rad/s, |x| ≤ ${GUARDS.maxDistance} m) at t = ${this.time.toFixed(4)} s. Stopped; reset to recover.`;
        this.state = 'faulted';
        this.event('fault', 'fault', this.fault, [id]);
        return false;
      }
    }
    return true;
  }

  private monitor(): void {
    const tol = this.definition.thresholds.limitTolerance;
    for (const j of this.joints) {
      this.measure(j); // coordinates and drift after the step
      if (j.m.mapping === 'revolute' || j.m.mapping === 'prismatic') {
        // The coordinate's change over the step must match the solver's reported rate (trapezoid).
        const fd = (j.q - j.prevQ) / this.definition.solver.timestepS;
        const avg = (j.qd + j.prevQd) / 2;
        const bad =
          Math.abs(fd - avg) > Math.max(j.m.mapping === 'prismatic' ? 0.05 : 0.5, 0.25 * Math.abs(avg));
        j.mismatch = bad ? j.mismatch + 1 : 0;
        if (j.mismatch >= 3 && !j.convergenceWarned) {
          j.convergenceWarned = true;
          this.event(
            'solver-convergence',
            'warning',
            `${j.m.name}: the solver's joint velocity disagrees with the joint's motion (${avg.toFixed(2)} vs ${fd.toFixed(2)} per s): the constraint solver is not converging — increase solver iterations or sub-steps. Results are unreliable until then.`,
            [j.m.mateId],
          );
        }
        j.prevQ = j.q;
        j.prevQd = j.qd;
      }
      const lim = j.m.limits[0];
      if (lim && (j.m.mapping === 'revolute' || j.m.mapping === 'prismatic')) {
        const at = j.q >= lim.max - tol || j.q <= lim.min + tol;
        const viol = j.q > lim.max + tol || j.q < lim.min - tol;
        if (at && !j.flags.atLimit)
          this.event(
            'joint-at-limit',
            'info',
            `${j.m.name} reached its ${j.q >= lim.max - tol ? 'upper' : 'lower'} limit (${fmtCoord(j.q > 0 ? lim.max : lim.min, j.m.mapping)}).`,
            [j.m.mateId],
          );
        if (viol && !j.flags.violation)
          this.event(
            'joint-limit-violation',
            'warning',
            `${j.m.name} is beyond its travel limit by more than the ${fmtCoord(tol, j.m.mapping)} tolerance (solver could not hold the limit).`,
            [j.m.mateId],
          );
        j.flags.atLimit = at;
        j.flags.violation = viol;
      }
      const st = j.state;
      if (j.actuator && st) {
        if (st.saturated && !j.flags.sat) {
          j.flags.satSince = this.time;
          this.event(
            'effort-limit',
            'warning',
            `${j.m.name}: actuator effort saturated at ${fmtEffort(st.applied, j.m.mapping)} (limit ${fmtEffort(j.actuator.effortLimit, j.m.mapping)}, speed-dependent envelope).`,
            [j.m.mateId],
          );
        }
        if (!st.saturated && j.flags.sat)
          this.event(
            'effort-limit-cleared',
            'info',
            `${j.m.name}: actuator back within its effort envelope after ${(this.time - j.flags.satSince).toFixed(3)} s.`,
            [j.m.mateId],
          );
        j.flags.sat = st.saturated;
        const rated = j.actuator.ratedEffort != null && Math.abs(st.applied) > j.actuator.ratedEffort;
        if (rated && !j.flags.rated)
          this.event(
            'rated-effort-exceeded',
            'warning',
            `${j.m.name}: applied effort ${fmtEffort(st.applied, j.m.mapping)} exceeds the rated ${fmtEffort(j.actuator.ratedEffort!, j.m.mapping)} (rating check).`,
            [j.m.mateId],
          );
        j.flags.rated = rated;
      }
    }
    const maxW = this.definition.thresholds.maxAngularSpeed;
    for (const [id, rb] of this.bodies) {
      if (!rb.isDynamic()) continue;
      const w = lenV(vec(rb.angvel()));
      const f = this.bodyFlags.get(id)!;
      if (w > maxW && !f.spin)
        this.event(
          'excessive-angular-velocity',
          'warning',
          `"${this.model.bodies.find((b) => b.id === id)?.name}" spins at ${w.toFixed(1)} rad/s (> ${maxW} rad/s threshold).`,
          [id],
        );
      f.spin = w > maxW;
    }
  }

  private sample(): void {
    const v: number[] = [];
    // Same order and layout as initTelemetry (fixed for the run: adding/removing an actuator needs a reset).
    for (const j of this.joints) {
      v.push(j.q, j.qd, Math.max(j.driftPos, 0));
      if (j.channels) {
        const a = j.actuator;
        v.push(
          a && a.mode === 'position' ? a.target : Number.NaN,
          j.state?.setpoint ?? Number.NaN,
          j.state?.command ?? 0,
          j.state?.applied ?? 0,
          j.state?.saturated ? 1 : 0,
        );
      }
    }
    const dyn = this.model.bodies.filter((b) => b.mode !== 'fixed');
    if (dyn.length <= 32)
      for (const b of dyn) {
        const rb = this.bodies.get(b.id)!;
        v.push(...vec(rb.translation()), ...quat(rb.rotation()), ...vec(rb.linvel()), ...vec(rb.angvel()));
      }
    for (const p of this.model.payloads) v.push(this.payloadMass.get(p.id) ?? p.massKg);
    let pairs = 0;
    this.world.forEachCollider((c) => {
      if (this.colliderBody.get(c.handle) === 'ground') return;
      this.world.contactPairsWith(c, () => pairs++);
    });
    this.stats.contactPairs = pairs;
    v.push(pairs);
    this.telemetry.record(this.time, v);
    this.nextSample = this.time + 1 / this.definition.recording.sampleRateHz - 1e-9;
  }

  // -- runtime inputs -------------------------------------------------------------------
  private bodyForNode(nodeId: string): { id: string; rb: RigidBody } | string {
    const id = this.model.bodyOfNode[nodeId] ?? (this.bodies.has(nodeId) ? nodeId : undefined);
    const rb = id ? this.bodies.get(id) : undefined;
    if (!id || !rb) return `"${nodeId}" is not a simulated body.`;
    if (!rb.isDynamic()) return 'Forces can only be applied to dynamic bodies.';
    return { id, rb };
  }

  /** Apply a world-frame force (N) at a world point (default: centre of mass) for a duration (default one fixed step). */
  applyForce(
    nodeId: string,
    forceN: V3,
    opts: { pointM?: V3; durationS?: number } = {},
  ): { ok: true } | { ok: false; error: string } {
    const b = this.bodyForNode(nodeId);
    if (typeof b === 'string') return { ok: false, error: b };
    if (!forceN.every(Number.isFinite) || lenV(forceN) > GUARDS.maxForceN)
      return { ok: false, error: `Force must be finite and ≤ ${GUARDS.maxForceN} N.` };
    if (opts.pointM && !opts.pointM.every(Number.isFinite))
      return { ok: false, error: 'Point must be finite.' };
    const d = opts.durationS ?? this.definition.solver.timestepS;
    if (!(d > 0) || d > 3600) return { ok: false, error: 'Duration must be in (0, 3600] s.' };
    this.loads.push({
      bodyId: b.id,
      force: [...forceN],
      torque: null,
      point: opts.pointM ? [...opts.pointM] : null,
      remaining: d,
    });
    b.rb.wakeUp();
    this.event(
      'external-force',
      'info',
      `Force (${forceN.map((x) => x.toFixed(2)).join(', ')}) N applied to "${this.model.bodies.find((x) => x.id === b.id)?.name}" for ${d.toFixed(3)} s.`,
      [b.id],
    );
    return { ok: true };
  }

  applyTorque(
    nodeId: string,
    torqueNm: V3,
    opts: { durationS?: number } = {},
  ): { ok: true } | { ok: false; error: string } {
    const b = this.bodyForNode(nodeId);
    if (typeof b === 'string') return { ok: false, error: b };
    if (!torqueNm.every(Number.isFinite) || lenV(torqueNm) > GUARDS.maxTorqueNm)
      return { ok: false, error: `Torque must be finite and ≤ ${GUARDS.maxTorqueNm} N·m.` };
    const d = opts.durationS ?? this.definition.solver.timestepS;
    if (!(d > 0) || d > 3600) return { ok: false, error: 'Duration must be in (0, 3600] s.' };
    this.loads.push({ bodyId: b.id, force: null, torque: [...torqueNm], point: null, remaining: d });
    b.rb.wakeUp();
    this.event(
      'external-torque',
      'info',
      `Torque (${torqueNm.map((x) => x.toFixed(3)).join(', ')}) N·m applied to "${this.model.bodies.find((x) => x.id === b.id)?.name}" for ${d.toFixed(3)} s.`,
      [b.id],
    );
    return { ok: true };
  }

  /** Change an actuator's runtime command (not persisted; any command source). */
  setMotorTarget(cmd: MotorCommand): { ok: true } | { ok: false; error: string } {
    const j = this.joints.find((x) => x.m.mateId === cmd.mateId);
    if (!j?.actuator) return { ok: false, error: `Joint "${cmd.mateId}" has no actuator.` };
    for (const k of ['target', 'targetVelocity', 'targetEffort'] as const)
      if (cmd[k] !== undefined && !Number.isFinite(cmd[k]))
        return { ok: false, error: `${k} must be finite.` };
    const next: Actuator = {
      ...j.actuator,
      ...(cmd.mode ? { mode: cmd.mode } : {}),
      ...(cmd.target !== undefined ? { target: cmd.target } : {}),
      ...(cmd.targetVelocity !== undefined ? { targetVelocity: cmd.targetVelocity } : {}),
      ...(cmd.targetEffort !== undefined ? { targetEffort: cmd.targetEffort } : {}),
      ...(cmd.enabled !== undefined ? { enabled: cmd.enabled } : {}),
    };
    if (next.mode !== j.actuator.mode && j.state) j.state = { ...initialActuatorState(j.q) };
    j.actuator = next;
    const js = this.definition.joints.find((x) => x.mateId === cmd.mateId);
    if (js) js.actuator = next;
    j.rA.wakeUp();
    j.rB.wakeUp();
    return { ok: true };
  }

  /** Change a payload's mass while running (runtime only; persist through physics.payload.set). */
  setPayloadMass(payloadId: string, massKg: number): { ok: true } | { ok: false; error: string } {
    const p = this.model.payloads.find((x) => x.id === payloadId);
    if (!p) return { ok: false, error: `Payload "${payloadId}" is not part of this run.` };
    if (!Number.isFinite(massKg) || massKg < 0 || massKg > 1e5)
      return { ok: false, error: 'Payload mass must be in [0, 100000] kg.' };
    this.payloadMass.set(payloadId, massKg);
    const b = this.model.bodies.find((x) => x.id === p.bodyId)!;
    const rb = this.bodies.get(b.id)!;
    const mp = this.massOf(b)!;
    const pr = principal(mp.inertia);
    rb.setAdditionalMassProperties(mp.massKg, xyz(mp.com), xyz(pr.values), pr.frame, true);
    this.event('payload-changed', 'info', `Payload "${p.name}" set to ${massKg} kg.`, [payloadId]);
    return { ok: true };
  }

  /**
   * Apply a changed definition. Live parameters (gravity, actuators, joint damping/friction,
   * payload masses, thresholds) take effect immediately; structural changes (bodies, modes,
   * colliders, solver, ground, pose) set `needsReset` and wait for reset/reinitialise.
   */
  updateDefinition(d: SimulationDefinition): void {
    if (structuralKey(d) !== this.structural) {
      this.needsReset = true;
      return;
    }
    this.definition = clone(d);
    this.world.gravity = this.gravityVector();
    for (const j of this.joints) {
      const s = d.joints.find((x) => x.mateId === j.m.mateId);
      j.m = { ...j.m, settings: s ?? { mateId: j.m.mateId, damping: 0, friction: 0, actuator: null } };
      const a = s?.actuator ?? null;
      if (!!a !== !!j.actuator) {
        this.needsReset = true; // channels change: adding/removing an actuator needs a reset
        continue;
      }
      if (a) {
        j.actuator = a;
        j.gains = gainsFor(a, j.inertia);
      }
    }
    for (const p of d.payloads)
      if (this.model.payloads.some((x) => x.id === p.id)) this.setPayloadMass(p.id, p.massKg);
    for (const b of this.model.bodies) {
      const rb = this.bodies.get(b.id);
      if (!rb) continue;
      for (let i = 0; i < rb.numColliders(); i++)
        rb.collider(i).setContactForceEventThreshold(this.forceThreshold(b));
    }
  }

  // -- sensing (Phase 6) -------------------------------------------------------------
  /**
   * Cast a ray against the simulated world (current body poses, all colliders including the
   * work surface). Returns the distance to the first hit along the unit direction, or null.
   * Read-only: used by sensor models (e.g. the ultrasonic ranger); never changes the world.
   */
  castRay(
    origin: V3,
    direction: V3,
    maxDistance: number,
    excludeBodies: readonly string[] = [],
  ): { distance: number; bodyId: string } | null {
    if (!this.world || !(maxDistance > 0)) return null;
    const len = lenV(direction);
    if (!(len > 0)) return null;
    const d = scaleV(direction, 1 / len);
    const ray = new this.R.Ray(xyz(origin), xyz(d));
    const excluded = new Set(excludeBodies);
    // Exact per-collider test at the colliders' CURRENT poses (Rapier's query BVH is only
    // refreshed by a step, so a just-moved obstacle would otherwise be missed). O(colliders)
    // per ray — fine for sensor ray counts.
    let best: { distance: number; bodyId: string } | null = null;
    this.world.colliders.forEach((c) => {
      const b = this.colliderBody.get(c.handle);
      if (b !== undefined && excluded.has(b)) return;
      const toi = c.castRay(ray, best ? best.distance : maxDistance, true);
      if (toi >= 0 && (!best || toi < best.distance)) best = { distance: toi, bodyId: b ?? 'unknown' };
    });
    return best;
  }

  /**
   * Move a FIXED or KINEMATIC body to a new position at runtime (an experiment input such as
   * repositioning a test obstacle). Not persisted; reset restores the CAD pose. Dynamic bodies
   * are refused (they move only under forces).
   */
  setBodyTranslation(bodyId: string, p: V3): { ok: true } | { ok: false; error: string } {
    const rb = this.bodies.get(bodyId);
    if (!rb) return { ok: false, error: `Body "${bodyId}" is not part of this run.` };
    if (rb.isDynamic())
      return { ok: false, error: 'Dynamic bodies cannot be moved directly; apply a force instead.' };
    if (!p.every(Number.isFinite) || lenV(p) > GUARDS.maxDistance)
      return { ok: false, error: 'Position out of range.' };
    if (rb.isKinematic()) rb.setNextKinematicTranslation(xyz(p));
    else rb.setTranslation(xyz(p), true);
    this.world.propagateModifiedBodyPositionsToColliders();
    return { ok: true };
  }

  // -- queries ------------------------------------------------------------------------
  /** Current world pose of a physics body. */
  bodyPose(bodyId: string): { p: V3; q: Quat } | null {
    const rb = this.bodies.get(bodyId);
    return rb ? { p: vec(rb.translation()), q: quat(rb.rotation()) } : null;
  }

  /** Simulated world matrix of a body unit node (display only; never written to the project). */
  unitWorldMatrix(unitId: string): Mat4 | null {
    const bid = this.model.bodyOfNode[unitId];
    const b = bid ? this.model.bodies.find((x) => x.id === bid) : undefined;
    const off = b?.unitOffsets[unitId];
    const pose = b ? this.bodyPose(b.id) : null;
    if (!off || !pose) return null;
    return multiply(compose({ position: pose.p, rotation: pose.q, scale: [1, 1, 1] }), off);
  }

  jointStates(): JointState[] {
    return this.joints.map((j) => {
      const lim = j.m.limits[0] ?? null;
      const tol = this.definition.thresholds.limitTolerance;
      const a = j.actuator;
      return {
        mateId: j.m.mateId,
        name: j.m.name,
        mapping: j.m.mapping,
        unit: j.m.mapping === 'prismatic' ? 'm' : 'rad',
        q: j.q,
        qd: j.qd,
        limits: j.m.limits,
        atLimit: lim ? (j.q >= lim.max - tol ? 'max' : j.q <= lim.min + tol ? 'min' : null) : null,
        driftPos: j.driftPos,
        driftAng: j.driftAng,
        passive: j.passive,
        actuator: a
          ? {
              enabled: a.enabled && !this.stopped,
              mode: a.mode,
              target: a.target,
              targetVelocity: a.targetVelocity,
              targetEffort: a.targetEffort,
              setpoint: j.state?.setpoint ?? j.q,
              command: j.state?.command ?? 0,
              applied: j.state?.applied ?? 0,
              saturated: j.state?.saturated ?? false,
              effortLimit: a.effortLimit,
              speedLimit: a.speedLimit,
              ratedEffort: a.ratedEffort,
              gains: j.gains,
              inertia: j.inertia,
              source: a.source,
            }
          : null,
      };
    });
  }

  bodyState(bodyId: string): BodyState | null {
    const b = this.model.bodies.find((x) => x.id === bodyId);
    const rb = this.bodies.get(bodyId);
    if (!b || !rb) return null;
    const mp = b.mode === 'dynamic' ? this.massOf(b) : null;
    const pose = this.bodyPose(bodyId)!;
    const contacts = new Map<string, { points: number; normalImpulse: number }>();
    for (let i = 0; i < rb.numColliders(); i++) {
      const c = rb.collider(i);
      this.world.contactPairsWith(c, (other) => {
        const ob = this.colliderBody.get(other.handle) ?? 'unknown';
        this.world.contactPair(c, other, (manifold) => {
          const n = manifold.numContacts();
          if (!n) return;
          const e = contacts.get(ob) ?? { points: 0, normalImpulse: 0 };
          e.points += n;
          for (let k = 0; k < n; k++) e.normalImpulse += manifold.contactImpulse(k) * this.contactForceScale;
          contacts.set(ob, e);
        });
      });
    }
    const ap = this.applied.get(bodyId) ?? { f: [0, 0, 0] as V3, t: [0, 0, 0] as V3 };
    return {
      id: b.id,
      name: b.name,
      mode: b.mode,
      unitIds: b.unitIds,
      position: pose.p,
      rotation: pose.q,
      linvel: vec(rb.linvel()),
      angvel: vec(rb.angvel()),
      sleeping: rb.isSleeping(),
      massKg: mp?.massKg ?? null,
      com: mp ? addV(pose.p, qrot(pose.q, mp.com)) : null,
      inertia: mp ? principal(mp.inertia).values : null,
      force: ap.f,
      torque: ap.t,
      contacts: [...contacts].map(([bodyId2, v]) => ({ bodyId: bodyId2, ...v })),
    };
  }

  /** World-space contact points of the last sub-step (display; at most `max`). */
  contactPoints(max = 256): V3[] {
    const out: V3[] = [];
    for (const [id, rb] of this.bodies) {
      if (!rb.isDynamic() || out.length >= max) continue;
      void id;
      for (let i = 0; i < rb.numColliders() && out.length < max; i++) {
        const c = rb.collider(i);
        this.world.contactPairsWith(c, (other) => {
          this.world.contactPair(c, other, (m) => {
            for (let k = 0; k < m.numSolverContacts() && out.length < max; k++)
              out.push(vec(m.solverContactPoint(k)));
          });
        });
      }
    }
    return out;
  }

  getState() {
    return {
      state: this.state,
      time: this.time,
      steps: this.steps,
      stopped: this.stopped,
      fault: this.fault,
      needsReset: this.needsReset,
      bodies: this.model.bodies.map((b) => this.bodyState(b.id)!),
      joints: this.jointStates(),
      stats: { ...this.stats },
    };
  }

  getTelemetry(): TelemetryRecorder {
    return this.telemetry;
  }

  /** Release the WASM world (call when the session is discarded). */
  dispose(): void {
    this.world?.free();
    this.queue?.free();
    this.bodies.clear();
  }
}

function principal(
  I: ReturnType<typeof massWithPayloads> extends infer M
    ? M extends { inertia: infer T }
      ? T
      : never
    : never,
) {
  const e = eigenSym3(I);
  const values = e.values.map((v) => Math.max(v, 1e-12)) as V3;
  const q = quatFromMat3(e.vectors);
  return { values, frame: { x: q[0], y: q[1], z: q[2], w: q[3] } };
}

function boxOfPoints(R: Rapier, pts: number[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, pts[i + k]!);
      max[k] = Math.max(max[k]!, pts[i + k]!);
    }
  return R.ColliderDesc.cuboid(
    Math.max((max[0]! - min[0]!) / 2, 1e-5),
    Math.max((max[1]! - min[1]!) / 2, 1e-5),
    Math.max((max[2]! - min[2]!) / 2, 1e-5),
  ).setTranslation((min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2);
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const fmtCoord = (v: number, m: ModelJoint['mapping']) =>
  m === 'prismatic' ? `${(v * 1000).toFixed(2)} mm` : `${((v * 180) / Math.PI).toFixed(2)}°`;
const fmtEffort = (v: number, m: ModelJoint['mapping']) =>
  m === 'prismatic' ? `${v.toFixed(3)} N` : `${v.toFixed(3)} N·m`;
const clock = globalThis as unknown as { performance?: { now(): number } };
const performanceNow = () => (clock.performance ? clock.performance.now() : Date.now());
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Parts of a definition that change the physical model (require a reset to apply). */
export function structuralKey(d: SimulationDefinition): string {
  return JSON.stringify({
    solver: d.solver,
    ground: d.ground,
    selfCollision: d.selfCollision,
    allowSleeping: d.allowSleeping,
    initialPose: d.initialPose,
    bodies: d.bodies,
    approvals: d.approvals,
    payloads: d.payloads.map((p) => ({ id: p.id, nodeId: p.nodeId, offsetM: p.offsetM })),
    recording: d.recording,
  });
}
