import { BrowserStorageProjectRepository, MemoryStorage } from '@forge/persistence';
import { serializeProject } from '@forge/engineering-core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';
import { HierarchyPanel } from '@/features/hierarchy/HierarchyPanel';
import { Inspector } from '@/features/inspector/Inspector';
import { handleShortcut } from '@/hooks/useShortcuts';
import { createEditorStore, EditorStoreContext, isDirty, type EditorState } from './store';

let storage: MemoryStorage;
let store: StoreApi<EditorState>;
const s = () => store.getState();
const cubeId = () => s().project.scene.nodes[s().project.scene.rootId]!.childIds[0]!;

function renderPanels() {
  return render(
    <EditorStoreContext.Provider value={store}>
      <HierarchyPanel />
      <Inspector />
    </EditorStoreContext.Provider>,
  );
}

beforeEach(() => {
  storage = new MemoryStorage();
  store = createEditorStore(new BrowserStorageProjectRepository(storage, 'ui'));
});

describe('hierarchy panel', () => {
  it('shows the scene tree and stays in sync with commands', () => {
    renderPanels();
    expect(screen.getByRole('treeitem', { name: /Scene/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /Reference Cube/ })).toBeInTheDocument();
    act(() => {
      expect(s().run('scene.node.create', { node: { kind: 'group', name: 'Assembly Group' } }).ok).toBe(true);
    });
    expect(screen.getByRole('treeitem', { name: /Assembly Group/ })).toBeInTheDocument();
  });

  it('click selects; double-click renames through a command', () => {
    renderPanels();
    const row = screen.getByTestId(`tree-row-${cubeId()}`);
    fireEvent.click(row);
    expect(s().selection).toEqual([cubeId()]);
    fireEvent.doubleClick(row);
    const input = screen.getByRole('textbox', { name: 'Rename' });
    fireEvent.change(input, { target: { value: 'Datum Cube' } });
    fireEvent.blur(input);
    expect(s().project.scene.nodes[cubeId()]!.name).toBe('Datum Cube');
    expect(s().history.undoLabel).toBe('Rename');
  });

  it('visibility and lock toggles are commands (undoable)', () => {
    renderPanels();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Reference Cube' }));
    expect(s().project.scene.nodes[cubeId()]!.visible).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Lock Reference Cube' }));
    expect(s().project.scene.nodes[cubeId()]!.locked).toBe(true);
    s().undo();
    s().undo();
    expect(s().project.scene.nodes[cubeId()]).toMatchObject({ visible: true, locked: false });
  });

  it('expand/collapse hides and shows children; group/ungroup buttons work', () => {
    renderPanels();
    const cube = cubeId(); // capture before grouping changes the root's first child
    fireEvent.click(screen.getByTestId(`tree-row-${cube}`));
    fireEvent.click(screen.getByRole('button', { name: 'Group selected' }));
    const groupId = s().selection[0]!;
    expect(s().project.scene.nodes[groupId]!.kind).toBe('group');
    const groupRow = screen.getByTestId(`tree-row-${groupId}`);
    fireEvent.click(within(groupRow).getByRole('button', { name: 'Collapse' }));
    expect(screen.queryByTestId(`tree-row-${cube}`)).toBeNull();
    fireEvent.click(within(groupRow).getByRole('button', { name: 'Expand' }));
    expect(screen.getByTestId(`tree-row-${cube}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ungroup' }));
    expect(s().project.scene.nodes[groupId]).toBeUndefined();
  });

  it('delete is refused for a locked node and the error is shown in status', () => {
    renderPanels();
    s().run('scene.node.lock', { nodeId: cubeId(), locked: true });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Reference Cube' }));
    expect(s().project.scene.nodes[cubeId()]).toBeDefined();
    expect(s().status).toMatchObject({ tone: 'error' });
  });
});

describe('inspector', () => {
  it('position entered in millimetres is stored in metres', () => {
    renderPanels();
    s().select(cubeId());
    renderPanels();
    const x = screen.getAllByTestId('position-x')[0]!;
    fireEvent.change(x, { target: { value: '125.5' } });
    fireEvent.blur(x);
    expect(s().project.scene.nodes[cubeId()]!.transform.position[0]).toBeCloseTo(0.1255, 12);
  });

  it('committing an unchanged (rounded) display value sends no command', () => {
    s().run('scene.node.transform', { nodeId: cubeId(), position: [0.1234567891, 0.15, 0] });
    s().select(cubeId());
    renderPanels();
    const rev = s().project.revision;
    const x = screen.getByTestId('position-x') as HTMLInputElement;
    expect(x.value).toBe('123.457');
    fireEvent.blur(x);
    expect(s().project.revision).toBe(rev);
    expect(s().project.scene.nodes[cubeId()]!.transform.position[0]).toBe(0.1234567891); // not rounded
  });

  it('rotation is entered in degrees and stored as a unit quaternion', () => {
    s().select(cubeId());
    renderPanels();
    const y = screen.getByTestId('rotation-y');
    fireEvent.change(y, { target: { value: '90' } });
    fireEvent.blur(y);
    const q = s().project.scene.nodes[cubeId()]!.transform.rotation;
    expect(q[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('invalid numeric input is rejected locally; zero scale is rejected by the engine', () => {
    s().select(cubeId());
    renderPanels();
    const rev = s().project.revision;
    const x = screen.getByTestId('position-x');
    fireEvent.change(x, { target: { value: 'abc' } });
    fireEvent.blur(x);
    expect(s().project.revision).toBe(rev);
    const sx = screen.getByTestId('scale-x');
    fireEvent.change(sx, { target: { value: '0' } });
    fireEvent.blur(sx);
    expect(s().project.scene.nodes[cubeId()]!.transform.scale[0]).toBe(1);
  });
});

describe('keyboard shortcuts', () => {
  const key = (init: KeyboardEventInit, target?: HTMLElement) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    if (target) Object.defineProperty(e, 'target', { value: target });
    return handleShortcut(e, store);
  };

  it('W/E/R set the tool; Escape deselects; Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z and Ctrl+Y undo/redo', () => {
    key({ key: 'e' });
    expect(s().toolMode).toBe('rotate');
    key({ key: 'r' });
    expect(s().toolMode).toBe('scale');
    key({ key: 'w' });
    expect(s().toolMode).toBe('translate');
    s().select(cubeId());
    key({ key: 'Escape' });
    expect(s().selection).toEqual([]);
    s().run('scene.node.rename', { nodeId: cubeId(), name: 'A' });
    key({ key: 'z', metaKey: true });
    expect(s().project.scene.nodes[cubeId()]!.name).toBe('Reference Cube');
    key({ key: 'z', metaKey: true, shiftKey: true });
    expect(s().project.scene.nodes[cubeId()]!.name).toBe('A');
    key({ key: 'z', ctrlKey: true });
    key({ key: 'y', ctrlKey: true });
    expect(s().project.scene.nodes[cubeId()]!.name).toBe('A');
  });

  it('shortcuts are ignored while typing in inputs', () => {
    const input = document.createElement('input');
    expect(key({ key: 'e' }, input)).toBe(false);
    expect(s().toolMode).toBe('translate');
    s().run('scene.node.rename', { nodeId: cubeId(), name: 'A' });
    expect(key({ key: 'z', metaKey: true }, input)).toBe(false);
    expect(s().project.scene.nodes[cubeId()]!.name).toBe('A');
  });
});

describe('editor store: persistence integration', () => {
  it('save → modify → reopen restores the saved copy; dirty tracking follows the baseline', () => {
    expect(isDirty(s())).toBe(false);
    s().run('scene.node.rename', { nodeId: cubeId(), name: 'Saved name' });
    expect(isDirty(s())).toBe(true);
    s().save();
    expect(isDirty(s())).toBe(false);
    const id = s().project.id;
    // A fresh store over the same storage reopens the latest quick-save.
    const reopened = createEditorStore(new BrowserStorageProjectRepository(storage, 'ui'));
    expect(reopened.getState().project.id).toBe(id);
    expect(reopened.getState().project.scene.nodes[cubeId()]!.name).toBe('Saved name');
  });

  it('a failed import keeps the current project; a valid import replaces it', () => {
    const before = serializeProject(s().project);
    expect(s().importProjectText('{"schemaVersion":2,')).toBe(false);
    expect(s().status.tone).toBe('error');
    expect(serializeProject(s().project)).toBe(before);
    const exported = s().exportProject();
    expect(exported.fileName).toMatch(/\.forge\.json$/);
    s().run('scene.node.rename', { nodeId: cubeId(), name: 'Changed' });
    s().save(); // not dirty → no confirm needed in jsdom
    expect(s().importProjectText(exported.text)).toBe(true);
    expect(s().project.scene.nodes[cubeId()]!.name).toBe('Reference Cube');
    expect(s().history.canUndo).toBe(false);
  });
});
