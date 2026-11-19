import {
  activeScene,
  createProject,
  degToRad,
  rotateAboutWorldY,
  validateProject,
} from '@forge/engineering-core';
import { BrowserStorageProjectRepository, MemoryStorage } from '@forge/persistence';
import { describe, expect, it } from 'vitest';

/** Cross-package: domain model + persistence together, as the app uses them. */
describe('project lifecycle', () => {
  it('create → edit transform → save → reopen in a fresh repository instance → identical', () => {
    const storage = new MemoryStorage();
    const p = createProject('Lifecycle');
    const inst = activeScene(p).instances[0]!;
    inst.transform.rotation = rotateAboutWorldY(inst.transform.rotation, degToRad(45));
    expect(new BrowserStorageProjectRepository(storage).save(p).ok).toBe(true);

    // Simulates a page reload: new repository over the same storage.
    const reopened = new BrowserStorageProjectRepository(storage).load(p.id);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value).toEqual(p);
    expect(validateProject(reopened.value).ok).toBe(true);
  });

  it('a project damaged in storage is reported and never returned as valid', () => {
    const storage = new MemoryStorage();
    const p = createProject();
    const repo = new BrowserStorageProjectRepository(storage);
    repo.save(p);
    const raw = JSON.parse(storage.getItem(`forge:project:${p.id}`)!);
    delete raw.units;
    storage.setItem(`forge:project:${p.id}`, JSON.stringify(raw));
    const r = repo.load(p.id);
    expect(r.ok).toBe(false);
  });
});
