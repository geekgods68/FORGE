import { createProject } from '@forge/engineering-core';
import { defaultWorkspaceLayout } from '@forge/facility';
import { describe, expect, it } from 'vitest';
import { BrowserStorageProjectRepository, MemoryStorage } from './repository';
import { BrowserStorageWorkspaceRepository, parseWorkspaceFile, serializeWorkspace } from './workspace';

describe('workspace persistence (separate from projects)', () => {
  it('round-trips a layout exactly through storage and through a file', () => {
    const storage = new MemoryStorage();
    const repo = new BrowserStorageWorkspaceRepository(storage);
    const layout = defaultWorkspaceLayout(new Date('2026-11-20T00:00:00Z'), 'ws-1');
    expect(repo.save(layout)).toEqual({ ok: true });
    expect(repo.load('ws-1')).toEqual({ ok: true, layout });
    expect(repo.latest()).toEqual(layout);
    expect(parseWorkspaceFile(serializeWorkspace(layout))).toEqual({ ok: true, layout });
  });

  it('uses its own key namespace: project and workspace stores never see each other', () => {
    const storage = new MemoryStorage();
    const projects = new BrowserStorageProjectRepository(storage);
    const workspaces = new BrowserStorageWorkspaceRepository(storage);
    projects.save(createProject('P'));
    workspaces.save(defaultWorkspaceLayout(new Date(), 'ws-1'));
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)!);
    expect(keys.filter((k) => k.startsWith('forge:project:'))).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith('forge:workspace:'))).toHaveLength(1);
    expect(projects.list()).toHaveLength(1);
    expect(workspaces.latest()!.id).toBe('ws-1');
  });

  it('rejects corrupt, oversized and semantically invalid files with useful errors', () => {
    expect(parseWorkspaceFile('{"workspaceSchemaVersion":')).toMatchObject({
      ok: false,
      error: { code: 'corrupt' },
    });
    expect(parseWorkspaceFile(' '.repeat(3 * 1024 * 1024))).toMatchObject({
      ok: false,
      error: { code: 'too-large' },
    });
    const bad = defaultWorkspaceLayout();
    bad.items['bench-a']!.pose.position = [100, 0, 0];
    const r = parseWorkspaceFile(JSON.stringify(bad));
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid' } });
    if (!r.ok && r.error.code === 'invalid')
      expect(r.error.details.join('\n')).toMatch(/outside Bench floor/);
  });
});
