import { createCatalogResolver } from '@forge/components';
import { createProject, ForgeEngine, makeCommand, type CommandInput } from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { planComponentBatches } from './componentBatches';

function build(n: number) {
  const e = new ForgeEngine(createProject(), { componentResolver: createCatalogResolver() });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = e.execute(
      makeCommand(
        'scene.node.create',
        {
          node: {
            kind: 'component-instance',
            definitionId: 'hex-nut',
            variantId: null,
            parameters: {},
            transform: { position: [i * 0.02, 0, 0] },
          },
        },
        'desktop-ui',
      ) as CommandInput,
    );
    if (!r.ok) throw new Error(r.error.message);
    ids.push(r.affectedIds[0]!);
  }
  return { e, ids };
}

describe('instancing plan', () => {
  it('batches identical configurations and leaves small groups individual', () => {
    const { e, ids } = build(6);
    const b = planComponentBatches(e.getProject().scene, []);
    expect(b).toHaveLength(1);
    expect(b[0]!.ids).toEqual(ids);
    expect(planComponentBatches(e.getProject().scene, [], 7)).toHaveLength(0);
  });

  it('excludes selected and hidden nodes (they render individually or not at all)', () => {
    const { e, ids } = build(6);
    e.execute(
      makeCommand('scene.node.visibility', { nodeId: ids[1]!, visible: false }, 'desktop-ui') as CommandInput,
    );
    const b = planComponentBatches(e.getProject().scene, [ids[0]!]);
    expect(b[0]!.ids).toEqual(ids.slice(2));
  });

  it('splits by material and parameters (each batch is one exact configuration)', () => {
    const { e, ids } = build(8);
    for (const id of ids.slice(0, 4)) {
      const r = e.execute(
        makeCommand(
          'scene.component.configure',
          { nodeId: id, materialId: 'ss-304' },
          'desktop-ui',
        ) as CommandInput,
      );
      expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    }
    const b = planComponentBatches(e.getProject().scene, []);
    expect(b.map((x) => x.ids.length).sort()).toEqual([4, 4]);
    expect(new Set(b.map((x) => x.materialId)).size).toBe(2);
  });
});
