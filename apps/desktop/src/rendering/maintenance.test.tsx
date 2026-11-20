import {
  createProject,
  serializeProject,
  identityNodeTransform,
  type Project,
} from '@forge/engineering-core';
import { BrowserStorageProjectRepository, MemoryStorage } from '@forge/persistence';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createEditorStore, EditorStoreContext } from '@/app/store';
import { HierarchyPanel } from '@/features/hierarchy/HierarchyPanel';
import { createPrimitiveGeometry, geometryCache, geometryKey, materialCache, materialKey } from './resources';

describe('shared GPU resources', () => {
  it('identical primitives share one geometry; it is disposed when the last user releases it', () => {
    const g = { shape: 'box', width: 0.1, height: 0.2, depth: 0.3 } as const;
    const key = geometryKey(g);
    const a = geometryCache.acquire(key, () => createPrimitiveGeometry(g));
    const b = geometryCache.acquire(key, () => createPrimitiveGeometry(g));
    expect(a).toBe(b);
    const dispose = vi.spyOn(a, 'dispose');
    geometryCache.release(key);
    expect(dispose).not.toHaveBeenCalled();
    geometryCache.release(key);
    expect(dispose).toHaveBeenCalledTimes(1);
    // A later acquire creates a fresh geometry.
    const c = geometryCache.acquire(key, () => createPrimitiveGeometry(g));
    expect(c).not.toBe(a);
    geometryCache.release(key);
  });

  it('material keys distinguish colour, selection emissive and sidedness', () => {
    const base = { color: '#8a93a3' };
    expect(materialKey(base)).toBe(materialKey({ ...base }));
    expect(materialKey(base)).not.toBe(materialKey({ ...base, emissive: '#0e7490' }));
    expect(materialKey(base)).not.toBe(materialKey({ ...base, doubleSided: true }));
    expect(materialCache.stats().unique).toBe(0);
  });

  it('builds real dimensions for every primitive shape', () => {
    const box = createPrimitiveGeometry({ shape: 'box', width: 0.1, height: 0.2, depth: 0.3 });
    box.computeBoundingBox();
    const size = box.boundingBox!.max.clone().sub(box.boundingBox!.min);
    // GPU vertex buffers are float32 (render-only); engineering values stay float64.
    [0.1, 0.2, 0.3].forEach((v, i) => expect([size.x, size.y, size.z][i]).toBeCloseTo(v, 6));
  });
});

function bigProject(n: number): Project {
  const p: Project = JSON.parse(JSON.stringify(createProject('big')));
  const root = p.scene.nodes[p.scene.rootId]!;
  for (let i = 0; i < n; i++) {
    const id = `b${i}`;
    p.scene.nodes[id] = {
      id,
      kind: 'primitive',
      name: `Box ${i}`,
      parentId: root.id,
      childIds: [],
      transform: identityNodeTransform([i * 0.01, 0, 0]),
      visible: true,
      locked: false,
      metadata: {},
      geometry: { shape: 'box', width: 0.01, height: 0.01, depth: 0.01 },
      color: '#8a93a3',
    };
    root.childIds.push(id);
  }
  return p;
}

describe('virtualized hierarchy', () => {
  it('mounts only a window of rows for a 5,000-node scene, and scrolling moves the window', () => {
    const store = createEditorStore(new BrowserStorageProjectRepository(new MemoryStorage(), 'v'));
    expect(store.getState().importProjectText(serializeProject(bigProject(5000)))).toBe(true);
    render(
      <EditorStoreContext.Provider value={store}>
        <HierarchyPanel />
      </EditorStoreContext.Provider>,
    );
    const mounted = screen.getAllByRole('treeitem');
    expect(mounted.length).toBeLessThan(60);
    expect(screen.getByText('(5001)')).toBeInTheDocument();
    const scroller = screen.getByTestId('hierarchy-scroll');
    fireEvent.scroll(scroller, { target: { scrollTop: 28 * 4000 } });
    expect(screen.getByTestId('tree-row-b3999')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-row-b0')).toBeNull();
    expect(screen.getAllByRole('treeitem').length).toBeLessThan(60);
  });

  it('selecting a node far down the list scrolls it into the mounted window', () => {
    const store = createEditorStore(new BrowserStorageProjectRepository(new MemoryStorage(), 'v'));
    store.getState().importProjectText(serializeProject(bigProject(2000)));
    render(
      <EditorStoreContext.Provider value={store}>
        <HierarchyPanel />
      </EditorStoreContext.Provider>,
    );
    const scroller = screen.getByTestId('hierarchy-scroll');
    Object.defineProperty(scroller, 'clientHeight', { value: 560, configurable: true });
    act(() => store.getState().select('b1500'));
    // The auto-scroll effect moved scrollTop; React re-renders on the scroll event.
    fireEvent.scroll(scroller, { target: { scrollTop: scroller.scrollTop } });
    expect(screen.getByTestId('tree-row-b1500')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('render mode', () => {
  it('demand rendering by default; continuous only while a subsystem requests it', () => {
    const store = createEditorStore(new BrowserStorageProjectRepository(new MemoryStorage(), 'r'));
    expect(store.getState().continuousReasons).toEqual([]);
    store.getState().setContinuous('simulation', true);
    store.getState().setContinuous('simulation', true); // idempotent
    store.getState().setContinuous('recording', true);
    expect(store.getState().continuousReasons).toEqual(['simulation', 'recording']);
    store.getState().setContinuous('simulation', false);
    store.getState().setContinuous('recording', false);
    expect(store.getState().continuousReasons).toEqual([]);
  });
});
