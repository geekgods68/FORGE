import { describe, expect, it } from 'vitest';
import { MAX_BATCH_COMMANDS } from '../commands/schemas';
import { GraphTransaction } from '../scene/transaction';
import { expectOk, makeEngine } from './helpers';

const box = (id: string, parentId?: string, x = 0) => ({
  type: 'scene.node.create' as const,
  payload: {
    node: {
      kind: 'primitive' as const,
      id,
      ...(parentId ? { parentId } : {}),
      geometry: { shape: 'box' as const, width: 0.1, height: 0.1, depth: 0.1 },
      transform: { position: [x, 0, 0] as [number, number, number] },
    },
  },
});

describe('scene.batch', () => {
  it('applies several commands as ONE undoable step; undo/redo restore exactly (same ids)', () => {
    const h = makeEngine();
    const before = h.state();
    const r = expectOk(
      h.run('scene.batch', {
        commands: [
          box('a', undefined, 0.1),
          box('b', undefined, 0.2),
          { type: 'scene.node.group', payload: { nodeIds: ['a', 'b'], groupId: 'g', name: 'Pair' } },
          { type: 'scene.node.transform', payload: { nodeId: 'g', position: [0, 0.5, 0] } },
        ],
      }),
    );
    expect(r.affectedIds).toEqual(expect.arrayContaining(['a', 'b', 'g']));
    expect(r.revision).toBe(1);
    expect(h.engine.getHistory().undoDepth).toBe(1);
    const after = h.state();
    h.engine.undo();
    expect(h.state()).toBe(before);
    h.engine.redo();
    expect(h.state()).toBe(after);
    expect(h.engine.getNode('a')!.parentId).toBe('g');
  });

  it('is atomic: a failing step aborts everything and reports which step failed', () => {
    const h = makeEngine();
    const before = h.state();
    const r = h.run('scene.batch', {
      commands: [box('a'), box('b'), { type: 'scene.node.delete', payload: { nodeId: h.rootId } }, box('c')],
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'protected' } });
    if (!r.ok) expect(r.error.message).toMatch(/^Batch step 3 \(scene\.node\.delete\)/);
    expect(h.state()).toBe(before);
    expect(h.engine.getHistory().undoDepth).toBe(0);
    expect(h.engine.getProject().revision).toBe(0);
  });

  it('validates every step before running: bad payloads give field paths; batches cannot nest', () => {
    const h = makeEngine();
    const bad = h.run('scene.batch', {
      commands: [box('a'), { type: 'scene.node.transform', payload: { nodeId: 'a', scale: [0, 1, 1] } }],
    } as never);
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid-command' } });
    if (!bad.ok)
      expect(bad.error.issues!.map((i) => i.path).join(' ')).toMatch(/payload\.commands\.1\.payload\.scale/);
    const nested = h.run('scene.batch', {
      commands: [{ type: 'scene.batch', payload: { commands: [box('x')] } }],
    } as never);
    expect(nested).toMatchObject({ ok: false, error: { code: 'invalid-command' } });
    expect(h.run('scene.batch', { commands: [] })).toMatchObject({
      ok: false,
      error: { code: 'invalid-command' },
    });
  });

  it(`rejects more than ${MAX_BATCH_COMMANDS} steps`, () => {
    const h = makeEngine();
    const commands = Array.from({ length: MAX_BATCH_COMMANDS + 1 }, (_, i) => box(`n${i}`));
    expect(h.run('scene.batch', { commands })).toMatchObject({
      ok: false,
      error: { code: 'invalid-command' },
    });
  });

  it('a batch whose net effect is nothing (create then delete) is a no-op', () => {
    const h = makeEngine();
    const r = h.run('scene.batch', {
      commands: [box('tmp'), { type: 'scene.node.delete', payload: { nodeId: 'tmp' } }],
    });
    expect(r).toMatchObject({ ok: true, noop: true, revision: 0 });
    expect(h.engine.getHistory().undoDepth).toBe(0);
  });

  it('later steps see earlier steps (references to ids created in the same batch)', () => {
    const h = makeEngine();
    expectOk(
      h.run('scene.batch', {
        commands: [
          { type: 'scene.node.create', payload: { node: { kind: 'group', id: 'bench' } } },
          box('vise', 'bench'),
          { type: 'scene.node.lock', payload: { nodeId: 'vise', locked: true } },
        ],
      }),
    );
    expect(h.engine.getNode('vise')).toMatchObject({ parentId: 'bench', locked: true });
  });

  it('scales linearly: 5,000 creates in one batch record one op per touched node and run quickly', () => {
    const h = makeEngine();
    const commands = Array.from({ length: 5000 }, (_, i) => box(`n${i}`, undefined, (i % 100) * 0.02));
    const t0 = performance.now();
    expectOk(h.run('scene.batch', { commands }));
    const ms = performance.now() - t0;
    expect(Object.keys(h.engine.getProject().scene.nodes)).toHaveLength(5002);
    expect(h.engine.getHistory().undoDepth).toBe(1);
    // Previously (per-command, O(N²)) 5,000 creates took ~14 s. Generous bound for a loaded 8 GB machine.
    expect(ms).toBeLessThan(5000);
    const t1 = performance.now();
    h.engine.undo();
    expect(Object.keys(h.engine.getProject().scene.nodes)).toHaveLength(2);
    expect(performance.now() - t1).toBeLessThan(2000);
  });
});

describe('flat-scene scaling (regression: validateGraph was O(siblings) per node)', () => {
  it('a single edit on 10,000 children of one parent stays fast, as do undo/redo', () => {
    const h = makeEngine();
    const commands = Array.from({ length: 10_000 }, (_, i) => box(`n${i}`));
    expectOk(h.run('scene.batch', { commands }));
    const t0 = performance.now();
    expectOk(h.run('scene.node.transform', { nodeId: 'n0', position: [1, 0, 0] }));
    const editMs = performance.now() - t0;
    const t1 = performance.now();
    h.engine.undo();
    h.engine.redo();
    const historyMs = performance.now() - t1;
    // Quadratic validation took ~320 ms per edit here; linear is a few ms. Generous bounds.
    expect(editMs).toBeLessThan(100);
    expect(historyMs).toBeLessThan(200);
  });
});

describe('GraphTransaction coalescing', () => {
  it('records one forward and one inverse op per touched node regardless of write count', () => {
    const h = makeEngine();
    const tx = new GraphTransaction(h.engine.getProject().scene);
    const root = tx.get(h.rootId);
    let r = root;
    for (let i = 0; i < 100; i++) {
      r = { ...r, name: `Scene ${i}` };
      tx.put(r);
    }
    expect(tx.forward).toHaveLength(1);
    expect(tx.inverse).toEqual([{ op: 'put', node: root }]);
    tx.put(root); // back to the original object → no net change
    expect(tx.forward).toHaveLength(0);
  });
});
