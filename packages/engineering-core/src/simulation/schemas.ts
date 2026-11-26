import { z } from 'zod';
import { IdSchema } from '../schemas';

/**
 * Simulation DEFINITION (Phase 5): what a physics run is set up to be — solver settings,
 * gravity, per-body physical settings, joint/actuator settings, payloads and overload
 * thresholds. It is persisted with the project (on the root node), validated here and
 * changed only through undoable `physics.*` engine commands.
 *
 * It never contains runtime state (positions, velocities, contacts, telemetry): those live
 * in a `@forge/physics` session and in separately exported recordings. Every setting refers
 * to engineering entities BY ID (node ids, mate ids); a dangling reference (e.g. to a
 * deleted body) does not invalidate the project — the CAD-to-physics bridge reports it.
 *
 * Units (SI, as everywhere internally): m, s, kg, N, N·m, rad, rad/s, m/s, kg·m².
 */
export const SIMULATION_SCHEMA_VERSION = 1 as const;

const finite = z.number().finite();
const vec3 = z.tuple([finite, finite, finite]);
const nonNeg = finite.min(0);
const positive = finite.positive();
const Note = z.string().max(500);

export const SolverSettingsSchema = z.object({
  /** Fixed simulation step (s), independent of the display frame rate. */
  timestepS: finite.min(1 / 2000).max(1 / 30),
  /** Physics sub-steps per fixed step (the Rapier world steps at timestepS / substeps). */
  substeps: z.number().int().min(1).max(16),
  /** Rapier solver iterations per (sub)step. */
  solverIterations: z.number().int().min(1).max(32),
  /** Upper bound on fixed steps run for one displayed frame (prevents a catch-up spiral). */
  maxCatchUpSteps: z.number().int().min(1).max(240),
  /**
   * Characteristic length (m) the solver's tolerances scale with (Rapier `lengthUnit`): the
   * allowed contact penetration is 0.1 % of it. 1 cm suits desktop-scale components.
   */
  lengthUnitM: finite.min(1e-4).max(10).default(0.01),
});
export type SolverSettings = z.infer<typeof SolverSettingsSchema>;

/**
 * Defaults justified by measurement (docs/PHYSICS_VALIDATION.md §solver settings): with 4
 * iterations the robotic arm's light intermediate link (bracket + servo between heavier
 * links) does not converge — its reported velocity disagrees with its motion by > 10 rad/s;
 * 8 iterations × 4 sub-steps is consistent, and 1 sub-step (120 Hz control) is unstable.
 */
export const DEFAULT_SOLVER: SolverSettings = {
  timestepS: 1 / 120,
  substeps: 4,
  solverIterations: 8,
  maxCatchUpSteps: 16,
  lengthUnitM: 0.01,
};

export const GroundPlaneSchema = z.object({
  enabled: z.boolean(),
  /** Height of the static work surface (project frame, m). */
  heightM: finite.min(-100).max(100),
  friction: nonNeg.max(10),
  restitution: nonNeg.max(1),
});

export const MassSettingSchema = z.discriminatedUnion('source', [
  /** Mass properties from the engineering model (geometry × density, or a published mass). */
  z.object({ source: z.literal('model') }),
  /** A user-supplied mass (kg); inertia from the body geometry with uniform density. */
  z.object({ source: z.literal('user'), massKg: positive.max(1e6), note: Note }),
  /** Geometry × the density of a selected library material (an explicit approximate model). */
  z.object({ source: z.literal('material'), materialId: z.string().min(1).max(96) }),
  /**
   * Phase 8: complete rigid-body mass properties supplied by a source document (e.g. a URDF
   * <inertial>) or the user: mass, centre of mass and the inertia tensor about the centre of
   * mass, all in the body node's LOCAL frame (m, kg·m²). Used as given — not derived from
   * geometry. The tensor must be physically realisable (positive principal moments that
   * satisfy the triangle inequalities).
   */
  z
    .object({
      source: z.literal('inertial'),
      massKg: positive.max(1e6),
      comM: z.tuple([finite, finite, finite]),
      /** [ixx, iyy, izz, ixy, ixz, iyz] about the centre of mass. */
      inertia: z.tuple([finite, finite, finite, finite, finite, finite]),
      note: Note,
    })
    .superRefine((m, ctx) => {
      const p = inertiaIssue(m.inertia);
      if (p) ctx.addIssue({ code: 'custom', path: ['inertia'], message: p });
    }),
]);

/**
 * Physical realisability of an inertia tensor [ixx, iyy, izz, ixy, ixz, iyz]: symmetric
 * positive definite (Sylvester's criterion) with principal moments obeying the triangle
 * inequality (relative tolerance 1e-6). Returns a message, or null when valid.
 */
export function inertiaIssue(t: readonly number[]): string | null {
  const [a, b, c, d, e, f] = t as [number, number, number, number, number, number];
  const m1 = a;
  const m2 = a * b - d * d;
  const m3 = a * (b * c - f * f) - d * (d * c - f * e) + e * (d * f - b * e);
  if (!(m1 > 0 && m2 > 0 && m3 > 0)) return 'inertia tensor is not positive definite';
  const tol = 1e-6 * (a + b + c);
  if (a + b < c - tol || a + c < b - tol || b + c < a - tol)
    return 'inertia moments violate the triangle inequality (not a physical rigid body)';
  return null;
}
export type MassSetting = z.infer<typeof MassSettingSchema>;

export const BODY_MODES = ['auto', 'dynamic', 'fixed', 'kinematic', 'excluded'] as const;
export const COLLIDER_MODES = ['auto', 'bounds-box', 'none'] as const;

export const BodySettingsSchema = z.object({
  nodeId: IdSchema,
  /** auto: assembly members dynamic (grounded → fixed); bodies outside assemblies fixed. */
  mode: z.enum(BODY_MODES),
  mass: MassSettingSchema,
  /** auto: one primitive collider per modelled solid; bounds-box: one box; none: no contact. */
  collider: z.enum(COLLIDER_MODES),
  friction: nonNeg.max(10),
  restitution: nonNeg.max(1),
  linearDamping: nonNeg.max(1000),
  angularDamping: nonNeg.max(1000),
  /** Continuous collision detection (fast, thin bodies). */
  ccd: z.boolean(),
  /** Initial (dynamic) or prescribed constant (kinematic) velocity, world frame. */
  linearVelocity: vec3,
  angularVelocity: vec3,
  /** User-defined contact load rating (N); contact force above it raises an overload warning. */
  contactLoadRatingN: positive.max(1e9).nullable(),
});
export type BodySettings = z.infer<typeof BodySettingsSchema>;

export const DEFAULT_BODY: Omit<BodySettings, 'nodeId'> = {
  mode: 'auto',
  mass: { source: 'model' },
  collider: 'auto',
  friction: 0.5,
  restitution: 0.1,
  linearDamping: 0,
  angularDamping: 0,
  ccd: false,
  linearVelocity: [0, 0, 0],
  angularVelocity: [0, 0, 0],
  contactLoadRatingN: null,
};

export const ACTUATOR_MODES = ['position', 'velocity', 'effort'] as const;

/**
 * Generic joint actuator ("servo"). Effort is torque (N·m) for revolute joints and force
 * (N) for prismatic ones; speed is rad/s or m/s; targets are rad or m. Controller:
 * position mode — the setpoint moves toward the target at ≤ speedLimit, and a PID torque
 * law tracks it; velocity mode — PI on velocity; effort mode — the commanded effort.
 * The applied effort is ALWAYS clamped to ±effortLimit (no infinite torque).
 */
export const ActuatorSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(ACTUATOR_MODES),
  target: finite,
  targetVelocity: finite,
  targetEffort: finite,
  effortLimit: positive.max(1e6),
  speedLimit: positive.max(1e4),
  /** Continuous rating (optional): exceeding it raises a warning (not a failure). */
  ratedEffort: positive.max(1e6).nullable(),
  /** auto: gains from the joint's effective inertia and a bandwidth; manual: as given. */
  gains: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('auto'), bandwidthHz: positive.max(200) }),
    z.object({ mode: z.literal('manual'), kp: nonNeg, kd: nonNeg, ki: nonNeg }),
  ]),
  /** Controller update rate (Hz); ≤ the physics sub-step rate (zero-order hold between updates). */
  controlRateHz: positive.max(10_000),
  /** Where the limits come from: generic defaults, or cited datasheet values (not validated). */
  source: z.enum(['generic', 'datasheet-cited', 'user']),
  sourceNote: Note,
});
export type Actuator = z.infer<typeof ActuatorSchema>;

export const JointSettingsSchema = z.object({
  mateId: IdSchema,
  /** Viscous joint damping (N·m·s/rad or N·s/m). */
  damping: nonNeg.max(1e6),
  /** Coulomb joint friction (N·m or N), smoothed near zero velocity. */
  friction: nonNeg.max(1e6),
  actuator: ActuatorSchema.nullable(),
});
export type JointSettings = z.infer<typeof JointSettingsSchema>;

export const PayloadSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  /** Body the payload is rigidly attached to. */
  nodeId: IdSchema,
  massKg: nonNeg.max(1e5),
  /** Attachment point in the body's local frame (m). Modelled as a point mass. */
  offsetM: vec3,
});
export type Payload = z.infer<typeof PayloadSchema>;

export const ThresholdsSchema = z.object({
  /** Body angular speed above which an "excessive angular velocity" warning is raised (rad/s). */
  maxAngularSpeed: positive.max(1e5),
  /** Contact force above which a contact-overload warning is raised (N); null = off. */
  contactForceN: positive.max(1e9).nullable(),
  /** Joint coordinate beyond its limit by more than this (rad or m) is a limit violation. */
  limitTolerance: positive.max(1),
});

export const SimulationDefinitionSchema = z
  .object({
    schemaVersion: z.literal(SIMULATION_SCHEMA_VERSION),
    name: z.string().trim().min(1).max(200),
    solver: SolverSettingsSchema,
    gravityEnabled: z.boolean(),
    /** m/s², project frame (+Y up). */
    gravity: vec3.refine((g) => Math.hypot(...g) <= 1000, { message: '|gravity| must be ≤ 1000 m/s²' }),
    ground: GroundPlaneSchema,
    /** Contacts between non-adjacent bodies of the same assembly. */
    selfCollision: z.boolean(),
    /**
     * Allow resting bodies to SLEEP (skip simulation until disturbed). Off by default: a
     * sleeping body can freeze in a non-equilibrium pose (e.g. a pendulum at its turning
     * point), which changes results. Enable only for large scenes where that is acceptable.
     */
    allowSleeping: z.boolean().default(false),
    /** Start from the current CAD joint coordinates, or from each mate's home values. */
    initialPose: z.enum(['current', 'home']),
    bodies: z.array(BodySettingsSchema).max(20_000),
    joints: z.array(JointSettingsSchema).max(2000),
    payloads: z.array(PayloadSchema).max(256),
    thresholds: ThresholdsSchema,
    recording: z.object({
      sampleRateHz: positive.max(1000),
      maxSamples: z.number().int().min(100).max(200_000),
    }),
    /** Explicit user consent for documented approximations (each one is listed in the run). */
    approvals: z.object({
      /** Driving assembly constraints have no dynamic equivalent; they are ignored if approved. */
      ignoreDrivingConstraints: z.boolean(),
      /** Joint limits Rapier cannot enforce (ball, cylindrical, planar) are dropped if approved. */
      ignoreUnsupportedLimits: z.boolean(),
    }),
  })
  .superRefine((d, ctx) => {
    const unique = (ids: string[], path: string) => {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id))
          ctx.addIssue({ code: 'custom', path: [path], message: `duplicate entry for "${id}"` });
        seen.add(id);
      }
    };
    unique(
      d.bodies.map((b) => b.nodeId),
      'bodies',
    );
    unique(
      d.joints.map((j) => j.mateId),
      'joints',
    );
    unique(
      d.payloads.map((p) => p.id),
      'payloads',
    );
  });
export type SimulationDefinition = z.infer<typeof SimulationDefinitionSchema>;

export function defaultSimulationDefinition(name = 'Simulation'): SimulationDefinition {
  return {
    schemaVersion: SIMULATION_SCHEMA_VERSION,
    name,
    solver: { ...DEFAULT_SOLVER },
    gravityEnabled: true,
    gravity: [0, -9.80665, 0],
    ground: { enabled: true, heightM: 0, friction: 0.6, restitution: 0.1 },
    selfCollision: false,
    allowSleeping: false,
    initialPose: 'current',
    bodies: [],
    joints: [],
    payloads: [],
    thresholds: { maxAngularSpeed: 50, contactForceN: null, limitTolerance: 0.01 },
    recording: { sampleRateHz: 60, maxSamples: 6000 },
    approvals: { ignoreDrivingConstraints: false, ignoreUnsupportedLimits: false },
  };
}

/** Effective settings of one body (defaults + its override, if any). */
export function bodySettingsFor(d: SimulationDefinition, nodeId: string): BodySettings {
  return d.bodies.find((b) => b.nodeId === nodeId) ?? { nodeId, ...DEFAULT_BODY };
}
