import { CATALOG, evaluate, resolveParameters } from '@forge/components';
import { Box3 } from 'three';
import { describe, expect, it } from 'vitest';
import { acquireComponent, componentCacheStats, releaseComponent } from './cache';
import { buildAppearanceGeometries } from './geometry';

describe('component geometry builder', () => {
  it('every catalogue family builds GPU geometry whose bounds match the domain evaluation', () => {
    for (const def of CATALOG) {
      const r = resolveParameters(def, null);
      expect(r.ok, def.id).toBe(true);
      const e = evaluate(def, r.values, def.materialId);
      const geos = buildAppearanceGeometries(e.solids);
      const box = new Box3();
      for (const g of geos.values()) box.union(g.boundingBox!);
      const tol = (i: number) => 0.02 * e.size[i]! + 1e-6; // curved outlines are faceted
      for (let i = 0; i < 3; i++) {
        expect(
          Math.abs(box.min.getComponent(i) - e.bounds.min[i]!),
          `${def.id} min[${i}]`,
        ).toBeLessThanOrEqual(tol(i));
        expect(
          Math.abs(box.max.getComponent(i) - e.bounds.max[i]!),
          `${def.id} max[${i}]`,
        ).toBeLessThanOrEqual(tol(i));
      }
      // One merged geometry per appearance (draw calls independent of part count).
      expect(geos.size).toBe(new Set(e.solids.map((s) => s.app)).size);
      for (const g of geos.values()) g.dispose();
    }
  }, 60_000); // builds all 401 families; generous bound for slow/swapping machines

  it('shares geometry between identical configurations and disposes on last release', () => {
    const p = resolveParameters(
      CATALOG.find((d) => d.id === 'towerpro-sg90')!,
      null,
    ).values;
    const before = componentCacheStats();
    const a = acquireComponent('towerpro-sg90', p, null)!;
    const b = acquireComponent('towerpro-sg90', p, null)!;
    expect(a).toBe(b);
    expect(componentCacheStats().builds).toBe(before.builds + 1);
    expect(componentCacheStats().refs).toBe(before.refs + 2);
    releaseComponent('towerpro-sg90', p);
    releaseComponent('towerpro-sg90', p);
    expect(componentCacheStats().entries).toBe(before.entries);
    expect(acquireComponent('no-such-component', {}, null)).toBeNull();
  });
});
