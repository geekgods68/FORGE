import { ACTUATION_FAMILIES } from './catalog/actuation';
import { ELECTRONICS_FAMILIES } from './catalog/electronics';
import { MECHANICAL_FAMILIES } from './catalog/mechanical';
import { ROBOT_ARM_PACK } from './catalog/robot-arm-pack';
import { evaluate, resolveParameters } from './evaluate';
import { getGenerator } from './geometry/generators';
import { getMaterial, MATERIALS } from './materials';
import {
  ComponentDefinitionSchema,
  type ComponentDefinition,
  type ComponentDefinitionInput,
} from './schemas';
import { CATEGORIES } from './taxonomy';

/** Catalogue revision (bump when definitions change in a way projects should notice). */
export const CATALOG_REVISION = 1;

/** Validate raw definitions into a catalogue. Throws with every problem listed. */
export function buildCatalog(inputs: readonly ComponentDefinitionInput[]): ComponentDefinition[] {
  const out: ComponentDefinition[] = [];
  const errors: string[] = [];
  for (const d of inputs) {
    const r = ComponentDefinitionSchema.safeParse(d);
    if (r.success) out.push(r.data);
    else
      errors.push(
        `${(d as { id?: string }).id ?? '?'}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
  }
  if (errors.length) throw new Error(`Invalid component definitions:\n${errors.join('\n')}`);
  return out;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** The shipped, read-only catalogue. */
export const CATALOG: readonly ComponentDefinition[] = deepFreeze(
  buildCatalog([...MECHANICAL_FAMILIES, ...ELECTRONICS_FAMILIES, ...ACTUATION_FAMILIES, ...ROBOT_ARM_PACK]),
);
const byId = new Map(CATALOG.map((d) => [d.id, d]));
export const getDefinition = (id: string): ComponentDefinition | undefined => byId.get(id);

/**
 * Structural invariants of a catalogue (run in tests): unique ids, valid taxonomy,
 * every subcategory populated, parameters/variants/materials valid, generators exist,
 * defaults and every variant evaluate, base-on-floor convention, unique interface ids,
 * named products carry references and a data status.
 */
export function validateCatalog(defs: readonly ComponentDefinition[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const d of defs) {
    if (ids.has(d.id)) errors.push(`duplicate component id "${d.id}"`);
    ids.add(d.id);
    const cat = CATEGORIES.find((c) => c.id === d.categoryId);
    if (!cat) errors.push(`${d.id}: unknown category ${d.categoryId}`);
    else if (!cat.subcategories.some((s) => s.id === d.subcategoryId))
      errors.push(`${d.id}: unknown subcategory "${d.subcategoryId}" in ${d.categoryId}`);
    if (!getGenerator(d.geometry.generator))
      errors.push(`${d.id}: unknown generator "${d.geometry.generator}"`);
    const pids = new Set<string>();
    for (const p of d.parameters) {
      if (pids.has(p.id)) errors.push(`${d.id}: duplicate parameter ${p.id}`);
      pids.add(p.id);
      if (p.kind === 'length' && !(p.minM <= p.defaultM && p.defaultM <= p.maxM))
        errors.push(`${d.id}: default of ${p.id} outside its range`);
      if (p.kind === 'count' && !(p.min <= p.default && p.default <= p.max))
        errors.push(`${d.id}: default of ${p.id} outside its range`);
      if (p.kind === 'choice' && !p.options.some((o) => o.value === p.default))
        errors.push(`${d.id}: default of ${p.id} is not an option`);
    }
    const vids = new Set<string>();
    for (const v of d.variants) {
      if (vids.has(v.id)) errors.push(`${d.id}: duplicate variant ${v.id}`);
      vids.add(v.id);
    }
    if (d.materialId && !getMaterial(d.materialId)) errors.push(`${d.id}: unknown material ${d.materialId}`);
    for (const m of d.allowedMaterialIds)
      if (!getMaterial(m)) errors.push(`${d.id}: unknown allowed material ${m}`);
    if (d.manufacturer && d.references.length === 0)
      errors.push(`${d.id}: names a product but cites no reference`);
    if (d.manufacturer && d.dataStatus === 'generic')
      errors.push(`${d.id}: names a product but is marked generic`);
    if (d.capabilities.some((c) => c.status !== 'unsupported'))
      errors.push(`${d.id}: Phase 3 components must not claim simulation validity`);
    for (const variantId of [null, ...d.variants.map((v) => v.id)]) {
      const r = resolveParameters(d, variantId);
      if (!r.ok) {
        errors.push(`${d.id}${variantId ? `/${variantId}` : ''}: ${r.issues.join('; ')}`);
        continue;
      }
      try {
        const e = evaluate(d, r.values, d.materialId);
        if (e.solids.length === 0) errors.push(`${d.id}: generator produced no geometry`);
        if (Math.abs(e.bounds.min[1]) > 1e-9)
          errors.push(
            `${d.id}${variantId ? `/${variantId}` : ''}: base is not at y = 0 (min y = ${e.bounds.min[1]})`,
          );
        if (e.size.some((s) => !(s > 0) || !Number.isFinite(s))) errors.push(`${d.id}: degenerate bounds`);
        const iids = new Set<string>();
        for (const i of e.interfaces) {
          if (iids.has(i.id)) errors.push(`${d.id}: duplicate interface id ${i.id}`);
          iids.add(i.id);
        }
      } catch (err) {
        errors.push(`${d.id}: evaluation failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
  for (const c of CATEGORIES)
    for (const s of c.subcategories)
      if (!defs.some((d) => d.categoryId === c.id && d.subcategoryId === s.id))
        errors.push(`${c.id} / ${s.id}: no registered component family`);
  return errors;
}

export const catalogStats = (defs: readonly ComponentDefinition[] = CATALOG) => ({
  categories: CATEGORIES.length,
  subcategories: CATEGORIES.reduce((n, c) => n + c.subcategories.length, 0),
  families: defs.length,
  variants: defs.reduce((n, d) => n + d.variants.length, 0),
  tiers: {
    A: defs.filter((d) => d.tier === 'A').length,
    B: defs.filter((d) => d.tier === 'B').length,
    C: defs.filter((d) => d.tier === 'C').length,
  },
  namedProducts: defs.filter((d) => d.manufacturer).length,
  materials: MATERIALS.length,
});
