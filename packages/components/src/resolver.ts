import type { ComponentResolver } from '@forge/engineering-core';
import { CATALOG_REVISION, getDefinition } from './catalog';
import { evaluate, resolveParameters } from './evaluate';
import { getMaterial } from './materials';

/**
 * Engine-side component resolver backed by the shipped catalogue. Every catalogue
 * component created or reconfigured through `engine.execute` — by the UI today, by Vey
 * later — passes through this validation: known definition, valid variant, parameters
 * in range and mutually consistent, permitted material.
 */
export function createCatalogResolver(): ComponentResolver {
  return {
    resolve({ definitionId, variantId, parameters, materialId }) {
      const def = getDefinition(definitionId);
      if (!def)
        return {
          ok: false,
          code: 'unknown-component',
          message: `Component "${definitionId}" is not in the component library.`,
        };
      const mat = materialId === undefined ? def.materialId : materialId;
      if (mat !== def.materialId) {
        if (mat !== null && !getMaterial(mat))
          return { ok: false, code: 'invalid-parameters', message: `Unknown material "${mat}".` };
        if (def.allowedMaterialIds.length === 0)
          return {
            ok: false,
            code: 'invalid-parameters',
            message: `${def.name}: material is fixed by the product definition.`,
          };
        if (mat !== null && !def.allowedMaterialIds.includes(mat))
          return {
            ok: false,
            code: 'invalid-parameters',
            message: `${def.name} cannot be made from ${getMaterial(mat)!.name}.`,
          };
      }
      const r = resolveParameters(def, variantId, parameters);
      if (!r.ok)
        return { ok: false, code: 'invalid-parameters', message: `${def.name}: ${r.issues.join('; ')}` };
      const e = evaluate(def, r.values, mat);
      const variant = variantId ? def.variants.find((v) => v.id === variantId) : undefined;
      return {
        ok: true,
        defaultName: variant ? `${def.name} · ${variant.name}` : def.name,
        ref: {
          catalogRevision: CATALOG_REVISION,
          variantId,
          parameters: r.values,
          materialId: mat,
          snapshot: {
            name: def.name,
            categoryId: def.categoryId,
            subcategoryId: def.subcategoryId,
            family: def.family,
            tier: def.tier,
            dataStatus: def.dataStatus,
            boundsM: e.size.map((v) => Math.max(v, 1e-6)) as [number, number, number],
          },
        },
      };
    },
  };
}
