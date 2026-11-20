import { canonicalStringify } from '@forge/engineering-core';
import { validateLayout, type WorkspaceLayout } from '@forge/facility';
import type { StorageLike } from './repository';

/**
 * Workspace-layout persistence — a SEPARATE store and file type from engineering
 * projects (different key prefix, different file extension, different schema).
 * Facility architecture is never persisted by users: it ships with FORGE.
 */
export const WORKSPACE_FILE_EXTENSION = '.forge-workspace.json';
export const MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;

export type WorkspaceLoadError =
  | { code: 'not-found' | 'corrupt' | 'too-large'; message: string }
  | { code: 'invalid'; message: string; details: string[] };

export type WorkspaceLoadResult =
  { ok: true; layout: WorkspaceLayout } | { ok: false; error: WorkspaceLoadError };

export const serializeWorkspace = (layout: WorkspaceLayout): string => canonicalStringify(layout, 2) + '\n';

/** Parse untrusted workspace-file text; validated against the facility. Never throws. */
export function parseWorkspaceFile(text: string): WorkspaceLoadResult {
  if (text.length > MAX_WORKSPACE_FILE_BYTES)
    return { ok: false, error: { code: 'too-large', message: 'Workspace file exceeds the 2 MiB limit.' } };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: 'corrupt', message: 'Workspace file is not valid JSON.' } };
  }
  const v = validateLayout(doc);
  return v.ok
    ? { ok: true, layout: v.layout }
    : {
        ok: false,
        error: { code: 'invalid', message: 'Workspace layout failed validation.', details: v.errors },
      };
}

export class BrowserStorageWorkspaceRepository {
  constructor(
    private readonly storage: StorageLike,
    private readonly namespace = 'forge',
  ) {}

  private key(id: string) {
    return `${this.namespace}:workspace:${id}`;
  }

  /** Most recently updated valid layout, if any. */
  latest(): WorkspaceLayout | null {
    const prefix = `${this.namespace}:workspace:`;
    let best: WorkspaceLayout | null = null;
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (!k?.startsWith(prefix)) continue;
      const r = this.load(k.slice(prefix.length));
      if (r.ok && (!best || r.layout.updatedAt > best.updatedAt)) best = r.layout;
    }
    return best;
  }

  load(id: string): WorkspaceLoadResult {
    const raw = this.storage.getItem(this.key(id));
    if (raw === null)
      return { ok: false, error: { code: 'not-found', message: `No saved workspace ${id}.` } };
    return parseWorkspaceFile(raw);
  }

  save(layout: WorkspaceLayout): { ok: true } | { ok: false; message: string } {
    const v = validateLayout(layout);
    if (!v.ok) return { ok: false, message: `Refusing to save an invalid layout: ${v.errors[0]}` };
    try {
      this.storage.setItem(this.key(layout.id), serializeWorkspace(v.layout));
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        message: `Browser storage rejected the save: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}
