import { z } from 'zod';

/**
 * Persistent twin metadata (one document per project, `<ns>:twin:<projectId>`, schema v1).
 * It is SEPARATE from the project file and its undo history, from transient telemetry
 * (pipeline buffers) and from recorded observations (recordings in the run-data store).
 */
export const TWIN_SCHEMA_VERSION = 1 as const;
const Id = z.string().trim().min(1).max(128);
const Text = (n: number) => z.string().max(n);
const finite = z.number().finite();

export const ChannelMappingSchema = z.object({
  /** Device channel id as declared by the firmware (@C). */
  channel: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/),
  /** What the channel is, as declared by the device; a commanded value is never shown as measured. */
  kind: z.enum(['measured', 'commanded', 'estimated']),
  /** Unit the device reports (must match its declaration). */
  deviceUnit: Text(32),
  /** Virtual quantity it corresponds to. */
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('joint'), mateId: Id }),
    z.object({ kind: z.literal('sensor'), partId: Id, quantity: z.enum(['distance']) }),
    z.object({ kind: z.literal('none') }),
  ]),
  /** Unit of the virtual quantity (rad for revolute joints, m for distances…). */
  modelUnit: Text(32),
  /** Simulation signal to compare with (Phase 5/6 signal key, e.g. "US1.reported", "j-shoulder.q"). */
  simulationSignal: Text(128).nullable(),
  /** Linear calibration applied after unit conversion: model = gain · x + offset. */
  calibration: z.object({
    gain: finite,
    offset: finite,
    source: z.enum(['none', 'manual', 'calibration-record']),
    recordId: Id.nullable(),
  }),
  interpolation: z.enum(['hold', 'linear']),
  /** Largest gap bridged by interpolation (s); larger gaps stay missing. */
  maxGapS: finite.positive().max(60),
});
export type ChannelMapping = z.infer<typeof ChannelMappingSchema>;

export const TwinSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(200),
  projectId: Id,
  /** Expected physical device (from the firmware hello); a different device is reported. */
  device: z.object({
    deviceId: Text(64),
    hardware: Text(200),
    firmware: Text(64),
    firmwareVersion: Text(32),
    transport: z.enum(['web-serial', 'bridge', 'synthetic']),
    baud: z.number().int().positive().max(2_000_000),
  }),
  /** Virtual component ids this twin represents (scene nodes, mates, circuit parts). */
  components: z.array(Id).max(256),
  channels: z.array(ChannelMappingSchema).max(64),
  /** Sensor mounting frame in the project (m, rad): where a distance is measured from. */
  frames: z
    .array(
      z.object({
        channel: Text(16),
        nodeId: Id,
        offsetM: z.tuple([finite, finite, finite]),
        note: Text(500),
      }),
    )
    .max(64),
  staleAfterMs: z.number().int().min(50).max(60_000),
  assumptions: z.array(Text(500)).max(50),
  uncertainties: z
    .array(z.object({ channel: Text(16), sd: finite.min(0), unit: Text(32), basis: Text(500) }))
    .max(64),
  /** Phase 7 evidence (ids in the research document) and twin recordings. */
  evidence: z.object({
    recordings: z.array(Id).max(500),
    calibrations: z.array(Id).max(500),
    validations: z.array(Id).max(500),
  }),
  revision: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Twin = z.infer<typeof TwinSchema>;

export const TwinDocumentSchema = z.object({
  format: z.literal('forge-twins'),
  schemaVersion: z.literal(TWIN_SCHEMA_VERSION),
  projectId: Id,
  twins: z.array(TwinSchema).max(32),
});
export type TwinDocument = z.infer<typeof TwinDocumentSchema>;

export const emptyTwinDocument = (projectId: string): TwinDocument => ({
  format: 'forge-twins',
  schemaVersion: TWIN_SCHEMA_VERSION,
  projectId,
  twins: [],
});
