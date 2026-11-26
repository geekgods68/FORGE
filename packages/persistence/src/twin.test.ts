import { createVeyrisTwinProject, emptyTwinDocument, upsertTwin, veyrisArmTwin } from '@forge/digital-twin';
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './repository';
import { BrowserStorageTwinRepository } from './twin';

const at = new Date('2026-11-26T00:00:00Z');
describe('BrowserStorageTwinRepository', () => {
  it('saves and reloads twin configuration per project; corrupt data is refused, not loaded', () => {
    const s = new MemoryStorage();
    const repo = new BrowserStorageTwinRepository(s, 'test');
    const p = createVeyrisTwinProject(at);
    const r = upsertTwin(emptyTwinDocument(p.id), veyrisArmTwin(p, at), at);
    if (!r.ok) throw new Error(r.error);
    expect(repo.save(r.doc).ok).toBe(true);
    const back = repo.load(p.id);
    expect(back.ok && back.doc).toEqual(r.doc);
    expect(repo.load('other')).toEqual({ ok: true, doc: null });
    s.setItem(`test:twin:${p.id}`, '{"format":"forge-twins","schemaVersion":1,"projectId":"x","twins":[]}');
    expect(repo.load(p.id).ok).toBe(false);
    s.setItem(`test:twin:${p.id}`, 'not json');
    expect(repo.load(p.id).ok).toBe(false);
  });
});
