import type { ComponentCategoryId } from '@forge/engineering-core';
import { STOCK_MATERIALS } from '../materials';
import {
  COMPONENT_LIBRARY_SCHEMA_VERSION,
  type ComponentDefinitionInput,
  type DataStatus,
  type ParameterDef,
  type Spec,
  type Tier,
  type Variant,
} from '../schemas';
import { slug } from '../taxonomy';

/** Builders that keep the catalogue declarative and consistent. All lengths given in mm are stored in metres. */
export const L = (id: string, label: string, defMm: number, minMm: number, maxMm: number): ParameterDef => ({
  kind: 'length',
  id,
  label,
  defaultM: defMm / 1000,
  minM: minMm / 1000,
  maxM: maxMm / 1000,
  displayUnit: 'mm',
});
export const N = (id: string, label: string, def: number, min: number, max: number): ParameterDef => ({
  kind: 'count',
  id,
  label,
  default: def,
  min,
  max,
});
export const C = (
  id: string,
  label: string,
  options: (string | [string, string])[],
  def?: string,
): ParameterDef => {
  const opts = options.map((o) =>
    typeof o === 'string' ? { value: o, label: o } : { value: o[0], label: o[1] },
  );
  return { kind: 'choice', id, label, options: opts, default: def ?? opts[0]!.value };
};
export const B = (id: string, label: string, def: boolean): ParameterDef => ({
  kind: 'boolean',
  id,
  label,
  default: def,
});

/** Variant helper: lengths in the `mm` record are converted to metres. */
export const V = (
  id: string,
  name: string,
  params: Record<string, number | string | boolean>,
  mmKeys: string[] = [],
  partNumber?: string,
): Variant => ({
  id,
  name,
  parameters: Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, mmKeys.includes(k) && typeof v === 'number' ? v / 1000 : v]),
  ),
  ...(partNumber ? { partNumber } : {}),
});

export const spec = (
  key: string,
  label: string,
  value: number | string | null,
  unit: string,
  status: DataStatus,
  note?: string,
): Spec => ({
  key,
  label,
  value,
  unit,
  status,
  ...(note ? { note } : {}),
});

/** No Phase 3 component is simulated: every domain is explicitly `unsupported` (docs/SIMULATION_VALIDITY.md). */
export const NO_SIMULATION = (
  domains: ('rigid-body' | 'kinematics' | 'structural' | 'electrical' | 'thermal' | 'fluid' | 'optical')[] = [
    'rigid-body',
  ],
) =>
  domains.map((domain) => ({
    domain,
    status: 'unsupported' as const,
    model: 'none',
    assumptions: ['No simulation model in Phase 3.'],
  }));

export interface FamilyOpts {
  description: string;
  tier: Tier;
  generator: string;
  representation: 'exact' | 'approximate' | 'envelope';
  parameters?: ParameterDef[];
  fixed?: Record<string, number | string | boolean>;
  variants?: Variant[];
  materialId?: string | null;
  allowedMaterialIds?: string[];
  aliases?: string[];
  mechanical?: Spec[];
  electrical?: Spec[];
  specifiedMassKg?: number | null;
  manufacturer?: { name: string; product: string } | null;
  references?: ComponentDefinitionInput['references'];
  dataStatus?: DataStatus;
  domains?: Parameters<typeof NO_SIMULATION>[0];
  interfaces?: ComponentDefinitionInput['interfaces'];
  family?: string;
}

export function fam(
  categoryId: ComponentCategoryId,
  subcategory: string,
  id: string,
  name: string,
  o: FamilyOpts,
): ComponentDefinitionInput {
  return {
    schemaVersion: COMPONENT_LIBRARY_SCHEMA_VERSION,
    id,
    revision: 1,
    name,
    categoryId,
    subcategoryId: slug(subcategory),
    family: o.family ?? subcategory,
    description: o.description,
    tier: o.tier,
    aliases: o.aliases ?? [],
    parameters: o.parameters ?? [],
    variants: o.variants ?? [],
    geometry: { generator: o.generator, fixed: o.fixed ?? {}, representation: o.representation },
    materialId: o.materialId === undefined ? null : o.materialId,
    allowedMaterialIds: o.allowedMaterialIds ?? [],
    interfaces: o.interfaces ?? [],
    specs: { mechanical: o.mechanical ?? [], electrical: o.electrical ?? [] },
    specifiedMassKg: o.specifiedMassKg ?? null,
    manufacturer: o.manufacturer ?? null,
    references: o.references ?? [],
    dataStatus: o.dataStatus ?? 'generic',
    capabilities: NO_SIMULATION(o.domains),
  };
}

// ------------------------------------------------------------ common family templates

/** Tier A rectangular stock (plates, sheets, blocks, panels) in a chosen material. */
export const plateFamily = (
  cat: ComponentCategoryId,
  sub: string,
  id: string,
  name: string,
  materialId: string,
  dims: [number, number, number],
  description: string,
  extra: Partial<FamilyOpts> = {},
) =>
  fam(cat, sub, id, name, {
    description,
    tier: 'A',
    generator: 'plate',
    representation: 'exact',
    materialId,
    allowedMaterialIds: STOCK_MATERIALS,
    parameters: [
      L('length', 'Length', dims[0], 1, 3000),
      L('width', 'Width', dims[1], 1, 2000),
      L('thickness', 'Thickness', dims[2], 0.01, 300),
      C('holes', 'Corner holes', [['none', 'None'], 'M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8'], 'none'),
      L('holeInset', 'Hole inset', 6, 2, 100),
    ],
    ...extra,
  });

/** Tier C/B generic block for entries awaiting a specialised model — always labelled generic. dimsMm = [x length, y height, z depth]. */
export const genericFamily = (
  cat: ComponentCategoryId,
  sub: string,
  id: string,
  name: string,
  dimsMm: [number, number, number],
  description: string,
  extra: Partial<FamilyOpts> = {},
) =>
  fam(cat, sub, id, name, {
    description: `${description} Generic preview — not a model of a specific product.`,
    tier: 'C',
    generator: 'generic-package',
    representation: 'envelope',
    parameters: [
      L('length', 'Length (X)', dimsMm[0], 0.001, 2000),
      L('height', 'Height (Y)', dimsMm[1], 0.0005, 2000),
      L('width', 'Depth (Z)', dimsMm[2], 0.001, 2000),
    ],
    materialId: null,
    dataStatus: 'generic',
    ...extra,
  });

/** Generic electronics module/breakout (PCB + component block + header pins). */
export const moduleFamily = (
  cat: ComponentCategoryId,
  sub: string,
  id: string,
  name: string,
  dimsMm: [number, number],
  pins: string,
  description: string,
  extra: Partial<FamilyOpts> = {},
) =>
  fam(cat, sub, id, name, {
    description: `${description} Generic module layout — not a replica of a specific board.`,
    tier: 'B',
    generator: 'board',
    representation: 'envelope',
    fixed: { layout: 'generic', pins },
    parameters: [
      L('length', 'Board length', dimsMm[0], 5, 300),
      L('width', 'Board width', dimsMm[1], 5, 300),
      L('componentHeight', 'Component height', 3, 0.5, 40),
      C(
        'pcbColor',
        'PCB colour',
        [
          ['pcb', 'Green'],
          ['pcb-blue', 'Blue'],
          ['black', 'Black'],
        ],
        'pcb',
      ),
    ],
    materialId: null,
    dataStatus: 'generic',
    domains: ['rigid-body', 'electrical'],
    ...extra,
  });

/** Discrete/IC package family (geometry generic per package style; electrical data generic). */
export const packageFamily = (
  cat: ComponentCategoryId,
  sub: string,
  id: string,
  name: string,
  pkg: string,
  pins: number,
  description: string,
  extra: Partial<FamilyOpts> = {},
) =>
  fam(cat, sub, id, name, {
    description: `${description} Package geometry is a generic ${pkg} outline.`,
    tier: 'B',
    generator: 'ic-package',
    representation: 'envelope',
    fixed: { package: pkg },
    parameters: [N('pins', 'Pin count', pins, 2, 208)],
    materialId: null,
    dataStatus: 'generic',
    domains: ['rigid-body', 'electrical'],
    ...extra,
  });
