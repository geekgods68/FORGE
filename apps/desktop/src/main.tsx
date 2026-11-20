import { getZone, itemChain, pointToFacility } from '@forge/facility';
import { BrowserStorageProjectRepository, BrowserStorageWorkspaceRepository } from '@forge/persistence';
import { loadedZoneModules } from './facility/loaded';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createEditorStore } from './app/store';
import './styles/index.css';

const namespace = import.meta.env.VITE_FORGE_STORAGE_NAMESPACE || 'forge';
const store = createEditorStore(
  new BrowserStorageProjectRepository(window.localStorage, namespace),
  window.localStorage,
  new BrowserStorageWorkspaceRepository(window.localStorage, namespace),
);

/**
 * Read-only diagnostics for local automated tests. Exposes the engine's QUERY
 * methods only — no execute/undo/replace — so it adds no mutation path.
 */
const engine = store.getState().engine;
const w = window as unknown as { __forge?: Record<string, unknown> };
w.__forge = {
  ...w.__forge,
  ready: true,
  storageNamespace: namespace,
  project: () => engine.getProject(),
  queryScene: () => engine.queryScene(),
  getNode: (id: string) => engine.getNode(id),
  getWorldTransform: (id: string) => engine.getWorldTransform(id),
  getSelection: () => engine.getSelection(),
  getHistory: () => engine.getHistory(),
  getCapabilities: () => engine.getCapabilities(),
  // Facility / workspace (read-only)
  view: () => store.getState().view,
  editLayer: () => store.getState().editLayer,
  layout: () => store.getState().workspace.getLayout(),
  workspaceHistory: () => store.getState().workspace.getHistory(),
  itemSelection: () => store.getState().itemSelection,
  loadedZoneModules: () => loadedZoneModules(),
  itemFacilityPosition: (itemId: string) => {
    const it = store.getState().workspace.getItem(itemId);
    const zone = it && getZone(it.zoneId);
    return it && zone ? pointToFacility([0, 0, 0], itemChain(zone, it)) : null;
  },
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
