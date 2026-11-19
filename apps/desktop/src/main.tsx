import { BrowserStorageProjectRepository } from '@forge/persistence';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createEditorStore } from './app/store';
import './styles/index.css';

const namespace = import.meta.env.VITE_FORGE_STORAGE_NAMESPACE || 'forge';
const store = createEditorStore(
  new BrowserStorageProjectRepository(window.localStorage, namespace),
  window.localStorage,
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
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
