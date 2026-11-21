import type { ParamValues } from '@forge/components';
import { getDefinition } from '@forge/components';
import type { SceneGraph } from '@forge/engineering-core';
import { componentKey } from '@/components3d/cache';

/**
 * Instancing plan: catalogue component instances with an identical configuration
 * (definition + resolved parameters + material) are drawn as ONE InstancedMesh per
 * appearance once at least `minCount` of them are visible. Selected nodes, hidden
 * nodes (or hidden ancestors) and components whose definition is missing are excluded
 * and render individually, so selection highlight, visibility and placeholders behave
 * exactly as before. Pure function of the scene graph — the model is never modified.
 */
export interface ComponentBatch {
  key: string;
  definitionId: string;
  parameters: ParamValues;
  materialId: string | null;
  ids: string[];
}

export const INSTANCING_MIN_COUNT = 4;

export function planComponentBatches(
  graph: SceneGraph,
  selection: readonly string[],
  minCount = INSTANCING_MIN_COUNT,
): ComponentBatch[] {
  const selected = new Set(selection);
  const groups = new Map<string, ComponentBatch>();
  const walk = (id: string) => {
    const n = graph.nodes[id];
    if (!n || !n.visible) return; // a hidden node hides its whole subtree
    if (
      n.kind === 'component-instance' &&
      n.component &&
      !selected.has(id) &&
      getDefinition(n.definitionId)
    ) {
      const params = n.component.parameters as ParamValues;
      const key = `${componentKey(n.definitionId, params)}|${n.component.materialId ?? ''}`;
      let b = groups.get(key);
      if (!b) {
        b = {
          key,
          definitionId: n.definitionId,
          parameters: params,
          materialId: n.component.materialId,
          ids: [],
        };
        groups.set(key, b);
      }
      b.ids.push(id);
    }
    for (const c of n.childIds) walk(c);
  };
  walk(graph.rootId);
  return [...groups.values()].filter((b) => b.ids.length >= minCount);
}
