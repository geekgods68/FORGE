import { describe, expect, it } from 'vitest';
import { parseProjectFile, serializeProject } from '../project/file';
import { PROJECT_SCHEMA_VERSION } from '../project/schema';
import { defaultSimulationDefinition, type SimulationDefinition } from '../simulation/schemas';
import { makeEngine } from './helpers';

const sim = (e: ReturnType<typeof makeEngine>['engine']): SimulationDefinition | undefined => {
  const p = e.getProject();
  const r = p.scene.nodes[p.scene.rootId]!;
  return r.kind === 'root' ? r.simulation : undefined;
};

describe('simulation definition commands (Phase 5)', () => {
  it('create → configure → undo/redo; each change is one validated history entry', () => {
    const { engine, run } = makeEngine();
    expect(run('physics.configure', { patch: { gravityEnabled: false } }).ok).toBe(false); // no setup yet
    expect(run('physics.simulation.create', {}).ok).toBe(true);
    expect(sim(engine)).toEqual(defaultSimulationDefinition());
    expect(run('physics.simulation.create', {}).ok).toBe(false); // only one
    expect(
      run('physics.configure', { patch: { gravity: [0, -1.62, 0], solver: { timestepS: 1 / 240 } } }).ok,
    ).toBe(true);
    expect(sim(engine)!.gravity).toEqual([0, -1.62, 0]);
    expect(sim(engine)!.solver.substeps).toBe(4); // merged, not replaced
    engine.undo();
    expect(sim(engine)!.gravity).toEqual([0, -9.80665, 0]);
    engine.redo();
    expect(sim(engine)!.solver.timestepS).toBeCloseTo(1 / 240, 12);
    engine.undo();
    engine.undo();
    expect(sim(engine)).toBeUndefined();
  });

  it('invalid settings are rejected and nothing changes', () => {
    const { engine, run } = makeEngine();
    run('physics.simulation.create', {});
    const rev = engine.getProject().revision;
    for (const patch of [
      { solver: { timestepS: 1 } },
      { gravity: [0, -2000, 0] as [number, number, number] },
      { solver: { substeps: 0 } },
    ]) {
      const r = run('physics.configure', { patch });
      expect(r.ok).toBe(false);
    }
    expect(engine.getProject().revision).toBe(rev);
  });

  it('body settings merge onto the defaults, validate the node, and null removes them', () => {
    const { engine, run, box } = makeEngine();
    box('b1');
    run('physics.simulation.create', {});
    expect(
      run('physics.body.set', {
        nodeId: 'b1',
        settings: { mode: 'dynamic', mass: { source: 'user', massKg: 2, note: 'measured on scale' } },
      }).ok,
    ).toBe(true);
    const b = sim(engine)!.bodies[0]!;
    expect(b).toMatchObject({ nodeId: 'b1', mode: 'dynamic', friction: 0.5, collider: 'auto' });
    expect(run('physics.body.set', { nodeId: 'b1', settings: { friction: -1 } }).ok).toBe(false);
    expect(
      run('physics.body.set', { nodeId: 'b1', settings: { mass: { source: 'user', massKg: 0, note: '' } } })
        .ok,
    ).toBe(false);
    expect(run('physics.body.set', { nodeId: 'missing', settings: {} }).ok).toBe(false);
    expect(run('physics.body.set', { nodeId: 'b1', settings: null }).ok).toBe(true);
    expect(sim(engine)!.bodies).toEqual([]);
  });

  it('payloads: add, replace, delete; actuators only on single-axis joints', () => {
    const { engine, run, box } = makeEngine();
    box('b1');
    run('physics.simulation.create', {});
    const payload = {
      id: 'p1',
      name: 'Payload',
      nodeId: 'b1',
      massKg: 0.2,
      offsetM: [0, 0.1, 0] as [number, number, number],
    };
    expect(run('physics.payload.set', { payload }).ok).toBe(true);
    expect(run('physics.payload.set', { payload: { ...payload, massKg: 0.5 } }).ok).toBe(true);
    expect(sim(engine)!.payloads).toEqual([{ ...payload, massKg: 0.5 }]);
    expect(run('physics.payload.set', { payload: { ...payload, massKg: -1 } }).ok).toBe(false);
    expect(run('physics.payload.delete', { payloadId: 'p1' }).ok).toBe(true);
    expect(run('physics.payload.delete', { payloadId: 'p1' }).ok).toBe(false);
    expect(run('physics.joint.set', { mateId: 'nope', settings: { damping: 1 } }).ok).toBe(false);
  });

  it('persists in project files (current schema v6); v4 files without a setup still load', () => {
    const { engine, run, box } = makeEngine();
    box('b1');
    run('physics.simulation.create', {});
    run('physics.body.set', { nodeId: 'b1', settings: { mode: 'fixed', collider: 'bounds-box' } });
    const text = serializeProject(engine.getProject());
    expect(JSON.parse(text).schemaVersion).toBe(6);
    expect(PROJECT_SCHEMA_VERSION).toBe(6);
    const back = parseProjectFile(text);
    if (!back.ok) throw new Error(back.error.message);
    const r = back.project.scene.nodes[back.project.scene.rootId]!;
    expect(r.kind === 'root' && r.simulation?.bodies[0]?.collider).toBe('bounds-box');
    // A v4 document (no simulation field) migrates without change.
    const v4 = JSON.parse(text);
    v4.schemaVersion = 4;
    delete v4.scene.nodes[v4.scene.rootId].simulation;
    const old = parseProjectFile(JSON.stringify(v4));
    expect(old.ok && old.migratedFrom).toBe(4);
    // A corrupt simulation setup is rejected as a whole; nothing half-loads.
    const bad = JSON.parse(text);
    bad.scene.nodes[bad.scene.rootId].simulation.solver.timestepS = -1;
    expect(parseProjectFile(JSON.stringify(bad)).ok).toBe(false);
  });
});
