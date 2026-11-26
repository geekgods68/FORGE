import { ProjectV1Schema, type ProjectV1 } from '../schemas';
import type { SceneGraph, SceneNode } from '../scene/schemas';
import { validateProject } from './create';
import { PROJECT_SCHEMA_VERSION, type Project } from './schema';

/**
 * Loading pipeline for persisted/imported documents:
 *   unknown JSON value → version check → migrate to current → full validation.
 * Only migrations for versions that actually existed are defined (v1 = Phase 0).
 */
export type DocumentError =
  | { code: 'corrupt'; message: string }
  | { code: 'unsupported-version'; message: string }
  | { code: 'invalid'; message: string; details: string[] }
  | { code: 'too-large'; message: string };

export type DocumentResult =
  { ok: true; project: Project; migratedFrom?: number } | { ok: false; error: DocumentError };

const invalid = (message: string, details: string[]): DocumentResult => ({
  ok: false,
  error: { code: 'invalid', message, details },
});

/** v1 (Phase 0: scenes[] of component instances) → v2 (single scene graph). */
export function migrateV1ToV2(
  v1: ProjectV1,
): { ok: true; value: Project } | { ok: false; details: string[] } {
  if (v1.scenes.length !== 1)
    return {
      ok: false,
      details: [
        `scenes: v1 projects with ${v1.scenes.length} scenes cannot be migrated (Phase 0 only created one)`,
      ],
    };
  const s = v1.scenes[0]!;
  const nodes: Record<string, SceneNode> = {};
  const rootId = s.id;
  nodes[rootId] = {
    id: rootId,
    kind: 'root',
    name: s.name,
    parentId: null,
    childIds: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    metadata: {},
  };
  const owner = new Map<string, string>();
  for (const a of s.assemblies) {
    nodes[a.id] = {
      ...nodes[rootId]!,
      id: a.id,
      kind: 'assembly',
      mechanical: { grounded: [], mates: [], constraints: [] },
      name: a.name,
      parentId: rootId,
      childIds: [],
    };
    nodes[rootId]!.childIds.push(a.id);
    for (const m of a.memberInstanceIds) {
      if (owner.has(m))
        return {
          ok: false,
          details: [`instance ${m} belongs to more than one v1 assembly; cannot form a tree`],
        };
      owner.set(m, a.id);
    }
  }
  for (const inst of s.instances) {
    const parentId = owner.get(inst.id) ?? rootId;
    nodes[inst.id] = {
      id: inst.id,
      kind: 'component-instance',
      definitionId: inst.definitionId,
      name: inst.name,
      parentId,
      childIds: [],
      transform: { position: inst.transform.position, rotation: inst.transform.rotation, scale: [1, 1, 1] },
      visible: true,
      locked: false,
      metadata: Object.fromEntries(Object.entries(inst.configuration)),
    };
    nodes[parentId]!.childIds.push(inst.id);
  }
  const scene: SceneGraph = { rootId, nodes };
  return {
    ok: true,
    value: {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: v1.id,
      name: v1.name,
      createdAt: v1.createdAt,
      updatedAt: v1.updatedAt,
      revision: 0,
      units: v1.units,
      materials: v1.materials,
      definitions: v1.definitions,
      scene,
    },
  };
}

/** Turn an already-parsed JSON value into a validated current-version project. */
export function loadProjectDocument(doc: unknown): DocumentResult {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
    return { ok: false, error: { code: 'corrupt', message: 'Document is not a FORGE project object.' } };
  const version = (doc as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version))
    return invalid('Document has no valid schemaVersion.', ['schemaVersion: missing or not an integer']);
  if (version > PROJECT_SCHEMA_VERSION)
    return {
      ok: false,
      error: {
        code: 'unsupported-version',
        message: `This project uses schema v${version}; this build of FORGE supports up to v${PROJECT_SCHEMA_VERSION}.`,
      },
    };
  if (version === 1) {
    const v1 = ProjectV1Schema.safeParse(doc);
    if (!v1.success)
      return invalid(
        'Phase 0 (v1) project failed validation.',
        v1.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      );
    const m = migrateV1ToV2(v1.data);
    if (!m.ok) return invalid('Phase 0 (v1) project could not be migrated.', m.details);
    const v = validateProject(m.value);
    return v.ok
      ? { ok: true, project: v.project, migratedFrom: 1 }
      : invalid('Migrated project failed validation.', v.errors);
  }
  if (version >= 2 && version <= 6) {
    // v2…v6 → v7: no structural change (v3 added the optional component reference;
    // v4 added assemblies' mechanical data — defaulted — and new node kinds; v5 added the
    // optional simulation definition, v6 the optional electrical definition and v7 the optional
    // import records on the root, absent in older files).
    const v = validateProject({ ...(doc as object), schemaVersion: PROJECT_SCHEMA_VERSION });
    return v.ok
      ? { ok: true, project: v.project, migratedFrom: version }
      : invalid(
          `Project failed validation (${v.errors.length} problem${v.errors.length === 1 ? '' : 's'}).`,
          v.errors,
        );
  }
  if (version !== PROJECT_SCHEMA_VERSION)
    return {
      ok: false,
      error: { code: 'unsupported-version', message: `Unknown schema version ${version}.` },
    };
  const v = validateProject(doc);
  return v.ok
    ? { ok: true, project: v.project }
    : invalid(
        `Project failed validation (${v.errors.length} problem${v.errors.length === 1 ? '' : 's'}).`,
        v.errors,
      );
}
