import { parseTwinDocument, type TwinDocument } from '@forge/digital-twin';
import type { StorageLike } from './repository';

/**
 * Digital-twin documents (Phase 8), one per engineering project, stored separately from the
 * project file and its undo history. Telemetry is never stored here: live samples stay in
 * the pipeline's memory and recordings in the run-data store.
 */
export class BrowserStorageTwinRepository {
  constructor(
    private readonly storage: StorageLike,
    private readonly namespace = 'forge',
  ) {}
  private key(projectId: string) {
    return `${this.namespace}:twin:${projectId}`;
  }
  load(projectId: string): { ok: true; doc: TwinDocument | null } | { ok: false; error: string } {
    const raw = this.storage.getItem(this.key(projectId));
    if (raw === null) return { ok: true, doc: null };
    const r = parseTwinDocument(raw, projectId);
    return r.ok ? { ok: true, doc: r.doc } : { ok: false, error: r.error };
  }
  save(doc: TwinDocument): { ok: true } | { ok: false; message: string } {
    try {
      this.storage.setItem(this.key(doc.projectId), JSON.stringify(doc));
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        message: `Browser storage rejected the twin save: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}
