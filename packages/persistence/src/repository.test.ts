import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProject, ForgeEngine, makeCommand, PROJECT_SCHEMA_VERSION } from '@forge/engineering-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserStorageProjectRepository, MemoryStorage } from './repository';

let storage: MemoryStorage;
let repo: BrowserStorageProjectRepository;
beforeEach(() => {
  storage = new MemoryStorage();
  repo = new BrowserStorageProjectRepository(storage, 'test');
});

describe('BrowserStorageProjectRepository', () => {
  it('save → load round-trips a hierarchy exactly', () => {
    const engine = new ForgeEngine(createProject('Round trip'));
    const g = engine.execute(
      makeCommand('scene.node.create', { node: { kind: 'group', name: 'Assembly' } }, 'test'),
    );
    if (!g.ok) throw new Error(g.error.message);
    engine.execute(
      makeCommand(
        'scene.node.create',
        {
          node: {
            kind: 'primitive',
            parentId: g.affectedIds[0],
            geometry: { shape: 'torus', majorRadius: 0.1, tubeRadius: 0.02 },
            transform: { position: [0.123456789, 0, 0] },
          },
        },
        'test',
      ),
    );
    const p = engine.getProject();
    expect(repo.save(p).ok).toBe(true);
    const r = repo.load(p.id);
    expect(r.ok && r.value).toEqual(p);
  });

  it('stores canonical, schema-versioned JSON', () => {
    const p = createProject();
    repo.save(p);
    expect(JSON.parse(storage.getItem(`test:project:${p.id}`)!).schemaVersion).toBe(7); // current schema (v7)
  });

  it('lists saved projects newest first and skips unreadable entries', () => {
    repo.save({ ...createProject('A'), updatedAt: '2026-01-01T00:00:00.000Z' });
    repo.save({ ...createProject('B'), updatedAt: '2026-06-01T00:00:00.000Z' });
    storage.setItem('test:project:broken', '{not json');
    expect(repo.list().map((x) => x.name)).toEqual(['B', 'A']);
  });

  it('reports not-found, corrupt JSON and schema violations with field paths', () => {
    expect(repo.load('missing')).toMatchObject({ ok: false, error: { code: 'not-found' } });
    storage.setItem('test:project:x', '{"schemaVersion": 2, ');
    expect(repo.load('x')).toMatchObject({ ok: false, error: { code: 'corrupt' } });
    const p = createProject();
    const bad = JSON.parse(JSON.stringify(p));
    bad.scene.nodes[bad.scene.rootId].transform.position = ['a', 0, 0];
    storage.setItem(`test:project:${p.id}`, JSON.stringify(bad));
    const r = repo.load(p.id);
    if (r.ok || r.error.code !== 'invalid') throw new Error('expected invalid');
    expect(r.error.details.join('\n')).toMatch(/scene\.nodes\..+\.transform\.position/);
  });

  it('rejects newer schema versions', () => {
    const p = { ...createProject(), schemaVersion: PROJECT_SCHEMA_VERSION + 1 };
    storage.setItem(`test:project:${p.id}`, JSON.stringify(p));
    expect(repo.load(p.id)).toMatchObject({ ok: false, error: { code: 'unsupported-version' } });
  });

  it('loads a Phase 0 (v1) project saved by the previous build and migrates it', () => {
    const v1Text = readFileSync(
      fileURLToPath(new URL('../../../tests/fixtures/phase0-v1-project.json', import.meta.url)),
      'utf8',
    );
    const id = JSON.parse(v1Text).id;
    storage.setItem(`test:project:${id}`, v1Text);
    const r = repo.load(id);
    expect(r).toMatchObject({ ok: true, migratedFrom: 1 });
    if (r.ok) expect(r.value.schemaVersion).toBe(7); // current schema (v7)
  });

  it('refuses to save an invalid project and surfaces storage failures', () => {
    const p = createProject();
    const bad = JSON.parse(JSON.stringify(p));
    bad.scene.rootId = 'missing';
    expect(repo.save(bad)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(storage.length).toBe(0);
    const full = new BrowserStorageProjectRepository(
      Object.assign(new MemoryStorage(), {
        setItem() {
          throw new Error('QuotaExceededError');
        },
      }),
    );
    expect(full.save(createProject())).toMatchObject({ ok: false, error: { code: 'storage' } });
  });
});
