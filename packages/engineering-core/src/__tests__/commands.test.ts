import { describe, expect, it } from 'vitest';
import { PRIMITIVE_SHAPES } from '../scene/schemas';
import { DEFAULT_PRIMITIVE_GEOMETRY } from '../project/create';
import { close, expectOk, makeEngine } from './helpers';

const Q90Y: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

describe('scene.node.create', () => {
  it.each(PRIMITIVE_SHAPES)(
    'creates a %s primitive with real geometry parameters and a stable id',
    (shape) => {
      const { engine, run, rootId } = makeEngine();
      const r = expectOk(
        run('scene.node.create', {
          node: { kind: 'primitive', geometry: DEFAULT_PRIMITIVE_GEOMETRY[shape] },
        }),
      );
      const id = r.affectedIds[0]!;
      const node = engine.getNode(id)!;
      expect(node.kind === 'primitive' && node.geometry).toEqual(DEFAULT_PRIMITIVE_GEOMETRY[shape]);
      expect(node.parentId).toBe(rootId);
      expect(engine.getNode(rootId)!.childIds).toContain(id);
      expect(r.revision).toBe(1);
    },
  );

  it('creates groups and reference datums; rejects duplicate ids and missing parents', () => {
    const { run, engine } = makeEngine();
    expectOk(run('scene.node.create', { node: { kind: 'group', id: 'g', name: 'Assembly Group' } }));
    expectOk(
      run('scene.node.create', {
        node: { kind: 'reference', id: 'd', parentId: 'g', referenceType: 'datum-axes', sizeM: 0.2 },
      }),
    );
    expect(engine.getNode('d')!.parentId).toBe('g');
    expect(run('scene.node.create', { node: { kind: 'group', id: 'g' } })).toMatchObject({
      ok: false,
      error: { code: 'duplicate-id' },
    });
    expect(run('scene.node.create', { node: { kind: 'group', parentId: 'nope' } })).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
  });

  it('rejects invalid geometry (zero, negative, torus tube ≥ major) as invalid-command', () => {
    const { run } = makeEngine();
    for (const geometry of [
      { shape: 'box', width: 0, height: 1, depth: 1 },
      { shape: 'sphere', radius: -1 },
      { shape: 'torus', majorRadius: 0.1, tubeRadius: 0.2 },
    ]) {
      expect(run('scene.node.create', { node: { kind: 'primitive', geometry } as never })).toMatchObject({
        ok: false,
        error: { code: 'invalid-command' },
      });
    }
  });
});

describe('validation, structured results and atomicity', () => {
  it('unknown command type → unknown-command, nothing changes', () => {
    const { engine, state } = makeEngine();
    const before = state();
    const r = engine.execute({
      commandId: 'x',
      type: 'scene.node.explode',
      payload: {},
      metadata: { source: 'test', timestamp: '2026-11-20T10:00:00.000Z' },
    });
    expect(r).toMatchObject({
      ok: false,
      commandId: 'x',
      type: 'scene.node.explode',
      error: { code: 'unknown-command' },
    });
    expect(state()).toBe(before);
  });

  it.each([
    ['NaN position', { position: [NaN, 0, 0] }],
    ['Infinity position', { position: [Infinity, 0, 0] }],
    ['out-of-range position', { position: [1e9, 0, 0] }],
    ['zero scale', { scale: [0, 1, 1] }],
    ['negative scale', { scale: [-1, 1, 1] }],
    ['non-unit quaternion', { rotation: [0, 0, 0, 2] }],
    ['empty transform', {}],
  ])('rejects %s with field-level issues', (_n, fields) => {
    const { engine, run, cubeId, state } = makeEngine();
    const before = state();
    const r = run('scene.node.transform', { nodeId: cubeId, ...fields } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid-command');
      expect(r.error.issues?.length).toBeGreaterThan(0);
    }
    expect(state()).toBe(before);
    expect(engine.getHistory().undoDepth).toBe(0);
  });

  it('malformed envelopes are rejected (missing metadata / bad timestamp)', () => {
    const { engine, cubeId } = makeEngine();
    expect(
      engine.execute({ commandId: 'a', type: 'scene.node.delete', payload: { nodeId: cubeId } }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-command' } });
    expect(
      engine.execute({
        commandId: 'a',
        type: 'scene.node.delete',
        payload: { nodeId: cubeId },
        metadata: { source: 'test', timestamp: 'yesterday' },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-command' },
    });
    expect(engine.execute(null)).toMatchObject({ ok: false, error: { code: 'unknown-command' } });
  });

  it('a command that fails midway leaves no partial mutation (atomic)', () => {
    const { engine, run, box, group, state } = makeEngine();
    group('g');
    box('a', 'g');
    box('b');
    const before = state();
    // Grouping members with different parents fails after validation began.
    const r = run('scene.node.group', { nodeIds: ['a', 'b'] });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid-operation' } });
    expect(state()).toBe(before);
    expect(engine.getHistory().undoDepth).toBe(3);
  });

  it('success results carry commandId, type, revision and affected ids', () => {
    const { run, cubeId } = makeEngine();
    expect(run('scene.node.rename', { nodeId: cubeId, name: 'Datum cube' })).toEqual({
      ok: true,
      commandId: 'cmd-1',
      type: 'scene.node.rename',
      revision: 1,
      affectedIds: [cubeId],
      noop: false,
    });
  });

  it('no-op commands succeed without a revision bump or history entry', () => {
    const { engine, run, cubeId } = makeEngine();
    const r = run('scene.node.visibility', { nodeId: cubeId, visible: true });
    expect(r).toMatchObject({ ok: true, noop: true, revision: 0 });
    expect(engine.getHistory().undoDepth).toBe(0);
  });

  it('stale expectedRevision is rejected', () => {
    const { run, cubeId } = makeEngine();
    run('scene.node.rename', { nodeId: cubeId, name: 'A' });
    expect(run('scene.node.rename', { nodeId: cubeId, name: 'B' }, { expectedRevision: 0 })).toMatchObject({
      ok: false,
      error: { code: 'stale-revision' },
    });
  });

  it('permission policy: source "vey" is denied until Phase 9', () => {
    const { run, cubeId, state } = makeEngine();
    const before = state();
    expect(run('scene.node.rename', { nodeId: cubeId, name: 'X' }, { source: 'vey' })).toMatchObject({
      ok: false,
      error: { code: 'permission-denied' },
    });
    expect(state()).toBe(before);
  });
});

describe('protection and lock enforcement', () => {
  it('the root cannot be deleted, transformed, reparented, hidden or locked', () => {
    const { run, rootId, box } = makeEngine();
    box('a');
    for (const r of [
      run('scene.node.delete', { nodeId: rootId }),
      run('scene.node.transform', { nodeId: rootId, position: [1, 0, 0] }),
      run('scene.node.reparent', { nodeId: rootId, parentId: 'a' }),
      run('scene.node.visibility', { nodeId: rootId, visible: false }),
      run('scene.node.lock', { nodeId: rootId, locked: true }),
      run('scene.node.duplicate', { nodeId: rootId }),
    ])
      expect(r).toMatchObject({ ok: false, error: { code: 'protected' } });
  });

  it('locked nodes reject edits but allow visibility and unlock', () => {
    const { run, cubeId, engine } = makeEngine();
    expectOk(run('scene.node.lock', { nodeId: cubeId, locked: true }));
    for (const r of [
      run('scene.node.transform', { nodeId: cubeId, position: [1, 0, 0] }),
      run('scene.node.rename', { nodeId: cubeId, name: 'x' }),
      run('scene.node.delete', { nodeId: cubeId }),
      run('scene.node.group', { nodeIds: [cubeId] }),
    ])
      expect(r).toMatchObject({ ok: false, error: { code: 'locked' } });
    expectOk(run('scene.node.visibility', { nodeId: cubeId, visible: false }));
    expectOk(run('scene.node.lock', { nodeId: cubeId, locked: false }));
    expectOk(run('scene.node.transform', { nodeId: cubeId, position: [1, 0, 0] }));
    expect(engine.getNode(cubeId)!.transform.position).toEqual([1, 0, 0]);
  });

  it('a locked group locks its descendants; deleting a parent of a locked child is refused', () => {
    const { run, group, box } = makeEngine();
    group('g');
    box('a', 'g');
    expectOk(run('scene.node.lock', { nodeId: 'g', locked: true }));
    expect(run('scene.node.transform', { nodeId: 'a', position: [1, 0, 0] })).toMatchObject({
      ok: false,
      error: { code: 'locked' },
    });
    expect(run('scene.node.create', { node: { kind: 'group', parentId: 'g' } })).toMatchObject({
      ok: false,
      error: { code: 'locked' },
    });
    expectOk(run('scene.node.lock', { nodeId: 'g', locked: false }));
    expectOk(run('scene.node.lock', { nodeId: 'a', locked: true }));
    expect(run('scene.node.delete', { nodeId: 'g' })).toMatchObject({ ok: false, error: { code: 'locked' } });
  });
});

describe('structural operations', () => {
  it('delete removes the whole subtree', () => {
    const { engine, run, group, box } = makeEngine();
    group('g');
    box('a', 'g');
    box('b', 'g');
    const r = expectOk(run('scene.node.delete', { nodeId: 'g' }));
    expect(r.affectedIds.sort()).toEqual(['a', 'b', 'g']);
    for (const id of ['a', 'b', 'g']) expect(engine.getNode(id)).toBeNull();
  });

  it('duplicate copies a subtree with fresh ids, remapped links and an offset', () => {
    const { engine, run, group, box } = makeEngine();
    group('g', undefined, { position: [1, 0, 0] });
    box('a', 'g', [0.1, 0, 0]);
    const r = expectOk(run('scene.node.duplicate', { nodeId: 'g', offset: [0, 0, 0.5] }));
    const [copyG, copyA] = r.affectedIds;
    const g2 = engine.getNode(copyG!)!;
    expect(g2.name).toBe('Group copy');
    expect(g2.transform.position).toEqual([1, 0, 0.5]);
    expect(g2.childIds).toEqual([copyA]);
    expect(engine.getNode(copyA!)!.parentId).toBe(copyG);
    expect(engine.getNode(copyA!)!.transform.position).toEqual([0.1, 0, 0]);
    const root = engine.getNode(engine.getProject().scene.rootId)!;
    expect(root.childIds.indexOf(copyG!)).toBe(root.childIds.indexOf('g') + 1);
  });

  it('reparent preserves world transform by default and prevents cycles', () => {
    const { engine, run, group, box } = makeEngine();
    group('g', undefined, { position: [1, 2, 3], rotation: Q90Y, scale: [2, 2, 2] });
    box('a', undefined, [0.5, 0, 0]);
    const before = engine.getWorldTransform('a')!;
    expectOk(run('scene.node.reparent', { nodeId: 'a', parentId: 'g' }));
    const after = engine.getWorldTransform('a')!;
    expect(engine.getNode('a')!.parentId).toBe('g');
    expect(close(after.position, before.position)).toBe(true);
    expect(close(after.scale, before.scale)).toBe(true);
    expect(run('scene.node.reparent', { nodeId: 'g', parentId: 'a' })).toMatchObject({
      ok: false,
      error: { code: 'cycle' },
    });
    expect(run('scene.node.reparent', { nodeId: 'g', parentId: 'g' })).toMatchObject({
      ok: false,
      error: { code: 'cycle' },
    });
  });

  it('reparent with keepWorldTransform=false keeps the local transform', () => {
    const { engine, run, group, box } = makeEngine();
    group('g', undefined, { position: [1, 0, 0] });
    box('a', undefined, [0.5, 0, 0]);
    expectOk(run('scene.node.reparent', { nodeId: 'a', parentId: 'g', keepWorldTransform: false }));
    expect(engine.getNode('a')!.transform.position).toEqual([0.5, 0, 0]);
    expect(close(engine.getWorldTransform('a')!.position, [1.5, 0, 0])).toBe(true);
  });

  it('refuses a world-preserving reparent that would require shear', () => {
    const { run, group, box, state } = makeEngine();
    group('g', undefined, { scale: [2, 1, 1] });
    expectOk(
      run('scene.node.create', {
        node: {
          kind: 'group',
          id: 'r',
          transform: { rotation: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)] },
        },
      }),
    );
    box('a', 'r');
    const before = state();
    expect(run('scene.node.reparent', { nodeId: 'r', parentId: 'g' })).toMatchObject({
      ok: false,
      error: { code: 'unrepresentable-transform' },
    });
    expect(state()).toBe(before);
  });

  it('group keeps world placement and sibling order; ungroup bakes the group transform into children', () => {
    const { engine, run, box, rootId, cubeId } = makeEngine();
    box('a', undefined, [0.1, 0, 0]);
    box('b', undefined, [0.2, 0, 0]);
    const r = expectOk(run('scene.node.group', { nodeIds: ['b', 'a'], groupId: 'grp', name: 'Pair' }));
    expect(r.affectedIds[0]).toBe('grp');
    expect(engine.getNode('grp')!.childIds).toEqual(['a', 'b']);
    expect(engine.getNode(rootId)!.childIds).toEqual([cubeId, 'grp']);
    expect(close(engine.getWorldTransform('a')!.position, [0.1, 0, 0])).toBe(true);
    // Move the group, then ungroup: children keep their (moved) world placement.
    expectOk(run('scene.node.transform', { nodeId: 'grp', position: [0, 1, 0], rotation: Q90Y }));
    const worldA = engine.getWorldTransform('a')!;
    expectOk(run('scene.node.ungroup', { groupId: 'grp' }));
    expect(engine.getNode('grp')).toBeNull();
    expect(engine.getNode(rootId)!.childIds).toEqual([cubeId, 'a', 'b']);
    expect(engine.getNode('a')!.parentId).toBe(rootId);
    expect(close(engine.getNode('a')!.transform.position, worldA.position)).toBe(true);
    expect(close(engine.getNode('a')!.transform.rotation, worldA.rotation)).toBe(true);
  });

  it('ungroup refuses non-groups', () => {
    const { run, cubeId } = makeEngine();
    expect(run('scene.node.ungroup', { groupId: cubeId })).toMatchObject({
      ok: false,
      error: { code: 'invalid-operation' },
    });
  });
});
