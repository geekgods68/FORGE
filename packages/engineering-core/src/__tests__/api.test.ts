import { describe, expect, it } from 'vitest';
import { makeCommand } from '../commands/build';
import { COMMAND_TYPES } from '../commands/schemas';
import { ForgeEngine } from '../engine';
import { createProject } from '../project/create';
import { makeEngine } from './helpers';

/**
 * The application API exercised exactly as a non-GUI client (a script today,
 * Vey in Phase 9) would use it: execute → query, with no React or WebGL.
 */
describe('programmatic application API', () => {
  it('a client can create, query, transform and undo without any UI', () => {
    const forge = new ForgeEngine(createProject('Scripted'));
    const created = forge.execute(
      makeCommand(
        'scene.node.create',
        {
          node: {
            kind: 'primitive',
            name: 'Bracket',
            geometry: { shape: 'box', width: 0.08, height: 0.01, depth: 0.04 },
          },
        },
        'api',
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.affectedIds[0]!;

    const scene = forge.queryScene();
    expect(scene.nodes.find((n) => n.id === id)).toMatchObject({
      name: 'Bracket',
      kind: 'primitive',
      depth: 1,
    });

    const moved = forge.execute(
      makeCommand('scene.node.transform', { nodeId: id, position: [0.15, 0.05, 0.1] }, 'api'),
    );
    expect(moved).toMatchObject({ ok: true, revision: 2, affectedIds: [id] });
    expect(forge.getNode(id)!.transform.position).toEqual([0.15, 0.05, 0.1]);
    expect(forge.getWorldTransform(id)!.position).toEqual([0.15, 0.05, 0.1]);

    expect(forge.undo().ok).toBe(true);
    expect(forge.getNode(id)!.transform.position).toEqual([0, 0, 0]);
  });

  it('UI-originated and programmatic commands receive identical validation', () => {
    const { engine, cubeId } = makeEngine();
    const bad = (source: 'desktop-ui' | 'api') =>
      engine.execute(makeCommand('scene.node.transform', { nodeId: cubeId, scale: [0, 1, 1] }, source));
    const a = bad('desktop-ui');
    const b = bad('api');
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) {
      expect(a.error.code).toBe(b.error.code);
      expect(a.error.issues).toEqual(b.error.issues);
    }
  });

  it('queries return deeply frozen data — callers cannot mutate engineering state', () => {
    const { engine, cubeId } = makeEngine();
    const node = engine.getNode(cubeId)!;
    expect(() => {
      (node.transform.position as number[])[0] = 99;
    }).toThrow();
    expect(() => {
      (engine.getProject() as { name: string }).name = 'hacked';
    }).toThrow();
    expect(engine.getNode(cubeId)!.transform.position[0]).toBe(0);
  });

  it('capability discovery lists implemented commands separately from planned ones', () => {
    const caps = new ForgeEngine(createProject()).getCapabilities();
    expect(caps.commands.map((c) => c.type)).toEqual(COMMAND_TYPES);
    expect(caps.commands.every((c) => c.status === 'implemented')).toBe(true);
    expect(caps.future.every((f) => f.status === 'planned')).toBe(true);
    // Phase 3: conjuring is implemented (scene.node.create kind component-instance + scene.component.configure).
    expect(caps.future.map((f) => f.name)).not.toContain('component.conjure');
    expect(caps.commands.map((c) => c.type)).toContain('scene.component.configure');
    // Phase 4: mates are implemented commands; Phase 5 simulation is still planned.
    expect(caps.future.map((f) => f.name)).not.toContain('assembly.mate');
    expect(caps.commands.map((c) => c.type)).toContain('assembly.mate.create');
    expect(caps.future.map((f) => f.name)).toContain('simulation.run');
    expect(caps.sources.denied).toEqual(['vey']);
    expect(caps.queries).toContain('queryScene');
  });

  it('selection is ephemeral: not in history, not persisted, pruned when nodes disappear', () => {
    const { engine, box, run } = makeEngine();
    box('a');
    expect(engine.select(['a'])).toMatchObject({ ok: true, selection: ['a'] });
    expect(engine.select(['ghost'])).toMatchObject({ ok: false });
    const rev = engine.getProject().revision;
    expect(engine.getProject().revision).toBe(rev);
    expect(JSON.stringify(engine.getProject())).not.toContain('selection');
    run('scene.node.delete', { nodeId: 'a' });
    expect(engine.getSelection()).toEqual([]);
  });

  it('replaceProject validates first and leaves the current project intact on failure', () => {
    const { engine, state } = makeEngine();
    const before = state();
    const bad = { ...createProject(), scene: { rootId: 'missing', nodes: {} } };
    expect(engine.replaceProject(bad)).toMatchObject({ ok: false });
    expect(state()).toBe(before);
    expect(engine.replaceProject(createProject('Other'))).toEqual({ ok: true });
    expect(engine.getProject().name).toBe('Other');
    expect(engine.getHistory().canUndo).toBe(false);
  });

  it('notifies subscribers of each change kind', () => {
    const { engine, box } = makeEngine();
    const kinds: string[] = [];
    engine.subscribe((k) => kinds.push(k));
    box('a');
    engine.select(['a']);
    engine.undo();
    engine.redo();
    expect(kinds).toEqual(['command', 'selection', 'undo', 'redo']);
  });
});
