import {
  COMPONENT_CATEGORY_IDS,
  SimulationCapabilitySchema,
  ValidityStatusSchema,
} from '@forge/engineering-core';
import { z } from 'zod';

/**
 * Component-library schemas (library schema v1).
 *
 * A COMPONENT DEFINITION (family) describes what a component is: identity, taxonomy,
 * parameters with units and ranges, variants/presets, a geometry generator reference,
 * material, connection interfaces, engineering specs, provenance and validity.
 * A COMPONENT INSTANCE (in an engineering project) references a definition by id and
 * stores only its variant, resolved parameters, material, transform and connections.
 *
 * Units: every stored length is metres, every angle radians, mass kg. Display units
 * (mm, degrees) are declared per parameter and applied only in the UI.
 * Unknown physical values are `null` — never 0.
 */
export const COMPONENT_LIBRARY_SCHEMA_VERSION = 1 as const;

const finite = z.number();
export const ComponentIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{0,95}$/, 'ids are lowercase kebab-case (a–z, 0–9, ".", "-")');

/** Implementation tier (docs/COMPONENT_SCHEMA.md). */
export const TierSchema = z.enum(['A', 'B', 'C']);
export const TIER_LABELS = {
  A: 'Fully parametric',
  B: 'Dimensional model',
  C: 'Catalogue entry · generic preview',
} as const;

/**
 * Provenance of the DATA (dimensions, specs, pinouts) — distinct from simulation validity.
 * - `standard`: dimensions from a named public standard (e.g. ISO 4762 heads).
 * - `datasheet-cited`: values transcribed from a cited public datasheet/document; not
 *   independently measured or verified by FORGE.
 * - `generic`: a representative generic part; NOT a replica of any specific product.
 * - `unverified`: values entered without a cited reference.
 */
export const DataStatusSchema = z.enum(['standard', 'datasheet-cited', 'generic', 'unverified']);

export const LengthParamSchema = z.object({
  kind: z.literal('length'),
  id: z.string().min(1),
  label: z.string().min(1),
  defaultM: finite.positive(),
  minM: finite.positive(),
  maxM: finite.positive(),
  /** Display unit for precision controls. */
  displayUnit: z.enum(['mm', 'm']).default('mm'),
});
export const CountParamSchema = z.object({
  kind: z.literal('count'),
  id: z.string().min(1),
  label: z.string().min(1),
  default: z.number().int(),
  min: z.number().int(),
  max: z.number().int(),
});
export const AngleParamSchema = z.object({
  kind: z.literal('angle'),
  id: z.string().min(1),
  label: z.string().min(1),
  defaultRad: finite,
  minRad: finite,
  maxRad: finite,
});
export const ChoiceParamSchema = z.object({
  kind: z.literal('choice'),
  id: z.string().min(1),
  label: z.string().min(1),
  options: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).min(1),
  default: z.string().min(1),
});
export const BooleanParamSchema = z.object({
  kind: z.literal('boolean'),
  id: z.string().min(1),
  label: z.string().min(1),
  default: z.boolean(),
});
export const ParameterDefSchema = z.discriminatedUnion('kind', [
  LengthParamSchema,
  CountParamSchema,
  AngleParamSchema,
  ChoiceParamSchema,
  BooleanParamSchema,
]);
export const ParamValueSchema = z.union([finite, z.string(), z.boolean()]);
export const ParamValuesSchema = z.record(z.string(), ParamValueSchema);

export const VariantSchema = z.object({
  id: ComponentIdSchema,
  name: z.string().min(1),
  /** Parameter overrides relative to the family defaults. */
  parameters: ParamValuesSchema,
  partNumber: z.string().optional(),
  note: z.string().optional(),
});

/** One engineering spec value. `value: null` means unknown — shown as "unknown", never 0. */
export const SpecSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.union([finite, z.string()]).nullable(),
  unit: z.string(),
  status: DataStatusSchema,
  note: z.string().optional(),
});

export const ReferenceSchema = z.object({
  title: z.string().min(1),
  kind: z.enum(['datasheet', 'standard', 'documentation', 'handbook']),
  /** Only real, known URLs; omitted when not certain. */
  url: z.url().optional(),
  note: z.string().optional(),
});

export const ManufacturerSchema = z.object({
  name: z.string().min(1),
  /** Marks a family that names a commercial product (shown with its data status). */
  product: z.string().min(1),
});

export const INTERFACE_TYPES = [
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
export const InterfaceTypeSchema = z.enum(INTERFACE_TYPES);

/** A connection interface in the component's local frame (metres; direction = outward unit normal). */
export const InterfaceSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1),
  type: InterfaceTypeSchema,
  position: z.tuple([finite, finite, finite]),
  direction: z
    .tuple([finite, finite, finite])
    .refine((d) => Math.abs(Math.hypot(...d) - 1) < 1e-6, { message: 'direction must be a unit vector' }),
  gender: z.enum(['male', 'female', 'neutral']).nullable(),
  /** Mating descriptors, e.g. 'M3-clearance', '2.54mm-header', 'servo-spline-25T', 'USB-B'. */
  compatibility: z.array(z.string().min(1)).min(1),
  /** Signal / pin function where relevant (e.g. 'D13', 'VCC', 'GND'). */
  signal: z.string().optional(),
  limits: z.array(SpecSchema).default([]),
});

export const GeometryRefSchema = z.object({
  /** Registered generator id (geometry/generators.ts). */
  generator: z.string().min(1),
  /** Fixed generator inputs not exposed as user parameters (e.g. a board layout). */
  fixed: ParamValuesSchema.default({}),
  /**
   * `exact`: solids represent the full material (volume × density is meaningful).
   * `approximate`: simplified profile (e.g. T-slot, gear teeth) — mass is an estimate.
   * `envelope`: outer shape only (internals omitted) — geometric mass is NOT computed.
   */
  representation: z.enum(['exact', 'approximate', 'envelope']),
});

export const ComponentDefinitionSchema = z.object({
  schemaVersion: z.literal(COMPONENT_LIBRARY_SCHEMA_VERSION),
  id: ComponentIdSchema,
  revision: z.number().int().positive(),
  name: z.string().min(1),
  categoryId: z.enum(COMPONENT_CATEGORY_IDS),
  subcategoryId: z.string().min(1),
  family: z.string().min(1),
  description: z.string().min(1),
  tier: TierSchema,
  aliases: z.array(z.string()).default([]),
  parameters: z.array(ParameterDefSchema),
  variants: z.array(VariantSchema).default([]),
  geometry: GeometryRefSchema,
  /** Default material; null = unspecified (mass unknown). */
  materialId: z.string().nullable(),
  /** Materials the user may assign; empty = material is fixed by the product. */
  allowedMaterialIds: z.array(z.string()).default([]),
  /** Interfaces fixed by the definition (generators may add parameter-dependent ones). */
  interfaces: z.array(InterfaceSchema).default([]),
  specs: z.object({
    mechanical: z.array(SpecSchema).default([]),
    electrical: z.array(SpecSchema).default([]),
  }),
  /** Published mass (kg) where geometry cannot give one (envelope models); null = unknown. */
  specifiedMassKg: finite.positive().nullable().default(null),
  manufacturer: ManufacturerSchema.nullable().default(null),
  references: z.array(ReferenceSchema).default([]),
  dataStatus: DataStatusSchema,
  capabilities: z.array(SimulationCapabilitySchema),
});

export const MaterialSchema = z.object({
  id: ComponentIdSchema,
  name: z.string().min(1),
  class: z.enum([
    'metal',
    'polymer',
    'elastomer',
    'composite',
    'ceramic',
    'glass',
    'wood',
    'semiconductor',
    'other',
  ]),
  densityKgM3: finite.positive().nullable(),
  youngsModulusPa: finite.positive().nullable(),
  poissonRatio: finite.min(-1).max(0.5).nullable(),
  yieldStrengthPa: finite.positive().nullable(),
  ultimateStrengthPa: finite.positive().nullable(),
  thermalConductivityWmK: finite.positive().nullable(),
  electricalConductivitySm: finite.positive().nullable(),
  surface: z.object({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    roughness: finite.min(0).max(1),
    metalness: finite.min(0).max(1),
  }),
  source: z.string().min(1),
  /** Validity of these property values for engineering use (docs/SIMULATION_VALIDITY.md). */
  status: ValidityStatusSchema,
  notes: z.string().optional(),
});

export const SubcategorySchema = z.object({ id: z.string().min(1), name: z.string().min(1) });
export const CategorySchema = z.object({
  id: z.enum(COMPONENT_CATEGORY_IDS),
  number: z.number().int().min(1).max(28),
  name: z.string().min(1),
  /** lucide icon name (rendered by the desktop app). */
  icon: z.string().min(1),
  description: z.string().min(1),
  subcategories: z.array(SubcategorySchema).min(1),
});

export type Tier = z.infer<typeof TierSchema>;
export type DataStatus = z.infer<typeof DataStatusSchema>;
export type ParameterDef = z.infer<typeof ParameterDefSchema>;
export type ParamValue = z.infer<typeof ParamValueSchema>;
export type ParamValues = z.infer<typeof ParamValuesSchema>;
export type Variant = z.infer<typeof VariantSchema>;
export type Spec = z.infer<typeof SpecSchema>;
export type ComponentInterface = z.infer<typeof InterfaceSchema>;
export type InterfaceType = z.infer<typeof InterfaceTypeSchema>;
export type ComponentDefinition = z.infer<typeof ComponentDefinitionSchema>;
export type ComponentDefinitionInput = z.input<typeof ComponentDefinitionSchema>;
export type Material = z.infer<typeof MaterialSchema>;
export type Category = z.infer<typeof CategorySchema>;
