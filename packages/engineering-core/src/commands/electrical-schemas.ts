import { z } from 'zod';
import { IdSchema } from '../schemas';
import {
  CircuitGroupSchema,
  DeviceSchema,
  ElectricalDefinitionSchema,
  ElectricalPartSchema,
  FIRMWARE_LANGUAGES,
  FIRMWARE_MAX_BYTES,
  NetLabelSchema,
  SchematicPlacementSchema,
  WireSchema,
} from '../electrical/schemas';

/**
 * Phase 6 commands that change the persisted ELECTRICAL DEFINITION (circuit topology,
 * device parameters, wiring, labels, firmware, analysis settings). They are ordinary
 * validated, undoable engine commands, batchable with node commands (e.g. placing a 3D
 * component and adding its electrical part is one atomic step).
 *
 * Running an electrical simulation (solving, stepping firmware, probing) is NOT an engine
 * command: runtime state lives in an @forge/electronics session.
 */
const finite = z.number().finite();
const positive = finite.positive();
const nonNeg = finite.min(0);

export const ELECTRICAL_PAYLOAD_SCHEMAS = {
  /** Create the project's circuit (empty, or a complete definition — also used for import). */
  'electrical.circuit.create': z.object({ definition: ElectricalDefinitionSchema.optional() }),
  'electrical.circuit.delete': z.object({}),
  /** Replace the whole circuit with an imported, validated definition. */
  'electrical.circuit.import': z.object({ definition: ElectricalDefinitionSchema }),
  /** Rename the circuit / change analysis settings (merged). */
  'electrical.configure': z.object({
    patch: z
      .object({
        name: z.string().trim().min(1).max(200),
        solver: z
          .object({
            relTol: positive,
            absTolV: positive,
            absTolA: positive,
            maxNewtonIterations: z.number().int(),
            gmin: nonNeg,
          })
          .partial(),
        transient: z
          .object({ method: z.enum(['trapezoidal', 'backward-euler']), stepS: positive, stopS: positive })
          .partial(),
        cosim: z
          .object({
            opCostNs: nonNeg,
            ambientC: finite,
            seed: z.number().int(),
            recording: z
              .object({
                sampleRateHz: positive,
                maxSamples: z.number().int(),
                maxTransitions: z.number().int(),
              })
              .partial(),
          })
          .partial(),
      })
      .partial(),
  }),
  'electrical.part.add': z.object({ part: ElectricalPartSchema }),
  /** Change a part. `device` replaces the device model (same type unless the pins still exist). */
  'electrical.part.update': z.object({
    partId: IdSchema,
    patch: z
      .object({
        label: z.string().trim().min(1).max(40),
        name: z.string().trim().min(1).max(200),
        device: DeviceSchema,
        nodeId: IdSchema.nullable(),
        schematic: SchematicPlacementSchema,
        note: z.string().max(500),
      })
      .partial(),
  }),
  /** Remove a part together with every wire and label attached to it. */
  'electrical.part.remove': z.object({ partId: IdSchema }),
  'electrical.wire.add': z.object({ wire: WireSchema }),
  'electrical.wire.update': z.object({
    wireId: IdSchema,
    patch: z.object({ route: WireSchema.shape.route, color: WireSchema.shape.color }).partial(),
  }),
  'electrical.wire.remove': z.object({ wireId: IdSchema }),
  /** Add or replace a net label (named signal) on a pin. */
  'electrical.net.label': z.object({ label: NetLabelSchema }),
  'electrical.net.unlabel': z.object({ labelId: IdSchema }),
  'electrical.group.set': z.object({ group: CircuitGroupSchema }),
  'electrical.group.delete': z.object({ groupId: IdSchema }),
  /** Add or replace a firmware source (its revision is incremented automatically). */
  'electrical.firmware.set': z.object({
    firmware: z.object({
      id: IdSchema,
      name: z.string().trim().min(1).max(200),
      language: z.enum(FIRMWARE_LANGUAGES),
      source: z.string().max(FIRMWARE_MAX_BYTES),
    }),
  }),
  'electrical.firmware.delete': z.object({ firmwareId: IdSchema }),
} as const;

export type ElectricalCommandType = keyof typeof ELECTRICAL_PAYLOAD_SCHEMAS;
