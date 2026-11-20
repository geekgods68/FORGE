import { z } from 'zod';
import { IdSchema, QuatSchema } from '../schemas';
import { MetadataSchema, PositionSchema, PrimitiveGeometrySchema, ScaleSchema } from '../scene/schemas';

/**
 * Command contract v1 for the engineering scene graph.
 * Every state-changing operation is one validated envelope; the same contract
 * serves the desktop UI, keyboard shortcuts, programmatic callers and (Phase 9) Vey.
 */
export const COMMAND_SOURCES = ['desktop-ui', 'keyboard', 'api', 'test', 'vey'] as const;
export type CommandSource = (typeof COMMAND_SOURCES)[number];

export const CommandMetadataSchema = z.object({
  source: z.enum(COMMAND_SOURCES),
  timestamp: z.iso.datetime(),
  /** If present, the command is rejected unless it equals the current project revision. */
  expectedRevision: z.number().int().min(0).optional(),
  /** Human-readable history label; defaults to one derived from the command type. */
  label: z.string().max(200).optional(),
});
export type CommandMetadata = z.infer<typeof CommandMetadataSchema>;

const Name = z.string().trim().min(1).max(200);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Index = z.number().int().min(0);

const PartialTransform = z
  .object({ position: PositionSchema, rotation: QuatSchema, scale: ScaleSchema })
  .partial();

const createCommon = {
  id: IdSchema.optional(),
  name: Name.optional(),
  parentId: IdSchema.optional(),
  index: Index.optional(),
  transform: PartialTransform.optional(),
  metadata: MetadataSchema.optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
};

export const CreateNodeSpecSchema = z.discriminatedUnion('kind', [
  z.object({ ...createCommon, kind: z.literal('group') }),
  z.object({
    ...createCommon,
    kind: z.literal('primitive'),
    geometry: PrimitiveGeometrySchema,
    color: Color.optional(),
  }),
  z.object({
    ...createCommon,
    kind: z.literal('reference'),
    referenceType: z.enum(['datum-axes', 'datum-point']),
    sizeM: z.number().min(1e-6).max(1000),
  }),
]);

/** Payloads of the single-node scene commands (usable on their own or inside a batch). */
export const NODE_PAYLOAD_SCHEMAS = {
  'scene.node.create': z.object({ node: CreateNodeSpecSchema }),
  'scene.node.delete': z.object({ nodeId: IdSchema }),
  'scene.node.duplicate': z.object({
    nodeId: IdSchema,
    /** World-aligned offset (metres) applied to the copy's local position. */
    offset: PositionSchema.optional(),
  }),
  'scene.node.rename': z.object({ nodeId: IdSchema, name: Name }),
  'scene.node.transform': z
    .object({
      nodeId: IdSchema,
      position: PositionSchema.optional(),
      rotation: QuatSchema.optional(),
      scale: ScaleSchema.optional(),
    })
    .refine((p) => p.position || p.rotation || p.scale, {
      message: 'at least one of position, rotation, scale is required',
    }),
  'scene.node.reparent': z.object({
    nodeId: IdSchema,
    parentId: IdSchema,
    /** Keep the node where it is in the world (default) instead of keeping its local transform. */
    keepWorldTransform: z.boolean().default(true),
    index: Index.optional(),
  }),
  'scene.node.visibility': z.object({ nodeId: IdSchema, visible: z.boolean() }),
  'scene.node.lock': z.object({ nodeId: IdSchema, locked: z.boolean() }),
  'scene.node.group': z.object({
    nodeIds: z
      .array(IdSchema)
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'nodeIds must be unique',
      }),
    groupId: IdSchema.optional(),
    name: Name.optional(),
  }),
  'scene.node.ungroup': z.object({ groupId: IdSchema }),
} as const;

export type NodeCommandType = keyof typeof NODE_PAYLOAD_SCHEMAS;

/** Upper bound on sub-commands in one batch (resource guard). */
export const MAX_BATCH_COMMANDS = 10_000;

const sub = <T extends NodeCommandType>(type: T) =>
  z.object({ type: z.literal(type), payload: NODE_PAYLOAD_SCHEMAS[type] });

/** One step of a `scene.batch` (any single-node command; batches do not nest). */
export const BatchSubCommandSchema = z.discriminatedUnion('type', [
  sub('scene.node.create'),
  sub('scene.node.delete'),
  sub('scene.node.duplicate'),
  sub('scene.node.rename'),
  sub('scene.node.transform'),
  sub('scene.node.reparent'),
  sub('scene.node.visibility'),
  sub('scene.node.lock'),
  sub('scene.node.group'),
  sub('scene.node.ungroup'),
]);
export type BatchSubCommand = z.output<typeof BatchSubCommandSchema>;

export const PAYLOAD_SCHEMAS = {
  ...NODE_PAYLOAD_SCHEMAS,
  /**
   * Atomic batch: all sub-commands apply in order inside ONE transaction with ONE
   * integrity check and ONE history entry; if any step fails, nothing changes.
   */
  'scene.batch': z.object({ commands: z.array(BatchSubCommandSchema).min(1).max(MAX_BATCH_COMMANDS) }),
} as const;

export type CommandType = keyof typeof PAYLOAD_SCHEMAS;
export const COMMAND_TYPES = Object.keys(PAYLOAD_SCHEMAS) as CommandType[];
export type PayloadOf<T extends CommandType> = z.output<(typeof PAYLOAD_SCHEMAS)[T]>;
export type PayloadInput<T extends CommandType> = z.input<(typeof PAYLOAD_SCHEMAS)[T]>;

const envelope = <T extends CommandType>(type: T) =>
  z.object({
    commandId: IdSchema,
    type: z.literal(type),
    payload: PAYLOAD_SCHEMAS[type],
    metadata: CommandMetadataSchema,
  });

export const CommandEnvelopeSchema = z.discriminatedUnion('type', [
  envelope('scene.node.create'),
  envelope('scene.node.delete'),
  envelope('scene.node.duplicate'),
  envelope('scene.node.rename'),
  envelope('scene.node.transform'),
  envelope('scene.node.reparent'),
  envelope('scene.node.visibility'),
  envelope('scene.node.lock'),
  envelope('scene.node.group'),
  envelope('scene.node.ungroup'),
  envelope('scene.batch'),
]);

/** A validated command (strongly typed discriminated union). */
export type Command = z.output<typeof CommandEnvelopeSchema>;
/** What a caller submits before defaults are applied. */
export type CommandInput = z.input<typeof CommandEnvelopeSchema>;

export const isCommandType = (t: unknown): t is CommandType =>
  typeof t === 'string' && Object.prototype.hasOwnProperty.call(PAYLOAD_SCHEMAS, t);
