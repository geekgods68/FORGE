import { makeEnvelope, type Command, type CommandSource } from '../commands/commands';
import type { Result, WorkshopStore } from '../commands/store';
import { checkTransform } from '../model/validate';
import { cloneTransform, rotateAboutY, transformsEqual } from '../model/math';
import type { Transform } from '../model/types';
import type { InputSourceInfo, Intent } from './intents';

/** Renderer hooks: temporary visual state only, never document state. */
export interface InteractionView {
  setPreview(entityId: string, transform: Transform | null): void;
  setHover(entityId: string | null): void;
  setSelected(entityId: string | null): void;
}

interface ActiveGrab {
  entityId: string;
  source: InputSourceInfo;
  start: Transform;
  current: Transform;
  /** Document revision when the grab began; the commit must still match it. */
  revision: number;
}

export interface InteractionEvent {
  kind: 'committed' | 'rejected' | 'cancelled' | 'ignored';
  detail: string;
}

/**
 * Turns intents into validated commands.
 * - A grab shows a renderer-only preview and commits exactly ONE setTransform
 *   on release (one undo step), using the revision captured at grab start.
 * - Cancel, source loss or session end during a grab discard the preview.
 * - Only the source that started a grab may move or release it.
 */
export class InteractionController {
  private grab: ActiveGrab | null = null;
  private selected: string | null = null;
  private hoverBySource = new Map<string, string | null>();
  lastEvent: InteractionEvent | null = null;
  onEvent?: (e: InteractionEvent) => void;

  constructor(
    private readonly store: WorkshopStore,
    private readonly view: InteractionView,
    private readonly actor = 'local-owner',
  ) {
    // Keep selection valid if the selected entity disappears (delete/undo).
    store.subscribe((doc) => {
      if (this.selected && !doc.entities[this.selected]) this.setSelected(null);
      if (this.grab && !doc.entities[this.grab.entityId]) this.cancelGrab('entity removed');
    });
  }

  get selectedId() {
    return this.selected;
  }
  get activeGrab(): Readonly<ActiveGrab> | null {
    return this.grab;
  }

  handle(intent: Intent): Result | null {
    switch (intent.kind) {
      case 'hover': {
        this.hoverBySource.set(intent.source.id, intent.entityId);
        this.view.setHover(intent.entityId ?? [...this.hoverBySource.values()].find((v) => v) ?? null);
        return null;
      }
      case 'select':
        if (this.grab) return null;
        this.setSelected(intent.entityId && this.store.document.entities[intent.entityId] ? intent.entityId : null);
        return null;
      case 'grab-start': {
        if (this.grab) return this.note('ignored', `grab already held by ${this.grab.source.id}`);
        const e = this.store.document.entities[intent.entityId];
        if (!e) return this.note('ignored', `no entity ${intent.entityId}`);
        this.grab = { entityId: e.id, source: intent.source, start: cloneTransform(e.transform), current: cloneTransform(e.transform), revision: this.store.document.revision };
        this.setSelected(e.id);
        return null;
      }
      case 'grab-move': {
        if (!this.grab || this.grab.source.id !== intent.source.id) return null;
        try {
          checkTransform(intent.transform, 'grab preview');
        } catch {
          return null; // ignore an invalid sample; keep the last valid preview
        }
        this.grab.current = cloneTransform(intent.transform);
        this.view.setPreview(this.grab.entityId, this.grab.current);
        return null;
      }
      case 'grab-end': {
        if (!this.grab || this.grab.source.id !== intent.source.id) return null;
        const g = this.grab;
        this.grab = null;
        this.view.setPreview(g.entityId, null);
        if (transformsEqual(g.start, g.current, 1e-6)) return this.note('ignored', 'released without movement');
        return this.submit([{ type: 'entity.setTransform', id: g.entityId, transform: g.current }], 'Move part', sourceOf(intent.source), g.revision);
      }
      case 'cancel':
        this.cancelGrab(intent.reason);
        return null;
      case 'source-lost':
        this.hoverBySource.delete(intent.source.id);
        if (this.grab?.source.id === intent.source.id) this.cancelGrab(intent.reason);
        this.view.setHover([...this.hoverBySource.values()].find((v) => v) ?? null);
        return null;
      case 'rotate-step': {
        if (this.grab || !this.selected) return null;
        const e = this.store.document.entities[this.selected]!;
        const t = { position: [...e.transform.position] as Transform['position'], rotation: rotateAboutY(e.transform.rotation, intent.radians) };
        return this.submit([{ type: 'entity.setTransform', id: e.id, transform: t }], 'Rotate part', sourceOf(intent.source));
      }
      case 'reset': {
        if (this.grab) this.cancelGrab('reset');
        const ids = this.selected ? [this.selected] : Object.keys(this.store.document.entities);
        const cmds: Command[] = ids.map((id) => ({ type: 'entity.setTransform', id, transform: cloneTransform(this.store.document.entities[id]!.home) }));
        return cmds.length ? this.submit(cmds, this.selected ? 'Reset part' : 'Reset all parts', sourceOf(intent.source)) : null;
      }
      case 'undo':
        if (this.grab) return null; // never undo underneath an active grab
        return this.store.undo();
      case 'redo':
        if (this.grab) return null;
        return this.store.redo();
    }
  }

  /** Called by the XR layer when the session ends or by the desktop on window blur. */
  cancelGrab(reason: string) {
    if (!this.grab) return;
    const id = this.grab.entityId;
    this.grab = null;
    this.view.setPreview(id, null);
    this.note('cancelled', reason);
  }

  private setSelected(id: string | null) {
    this.selected = id;
    this.view.setSelected(id);
  }

  private submit(commands: Command[], label: string, source: CommandSource, expectedRevision = this.store.document.revision): Result {
    const r = this.store.dispatch(makeEnvelope(commands, { label, expectedRevision, source, requestedBy: this.actor }));
    this.note(r.ok ? 'committed' : 'rejected', r.ok ? label : `${label}: ${r.message}`);
    return r;
  }

  private note(kind: InteractionEvent['kind'], detail: string): null {
    this.lastEvent = { kind, detail };
    this.onEvent?.(this.lastEvent);
    return null;
  }
}

function sourceOf(s: InputSourceInfo): CommandSource {
  if (s.type === 'xr-controller') return 'xr';
  if (s.type === 'in-world-ui') return 'ui';
  return 'desktop';
}
