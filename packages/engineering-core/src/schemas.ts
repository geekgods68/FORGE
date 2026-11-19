import { z } from 'zod';
import { COMPONENT_CATEGORY_IDS } from './categories';

/**
 * Persisted FORGE project format, schema version 1.
 * Every persisted structure is validated at runtime with these schemas;
 * TypeScript types are inferred from them so the two cannot drift apart.
 */
export const PROJECT_SCHEMA_VERSION = 1 as const;

/** Workshop-scale coordinate bound (metres) to catch corrupt or absurd values. */
export const MAX_COORDINATE_M = 10_000;

const finite = z.number(); // zod 4 rejects NaN and ±Infinity by default
const positive = finite.positive();
export const IdSchema = z.string().min(1).max(128);
const isoDate = z.iso.datetime();

export const Vec3Schema = z.tuple([finite, finite, finite]);
export const QuatSchema = z
  .tuple([finite, finite, finite, finite])
  .refine((q) => Math.abs(Math.hypot(...q) - 1) <= 1e-6, { message: 'rotation must be a unit quaternion' });

export const TransformSchema = z.object({
  position: Vec3Schema.refine((p) => p.every((c) => Math.abs(c) <= MAX_COORDINATE_M), {
    message: `position must be within ±${MAX_COORDINATE_M} m`,
  }),
  rotation: QuatSchema,
});

export const EngineeringUnitsSchema = z.object({
  length: z.literal('m'),
  angle: z.literal('rad'),
  mass: z.literal('kg'),
  time: z.literal('s'),
  temperature: z.literal('K'),
});

/** docs/SIMULATION_VALIDITY.md */
export const ValidityStatusSchema = z.enum(['verified', 'approximate', 'illustrative', 'unsupported']);

export const SimulationCapabilitySchema = z.object({
  domain: z.enum(['rigid-body', 'kinematics', 'structural', 'electrical', 'thermal', 'fluid', 'optical']),
  status: ValidityStatusSchema,
  /** Name/version of the model or solver, or 'none'. */
  model: z.string().min(1),
  assumptions: z.array(z.string()),
});

export const MaterialDefinitionSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  densityKgPerM3: positive.optional(),
  /** Display colour only — not a physical property. */
  renderColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  source: z.string().min(1),
  status: ValidityStatusSchema,
});

export const InterfaceKindSchema = z.enum([
  'mechanical-mount',
  'shaft',
  'electrical-pin',
  'electrical-connector',
  'fluid-port',
  'data-port',
]);

export const ConnectionInterfaceSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  kind: InterfaceKindSchema,
  /** Pose of the interface in the component's local frame (metres). */
  localTransform: TransformSchema,
  compatibleKinds: z.array(InterfaceKindSchema),
});

/** Imported model reference. Dimensions are never trusted until explicitly validated. */
export const ModelAssetSchema = z.object({
  uri: z
    .string()
    .regex(/^assets\/[\w./-]+\.(glb|gltf)$/, 'model uri must be a relative assets/… .glb or .gltf path'),
  /** Multiply model units by this to obtain metres (e.g. 0.001 for millimetre-authored models). */
  unitScaleToMetres: positive,
  upAxis: z.enum(['Y', 'Z']),
  dimensionsValidated: z.boolean(),
});

export const GeometrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('box'), sizeM: z.tuple([positive, positive, positive]) }),
  z.object({ kind: z.literal('cylinder'), radiusM: positive, heightM: positive }),
  z.object({ kind: z.literal('sphere'), radiusM: positive }),
  z.object({ kind: z.literal('model'), asset: ModelAssetSchema }),
]);

/** What a component IS (shared by all of its placed instances). */
export const ComponentDefinitionSchema = z.object({
  id: IdSchema,
  revision: z.number().int().positive(),
  name: z.string().min(1),
  categoryId: z.enum(COMPONENT_CATEGORY_IDS),
  description: z.string(),
  geometry: GeometrySchema,
  materialId: IdSchema.optional(),
  interfaces: z.array(ConnectionInterfaceSchema),
  capabilities: z.array(SimulationCapabilitySchema),
  provenance: z.string().min(1),
});

export const ConfigValueSchema = z.union([finite, z.string(), z.boolean()]);

/** One placed occurrence of a definition, with its own identity, pose and configuration. */
export const ComponentInstanceSchema = z.object({
  id: IdSchema,
  definitionId: IdSchema,
  name: z.string().min(1),
  transform: TransformSchema,
  configuration: z.record(z.string(), ConfigValueSchema),
});

export const AssemblySchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  memberInstanceIds: z.array(IdSchema),
});

export const SceneSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  instances: z.array(ComponentInstanceSchema),
  assemblies: z.array(AssemblySchema),
});

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    id: IdSchema,
    name: z.string().min(1).max(200),
    createdAt: isoDate,
    updatedAt: isoDate,
    units: EngineeringUnitsSchema,
    materials: z.array(MaterialDefinitionSchema),
    definitions: z.array(ComponentDefinitionSchema),
    scenes: z.array(SceneSchema).min(1),
    activeSceneId: IdSchema,
  })
  .superRefine((p, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const unique = (ids: string[], path: string) => {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) issue([path], `duplicate id "${id}"`);
        seen.add(id);
      }
    };
    unique(
      p.materials.map((m) => m.id),
      'materials',
    );
    unique(
      p.definitions.map((d) => d.id),
      'definitions',
    );
    unique(
      p.scenes.map((s) => s.id),
      'scenes',
    );
    const materialIds = new Set(p.materials.map((m) => m.id));
    const definitionIds = new Set(p.definitions.map((d) => d.id));
    p.definitions.forEach((d, i) => {
      if (d.materialId && !materialIds.has(d.materialId))
        issue(['definitions', i, 'materialId'], `unknown material "${d.materialId}"`);
    });
    if (!p.scenes.some((s) => s.id === p.activeSceneId))
      issue(['activeSceneId'], `unknown scene "${p.activeSceneId}"`);
    p.scenes.forEach((s, si) => {
      unique(
        s.instances.map((x) => x.id),
        `scenes.${si}.instances`,
      );
      const instanceIds = new Set(s.instances.map((x) => x.id));
      s.instances.forEach((inst, ii) => {
        if (!definitionIds.has(inst.definitionId))
          issue(
            ['scenes', si, 'instances', ii, 'definitionId'],
            `unknown component definition "${inst.definitionId}"`,
          );
      });
      s.assemblies.forEach((a, ai) =>
        a.memberInstanceIds.forEach((m, mi) => {
          if (!instanceIds.has(m))
            issue(['scenes', si, 'assemblies', ai, 'memberInstanceIds', mi], `unknown instance "${m}"`);
        }),
      );
    });
  });

export type ValidityStatus = z.infer<typeof ValidityStatusSchema>;
export type SimulationCapability = z.infer<typeof SimulationCapabilitySchema>;
export type MaterialDefinition = z.infer<typeof MaterialDefinitionSchema>;
export type ConnectionInterface = z.infer<typeof ConnectionInterfaceSchema>;
export type Geometry = z.infer<typeof GeometrySchema>;
export type ComponentDefinition = z.infer<typeof ComponentDefinitionSchema>;
export type ComponentInstance = z.infer<typeof ComponentInstanceSchema>;
export type Assembly = z.infer<typeof AssemblySchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Project = z.infer<typeof ProjectSchema>;
