import {
  createProject,
  ForgeEngine,
  makeCommand,
  parseProjectFile,
  serializeProject,
} from '@forge/engineering-core';
import { BrowserStorageProjectRepository, MemoryStorage } from '@forge/persistence';
import { describe, expect, it } from 'vitest';

/** Cross-package: engine + file format + storage adapter, as the app uses them. */
describe('project lifecycle', () => {
  it('edit via commands → quick-save → reopen in a fresh repository → export → import → identical', () => {
    const engine = new ForgeEngine(createProject('Lifecycle'));
    const r = engine.execute(
      makeCommand(
        'scene.node.create',
        { node: { kind: 'primitive', geometry: { shape: 'cone', radius: 0.03, height: 0.12 } } },
        'api',
      ),
    );
    if (!r.ok) throw new Error(r.error.message);
    engine.execute(
      makeCommand('scene.node.transform', { nodeId: r.affectedIds[0]!, position: [0.25, 0.06, -0.1] }, 'api'),
    );
    const project = engine.getProject();

    const storage = new MemoryStorage();
    expect(new BrowserStorageProjectRepository(storage).save(project).ok).toBe(true);
    const reopened = new BrowserStorageProjectRepository(storage).load(project.id);
    expect(reopened.ok && reopened.value).toEqual(project);

    const imported = parseProjectFile(serializeProject(project));
    expect(imported.ok && imported.project).toEqual(project);

    // Loading into a new engine reproduces the same engineering state.
    if (!imported.ok) return;
    const engine2 = new ForgeEngine(imported.project);
    expect(engine2.queryScene()).toEqual(engine.queryScene());
  });

  it('a failed import leaves the active engine state untouched', () => {
    const engine = new ForgeEngine(createProject());
    const before = serializeProject(engine.getProject());
    const r = parseProjectFile('{"schemaVersion":2,"scene":{"rootId":"x","nodes":{}}}');
    expect(r.ok).toBe(false);
    if (r.ok) engine.replaceProject(r.project);
    expect(serializeProject(engine.getProject())).toBe(before);
  });
});
