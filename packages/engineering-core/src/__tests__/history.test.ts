import { describe, expect, it } from 'vitest';
import { TransformSession } from '../editing/transform-session';
import type { NodeTransform } from '../scene/schemas';
import { close, expectOk, makeEngine } from './helpers';

const Q90Y: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

/** Run an operation, then check undo restores `before` and redo restores `after` exactly. */
function roundTrip(h: ReturnType<typeof makeEngine>, op: () => void) {
  const before = h.state();
  op();
  const after = h.state();
  expect(after).not.toBe(before);
  expect(h.engine.undo().ok).toBe(true);
  expect(h.state()).toBe(before);
  expect(h.engine.redo().ok).toBe(true);
  expect(h.state()).toBe(after);
}

describe('undo / redo for every supported operation', () => {
  it('create', () => {
    const h = makeEngine();
    roundTrip(h, () => expectOk(h.box('a')));
    expect(h.engine.getNode('a')).not.toBeNull(); // redo restored the same id
  });
  it('delete (subtree)', () => {
    const h = makeEngine();
    h.group('g');
    h.box('a', 'g');
    roundTrip(h, () => expectOk(h.run('scene.node.delete', { nodeId: 'g' })));
  });
  it('duplicate (ids restored identically on redo)', () => {
    const h = makeEngine();
    h.group('g');
    h.box('a', 'g');
    roundTrip(h, () => expectOk(h.run('scene.node.duplicate', { nodeId: 'g' })));
  });
  it('rename', () => {
    const h = makeEngine();
    roundTrip(h, () => expectOk(h.run('scene.node.rename', { nodeId: h.cubeId, name: 'Renamed' })));
  });
  it('transform', () => {
    const h = makeEngine();
    roundTrip(h, () =>
      expectOk(
        h.run('scene.node.transform', {
          nodeId: h.cubeId,
          position: [0.5, 0.15, 0],
          rotation: Q90Y,
          scale: [2, 1, 1],
        }),
      ),
    );
  });
  it('reparent (world-preserving, with parent child lists)', () => {
    const h = makeEngine();
    h.group('g', undefined, { position: [1, 0, 0], rotation: Q90Y });
    roundTrip(h, () => expectOk(h.run('scene.node.reparent', { nodeId: h.cubeId, parentId: 'g' })));
  });
  it('visibility and lock', () => {
    const h = makeEngine();
    roundTrip(h, () => expectOk(h.run('scene.node.visibility', { nodeId: h.cubeId, visible: false })));
    roundTrip(h, () => expectOk(h.run('scene.node.lock', { nodeId: h.cubeId, locked: true })));
  });
  it('group and ungroup', () => {
    const h = makeEngine();
    h.box('a');
    h.box('b');
    roundTrip(h, () => expectOk(h.run('scene.node.group', { nodeIds: ['a', 'b'], groupId: 'g' })));
    h.run('scene.node.transform', { nodeId: 'g', position: [0, 1, 0] });
    roundTrip(h, () => expectOk(h.run('scene.node.ungroup', { groupId: 'g' })));
  });
});

describe('history semantics', () => {
  it('multiple sequential changes undo in reverse order and redo forward', () => {
    const h = makeEngine();
    const states = [h.state()];
    h.box('a');
    states.push(h.state());
    h.run('scene.node.transform', { nodeId: 'a', position: [1, 0, 0] });
    states.push(h.state());
    h.run('scene.node.rename', { nodeId: 'a', name: 'A' });
    states.push(h.state());
    h.group('g');
    states.push(h.state());
    h.run('scene.node.reparent', { nodeId: 'a', parentId: 'g' });
    states.push(h.state());
    for (let i = states.length - 2; i >= 0; i--) {
      expect(h.engine.undo().ok).toBe(true);
      expect(h.state()).toBe(states[i]);
    }
    expect(h.engine.undo()).toMatchObject({ ok: false, error: { code: 'empty-history' } });
    for (let i = 1; i < states.length; i++) {
      expect(h.engine.redo().ok).toBe(true);
      expect(h.state()).toBe(states[i]);
    }
    expect(h.engine.redo()).toMatchObject({ ok: false, error: { code: 'empty-history' } });
  });

  it('a new command after undo invalidates the redo branch', () => {
    const h = makeEngine();
    h.box('a');
    h.box('b');
    h.engine.undo();
    expect(h.engine.getHistory().canRedo).toBe(true);
    h.box('c');
    expect(h.engine.getHistory().canRedo).toBe(false);
    expect(h.engine.redo().ok).toBe(false);
    expect(h.engine.getNode('b')).toBeNull();
    expect(h.engine.getNode('c')).not.toBeNull();
  });

  it('undo/redo never create history entries of their own and always advance the revision', () => {
    const h = makeEngine();
    h.box('a');
    const rev = h.engine.getProject().revision;
    h.engine.undo();
    h.engine.redo();
    expect(h.engine.getHistory()).toMatchObject({ undoDepth: 1, redoDepth: 0 });
    expect(h.engine.getProject().revision).toBe(rev + 2);
  });

  it('undo makes an old revision-pinned request stale rather than valid again', () => {
    const h = makeEngine();
    h.run('scene.node.rename', { nodeId: h.cubeId, name: 'A' }); // rev 1
    h.engine.undo(); // rev 2 (content equals rev 0)
    expect(
      h.run('scene.node.rename', { nodeId: h.cubeId, name: 'B' }, { expectedRevision: 0 }),
    ).toMatchObject({
      ok: false,
      error: { code: 'stale-revision' },
    });
  });

  it('complex parent-child changes undo correctly (reparent chain + delete + ungroup)', () => {
    const h = makeEngine();
    h.group('g1', undefined, { position: [1, 0, 0] });
    h.group('g2', 'g1', { rotation: Q90Y });
    h.box('a', 'g2', [0.2, 0, 0]);
    const s0 = h.state();
    const world0 = h.engine.getWorldTransform('a')!;
    h.run('scene.node.reparent', { nodeId: 'a', parentId: h.rootId });
    h.run('scene.node.ungroup', { groupId: 'g2' });
    h.run('scene.node.delete', { nodeId: 'g1' });
    expect(close(h.engine.getWorldTransform('a')!.position, world0.position)).toBe(true);
    h.engine.undo();
    h.engine.undo();
    h.engine.undo();
    expect(h.state()).toBe(s0);
  });

  it('history limit is configurable and drops the oldest entries', () => {
    const h = makeEngine({ historyLimit: 3 });
    for (let i = 0; i < 6; i++) h.run('scene.node.transform', { nodeId: h.cubeId, position: [i, 0, 0] });
    expect(h.engine.getHistory()).toMatchObject({ undoDepth: 3, limit: 3 });
    while (h.engine.undo().ok);
    expect(h.engine.getNode(h.cubeId)!.transform.position).toEqual([2, 0, 0]);
  });
});

describe('continuous drag = one history entry', () => {
  it('100 preview samples produce no state change until commit, then exactly one entry', () => {
    const h = makeEngine();
    const start = h.engine.getNode(h.cubeId)!.transform;
    const s = new TransformSession(h.engine, h.cubeId);
    for (let i = 1; i <= 100; i++) {
      s.preview({ ...start, position: [i * 0.001, 0.15, 0] });
      expect(h.engine.getNode(h.cubeId)!.transform).toEqual(start);
    }
    expect(s.commit()).toMatchObject({ ok: true });
    expect(h.engine.getHistory().undoDepth).toBe(1);
    expect(h.engine.getNode(h.cubeId)!.transform.position).toEqual([0.1, 0.15, 0]);
    h.engine.undo();
    expect(h.engine.getNode(h.cubeId)!.transform).toEqual(start); // back to pre-drag pose
    h.engine.redo();
    expect(h.engine.getNode(h.cubeId)!.transform.position).toEqual([0.1, 0.15, 0]);
  });

  it('cancel discards the drag; a no-movement drag commits nothing; invalid samples are ignored', () => {
    const h = makeEngine();
    const start = h.engine.getNode(h.cubeId)!.transform;
    const s1 = new TransformSession(h.engine, h.cubeId);
    s1.preview({ ...start, position: [1, 1, 1] });
    s1.cancel();
    expect(s1.commit()).toBeNull();
    expect(new TransformSession(h.engine, h.cubeId).commit()).toBeNull();
    const s3 = new TransformSession(h.engine, h.cubeId);
    expect(s3.preview({ ...start, scale: [0, 1, 1] } as NodeTransform)).toBe(false);
    expect(s3.commit()).toBeNull();
    expect(h.engine.getHistory().undoDepth).toBe(0);
  });

  it('a drag commit is rejected as stale if the project changed during the drag', () => {
    const h = makeEngine();
    const s = new TransformSession(h.engine, h.cubeId);
    s.preview({ ...s.start, position: [1, 0, 0] });
    h.run('scene.node.rename', { nodeId: h.cubeId, name: 'changed meanwhile' });
    expect(s.commit()).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
  });
});
