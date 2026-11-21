import { getGenerator } from './geometry/generators';
import { solidVolume, unionBounds, type Bounds, type Solid } from './geometry/solids';
import { getMaterial } from './materials';
import type { ComponentDefinition, ComponentInterface, Material, ParameterDef, ParamValues } from './schemas';

/**
 * Parameter resolution and geometric evaluation of a component definition.
 * Resolution order: family defaults → variant overrides → instance overrides.
 * Every value is validated against its parameter definition (type, range, options)
 * and then against the generator's cross-parameter rules.
 */
export interface ResolveResult {
  ok: boolean;
  values: ParamValues;
  issues: string[];
}

export function defaultValue(def: ParameterDef): number | string | boolean {
  switch (def.kind) {
    case 'length':
      return def.defaultM;
    case 'angle':
      return def.defaultRad;
    case 'count':
    case 'choice':
    case 'boolean':
      return def.default;
  }
}

export function checkParam(def: ParameterDef, v: unknown): string | null {
  switch (def.kind) {
    case 'length':
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${def.label}: must be a length in metres`;
      if (v < def.minM - 1e-12 || v > def.maxM + 1e-12)
        return `${def.label}: ${(v * 1000).toFixed(2)} mm is outside ${(def.minM * 1000).toFixed(2)}–${(def.maxM * 1000).toFixed(2)} mm`;
      return null;
    case 'angle':
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${def.label}: must be an angle in radians`;
      return v < def.minRad - 1e-12 || v > def.maxRad + 1e-12 ? `${def.label}: out of range` : null;
    case 'count':
      if (typeof v !== 'number' || !Number.isInteger(v)) return `${def.label}: must be a whole number`;
      return v < def.min || v > def.max ? `${def.label}: ${v} is outside ${def.min}–${def.max}` : null;
    case 'choice':
      return typeof v === 'string' && def.options.some((o) => o.value === v)
        ? null
        : `${def.label}: "${String(v)}" is not an available option`;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${def.label}: must be true or false`;
  }
}

export function resolveParameters(
  def: ComponentDefinition,
  variantId: string | null,
  overrides: ParamValues = {},
): ResolveResult {
  const issues: string[] = [];
  const values: ParamValues = {};
  for (const p of def.parameters) values[p.id] = defaultValue(p);
  if (variantId) {
    const v = def.variants.find((x) => x.id === variantId);
    if (!v) issues.push(`Unknown variant "${variantId}" for ${def.name}.`);
    else Object.assign(values, v.parameters);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (!def.parameters.some((p) => p.id === k)) issues.push(`Unknown parameter "${k}" for ${def.name}.`);
    else values[k] = v;
  }
  for (const p of def.parameters) {
    const e = checkParam(p, values[p.id]);
    if (e) issues.push(e);
  }
  const gen = getGenerator(def.geometry.generator);
  if (!gen) issues.push(`Geometry generator "${def.geometry.generator}" is not available.`);
  else if (issues.length === 0 && gen.check) issues.push(...gen.check({ ...def.geometry.fixed, ...values }));
  return { ok: issues.length === 0, values, issues };
}

export interface MassResult {
  massKg: number | null;
  source: 'geometry-density' | 'geometry-density-approximate' | 'specified' | 'unknown';
  note: string;
}

export interface Evaluation {
  solids: Solid[];
  interfaces: ComponentInterface[];
  bounds: Bounds;
  /** Bounding-box size [x, y, z] (m). */
  size: [number, number, number];
  /** Volume of the modelled solids (m³); null for envelope models (internals omitted). */
  volumeM3: number | null;
  mass: MassResult;
  material: Material | undefined;
}

/** Evaluate geometry, bounds, volume and mass for resolved parameter values. Throws on invalid input. */
export function evaluate(
  def: ComponentDefinition,
  values: ParamValues,
  materialId: string | null,
): Evaluation {
  const gen = getGenerator(def.geometry.generator);
  if (!gen) throw new Error(`Geometry generator "${def.geometry.generator}" is not available.`);
  const out = gen.generate({ ...def.geometry.fixed, ...values });
  const bounds = unionBounds(out.solids);
  const size: [number, number, number] = [0, 1, 2].map((i) => bounds.max[i]! - bounds.min[i]!) as [
    number,
    number,
    number,
  ];
  const rep = def.geometry.representation;
  const volumeM3 =
    rep === 'envelope'
      ? null
      : out.solids.filter((s) => s.app === 'primary').reduce((n, s) => n + solidVolume(s), 0);
  const material = getMaterial(materialId);
  let mass: MassResult;
  if (def.specifiedMassKg !== null) {
    mass = {
      massKg: def.specifiedMassKg,
      source: 'specified',
      note: `Published mass (${def.dataStatus === 'datasheet-cited' ? 'datasheet-cited, not verified by FORGE' : def.dataStatus}).`,
    };
  } else if (volumeM3 === null) {
    mass = {
      massKg: null,
      source: 'unknown',
      note: 'Envelope model: internals are not modelled, so geometric mass is not computed.',
    };
  } else if (!material || material.densityKgM3 === null) {
    mass = {
      massKg: null,
      source: 'unknown',
      note: material ? `Density of ${material.name} is unknown.` : 'No material assigned.',
    };
  } else {
    mass = {
      massKg: volumeM3 * material.densityKgM3,
      source: rep === 'exact' ? 'geometry-density' : 'geometry-density-approximate',
      note:
        rep === 'exact'
          ? `Modelled volume × typical density of ${material.name} (${material.status}).`
          : `Simplified profile × typical density of ${material.name} — estimate only.`,
    };
  }
  return {
    solids: out.solids,
    interfaces: [...def.interfaces, ...out.interfaces],
    bounds,
    size,
    volumeM3,
    mass,
    material,
  };
}
