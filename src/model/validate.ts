import { CATALOG } from './catalog';
import { SCHEMA_ID, SCHEMA_VERSION, type Entity, type Transform, type WorkshopDocument } from './types';

/** Runtime validation (TypeScript types are not trusted for external input). */

export type ErrorCode =
  | 'malformed'
  | 'stale-revision'
  | 'not-found'
  | 'duplicate-id'
  | 'invalid-geometry'
  | 'unknown-part'
  | 'cycle'
  | 'has-children'
  | 'invalid-document';

export class ValidationError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Workshop-scale bound for any coordinate, in metres. */
export const MAX_COORD_M = 100;
const QUAT_NORM_TOLERANCE = 1e-3;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isNonEmptyString = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function checkTransform(t: unknown, where: string): asserts t is Transform {
  if (!isObj(t)) throw new ValidationError('invalid-geometry', `${where}: transform must be an object`);
  const { position: p, rotation: r } = t;
  if (!Array.isArray(p) || p.length !== 3 || !p.every(isFiniteNum)) throw new ValidationError('invalid-geometry', `${where}: position must be 3 finite numbers`);
  if (p.some((c) => Math.abs(c) > MAX_COORD_M)) throw new ValidationError('invalid-geometry', `${where}: position exceeds ±${MAX_COORD_M} m`);
  if (!Array.isArray(r) || r.length !== 4 || !r.every(isFiniteNum)) throw new ValidationError('invalid-geometry', `${where}: rotation must be 4 finite numbers`);
  const n = Math.hypot(...(r as number[]));
  if (Math.abs(n - 1) > QUAT_NORM_TOLERANCE) throw new ValidationError('invalid-geometry', `${where}: rotation must be a unit quaternion (norm ${n.toFixed(4)})`);
}

export function checkEntity(e: unknown): asserts e is Entity {
  if (!isObj(e)) throw new ValidationError('malformed', 'entity must be an object');
  if (!isNonEmptyString(e.id)) throw new ValidationError('malformed', 'entity.id must be a non-empty string');
  if (e.kind !== 'part') throw new ValidationError('malformed', `entity ${e.id}: unsupported kind`);
  if (!isNonEmptyString(e.partDefId)) throw new ValidationError('malformed', `entity ${e.id}: partDefId required`);
  if (!CATALOG[e.partDefId]) throw new ValidationError('unknown-part', `entity ${e.id}: unknown part definition "${e.partDefId}"`);
  if (typeof e.name !== 'string' || e.name.length > 200) throw new ValidationError('malformed', `entity ${e.id}: name must be a string ≤ 200 chars`);
  if (e.parentId !== null && !isNonEmptyString(e.parentId)) throw new ValidationError('malformed', `entity ${e.id}: parentId must be a string or null`);
  checkTransform(e.transform, `entity ${e.id}.transform`);
  checkTransform(e.home, `entity ${e.id}.home`);
}

/** Referential integrity across the whole entity set: parents exist, no cycles. */
export function checkEntityGraph(entities: Record<string, Entity>): void {
  for (const [key, e] of Object.entries(entities)) {
    if (key !== e.id) throw new ValidationError('invalid-document', `entity key ${key} does not match id ${e.id}`);
    if (e.parentId !== null && !entities[e.parentId]) throw new ValidationError('not-found', `entity ${e.id}: parent ${e.parentId} does not exist`);
  }
  for (const e of Object.values(entities)) {
    const seen = new Set<string>([e.id]);
    let cur = e.parentId;
    while (cur !== null) {
      if (seen.has(cur)) throw new ValidationError('cycle', `parent cycle through ${e.id}`);
      seen.add(cur);
      cur = entities[cur]?.parentId ?? null;
    }
  }
}

export function checkDocument(d: unknown): asserts d is WorkshopDocument {
  if (!isObj(d)) throw new ValidationError('invalid-document', 'document must be an object');
  if (d.schema !== SCHEMA_ID) throw new ValidationError('invalid-document', `unknown schema "${String(d.schema)}"`);
  if (d.schemaVersion !== SCHEMA_VERSION) throw new ValidationError('invalid-document', `unsupported schemaVersion ${String(d.schemaVersion)} (supported: ${SCHEMA_VERSION})`);
  if (!isNonEmptyString(d.projectId)) throw new ValidationError('invalid-document', 'projectId required');
  if (!Number.isSafeInteger(d.revision) || (d.revision as number) < 0) throw new ValidationError('invalid-document', 'revision must be a non-negative integer');
  if (!isObj(d.units) || d.units.length !== 'm') throw new ValidationError('invalid-document', 'units.length must be "m"');
  if (!isObj(d.entities)) throw new ValidationError('invalid-document', 'entities must be an object');
  for (const e of Object.values(d.entities)) checkEntity(e);
  checkEntityGraph(d.entities as Record<string, Entity>);
}
