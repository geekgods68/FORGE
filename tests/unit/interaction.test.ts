import { beforeEach, describe, expect, it } from 'vitest';
import { makeEnvelope } from '../../src/commands/commands';
import { WorkshopStore } from '../../src/commands/store';
import { InteractionController, type InteractionView } from '../../src/interaction/controller';
import type { InputSourceInfo, Intent } from '../../src/interaction/intents';
import { initialDocument } from '../../src/model/fixture';
import { yawDegrees } from '../../src/model/math';
import type { Transform } from '../../src/model/types';

const ID = 'part-enclosure-1';
const right: InputSourceInfo = { id: 'xr-right', type: 'xr-controller', handedness: 'right' };
const left: InputSourceInfo = { id: 'xr-left', type: 'xr-controller', handedness: 'left' };
const mouse: InputSourceInfo = { id: 'mouse', type: 'desktop-mouse', handedness: 'none' };
const T = (x: number): Transform => ({ position: [x, 0.8, -0.6], rotation: [0, 0, 0, 1] });

let store: WorkshopStore;
let ctl: InteractionController;
let previews: [string, Transform | null][];
const view: InteractionView = {
  setPreview: (id, t) => previews.push([id, t]),
  setHover: () => {},
  setSelected: () => {},
};
type NoTime<U> = U extends unknown ? Omit<U, 'time'> : never;
const go = (i: NoTime<Intent>) => ctl.handle({ ...i, time: 0 } as Intent);
const x = () => store.document.entities[ID]!.transform.position[0];

beforeEach(() => {
  store = new WorkshopStore(initialDocument());
  previews = [];
  ctl = new InteractionController(store, view);
});

describe('grab transactions', () => {
  it('a drag of 100 samples produces exactly one undo step and previews do not touch the document', () => {
    go({ kind: 'grab-start', source: right, entityId: ID });
    for (let i = 1; i <= 100; i++) {
      go({ kind: 'grab-move', source: right, transform: T(i / 1000) });
      expect(x()).toBe(0); // document unchanged while previewing
    }
    go({ kind: 'grab-end', source: right });
    expect(x()).toBeCloseTo(0.1);
    expect(store.undoDepth).toBe(1);
    expect(previews.at(-1)).toEqual([ID, null]);
    store.undo();
    expect(x()).toBe(0);
  });

  it('release without movement commits nothing', () => {
    go({ kind: 'grab-start', source: right, entityId: ID });
    go({ kind: 'grab-end', source: right });
    expect(store.undoDepth).toBe(0);
  });

  it.each([
    ['cancel', { kind: 'cancel', source: right, reason: 'escape' }],
    ['source lost (controller disconnected)', { kind: 'source-lost', source: right, reason: 'disconnected' }],
  ] as const)('%s during a grab discards the preview and commits nothing', (_n, intent) => {
    go({ kind: 'grab-start', source: right, entityId: ID });
    go({ kind: 'grab-move', source: right, transform: T(0.2) });
    go(intent);
    expect(ctl.activeGrab).toBeNull();
    expect(previews.at(-1)).toEqual([ID, null]);
    go({ kind: 'grab-end', source: right });
    expect(store.undoDepth).toBe(0);
    expect(x()).toBe(0);
  });

  it('session exit while grabbing (cancelGrab) leaves no partial edit', () => {
    go({ kind: 'grab-start', source: right, entityId: ID });
    go({ kind: 'grab-move', source: right, transform: T(0.2) });
    ctl.cancelGrab('xr session ended');
    expect(store.undoDepth).toBe(0);
    expect(ctl.lastEvent).toEqual({ kind: 'cancelled', detail: 'xr session ended' });
  });

  it('another source cannot move, release or steal an active grab', () => {
    go({ kind: 'grab-start', source: right, entityId: ID });
    go({ kind: 'grab-start', source: left, entityId: ID });
    go({ kind: 'grab-move', source: left, transform: T(0.5) });
    go({ kind: 'grab-end', source: left });
    expect(ctl.activeGrab?.source.id).toBe('xr-right');
    go({ kind: 'grab-move', source: right, transform: T(0.05) });
    go({ kind: 'grab-end', source: right });
    expect(x()).toBeCloseTo(0.05);
  });

  it('ignores invalid preview samples (NaN) and keeps the last valid pose', () => {
    go({ kind: 'grab-start', source: mouse, entityId: ID });
    go({ kind: 'grab-move', source: mouse, transform: T(0.07) });
    go({ kind: 'grab-move', source: mouse, transform: T(NaN) });
    go({ kind: 'grab-end', source: mouse });
    expect(x()).toBeCloseTo(0.07);
  });

  it('a grab commit is rejected as stale if the document changed during the grab', () => {
    go({ kind: 'grab-start', source: right, entityId: ID });
    go({ kind: 'grab-move', source: right, transform: T(0.2) });
    // An external (scripted) edit lands mid-grab.
    store.dispatch(makeEnvelope([{ type: 'entity.setTransform', id: ID, transform: T(0.9) }], { label: 'script', expectedRevision: store.document.revision, source: 'script', requestedBy: 'script' }));
    const r = go({ kind: 'grab-end', source: right });
    expect(r).toMatchObject({ ok: false, code: 'stale-revision' });
    expect(x()).toBeCloseTo(0.9);
    expect(previews.at(-1)).toEqual([ID, null]);
  });

  it('undo is refused while a grab is active', () => {
    store.dispatch(makeEnvelope([{ type: 'entity.setTransform', id: ID, transform: T(0.3) }], { label: 'm', expectedRevision: 0, source: 'script', requestedBy: 't' }));
    go({ kind: 'grab-start', source: right, entityId: ID });
    expect(go({ kind: 'undo', source: left })).toBeNull();
    expect(x()).toBeCloseTo(0.3);
  });
});

describe('rotate and reset', () => {
  it('rotate-step rotates the selected part about +Y as one undoable command with a unit quaternion', () => {
    go({ kind: 'select', source: mouse, entityId: ID });
    go({ kind: 'rotate-step', source: mouse, radians: Math.PI / 12 });
    const q = store.document.entities[ID]!.transform.rotation;
    expect(Math.hypot(...q)).toBeCloseTo(1, 12);
    expect(yawDegrees(q)).toBeCloseTo(15, 9);
    expect(store.undoDepth).toBe(1);
  });

  it('reset returns the part to its home placement and is undoable', () => {
    go({ kind: 'grab-start', source: mouse, entityId: ID });
    go({ kind: 'grab-move', source: mouse, transform: T(0.25) });
    go({ kind: 'grab-end', source: mouse });
    go({ kind: 'reset', source: mouse });
    expect(x()).toBe(0);
    store.undo();
    expect(x()).toBeCloseTo(0.25);
  });

  it('selection is cleared when the selected entity is removed by undo', () => {
    store.dispatch(makeEnvelope([{ type: 'entity.create', entity: { ...store.document.entities[ID]!, id: 'b', transform: T(0.4), home: T(0.4) } }], { label: 'c', expectedRevision: 0, source: 'script', requestedBy: 't' }));
    go({ kind: 'select', source: mouse, entityId: 'b' });
    store.undo();
    expect(ctl.selectedId).toBeNull();
  });
});
