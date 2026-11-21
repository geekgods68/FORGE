import { z } from 'zod';
import { IdSchema, QuatSchema } from '../schemas';
import {
  AssemblyConstraintSchema,
  ComponentParamValueSchema,
  FeatureSchema,
  JointLimitSchema,
  MATE_TYPES,
  MateEndSchema,
  MetadataSchema,
  ModelInterfacesSchema,
  ModelRefSchema,
  PositionSchema,
  PrimitiveGeometrySchema,
  ProfileSchema,
  ScaleSchema,
  SketchConstraintSchema,
  SketchEntitySchema,
} from '../scene/schemas';

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
    kind: z.literal('component-instance'),
    /** Component-library definition id (validated by the engine's component resolver). */
    definitionId: IdSchema,
    variantId: z.string().min(1).max(96).nullable().optional(),
    /** Parameter overrides (metres / radians / option values); defaults fill the rest. */
    parameters: z.record(z.string().min(1).max(64), ComponentParamValueSchema).optional(),
    materialId: z.string().min(1).max(96).nullable().optional(),
  }),
  z.object({
    ...createCommon,
    kind: z.literal('reference'),
    referenceType: z.enum(['datum-axes', 'datum-point']),
    sizeM: z.number().min(1e-6).max(1000),
  }),
]);

const configurePayload = z.object({
  nodeId: IdSchema,
  variantId: z.string().min(1).max(96).nullable().optional(),
  parameters: z.record(z.string().min(1).max(64), ComponentParamValueSchema).optional(),
  materialId: z.string().min(1).max(96).nullable().optional(),
});
const finite = z.number();
const len = z.number().min(1e-6).max(1000);
const Vec2 = z.tuple([finite, finite]);
const placement = {
  id: IdSchema.optional(),
  name: Name.optional(),
  parentId: IdSchema.optional(),
  transform: PartialTransform.optional(),
};
const MateInput = z.object({
  id: IdSchema.optional(),
  name: Name.optional(),
  type: z.enum(MATE_TYPES),
  a: MateEndSchema,
  b: MateEndSchema,
  alignment: z.enum(['opposed', 'aligned']).optional(),
  offsetRad: finite.optional(),
  coordinates: z.array(finite).max(3).optional(),
  home: z.array(finite).max(3).optional(),
  limits: z.array(JointLimitSchema.nullable()).max(3).optional(),
});
const ConstraintInput = AssemblyConstraintSchema.extend({
  id: IdSchema.optional(),
  name: Name.optional(),
  value: finite.nullable().optional(),
  driving: z.boolean().optional(),
});
const featureId = { partId: IdSchema, id: IdSchema.optional() };

/** Phase 4 mechanical / CAD commands (node-scoped: each edits nodes, so all work inside batches). */
export const MECHANICAL_PAYLOAD_SCHEMAS = {
  'assembly.create': z.object({ ...placement, nodeIds: z.array(IdSchema).max(10_000) }),
  'assembly.insertComponent': z.object({ assemblyId: IdSchema, nodeId: IdSchema }),
  'assembly.removeComponent': z.object({ assemblyId: IdSchema, nodeId: IdSchema }),
  'assembly.ground': z.object({ assemblyId: IdSchema, nodeId: IdSchema, grounded: z.boolean() }),
  'assembly.mate.create': z.object({ assemblyId: IdSchema, mate: MateInput }),
  'assembly.mate.update': z.object({
    assemblyId: IdSchema,
    mateId: IdSchema,
    patch: z.object({
      name: Name.optional(),
      /** Safe conversions only (see canConvertMate); coordinates carry over by kind. */
      type: z.enum(MATE_TYPES).optional(),
      alignment: z.enum(['opposed', 'aligned']).optional(),
      offsetRad: finite.optional(),
      limits: z.array(JointLimitSchema.nullable()).max(3).optional(),
      home: z.array(finite).max(3).optional(),
      suppressed: z.boolean().optional(),
    }),
  }),
  'assembly.mate.delete': z.object({ assemblyId: IdSchema, mateId: IdSchema }),
  'assembly.joint.setPosition': z.object({
    assemblyId: IdSchema,
    mateId: IdSchema,
    coordinates: z.array(finite).min(1).max(3),
  }),
  'assembly.joint.home': z.object({ assemblyId: IdSchema }),
  'assembly.constraint.add': z.object({ assemblyId: IdSchema, constraint: ConstraintInput }),
  'assembly.constraint.update': z.object({
    assemblyId: IdSchema,
    constraintId: IdSchema,
    patch: z.object({
      name: Name.optional(),
      a: MateEndSchema.optional(),
      b: MateEndSchema.optional(),
      value: finite.nullable().optional(),
      driving: z.boolean().optional(),
    }),
  }),
  'assembly.constraint.delete': z.object({ assemblyId: IdSchema, constraintId: IdSchema }),
  /** Alias of scene.component.configure that also re-solves the owning assembly. */
  'component.parameters.update': configurePayload,
  'sketch.create': z.object({
    ...placement,
    entities: z.array(SketchEntitySchema).max(2000).optional(),
    constraints: z.array(SketchConstraintSchema).max(4000).optional(),
  }),
  'sketch.entity.add': z.object({
    sketchId: IdSchema,
    entities: z.array(SketchEntitySchema).min(1).max(2000),
  }),
  'sketch.constraint.add': z.object({
    sketchId: IdSchema,
    constraint: SketchConstraintSchema.extend({ id: IdSchema.optional() }),
  }),
  'sketch.constraint.delete': z.object({ sketchId: IdSchema, constraintId: IdSchema }),
  'part.create': z.object({
    ...placement,
    materialId: z.string().min(1).max(96).nullable().optional(),
    /** Base extrusion: an explicit profile, or the closed loop of a sketch (copied at creation). */
    profile: ProfileSchema.optional(),
    fromSketchId: IdSchema.optional(),
    depth: len,
  }),
  'geometry.hole.create': z.object({ ...featureId, center: Vec2, diameter: len, depth: len.nullable() }),
  'geometry.cut.create': z.object({
    ...featureId,
    profile: z.array(Vec2).min(3).max(512),
    depth: len.nullable(),
  }),
  'geometry.boolean.create': z.object({
    ...featureId,
    op: z.enum(['union', 'difference', 'intersection']),
    profile: z.array(Vec2).min(3).max(512),
  }),
  'geometry.pattern.create': z.discriminatedUnion('kind', [
    z.object({
      ...featureId,
      kind: z.literal('rect'),
      target: IdSchema,
      countU: z.number().int().min(1).max(64),
      countV: z.number().int().min(1).max(64),
      spacingU: finite,
      spacingV: finite,
    }),
    z.object({
      ...featureId,
      kind: z.literal('circ'),
      target: IdSchema,
      count: z.number().int().min(2).max(128),
      center: Vec2,
      totalAngle: finite,
    }),
  ]),
  'geometry.mirror.create': z.object({
    ...featureId,
    target: IdSchema,
    axis: z.enum(['u', 'v']),
    offset: finite,
  }),
  'geometry.feature.update': z.object({ partId: IdSchema, feature: FeatureSchema }),
  'geometry.feature.delete': z.object({ partId: IdSchema, featureId: IdSchema }),
  'model.instance.create': z.object({ ...placement, model: ModelRefSchema }),
  /** Replace the user-declared connection interfaces of a placed imported model. */
  'model.instance.interfaces.set': z.object({ nodeId: IdSchema, interfaces: ModelInterfacesSchema }),
} as const;

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
  /**
   * Reconfigure a component instance through its definition: variant, parameter
   * overrides (merged onto the current values) and/or material. Validated by the
   * component resolver; one undoable step. Dimensions change here — never via scale.
   */
  'scene.component.configure': configurePayload,
  ...MECHANICAL_PAYLOAD_SCHEMAS,
} as const;

export type NodeCommandType = keyof typeof NODE_PAYLOAD_SCHEMAS;
export type MechanicalCommandType = keyof typeof MECHANICAL_PAYLOAD_SCHEMAS;

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
  sub('scene.component.configure'),
  sub('assembly.create'),
  sub('assembly.insertComponent'),
  sub('assembly.removeComponent'),
  sub('assembly.ground'),
  sub('assembly.mate.create'),
  sub('assembly.mate.update'),
  sub('assembly.mate.delete'),
  sub('assembly.joint.setPosition'),
  sub('assembly.joint.home'),
  sub('assembly.constraint.add'),
  sub('assembly.constraint.update'),
  sub('assembly.constraint.delete'),
  sub('component.parameters.update'),
  sub('sketch.create'),
  sub('sketch.entity.add'),
  sub('sketch.constraint.add'),
  sub('sketch.constraint.delete'),
  sub('part.create'),
  sub('geometry.hole.create'),
  sub('geometry.cut.create'),
  sub('geometry.boolean.create'),
  sub('geometry.pattern.create'),
  sub('geometry.mirror.create'),
  sub('geometry.feature.update'),
  sub('geometry.feature.delete'),
  sub('model.instance.create'),
  sub('model.instance.interfaces.set'),
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
  envelope('scene.component.configure'),
  envelope('assembly.create'),
  envelope('assembly.insertComponent'),
  envelope('assembly.removeComponent'),
  envelope('assembly.ground'),
  envelope('assembly.mate.create'),
  envelope('assembly.mate.update'),
  envelope('assembly.mate.delete'),
  envelope('assembly.joint.setPosition'),
  envelope('assembly.joint.home'),
  envelope('assembly.constraint.add'),
  envelope('assembly.constraint.update'),
  envelope('assembly.constraint.delete'),
  envelope('component.parameters.update'),
  envelope('sketch.create'),
  envelope('sketch.entity.add'),
  envelope('sketch.constraint.add'),
  envelope('sketch.constraint.delete'),
  envelope('part.create'),
  envelope('geometry.hole.create'),
  envelope('geometry.cut.create'),
  envelope('geometry.boolean.create'),
  envelope('geometry.pattern.create'),
  envelope('geometry.mirror.create'),
  envelope('geometry.feature.update'),
  envelope('geometry.feature.delete'),
  envelope('model.instance.create'),
  envelope('model.instance.interfaces.set'),
  envelope('scene.batch'),
]);

/** A validated command (strongly typed discriminated union). */
export type Command = z.output<typeof CommandEnvelopeSchema>;
/** What a caller submits before defaults are applied. */
export type CommandInput = z.input<typeof CommandEnvelopeSchema>;

export const isCommandType = (t: unknown): t is CommandType =>
  typeof t === 'string' && Object.prototype.hasOwnProperty.call(PAYLOAD_SCHEMAS, t);
