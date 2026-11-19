import { z } from 'zod';
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

export const SceneNodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...nodeBase, kind: z.literal('root') }),
  z.object({ ...nodeBase, kind: z.literal('group') }),
  z.object({ ...nodeBase, kind: z.literal('primitive'), geometry: PrimitiveGeometrySchema, color: hexColor }),
  z.object({
    ...nodeBase,
    kind: z.literal('reference'),
    referenceType: z.enum(['datum-axes', 'datum-point']),
    sizeM: length,
  }),
  /** Extension point (Phase 3): a placed component-catalogue definition. */
  z.object({ ...nodeBase, kind: z.literal('component-instance'), definitionId: IdSchema }),
  /** Extension point (Phase 4): container that will carry mates/constraints. */
  z.object({ ...nodeBase, kind: z.literal('assembly') }),
]);

export const NODE_KINDS = [
  'root',
  'group',
  'primitive',
  'reference',
  'component-instance',
  'assembly',
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
