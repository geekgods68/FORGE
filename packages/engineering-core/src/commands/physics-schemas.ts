import { z } from 'zod';
import { IdSchema } from '../schemas';
import {
  ActuatorSchema,
  BodySettingsSchema,
  GroundPlaneSchema,
  PayloadSchema,
  SimulationDefinitionSchema,
  SolverSettingsSchema,
  ThresholdsSchema,
} from '../simulation/schemas';

/**
 * Phase 5 commands that change the persisted SIMULATION DEFINITION (setup). They are
 * ordinary validated, undoable engine commands. Running a simulation (stepping, forces,
 * motor targets) is NOT an engine command: runtime evolution lives in a @forge/physics
 * session and never enters the undo history or the CAD model.
 */
const finite = z.number().finite();
const vec3 = z.tuple([finite, finite, finite]);

export const PHYSICS_PAYLOAD_SCHEMAS = {
  /** Create the project's simulation definition (defaults, or a complete definition). */
  'physics.simulation.create': z.object({ definition: SimulationDefinitionSchema.optional() }),
  'physics.simulation.delete': z.object({}),
  /** World / solver settings (merged onto the current definition). */
  'physics.configure': z.object({
    patch: z
      .object({
        name: z.string().trim().min(1).max(200),
        solver: SolverSettingsSchema.partial(),
        gravityEnabled: z.boolean(),
        gravity: vec3,
        ground: GroundPlaneSchema.partial(),
        selfCollision: z.boolean(),
        allowSleeping: z.boolean(),
        initialPose: z.enum(['current', 'home']),
        thresholds: ThresholdsSchema.partial(),
        recording: z.object({ sampleRateHz: finite, maxSamples: z.number().int() }).partial(),
        approvals: z
          .object({ ignoreDrivingConstraints: z.boolean(), ignoreUnsupportedLimits: z.boolean() })
          .partial(),
      })
      .partial(),
  }),
  /** Per-body physical settings (merged onto the effective settings); null removes the override. */
  'physics.body.set': z.object({
    nodeId: IdSchema,
    settings: BodySettingsSchema.omit({ nodeId: true }).partial().nullable(),
  }),
  /** Joint damping/friction and actuator (merged); null removes the joint's settings. */
  'physics.joint.set': z.object({
    mateId: IdSchema,
    settings: z
      .object({ damping: finite, friction: finite, actuator: ActuatorSchema.partial().nullable() })
      .partial()
      .nullable(),
  }),
  /** Add or replace a payload (point mass rigidly attached to a body). */
  'physics.payload.set': z.object({ payload: PayloadSchema }),
  'physics.payload.delete': z.object({ payloadId: IdSchema }),
} as const;

export type PhysicsCommandType = keyof typeof PHYSICS_PAYLOAD_SCHEMAS;
