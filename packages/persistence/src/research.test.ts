import { ResearchEngine } from '@forge/research';
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './repository';
import { BrowserStorageResearchRepository } from './research';

describe('research repository', () => {
  it('saves and reloads a research document per project; corrupt data is reported, not loaded', () => {
    const s = new MemoryStorage();
    const repo = new BrowserStorageResearchRepository(s, 'test');
    expect(repo.load('p1')).toEqual({ ok: true, doc: null });
    const eng = ResearchEngine.empty('p1', () => new Date('2026-11-22T00:00:00Z'));
    expect(repo.save(eng.document).ok).toBe(true);
    expect(repo.load('p1')).toEqual({ ok: true, doc: eng.document });
    s.setItem('test:research:p1', '{"schemaVersion":1}');
    expect(repo.load('p1').ok).toBe(false);
  });
});
