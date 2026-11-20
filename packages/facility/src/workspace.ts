import { IdSchema } from '@forge/engineering-core';
import { z } from 'zod';
import { normalizeYaw } from './frames';
import { getEquipment, getZone, itemFootprint, rectInside, rectsOverlap } from './registry';
import { FACILITY } from './registry';
import { WorkspaceLayoutSchema, type WorkspaceItem, type WorkspaceLayout } from './schemas';

/**
 * WorkspaceEngine — authoritative state of the user's EDITABLE workspace layout
 * (workbenches, cabinets, instruments). Separate from:
 *   - the facility (read-only data; no command can address walls, corridors or zones),
 *   - engineering projects (ForgeEngine; linked only by `mountedProjectId`).
 *
 * Contract `forge.workspace-command/v1` mirrors the engineering command contract:
 * validated envelope, atomic application, structured results, revision counter that
 * advances on every change (incl. undo/redo), and its own undo/redo history.
 */
export const WORKSPACE_COMMAND_SOURCES = ['desktop-ui', 'keyboard', 'api', 'test', 'vey'] as const;
const Meta = z.object({
  source: z.enum(WORKSPACE_COMMAND_SOURCES),
  timestamp: z.iso.datetime(),
  expectedRevision: z.number().int().min(0).optional(),
  label: z.string().max(200).optional(),
});
const n = z.number();
const XZ = z.tuple([n, n]);
const Yaw = n.min(-1e3).max(1e3);

const env = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ commandId: IdSchema, type: z.literal(type), payload, metadata: Meta });

export const WorkspaceCommandSchema = z.discriminatedUnion('type', [
  env(
    'workspace.item.place',
    z.object({
      id: IdSchema.optional(),
      name: z.string().trim().min(1).max(200).optional(),
      equipmentId: IdSchema,
      zoneId: IdSchema,
      areaId: IdSchema,
      /** Floor position (x, z) in the zone frame, metres. */
      position: XZ,
      yaw: Yaw.default(0),
    }),
  ),
  env('workspace.item.move', z.object({ itemId: IdSchema, position: XZ.optional(), yaw: Yaw.optional() })),
  env('workspace.item.remove', z.object({ itemId: IdSchema })),
  env('workspace.item.rename', z.object({ itemId: IdSchema, name: z.string().trim().min(1).max(200) })),
  env('workspace.item.lock', z.object({ itemId: IdSchema, locked: z.boolean() })),
  env('workspace.bench.mount', z.object({ itemId: IdSchema, projectId: IdSchema.nullable() })),
]);
export type WorkspaceCommand = z.output<typeof WorkspaceCommandSchema>;
export type WorkspaceCommandType = WorkspaceCommand['type'];
export const WORKSPACE_COMMAND_TYPES: WorkspaceCommandType[] = [
  'workspace.item.place',
  'workspace.item.move',
  'workspace.item.remove',
  'workspace.item.rename',
  'workspace.item.lock',
  'workspace.bench.mount',
];

export type WorkspaceErrorCode =
  | 'unknown-command'
  | 'invalid-command'
  | 'not-found'
  | 'duplicate-id'
  | 'locked'
  | 'zone-unavailable'
  | 'not-allowed-here'
  | 'out-of-bounds'
  | 'collision'
  | 'not-a-workbench'
  | 'stale-revision'
  | 'permission-denied';

export type WorkspaceResult =
  | {
      ok: true;
      commandId: string;
      type: WorkspaceCommandType;
      revision: number;
      affectedIds: string[];
      noop: boolean;
    }
  | {
      ok: false;
      commandId: string | null;
      type: string | null;
      revision: number;
      error: { code: WorkspaceErrorCode; message: string; issues?: { path: string; message: string }[] };
    };

class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type ItemOp = { put: WorkspaceItem } | { remove: string };
interface Entry {
  label: string;
  forward: ItemOp[];
  inverse: ItemOp[];
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * Placement rules for one item against the rest of the layout:
 * zone implemented, area exists and admits the category, footprint inside the area,
 * no footprint overlap with other items in the same zone, floor-level pose.
 */
export function checkPlacement(item: WorkspaceItem, others: readonly WorkspaceItem[]): void {
  const zone = getZone(item.zoneId);
  if (!zone) throw new WorkspaceError('not-found', `Zone "${item.zoneId}" does not exist.`);
  if (zone.status !== 'implemented')
    throw new WorkspaceError('zone-unavailable', `"${zone.name}" is not built yet.`);
  const eq = getEquipment(item.equipmentId);
  if (!eq) throw new WorkspaceError('not-found', `Equipment "${item.equipmentId}" does not exist.`);
  const area = zone.placementAreas.find((a) => a.id === item.areaId);
  if (!area)
    throw new WorkspaceError('not-found', `Placement area "${item.areaId}" does not exist in ${zone.name}.`);
  if (!area.allowedCategories.includes(eq.category))
    throw new WorkspaceError(
      'not-allowed-here',
      `${eq.name} (${eq.category}) is not allowed in ${area.name}.`,
    );
  if (!item.pose.position.every(Number.isFinite) || item.pose.position[1] !== 0)
    throw new WorkspaceError(
      'out-of-bounds',
      'Equipment must stand on the floor (y = 0) at a finite position.',
    );
  const fp = itemFootprint(item.pose, eq);
  if (!rectInside(fp, area.rect))
    throw new WorkspaceError('out-of-bounds', `${item.name} would extend outside ${area.name}.`);
  for (const o of others) {
    if (o.id === item.id || o.zoneId !== item.zoneId) continue;
    const oe = getEquipment(o.equipmentId);
    if (oe && rectsOverlap(fp, itemFootprint(o.pose, oe)))
      throw new WorkspaceError('collision', `${item.name} would overlap ${o.name}.`);
  }
}

/** Full semantic validation of a layout against the facility (used for load/import). */
export function validateLayout(
  data: unknown,
): { ok: true; layout: WorkspaceLayout } | { ok: false; errors: string[] } {
  const r = WorkspaceLayoutSchema.safeParse(data);
  if (!r.success)
    return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const items = Object.values(r.data.items);
  const errors: string[] = [];
  for (const [key, it] of Object.entries(r.data.items)) {
    if (key !== it.id) errors.push(`items.${key}: key does not match id ${it.id}`);
    try {
      checkPlacement(it, items);
    } catch (e) {
      errors.push(`items.${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const eq = getEquipment(it.equipmentId);
    if (it.mountedProjectId && eq?.category !== 'workbench')
      errors.push(`items.${key}: only workbenches can host projects`);
  }
  if (r.data.facilityRevision > FACILITY.revision)
    errors.push(
      `facilityRevision ${r.data.facilityRevision} is newer than this build (${FACILITY.revision})`,
    );
  return errors.length ? { ok: false, errors } : { ok: true, layout: r.data };
}

export interface WorkspaceEngineOptions {
  historyLimit?: number;
  newId?: () => string;
  now?: () => Date;
  deniedSources?: string[];
}

declare const crypto: { randomUUID(): string };

export class WorkspaceEngine {
  private layout: WorkspaceLayout;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<() => void>();
  private readonly limit: number;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly denied: string[];

  constructor(layout: WorkspaceLayout, opts: WorkspaceEngineOptions = {}) {
    const v = validateLayout(layout);
    if (!v.ok) throw new Error(`Invalid workspace layout: ${v.errors.slice(0, 3).join('; ')}`);
    this.layout = deepFreeze(JSON.parse(JSON.stringify(v.layout)) as WorkspaceLayout);
    this.limit = opts.historyLimit ?? 200;
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => new Date());
    this.denied = opts.deniedSources ?? ['vey'];
  }

  getLayout(): WorkspaceLayout {
    return this.layout;
  }
  getItem(id: string): WorkspaceItem | null {
    return this.layout.items[id] ?? null;
  }
  /** The bench a project is mounted on, if any. */
  benchForProject(projectId: string): WorkspaceItem | null {
    return Object.values(this.layout.items).find((i) => i.mountedProjectId === projectId) ?? null;
  }
  getHistory() {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.at(-1)?.label ?? null,
      redoLabel: this.redoStack.at(-1)?.label ?? null,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
    };
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  replaceLayout(layout: unknown): { ok: true } | { ok: false; errors: string[] } {
    const v = validateLayout(layout);
    if (!v.ok) return v;
    this.layout = deepFreeze(JSON.parse(JSON.stringify(v.layout)) as WorkspaceLayout);
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
    return { ok: true };
  }

  execute(input: unknown): WorkspaceResult {
    const rev = this.layout.revision;
    const raw = (typeof input === 'object' && input !== null ? input : {}) as {
      type?: unknown;
      commandId?: unknown;
    };
    const cid = typeof raw.commandId === 'string' ? raw.commandId : null;
    const fail = (
      code: WorkspaceErrorCode,
      message: string,
      type: string | null = null,
      issues?: { path: string; message: string }[],
    ): WorkspaceResult => ({
      ok: false,
      commandId: cid,
      type,
      revision: rev,
      error: { code, message, ...(issues ? { issues } : {}) },
    });
    if (typeof raw.type !== 'string' || !(WORKSPACE_COMMAND_TYPES as string[]).includes(raw.type))
      return fail('unknown-command', `Unknown workspace command "${String(raw.type)}".`);
    const parsed = WorkspaceCommandSchema.safeParse(input);
    if (!parsed.success)
      return fail(
        'invalid-command',
        'Workspace command failed validation.',
        raw.type,
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    const cmd = parsed.data;
    if (this.denied.includes(cmd.metadata.source))
      return fail('permission-denied', `Source "${cmd.metadata.source}" is not permitted.`, cmd.type);
    if (cmd.metadata.expectedRevision !== undefined && cmd.metadata.expectedRevision !== rev)
      return fail(
        'stale-revision',
        `Expected revision ${cmd.metadata.expectedRevision}, current is ${rev}.`,
        cmd.type,
      );

    const items = { ...this.layout.items };
    const before = new Map<string, WorkspaceItem | undefined>();
    const put = (it: WorkspaceItem) => {
      if (!before.has(it.id)) before.set(it.id, items[it.id]);
      items[it.id] = it;
    };
    const remove = (id: string) => {
      if (!before.has(id)) before.set(id, items[id]);
      delete items[id];
    };
    const need = (id: string) => {
      const it = items[id];
      if (!it) throw new WorkspaceError('not-found', `Workspace item "${id}" does not exist.`);
      return it;
    };
    const unlocked = (it: WorkspaceItem) => {
      if (it.locked) throw new WorkspaceError('locked', `${it.name} is locked.`);
      return it;
    };

    let affected: string[];
    try {
      switch (cmd.type) {
        case 'workspace.item.place': {
          const p = cmd.payload;
          const id = p.id ?? this.newId();
          if (items[id]) throw new WorkspaceError('duplicate-id', `Workspace item "${id}" already exists.`);
          const eq = getEquipment(p.equipmentId);
          const it: WorkspaceItem = {
            id,
            name: p.name ?? eq?.name ?? 'Equipment',
            equipmentId: p.equipmentId,
            zoneId: p.zoneId,
            areaId: p.areaId,
            pose: { position: [p.position[0], 0, p.position[1]], yaw: normalizeYaw(p.yaw) },
            mountedProjectId: null,
            locked: false,
          };
          checkPlacement(it, Object.values(items));
          put(it);
          affected = [id];
          break;
        }
        case 'workspace.item.move': {
          const cur = unlocked(need(cmd.payload.itemId));
          const pos = cmd.payload.position;
          const next: WorkspaceItem = {
            ...cur,
            pose: {
              position: pos ? [pos[0], 0, pos[1]] : cur.pose.position,
              yaw: cmd.payload.yaw !== undefined ? normalizeYaw(cmd.payload.yaw) : cur.pose.yaw,
            },
          };
          checkPlacement(next, Object.values(items));
          if (JSON.stringify(next.pose) !== JSON.stringify(cur.pose)) put(next);
          affected = [cur.id];
          break;
        }
        case 'workspace.item.remove': {
          const cur = unlocked(need(cmd.payload.itemId));
          remove(cur.id);
          affected = [cur.id];
          break;
        }
        case 'workspace.item.rename': {
          const cur = unlocked(need(cmd.payload.itemId));
          if (cur.name !== cmd.payload.name) put({ ...cur, name: cmd.payload.name });
          affected = [cur.id];
          break;
        }
        case 'workspace.item.lock': {
          const cur = need(cmd.payload.itemId);
          if (cur.locked !== cmd.payload.locked) put({ ...cur, locked: cmd.payload.locked });
          affected = [cur.id];
          break;
        }
        case 'workspace.bench.mount': {
          const cur = need(cmd.payload.itemId);
          if (getEquipment(cur.equipmentId)?.category !== 'workbench')
            throw new WorkspaceError('not-a-workbench', `${cur.name} is not a workbench.`);
          const pid = cmd.payload.projectId;
          affected = [cur.id];
          if (pid) {
            // A project is mounted on at most one bench: unmount it elsewhere in the same step.
            for (const o of Object.values(items))
              if (o.id !== cur.id && o.mountedProjectId === pid) {
                put({ ...o, mountedProjectId: null });
                affected.push(o.id);
              }
          }
          if (cur.mountedProjectId !== pid) put({ ...items[cur.id]!, mountedProjectId: pid });
          break;
        }
      }
    } catch (e) {
      if (e instanceof WorkspaceError) return fail(e.code, e.message, cmd.type);
      throw e;
    }

    const forward: ItemOp[] = [];
    const inverse: ItemOp[] = [];
    for (const [id, prev] of before) {
      const now = items[id];
      if (JSON.stringify(now) === JSON.stringify(prev)) continue;
      forward.push(now ? { put: now } : { remove: id });
      inverse.unshift(prev ? { put: prev } : { remove: id });
    }
    if (!forward.length)
      return {
        ok: true,
        commandId: cmd.commandId,
        type: cmd.type,
        revision: rev,
        affectedIds: affected,
        noop: true,
      };
    this.commit(items);
    this.undoStack.push({
      label: cmd.metadata.label ?? cmd.type.split('.').slice(1).join(' '),
      forward,
      inverse,
    });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
    return {
      ok: true,
      commandId: cmd.commandId,
      type: cmd.type,
      revision: this.layout.revision,
      affectedIds: affected,
      noop: false,
    };
  }

  undo() {
    return this.replay('undo');
  }
  redo() {
    return this.replay('redo');
  }

  private replay(kind: 'undo' | 'redo') {
    const from = kind === 'undo' ? this.undoStack : this.redoStack;
    const to = kind === 'undo' ? this.redoStack : this.undoStack;
    const e = from.pop();
    if (!e) return { ok: false as const, message: `Nothing to ${kind}.` };
    const items = { ...this.layout.items };
    for (const op of kind === 'undo' ? e.inverse : e.forward) {
      if ('put' in op) items[op.put.id] = op.put;
      else delete items[op.remove];
    }
    this.commit(items);
    to.push(e);
    this.emit();
    return { ok: true as const, label: e.label, revision: this.layout.revision };
  }

  private commit(items: Record<string, WorkspaceItem>) {
    this.layout = deepFreeze({
      ...this.layout,
      items,
      revision: this.layout.revision + 1,
      updatedAt: this.now().toISOString(),
    });
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

export function makeWorkspaceCommand<T extends WorkspaceCommandType>(
  type: T,
  payload: z.input<
    Extract<
      (typeof WorkspaceCommandSchema)['options'][number],
      { shape: { type: z.ZodLiteral<T> } }
    >['shape']['payload']
  >,
  source: (typeof WORKSPACE_COMMAND_SOURCES)[number],
  extra: { expectedRevision?: number; label?: string } = {},
) {
  return {
    commandId: crypto.randomUUID(),
    type,
    payload,
    metadata: { source, timestamp: new Date().toISOString(), ...extra },
  };
}
