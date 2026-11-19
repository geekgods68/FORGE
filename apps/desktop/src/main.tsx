import { BrowserStorageProjectRepository } from '@forge/persistence';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createForgeStore } from './app/store';
import './styles/index.css';

const namespace = import.meta.env.VITE_FORGE_STORAGE_NAMESPACE || 'forge';
const store = createForgeStore(new BrowserStorageProjectRepository(window.localStorage, namespace));

// Read-only diagnostics hook for local automated tests; exposes no mutation path.
const w = window as unknown as { __forge?: Record<string, unknown> };
w.__forge = {
  ...w.__forge,
  ready: true,
  storageNamespace: namespace,
  project: () => store.getState().project,
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
