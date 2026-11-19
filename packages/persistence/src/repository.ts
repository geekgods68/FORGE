import { PROJECT_SCHEMA_VERSION, validateProject, type Project } from '@forge/engineering-core';

/**
 * Persistence boundary. The browser adapter below is Phase 0's only implementation;
 * a future desktop filesystem adapter implements the same interface.
 *
 * Browser storage is a convenience store, NOT a production-grade backup:
 * it is per-browser-profile, can be cleared by the user or browser, and is size-limited.
 */
export type LoadError =
  | { code: 'not-found'; message: string }
  | { code: 'corrupt'; message: string }
  | { code: 'unsupported-version'; message: string }
  | { code: 'invalid'; message: string; details: string[] };

export type SaveError =
  { code: 'invalid'; message: string; details: string[] } | { code: 'storage'; message: string };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

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

/**
 * Upgrade older persisted documents to the current schema. Only v1 exists, so the
 * table is empty; adding v2 means adding `1: (doc) => v2Doc` here plus tests.
 */
const MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrate(doc: unknown): Result<unknown, LoadError> {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
    return { ok: false, error: { code: 'corrupt', message: 'Saved data is not a project object.' } };
  let current = doc as Record<string, unknown>;
  let version = current.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version))
    return {
      ok: false,
      error: {
        code: 'invalid',
        message: 'Saved project has no valid schemaVersion.',
        details: ['schemaVersion: missing'],
      },
    };
  if (version > PROJECT_SCHEMA_VERSION)
    return {
      ok: false,
      error: {
        code: 'unsupported-version',
        message: `This project was saved with schema v${version}; this build of FORGE supports up to v${PROJECT_SCHEMA_VERSION}.`,
      },
    };
  while (version < PROJECT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step)
      return {
        ok: false,
        error: { code: 'unsupported-version', message: `No migration from schema v${version}.` },
      };
    current = step(current);
    version = current.schemaVersion;
    if (typeof version !== 'number') break;
  }
  return { ok: true, value: current };
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
    const migrated = migrate(parsed);
    if (!migrated.ok) return migrated;
    const v = validateProject(migrated.value);
    if (!v.ok)
      return {
        ok: false,
        error: {
          code: 'invalid',
          message: `Saved project failed validation (${v.errors.length} problem${v.errors.length === 1 ? '' : 's'}).`,
          details: v.errors,
        },
      };
    return { ok: true, value: v.project };
  }

  save(project: Project): Result<ProjectSummary, SaveError> {
    const v = validateProject(project);
    if (!v.ok)
      return {
        ok: false,
        error: { code: 'invalid', message: 'Refusing to save an invalid project.', details: v.errors },
      };
    try {
      this.storage.setItem(this.key(project.id), JSON.stringify(v.project));
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
