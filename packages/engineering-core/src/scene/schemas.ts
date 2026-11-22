import { z } from 'zod';
import { SimulationDefinitionSchema } from '../simulation/schemas';
import { COMPONENT_CATEGORY_IDS } from '../categories';
import { IdSchema, MAX_COORDINATE_M, QuatSchema } from '../schemas';

/**
 * Engineering scene graph (project schema v2).
 *
 * Units: metres, radians (quaternions), right-handed, +Y up.
 * Every node carries a local TRS transform relative to its parent. Physical size
 * of primitives lives in `geometry` (real dimensions), never in `scale`.
 */

/** Smallest/largest representable primitive dimension (1 µm … 1 km). */
export const MIN_LENGTH_M = 1e-6;
export const MAX_LENGTH_M = 1000;
export const MIN_SCALE = 1e-6;
export const MAX_SCALE = 1e6;
/** Resource limits for loaded/imported documents. */
export const MAX_NODES = 20_000;
export const MAX_DEPTH = 64;

const finite = z.number();
const length = finite.min(MIN_LENGTH_M).max(MAX_LENGTH_M);

export const PositionSchema = z
  .tuple([finite, finite, finite])
  .refine((p) => p.every((c) => Math.abs(c) <= MAX_COORDINATE_M), {
    message: `position must be within ±${MAX_COORDINATE_M} m`,
  });
export const ScaleSchema = z
  .tuple([finite, finite, finite])
  .refine((s) => s.every((c) => c >= MIN_SCALE && c <= MAX_SCALE), {
    message: `scale components must be between ${MIN_SCALE} and ${MAX_SCALE} (zero/negative scale unsupported)`,
  });

export const NodeTransformSchema = z.object({
  position: PositionSchema,
  rotation: QuatSchema,
  scale: ScaleSchema,
});

export const PrimitiveGeometrySchema = z.discriminatedUnion('shape', [
  z.object({ shape: z.literal('box'), width: length, height: length, depth: length }),
  z.object({ shape: z.literal('sphere'), radius: length }),
  z.object({ shape: z.literal('cylinder'), radius: length, height: length }),
  z.object({ shape: z.literal('cone'), radius: length, height: length }),
  z.object({ shape: z.literal('plane'), width: length, length: length }),
  z
    .object({ shape: z.literal('torus'), majorRadius: length, tubeRadius: length })
    .refine((t) => t.tubeRadius < t.majorRadius, {
      message: 'torus tubeRadius must be smaller than majorRadius',
    }),
]);

export const PRIMITIVE_SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'torus'] as const;

export const MetadataSchema = z.record(
  z.string().min(1).max(64),
  z.union([finite, z.string().max(1000), z.boolean()]),
);

const nodeBase = {
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  parentId: IdSchema.nullable(),
  /** Ordered child ids. Must mirror the children's parentId exactly. */
  childIds: z.array(IdSchema),
  transform: NodeTransformSchema,
  visible: z.boolean(),
  locked: z.boolean(),
  metadata: MetadataSchema,
};

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * Reference from a component-instance node to a COMPONENT-LIBRARY definition (Phase 3,
 * project schema v3). The definition itself (geometry generator, specs, interfaces)
 * lives in the catalogue and is shared by every instance; the instance stores only its
 * own configuration plus a small identity snapshot so that a project remains
 * self-describing — and is shown as a labelled placeholder, never silently replaced —
 * if its definition is unavailable.
 */
export const ComponentParamValueSchema = z.union([finite, z.string().max(200), z.boolean()]);
export const ComponentConnectionSchema = z.object({
  interfaceId: z.string().min(1).max(64),
  targetNodeId: IdSchema,
  targetInterfaceId: z.string().min(1).max(64),
});
export const ComponentRefSchema = z.object({
  /** Catalogue revision the parameters were resolved against. */
  catalogRevision: z.number().int().positive(),
  variantId: z.string().min(1).max(96).nullable(),
  /** Fully resolved parameter values (metres / radians / options). */
  parameters: z.record(z.string().min(1).max(64), ComponentParamValueSchema),
  materialId: z.string().min(1).max(96).nullable(),
  snapshot: z.object({
    name: z.string().min(1).max(200),
    categoryId: z.enum(COMPONENT_CATEGORY_IDS),
    subcategoryId: z.string().min(1).max(96),
    family: z.string().min(1).max(200),
    tier: z.enum(['A', 'B', 'C']),
    dataStatus: z.string().min(1).max(32),
    /** Bounding-box size [x, y, z] (m) at resolution time — sizes placeholders. */
    boundsM: z.tuple([length, length, length]),
  }),
  /** Declared (not solved) connections to other component interfaces. Phase 4 adds mates. */
  connections: z.array(ComponentConnectionSchema).max(512),
});

// ---------------------------------------------------------------------------
// Phase 4: mechanical assemblies, sketches, parametric parts, imported models.
// Units: metres and radians. Frames: right-handed; `axis` is a frame's +Z, `xRef` its +X.
// ---------------------------------------------------------------------------

const unitVec = z
  .tuple([finite, finite, finite])
  .refine((v) => Math.abs(Math.hypot(...v) - 1) < 1e-6, { message: 'must be a unit vector' });
const point3 = PositionSchema;

/** Reference geometry on a body: a declared component interface, or an explicit frame (body-local). */
export const FrameRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interface'), interfaceId: z.string().min(1).max(64) }),
  z
    .object({ kind: z.literal('frame'), origin: point3, axis: unitVec, xRef: unitVec })
    .refine((f) => Math.abs(f.axis[0] * f.xRef[0] + f.axis[1] * f.xRef[1] + f.axis[2] * f.xRef[2]) < 1e-6, {
      message: 'xRef must be perpendicular to axis',
    }),
]);
export const MateEndSchema = z.object({ nodeId: IdSchema, ref: FrameRefSchema });

export const MATE_TYPES = ['fixed', 'revolute', 'prismatic', 'cylindrical', 'ball', 'planar'] as const;
/** Joint coordinates per mate type (radians / metres). */
export const MATE_COORDINATES: Record<(typeof MATE_TYPES)[number], readonly ('angle' | 'length')[]> = {
  fixed: [],
  revolute: ['angle'],
  prismatic: ['length'],
  cylindrical: ['angle', 'length'],
  ball: ['angle', 'angle', 'angle'],
  planar: ['length', 'length', 'angle'],
};
export const JointLimitSchema = z
  .object({ min: finite, max: finite })
  .refine((l) => l.min <= l.max, { message: 'limit min must be ≤ max' });

export const MateSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(200),
    type: z.enum(MATE_TYPES),
    a: MateEndSchema,
    b: MateEndSchema,
    /** `opposed`: B's axis faces A's (face-to-face mounting); `aligned`: same direction. */
    alignment: z.enum(['opposed', 'aligned']),
    /** Fixed rotation about the mate axis (rad), applied before the joint motion. */
    offsetRad: finite,
    /** Current joint coordinates (rad / m), length = MATE_COORDINATES[type].length. */
    coordinates: z.array(finite).max(3),
    /** Home (reference) configuration. */
    home: z.array(finite).max(3),
    limits: z.array(JointLimitSchema.nullable()).max(3),
    suppressed: z.boolean(),
  })
  .superRefine((m, ctx) => {
    const n = MATE_COORDINATES[m.type].length;
    for (const k of ['coordinates', 'home', 'limits'] as const)
      if (m[k].length !== n)
        ctx.addIssue({ code: 'custom', path: [k], message: `${m.type} mates have ${n} coordinate(s)` });
    if (m.a.nodeId === m.b.nodeId)
      ctx.addIssue({ code: 'custom', path: ['b'], message: 'a mate needs two different bodies' });
    m.limits.forEach((l, i) => {
      if (l && (m.coordinates[i]! < l.min - 1e-9 || m.coordinates[i]! > l.max + 1e-9))
        ctx.addIssue({
          code: 'custom',
          path: ['coordinates', i],
          message: 'joint coordinate outside its limits',
        });
    });
  });

export const CONSTRAINT_TYPES = [
  'distance',
  'angle',
  'concentric',
  'coincident',
  'parallel',
  'perpendicular',
] as const;
export const AssemblyConstraintSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  type: z.enum(CONSTRAINT_TYPES),
  a: MateEndSchema,
  b: MateEndSchema,
  /** distance (m) or angle (rad); unused for the others. */
  value: finite.nullable(),
  /** Driving constraints position bodies; non-driving ones are only checked and reported. */
  driving: z.boolean(),
});

export const MechanicalSchema = z.object({
  grounded: z.array(IdSchema),
  mates: z.array(MateSchema).max(2000),
  constraints: z.array(AssemblyConstraintSchema).max(2000),
});

// -- sketches (2D, sketch-local XY plane = the sketch node's local XY plane) ----------

export const SketchEntitySchema = z.discriminatedUnion('kind', [
  z.object({ id: IdSchema, kind: z.literal('point'), x: finite, y: finite }),
  z.object({ id: IdSchema, kind: z.literal('line'), p1: IdSchema, p2: IdSchema }),
  z.object({ id: IdSchema, kind: z.literal('circle'), center: IdSchema, r: finite.positive() }),
  z.object({ id: IdSchema, kind: z.literal('arc'), center: IdSchema, start: IdSchema, end: IdSchema }),
]);
export const SKETCH_CONSTRAINT_TYPES = [
  'horizontal',
  'vertical',
  'coincident',
  'parallel',
  'perpendicular',
  'equal',
  'distance',
  'radius',
  'diameter',
  'angle',
  'fixed',
] as const;
export const SketchConstraintSchema = z.object({
  id: IdSchema,
  type: z.enum(SKETCH_CONSTRAINT_TYPES),
  /** Referenced entity ids (1–2). */
  refs: z.array(IdSchema).min(1).max(2),
  /** Dimension value (m or rad) where applicable; fixed: [x, y] encoded as value + value2. */
  value: finite.nullable(),
  value2: finite.nullable(),
});

// -- parametric parts (features on the part's local XZ plane, extruded along +Y) --------

const Vec2S = z.tuple([finite, finite]);
const polygon = z.array(Vec2S).min(3).max(512);
export const ProfileSchema = z.object({ outer: polygon, holes: z.array(polygon).max(256) });
export const FeatureSchema = z.discriminatedUnion('type', [
  z.object({
    id: IdSchema,
    type: z.literal('extrude'),
    profile: ProfileSchema,
    depth: length,
    sourceSketchId: IdSchema.nullable(),
  }),
  z.object({
    id: IdSchema,
    type: z.literal('hole'),
    center: Vec2S,
    diameter: length,
    depth: length.nullable() /* null = through */,
  }),
  z.object({ id: IdSchema, type: z.literal('cut'), profile: polygon, depth: length.nullable() }),
  z.object({
    id: IdSchema,
    type: z.literal('boolean'),
    op: z.enum(['union', 'difference', 'intersection']),
    profile: polygon,
  }),
  z.object({
    id: IdSchema,
    type: z.literal('pattern-rect'),
    target: IdSchema,
    countU: z.number().int().min(1).max(64),
    countV: z.number().int().min(1).max(64),
    spacingU: finite,
    spacingV: finite,
  }),
  z.object({
    id: IdSchema,
    type: z.literal('pattern-circ'),
    target: IdSchema,
    count: z.number().int().min(2).max(128),
    center: Vec2S,
    totalAngle: finite,
  }),
  z.object({
    id: IdSchema,
    type: z.literal('mirror'),
    target: IdSchema,
    axis: z.enum(['u', 'v']),
    offset: finite,
  }),
]);

// -- imported models (GLB / glTF) -----------------------------------------------------

/** Connection interface types (same vocabulary as catalogue component interfaces). */
export const MODEL_INTERFACE_TYPES = [
  'mechanical-mount',
  'bolt-hole',
  'shaft-coupling',
  'revolute-joint',
  'slider',
  'electrical-terminal',
  'gpio-pin',
  'power-terminal',
  'data-connector',
  'fluid-port',
  'optical-interface',
] as const;

/**
 * A connection interface DECLARED BY THE USER on an imported model (Phase 4.1). Nothing
 * here is inferred from the mesh: position, axis, orientation, tags and dimensions are
 * exactly what the user entered. Frame: the model-instance node's local frame (metres,
 * after the confirmed unit and up-axis conversion). `direction` is the mounting axis
 * (outward normal, the frame's +Z for mates) and `xRef` the in-plane reference (+X).
 */
export const ModelInterfaceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'use lowercase letters, digits, - or _ (max 64)'),
    name: z.string().trim().min(1).max(200),
    type: z.enum(MODEL_INTERFACE_TYPES),
    gender: z.enum(['male', 'female', 'neutral']).nullable(),
    position: z.tuple([finite, finite, finite]),
    direction: unitVec,
    xRef: unitVec,
    /** Mating descriptors, e.g. 'M3-clearance', 'servo-horn-mount' (at least one). */
    compatibility: z.array(z.string().trim().min(1).max(64)).min(1).max(16),
    /** Declared dimensions (metres), e.g. a hole or shaft diameter. */
    dimensions: z
      .object({ diameter: length.optional(), length: length.optional(), width: length.optional() })
      .default({}),
  })
  .refine(
    (i) =>
      Math.abs(i.direction[0] * i.xRef[0] + i.direction[1] * i.xRef[1] + i.direction[2] * i.xRef[2]) < 1e-6,
    { message: 'the orientation reference must be perpendicular to the mounting axis', path: ['xRef'] },
  );

export const ModelInterfacesSchema = z
  .array(ModelInterfaceSchema)
  .max(64)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((i, k) => {
      if (seen.has(i.id))
        ctx.addIssue({ code: 'custom', path: [k, 'id'], message: `duplicate interface id "${i.id}"` });
      seen.add(i.id);
    });
  });

export const ModelRefSchema = z.object({
  /** Content address of the stored asset bytes. */
  assetHash: z.string().regex(/^sha256-[0-9a-f]{64}$/),
  byteLength: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024),
  mediaType: z.enum(['model/gltf-binary', 'model/gltf+json']),
  name: z.string().trim().min(1).max(200),
  categoryId: z.enum(COMPONENT_CATEGORY_IDS),
  description: z.string().max(2000),
  /** Source unit confirmed by the user → metres. */
  unitScale: finite.positive(),
  upAxis: z.enum(['Y', 'Z']),
  /** Measured bounding-box size in metres (after unit/axis conversion). */
  boundsM: z.tuple([length, length, length]),
  /** Bounding-box minimum (model space, metres) — lets the renderer place the base on y = 0. */
  minM: z.tuple([finite, finite, finite]),
  /** User-supplied, untrusted metadata (plain strings only). */
  metadata: z.record(z.string().min(1).max(64), z.string().max(500)),
  /** User-declared connection interfaces (Phase 4.1; absent in older files → none). */
  interfaces: ModelInterfacesSchema.default([]),
});

export const SceneNodeSchema = z.discriminatedUnion('kind', [
  /** The project root. Phase 5: optionally carries the simulation definition (setup only, never runtime state). */
  z.object({ ...nodeBase, kind: z.literal('root'), simulation: SimulationDefinitionSchema.optional() }),
  z.object({ ...nodeBase, kind: z.literal('group') }),
  z.object({ ...nodeBase, kind: z.literal('primitive'), geometry: PrimitiveGeometrySchema, color: hexColor }),
  z.object({
    ...nodeBase,
    kind: z.literal('reference'),
    referenceType: z.enum(['datum-axes', 'datum-point']),
    sizeM: length,
  }),
  /**
   * A placed component. With `component`: a component-library definition (Phase 3).
   * Without: a legacy project-level definition (Phase 0 files) listed in `definitions`.
   */
  z.object({
    ...nodeBase,
    kind: z.literal('component-instance'),
    definitionId: IdSchema,
    component: ComponentRefSchema.optional(),
  }),
  /** Mechanical assembly: hierarchy PLUS mechanical relationships (mates, constraints, grounding). */
  z.object({
    ...nodeBase,
    kind: z.literal('assembly'),
    mechanical: MechanicalSchema.default({ grounded: [], mates: [], constraints: [] }),
  }),
  /** 2D sketch in the node's local XY plane. */
  z.object({
    ...nodeBase,
    kind: z.literal('sketch'),
    entities: z.array(SketchEntitySchema).max(2000),
    constraints: z.array(SketchConstraintSchema).max(4000),
  }),
  /** Parametric part built from an ordered feature list (prismatic features along local +Y). */
  z.object({
    ...nodeBase,
    kind: z.literal('part'),
    materialId: z.string().min(1).max(96).nullable(),
    features: z.array(FeatureSchema).min(1).max(512),
  }),
  /** Placed imported model (asset referenced by content hash; bytes live in the asset store / bundle). */
  z.object({ ...nodeBase, kind: z.literal('model-instance'), model: ModelRefSchema }),
]);

export const NODE_KINDS = [
  'root',
  'group',
  'primitive',
  'reference',
  'component-instance',
  'assembly',
  'sketch',
  'part',
  'model-instance',
] as const;

export const SceneGraphSchema = z.object({
  rootId: IdSchema,
  nodes: z.record(IdSchema, SceneNodeSchema),
});

export type NodeTransform = z.infer<typeof NodeTransformSchema>;
export type PrimitiveGeometry = z.infer<typeof PrimitiveGeometrySchema>;
export type PrimitiveShape = PrimitiveGeometry['shape'];
export type SceneNode = z.infer<typeof SceneNodeSchema>;
export type NodeKind = SceneNode['kind'];
export type SceneGraph = z.infer<typeof SceneGraphSchema>;
export type Metadata = z.infer<typeof MetadataSchema>;
export type ComponentRef = z.infer<typeof ComponentRefSchema>;
export type FrameRef = z.infer<typeof FrameRefSchema>;
export type MateEnd = z.infer<typeof MateEndSchema>;
export type Mate = z.infer<typeof MateSchema>;
export type MateType = Mate['type'];
export type AssemblyConstraint = z.infer<typeof AssemblyConstraintSchema>;
export type Mechanical = z.infer<typeof MechanicalSchema>;
export type SketchEntity = z.infer<typeof SketchEntitySchema>;
export type SketchConstraint = z.infer<typeof SketchConstraintSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Feature = z.infer<typeof FeatureSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;
export type ModelInterface = z.infer<typeof ModelInterfaceSchema>;
export type ComponentConnection = z.infer<typeof ComponentConnectionSchema>;
export type ComponentParamValue = z.infer<typeof ComponentParamValueSchema>;
