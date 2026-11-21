import {
  evaluate,
  getDefinition,
  type Appearance,
  type Evaluation,
  type ParamValues,
} from '@forge/components';
import type { BufferGeometry } from 'three';
import { buildAppearanceGeometries } from './geometry';

/**
 * Reference-counted cache of built component geometry, keyed by definition + resolved
 * parameters. N instances of the same configured component share one set of GPU
 * buffers; entries are disposed when the last instance unmounts. The catalogue itself
 * never creates meshes — only placed (or previewed) components do.
 */
interface Entry {
  evaluation: Evaluation;
  geometries: Map<Appearance, BufferGeometry>;
  refs: number;
}
const entries = new Map<string, Entry>();
let builds = 0;

export const componentKey = (definitionId: string, params: ParamValues) =>
  `${definitionId}|${JSON.stringify(
    Object.keys(params)
      .sort()
      .map((k) => [k, params[k]]),
  )}`;

export function acquireComponent(
  definitionId: string,
  params: ParamValues,
  materialId: string | null,
): Entry | null {
  const def = getDefinition(definitionId);
  if (!def) return null;
  const key = componentKey(definitionId, params);
  let e = entries.get(key);
  if (!e) {
    const evaluation = evaluate(def, params, materialId);
    e = { evaluation, geometries: buildAppearanceGeometries(evaluation.solids), refs: 0 };
    entries.set(key, e);
    builds += 1;
  }
  e.refs += 1;
  return e;
}

export function releaseComponent(definitionId: string, params: ParamValues) {
  const key = componentKey(definitionId, params);
  const e = entries.get(key);
  if (!e) return;
  e.refs -= 1;
  if (e.refs <= 0) {
    for (const g of e.geometries.values()) g.dispose();
    entries.delete(key);
  }
}

/** Diagnostics: live entries, total references, geometries, and builds since start. */
export function componentCacheStats() {
  let refs = 0;
  let geometries = 0;
  for (const e of entries.values()) {
    refs += e.refs;
    geometries += e.geometries.size;
  }
  return { entries: entries.size, refs, geometries, builds };
}
