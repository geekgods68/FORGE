import { parseResearch, serializeResearch, type ResearchDocument } from '@forge/research';
import type { StorageLike } from './repository';

/**
 * Research documents (Phase 7), one per engineering project, stored separately from the
 * project file. Saved automatically after every change: recorded runs must not depend on the
 * user remembering to press Save. Raw run telemetry is NOT stored here (see the run-data store).
 */
export class BrowserStorageResearchRepository {
  constructor(
    private readonly storage: StorageLike,
    private readonly namespace = 'forge',
  ) {}
  private key(projectId: string) {
    return `${this.namespace}:research:${projectId}`;
  }
  load(projectId: string): { ok: true; doc: ResearchDocument | null } | { ok: false; error: string } {
    const raw = this.storage.getItem(this.key(projectId));
    if (raw === null) return { ok: true, doc: null };
    const r = parseResearch(raw);
    return r.ok ? { ok: true, doc: r.doc } : { ok: false, error: r.error };
  }
  save(doc: ResearchDocument): { ok: true } | { ok: false; message: string } {
    try {
      this.storage.setItem(this.key(doc.projectId), serializeResearch(doc));
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        message: `Browser storage rejected the research save: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}
