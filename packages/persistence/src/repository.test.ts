import { activeScene, createProject, rotateAboutWorldY } from '@forge/engineering-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserStorageProjectRepository, MemoryStorage, migrate } from './repository';

let storage: MemoryStorage;
let repo: BrowserStorageProjectRepository;
beforeEach(() => {
  storage = new MemoryStorage();
  repo = new BrowserStorageProjectRepository(storage, 'test');
});

describe('BrowserStorageProjectRepository', () => {
  it('save → load round-trips the project exactly, including transforms', () => {
    const p = createProject('Round trip');
    const inst = activeScene(p).instances[0]!;
    inst.transform.position = [0.123456789, 0.15, -1.5];
    inst.transform.rotation = rotateAboutWorldY(inst.transform.rotation, 0.7);
    expect(repo.save(p).ok).toBe(true);
    const r = repo.load(p.id);
    expect(r.ok && r.value).toEqual(p);
  });

  it('stores readable, namespaced JSON with an explicit schema version', () => {
    const p = createProject();
    repo.save(p);
    const raw = storage.getItem(`test:project:${p.id}`)!;
    expect(JSON.parse(raw).schemaVersion).toBe(1);
  });

  it('lists saved projects newest first and skips unreadable entries', () => {
    const a = { ...createProject('A'), updatedAt: '2026-01-01T00:00:00.000Z' };
    const b = { ...createProject('B'), updatedAt: '2026-06-01T00:00:00.000Z' };
    repo.save(a);
    repo.save(b);
    storage.setItem('test:project:broken', '{not json');
    expect(repo.list().map((x) => x.name)).toEqual(['B', 'A']);
  });

  it('reports not-found', () => {
    expect(repo.load('missing')).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('reports corrupt JSON understandably', () => {
    storage.setItem('test:project:x', '{"schemaVersion": 1, ');
    const r = repo.load('x');
    expect(r).toMatchObject({ ok: false, error: { code: 'corrupt' } });
    expect(!r.ok && r.error.message).toMatch(/not valid JSON/);
  });

  it('reports schema violations with field paths', () => {
    const p = createProject();
    const bad = JSON.parse(JSON.stringify(p));
    bad.scenes[0].instances[0].transform.position = ['a', 0, 0];
    storage.setItem(`test:project:${p.id}`, JSON.stringify(bad));
    const r = repo.load(p.id);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'invalid')
      expect(r.error.details.join('\n')).toMatch(/scenes\.0\.instances\.0\.transform\.position/);
    else throw new Error('expected invalid');
  });

  it('rejects projects from a newer schema version without attempting to read them', () => {
    const p = { ...createProject(), schemaVersion: 7 };
    storage.setItem(`test:project:${p.id}`, JSON.stringify(p));
    expect(repo.load(p.id)).toMatchObject({ ok: false, error: { code: 'unsupported-version' } });
  });

  it('refuses to save an invalid project and leaves storage untouched', () => {
    const p = createProject();
    activeScene(p).instances[0]!.transform.position[0] = NaN;
    expect(repo.save(p)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(storage.length).toBe(0);
  });

  it('surfaces storage failures (e.g. quota exceeded) as errors instead of throwing', () => {
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

describe('migrate', () => {
  it('passes current-version documents through and rejects non-objects', () => {
    expect(migrate({ schemaVersion: 1 }).ok).toBe(true);
    expect(migrate([])).toMatchObject({ ok: false, error: { code: 'corrupt' } });
    expect(migrate({})).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(migrate({ schemaVersion: 0 })).toMatchObject({
      ok: false,
      error: { code: 'unsupported-version' },
    });
  });
});
