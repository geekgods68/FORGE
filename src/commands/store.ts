import { transformsEqual } from '../model/math';
import type { Entity, WorkshopDocument } from '../model/types';
import { checkDocument, checkEntity, checkEntityGraph, checkTransform, ValidationError, type ErrorCode } from '../model/validate';
import { checkEnvelopeShape, type Command, type CommandEnvelope } from './commands';

/**
 * The single mutation path for the project document.
 *
 * Revision semantics:
 * - `revision` increases by 1 on every applied change: dispatch, undo and redo.
 * - A newly submitted envelope must carry expectedRevision === revision, else it
 *   is rejected as stale. An undo also advances the revision, so undo can never
 *   make an old external request valid again.
 * - Undo/redo replay STORED operations (inverse/forward). They are not
 *   re-validated against the original envelope's expectedRevision, so redo does
 *   not fail merely because its original request is now old.
 * - Failed dispatches leave the document, revision and history untouched.
 */

/** Primitive state operations. Every history entry is a list of these. */
export type Op = { op: 'put'; entity: Entity } | { op: 'remove'; id: string };

export interface HistoryEntry {
  commandId: string;
  label: string;
  source: CommandEnvelope['source'];
  forward: Op[];
  inverse: Op[];
}

export type Result =
  | { ok: true; revision: number; noop?: boolean }
  | { ok: false; code: ErrorCode | 'empty-history'; message: string };

export type ChangeKind = 'dispatch' | 'undo' | 'redo' | 'load';
export type Listener = (doc: WorkshopDocument, kind: ChangeKind) => void;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const clone = <T>(v: T): T => structuredClone(v);

export class WorkshopStore {
  private doc: WorkshopDocument;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<Listener>();

  constructor(
    initial: WorkshopDocument,
    readonly historyLimit = 200,
  ) {
    checkDocument(initial);
    this.doc = deepFreeze(clone(initial));
  }

  get document(): Readonly<WorkshopDocument> {
    return this.doc;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get undoDepth() {
    return this.undoStack.length;
  }
  get redoDepth() {
    return this.redoStack.length;
  }
  get lastUndoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispatch(envelope: unknown): Result {
    try {
      checkEnvelopeShape(envelope);
      if (envelope.expectedRevision !== this.doc.revision) {
        throw new ValidationError('stale-revision', `expected revision ${envelope.expectedRevision}, current is ${this.doc.revision}`);
      }
      const draft = { ...this.doc.entities };
      const forward: Op[] = [];
      const inverse: Op[] = [];
      for (const cmd of envelope.commands) applyCommand(draft, cmd, forward, inverse);
      checkEntityGraph(draft);
      if (forward.length === 0) return { ok: true, revision: this.doc.revision, noop: true };
      this.commit(draft, 'dispatch');
      this.undoStack.push({ commandId: envelope.commandId, label: envelope.label, source: envelope.source, forward, inverse: inverse.reverse() });
      if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
      this.redoStack = [];
      this.emit('dispatch');
      return { ok: true, revision: this.doc.revision };
    } catch (err) {
      return failure(err);
    }
  }

  undo(): Result {
    const entry = this.undoStack.at(-1);
    if (!entry) return { ok: false, code: 'empty-history', message: 'Nothing to undo' };
    const r = this.replay(entry.inverse, 'undo');
    if (r.ok) this.redoStack.push(this.undoStack.pop()!);
    return r;
  }

  redo(): Result {
    const entry = this.redoStack.at(-1);
    if (!entry) return { ok: false, code: 'empty-history', message: 'Nothing to redo' };
    const r = this.replay(entry.forward, 'redo');
    if (r.ok) this.undoStack.push(this.redoStack.pop()!);
    return r;
  }

  private replay(ops: Op[], kind: ChangeKind): Result {
    try {
      const draft = { ...this.doc.entities };
      for (const o of ops) {
        if (o.op === 'put') draft[o.entity.id] = clone(o.entity);
        else delete draft[o.id];
      }
      checkEntityGraph(draft); // integrity guard; should never fail for well-formed history
      this.commit(draft, kind);
      this.emit(kind);
      return { ok: true, revision: this.doc.revision };
    } catch (err) {
      return failure(err);
    }
  }

  private commit(entities: Record<string, Entity>, _kind: ChangeKind) {
    this.doc = deepFreeze({ ...clone(this.doc), entities: clone(entities), revision: this.doc.revision + 1 });
  }

  private emit(kind: ChangeKind) {
    for (const l of this.listeners) l(this.doc, kind);
  }
}

function failure(err: unknown): Result {
  if (err instanceof ValidationError) return { ok: false, code: err.code, message: err.message };
  return { ok: false, code: 'malformed', message: err instanceof Error ? err.message : String(err) };
}

/** Layer 2: validate one command against the draft state, apply it, record ops. */
function applyCommand(draft: Record<string, Entity>, cmd: Command, forward: Op[], inverse: Op[]) {
  const put = (next: Entity) => {
    const prev = draft[next.id];
    forward.push({ op: 'put', entity: clone(next) });
    inverse.push(prev ? { op: 'put', entity: clone(prev) } : { op: 'remove', id: next.id });
    draft[next.id] = next;
  };
  const remove = (id: string) => {
    forward.push({ op: 'remove', id });
    inverse.push({ op: 'put', entity: clone(draft[id]!) });
    delete draft[id];
  };
  const need = (id: unknown): Entity => {
    const e = typeof id === 'string' ? draft[id] : undefined;
    if (!e) throw new ValidationError('not-found', `entity ${String(id)} does not exist`);
    return e;
  };

  switch (cmd.type) {
    case 'entity.create': {
      checkEntity(cmd.entity);
      if (draft[cmd.entity.id]) throw new ValidationError('duplicate-id', `entity ${cmd.entity.id} already exists`);
      put(clone(cmd.entity));
      return;
    }
    case 'entity.setTransform': {
      const e = need(cmd.id);
      checkTransform(cmd.transform, `setTransform ${cmd.id}`);
      if (transformsEqual(e.transform, cmd.transform)) return; // no-op
      put({ ...e, transform: clone(cmd.transform) });
      return;
    }
    case 'entity.setParent': {
      const e = need(cmd.id);
      if (cmd.parentId !== null) need(cmd.parentId);
      if (e.parentId === cmd.parentId) return;
      put({ ...e, parentId: cmd.parentId });
      return; // cycles are rejected by checkEntityGraph before commit
    }
    case 'entity.delete': {
      need(cmd.id);
      const children = Object.values(draft).filter((x) => x.parentId === cmd.id);
      if (children.length && !cmd.cascade) throw new ValidationError('has-children', `entity ${cmd.id} has ${children.length} child(ren); use cascade`);
      // Remove descendants deepest-first so every intermediate state is consistent.
      const order: string[] = [];
      const visit = (id: string) => {
        for (const c of Object.values(draft)) if (c.parentId === id) visit(c.id);
        order.push(id);
      };
      visit(cmd.id);
      for (const id of order) remove(id);
      return;
    }
  }
}
