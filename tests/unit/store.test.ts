import { beforeEach, describe, expect, it } from 'vitest';
import { makeEnvelope, type Command } from '../../src/commands/commands';
import { WorkshopStore } from '../../src/commands/store';
import { initialDocument } from '../../src/model/fixture';
import type { Entity, Transform } from '../../src/model/types';
import { checkDocument } from '../../src/model/validate';

const T = (x: number, y = 0.8, z = -0.6): Transform => ({ position: [x, y, z], rotation: [0, 0, 0, 1] });
const part = (id: string, parentId: string | null = null, x = 0): Entity => ({
  id,
  kind: 'part',
  partDefId: 'generic.enclosure.v1',
  name: id,
  parentId,
  transform: T(x),
  home: T(x),
});

let store: WorkshopStore;
const env = (commands: Command[], expectedRevision = store.document.revision, source: 'script' | 'desktop' = 'script') =>
  makeEnvelope(commands, { label: 'test', expectedRevision, source, requestedBy: 'test-actor' });
const snapshot = () => JSON.stringify({ doc: store.document, u: store.undoDepth, r: store.redoDepth });

beforeEach(() => {
  store = new WorkshopStore(initialDocument());
});

describe('dispatch', () => {
  it('creates, transforms and deletes; each applied change bumps revision by 1', () => {
    expect(store.dispatch(env([{ type: 'entity.create', entity: part('a') }]))).toMatchObject({ ok: true, revision: 1 });
    expect(store.dispatch(env([{ type: 'entity.setTransform', id: 'a', transform: T(0.3) }]))).toMatchObject({ ok: true, revision: 2 });
    expect(store.document.entities.a!.transform.position[0]).toBe(0.3);
    expect(store.dispatch(env([{ type: 'entity.delete', id: 'a' }]))).toMatchObject({ ok: true, revision: 3 });
    expect(store.document.entities.a).toBeUndefined();
    expect(store.undoDepth).toBe(3);
  });

  it('documents are deeply frozen (no accidental direct mutation)', () => {
    expect(() => {
      (store.document.entities['part-enclosure-1']!.transform.position as number[])[0] = 5;
    }).toThrow();
  });

  const rejections: [string, () => unknown, string][] = [
    ['malformed envelope', () => ({ nope: true }), 'malformed'],
    ['unknown command type', () => env([{ type: 'entity.explode' } as unknown as Command]), 'malformed'],
    ['empty command list', () => env([]), 'malformed'],
    ['stale revision', () => env([{ type: 'entity.create', entity: part('a') }], 99), 'stale-revision'],
    ['missing target', () => env([{ type: 'entity.setTransform', id: 'ghost', transform: T(0) }]), 'not-found'],
    ['NaN position', () => env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: { position: [NaN, 0, 0], rotation: [0, 0, 0, 1] } }]), 'invalid-geometry'],
    ['Infinity position', () => env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: { position: [Infinity, 0, 0], rotation: [0, 0, 0, 1] } }]), 'invalid-geometry'],
    ['out-of-bounds position', () => env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: T(1e4) }]), 'invalid-geometry'],
    ['non-unit quaternion', () => env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: { position: [0, 0, 0], rotation: [0, 0, 0, 2] } }]), 'invalid-geometry'],
    ['duplicate id', () => env([{ type: 'entity.create', entity: part('part-enclosure-1') }]), 'duplicate-id'],
    ['unknown part definition', () => env([{ type: 'entity.create', entity: { ...part('a'), partDefId: 'acme.unobtainium' } }]), 'unknown-part'],
    ['missing parent', () => env([{ type: 'entity.create', entity: part('a', 'ghost') }]), 'not-found'],
    ['self-parent', () => env([{ type: 'entity.setParent', id: 'part-enclosure-1', parentId: 'part-enclosure-1' }]), 'cycle'],
  ];
  it.each(rejections)('rejects %s without changing document or history', (_n, make, code) => {
    const before = snapshot();
    const r = store.dispatch(make());
    expect(r).toMatchObject({ ok: false, code });
    expect(snapshot()).toBe(before);
  });

  it('rejects a two-step parent cycle', () => {
    store.dispatch(env([{ type: 'entity.create', entity: part('a') }, { type: 'entity.create', entity: part('b', 'a') }]));
    const before = snapshot();
    expect(store.dispatch(env([{ type: 'entity.setParent', id: 'a', parentId: 'b' }]))).toMatchObject({ ok: false, code: 'cycle' });
    expect(snapshot()).toBe(before);
  });

  it('compound envelopes are atomic: a later failing command rolls back earlier ones', () => {
    const before = snapshot();
    const r = store.dispatch(env([{ type: 'entity.create', entity: part('a') }, { type: 'entity.setTransform', id: 'ghost', transform: T(0) }]));
    expect(r.ok).toBe(false);
    expect(snapshot()).toBe(before);
  });

  it('a no-op change creates no history entry and no revision bump', () => {
    const t = store.document.entities['part-enclosure-1']!.transform;
    expect(store.dispatch(env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: t }]))).toMatchObject({ ok: true, noop: true, revision: 0 });
    expect(store.undoDepth).toBe(0);
  });

  it('refuses to delete a parent without cascade', () => {
    store.dispatch(env([{ type: 'entity.create', entity: part('a') }, { type: 'entity.create', entity: part('b', 'a') }]));
    expect(store.dispatch(env([{ type: 'entity.delete', id: 'a' }]))).toMatchObject({ ok: false, code: 'has-children' });
  });
});

describe('undo / redo', () => {
  it('empty undo and redo are safe', () => {
    const before = snapshot();
    expect(store.undo()).toMatchObject({ ok: false, code: 'empty-history' });
    expect(store.redo()).toMatchObject({ ok: false, code: 'empty-history' });
    expect(snapshot()).toBe(before);
  });

  it('undo of a cascading delete restores all descendants, ids and parent links in one step', () => {
    store.dispatch(env([
      { type: 'entity.create', entity: part('a', null, 0.1) },
      { type: 'entity.create', entity: part('b', 'a', 0.2) },
      { type: 'entity.create', entity: part('c', 'b', 0.3) },
    ]));
    const full = JSON.stringify(store.document.entities);
    expect(store.dispatch(env([{ type: 'entity.delete', id: 'a', cascade: true }])).ok).toBe(true);
    expect(Object.keys(store.document.entities)).toEqual(['part-enclosure-1']);
    expect(store.undo().ok).toBe(true);
    expect(JSON.stringify(sortKeys(store.document.entities))).toBe(JSON.stringify(sortKeys(JSON.parse(full))));
    expect(() => checkDocument(store.document)).not.toThrow();
  });

  it('a new edit after undo invalidates the redo branch', () => {
    store.dispatch(env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: T(0.1) }]));
    store.undo();
    expect(store.canRedo).toBe(true);
    store.dispatch(env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: T(0.2) }]));
    expect(store.canRedo).toBe(false);
    expect(store.redo().ok).toBe(false);
  });

  it('undo advances the revision, so an old external request stays stale', () => {
    const oldRev = store.document.revision; // 0
    store.dispatch(env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: T(0.1) }])); // rev 1
    store.undo(); // rev 2, content equal to rev 0
    expect(store.document.revision).toBe(2);
    const stale = env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: T(0.5) }], oldRev);
    expect(store.dispatch(stale)).toMatchObject({ ok: false, code: 'stale-revision' });
  });

  it('redo succeeds even though its original envelope carried an old expectedRevision', () => {
    store.dispatch(env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: T(0.1) }]));
    store.undo();
    store.dispatch(env([{ type: 'entity.create', entity: part('unrelated') }])); // clears redo; re-test with a fresh chain
    store.dispatch(env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: T(0.3) }]));
    store.undo();
    expect(store.redo()).toMatchObject({ ok: true });
    expect(store.document.entities['part-enclosure-1']!.transform.position[0]).toBe(0.3);
  });

  it('scripted and interactive sources undo identically through the same history', () => {
    store.dispatch(env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: T(0.1) }], undefined, 'desktop'));
    store.dispatch(env([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: T(0.2) }], undefined, 'script'));
    store.undo();
    expect(store.document.entities['part-enclosure-1']!.transform.position[0]).toBe(0.1);
    store.undo();
    expect(store.document.entities['part-enclosure-1']!.transform.position[0]).toBe(0);
  });

  it('history is bounded', () => {
    const small = new WorkshopStore(initialDocument(), 5);
    for (let i = 1; i <= 12; i++) small.dispatch(makeEnvelope([{ type: 'entity.setTransform', id: 'part-enclosure-1', transform: T(i / 100) }], { label: 'm', expectedRevision: small.document.revision, source: 'script', requestedBy: 't' }));
    expect(small.undoDepth).toBe(5);
  });
});

function sortKeys(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}
