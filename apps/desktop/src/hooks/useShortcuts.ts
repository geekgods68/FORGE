import { useEffect } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { EditorState } from '@/app/store';

/** True when the keyboard event belongs to a text/number field and must not trigger shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Editor shortcuts:
 *   W / E / R            translate / rotate / scale tool
 *   Escape               cancel the active manipulation, otherwise deselect
 *   ⌘/Ctrl+Z             undo
 *   ⌘/Ctrl+⇧+Z, Ctrl+Y   redo
 *   ⌘/Ctrl+D             duplicate selected
 *   Delete               delete selected
 */
export function handleShortcut(e: KeyboardEvent, store: StoreApi<EditorState>): boolean {
  if (isTypingTarget(e.target)) return false;
  const s = store.getState();
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  const selected = s.selection[0];
  // First-person walking owns movement keys; Escape leaves walking. Editing shortcuts
  // with a modifier (undo/redo) still work; bare-key editing shortcuts are suppressed.
  if (s.navMode === 'walk') {
    if (key === 'escape') {
      s.setNavMode('orbit');
      return true;
    }
    return !mod;
  }

  if (mod && key === 'z') {
    if (e.shiftKey) s.redo();
    else s.undo();
    return true;
  }
  if (e.ctrlKey && !e.metaKey && key === 'y') {
    s.redo();
    return true;
  }
  if (mod && key === 'd') {
    if (selected) {
      const r = s.run(
        'scene.node.duplicate',
        { nodeId: selected, offset: [0.05, 0, 0] },
        { label: 'Duplicate', source: 'keyboard' },
      );
      if (r.ok) s.select(r.affectedIds[0]!);
    }
    return true;
  }
  if (mod || e.altKey) return false;
  if (key === 'escape') {
    if (s.dragging) s.requestCancelDrag();
    else s.select(null);
    return true;
  }
  if (key === 'w' || key === 'e' || key === 'r') {
    s.setToolMode(key === 'w' ? 'translate' : key === 'e' ? 'rotate' : 'scale');
    return true;
  }
  if (key === 'delete' && s.view === 'facility' && s.editLayer === 'layout') {
    if (s.itemSelection)
      s.runWorkspace('workspace.item.remove', { itemId: s.itemSelection }, { label: 'Remove equipment' });
    return true;
  }
  if (key === 'delete' && selected) {
    s.run('scene.node.delete', { nodeId: selected }, { label: 'Delete', source: 'keyboard' });
    return true;
  }
  return false;
}

export function useShortcuts(store: StoreApi<EditorState>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (handleShortcut(e, store)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
}
