import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeEnvelope, type Command } from '../../src/commands/commands';
import { WorkshopStore } from '../../src/commands/store';
import { initialDocument } from '../../src/model/fixture';
import type { Entity, Transform } from '../../src/model/types';
import { Scene } from '../../src/render/babylon';
import { EntityView } from '../../src/render/entityView';
import { detectXrSupport } from '../../src/xr/readiness';

const ID = 'part-enclosure-1';
const T = (x: number, y = 0.8, z = -0.6): Transform => ({ position: [x, y, z], rotation: [0, 0, 0, 1] });

let scene: Scene;
let store: WorkshopStore;
let view: EntityView;
const run = (commands: Command[]) => store.dispatch(makeEnvelope(commands, { label: 't', expectedRevision: store.document.revision, source: 'script', requestedBy: 't' }));
const entityMeshes = () => scene.meshes.filter((m) => m.metadata?.entityId);

beforeEach(() => {
  scene = new Scene(new NullEngine());
  scene.useRightHandedSystem = true;
  store = new WorkshopStore(initialDocument());
  view = new EntityView(scene);
  view.sync(store.document);
  store.subscribe((d) => view.sync(d));
});

describe('EntityView reconciliation (NullEngine, no GPU)', () => {
  it('renders one mesh per entity at the document transform', () => {
    expect(entityMeshes()).toHaveLength(1);
    const p = view.worldPose(ID).position;
    const doc = store.document.entities[ID]!.transform.position;
    // Babylon world matrices are float32: read-back agrees to ~1e-7 m, not bit-exactly.
    [p.x, p.y, p.z].forEach((v, i) => expect(v).toBeCloseTo(doc[i]!, 6));
  });

  it('repeated sync (e.g. XR exit/re-entry) never duplicates meshes', () => {
    for (let i = 0; i < 5; i++) view.sync(store.document);
    expect(entityMeshes()).toHaveLength(1);
    expect(view.meshCount()).toBe(1);
  });

  it('delete disposes the mesh; undo recreates exactly one', () => {
    run([{ type: 'entity.delete', id: ID }]);
    expect(entityMeshes()).toHaveLength(0);
    store.undo();
    expect(entityMeshes()).toHaveLength(1);
  });

  it('a preview moves only the rendered mesh; clearing it restores the document pose', () => {
    view.setPreview(ID, T(0.4));
    expect(view.worldPose(ID).position.x).toBeCloseTo(0.4);
    expect(store.document.entities[ID]!.transform.position[0]).toBe(0);
    view.setPreview(ID, null);
    expect(view.worldPose(ID).position.x).toBeCloseTo(0);
  });

  it('parent links are rendered and worldToLocal converts into the parent frame', () => {
    const child: Entity = { ...store.document.entities[ID]!, id: 'child', parentId: ID, transform: T(0.1, 0.05, 0), home: T(0.1, 0.05, 0) };
    run([
      { type: 'entity.setTransform', id: ID, transform: { position: [1, 0.8, -0.6], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] } }, // 90° yaw
      { type: 'entity.create', entity: child },
    ]);
    const world = view.worldPose('child');
    // Parent yawed +90° about Y (right-handed): child local +X maps to world -Z.
    expect(world.position.x).toBeCloseTo(1, 6);
    expect(world.position.z).toBeCloseTo(-0.7, 6);
    const local = view.worldToLocal('child', world.position, world.rotation);
    expect(local.position[0]).toBeCloseTo(0.1, 6);
    expect(local.position[1]).toBeCloseTo(0.05, 6);
    expect(local.position[2]).toBeCloseTo(0, 6);
  });

  it('picking predicate recognises entity meshes only', () => {
    const mesh = view.meshFor(ID)!;
    expect(view.isEntityMesh(mesh)).toBe(true);
    expect(view.entityIdOf(null)).toBeNull();
  });
});

describe('XR readiness detection', () => {
  it('reports insecure context before anything else', async () => {
    expect((await detectXrSupport({ isSecureContext: false, xr: undefined })).state).toBe('insecure-context');
  });
  it('reports missing WebXR', async () => {
    expect((await detectXrSupport({ isSecureContext: true, xr: undefined })).state).toBe('no-webxr');
  });
  it('reports immersive-vr unsupported (desktop without headset)', async () => {
    expect((await detectXrSupport({ isSecureContext: true, xr: { isSessionSupported: async () => false } })).state).toBe('vr-unsupported');
  });
  it('reports ready when supported', async () => {
    expect((await detectXrSupport({ isSecureContext: true, xr: { isSessionSupported: async () => true } })).state).toBe('ready');
  });
  it('reports an error state when the query throws', async () => {
    const s = await detectXrSupport({ isSecureContext: true, xr: { isSessionSupported: async () => Promise.reject(new Error('SecurityError')) } });
    expect(s.state).toBe('error');
    expect(s.message).toContain('SecurityError');
  });
});
