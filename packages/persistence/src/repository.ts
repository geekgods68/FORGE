import {
  loadProjectDocument,
  serializeProject,
  validateProject,
  type DocumentError,
  type Project,
} from '@forge/engineering-core';

/**
 * Persistence boundary. The browser-storage adapter below is the local quick-save
 * store; durable copies are `.forge.json` files (export/import, see engineering-core
 * project/file.ts). A future desktop filesystem adapter implements the same interface.
 *
 * Browser storage is NOT a backup: it is per-browser-profile, user-clearable and size-limited.
 */
export type LoadError = { code: 'not-found'; message: string } | DocumentError;

export type SaveError =
  { code: 'invalid'; message: string; details: string[] } | { code: 'storage'; message: string };

export type Result<T, E> = { ok: true; value: T; migratedFrom?: number } | { ok: false; error: E };

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export interface ProjectRepository {
  list(): ProjectSummary[];
  load(id: string): Result<Project, LoadError>;
  save(project: Project): Result<ProjectSummary, SaveError>;
  remove(id: string): void;
}

/** The subset of the Web Storage API we depend on (injectable for tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export class BrowserStorageProjectRepository implements ProjectRepository {
  constructor(
    private readonly storage: StorageLike,
    private readonly namespace = 'forge',
  ) {}

  private key(id: string) {
    return `${this.namespace}:project:${id}`;
  }

  list(): ProjectSummary[] {
    const prefix = `${this.namespace}:project:`;
    const out: ProjectSummary[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (!k?.startsWith(prefix)) continue;
      const r = this.load(k.slice(prefix.length));
      if (r.ok) out.push({ id: r.value.id, name: r.value.name, updatedAt: r.value.updatedAt });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Parses, migrates (v1 → v2) and validates. Never returns an unvalidated project. */
  load(id: string): Result<Project, LoadError> {
    const raw = this.storage.getItem(this.key(id));
    if (raw === null)
      return { ok: false, error: { code: 'not-found', message: `No saved project with id ${id}.` } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: { code: 'corrupt', message: 'Saved project is not valid JSON.' } };
    }
    const r = loadProjectDocument(parsed);
    if (!r.ok) return { ok: false, error: r.error };
    return r.migratedFrom
      ? { ok: true, value: r.project, migratedFrom: r.migratedFrom }
      : { ok: true, value: r.project };
  }

  save(project: Project): Result<ProjectSummary, SaveError> {
    const v = validateProject(project);
    if (!v.ok)
      return {
        ok: false,
        error: { code: 'invalid', message: 'Refusing to save an invalid project.', details: v.errors },
      };
    try {
      this.storage.setItem(this.key(project.id), serializeProject(v.project));
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'storage',
          message: `Browser storage rejected the save: ${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }
    return { ok: true, value: { id: project.id, name: project.name, updatedAt: project.updatedAt } };
  }

  remove(id: string): void {
    this.storage.removeItem(this.key(id));
  }
}

/** In-memory StorageLike for tests and non-browser environments. */
export class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
}
