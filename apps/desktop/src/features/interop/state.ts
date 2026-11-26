import { createStore } from 'zustand/vanilla';
import type { Pending, Plan } from './importer';

/** Import/export dialog state (outside the engineering store; not persisted). */
export const interopUi = createStore<{ open: boolean; tab: 'import' | 'export' | 'imports' }>(() => ({
  open: false,
  tab: 'import',
}));
/** Read-only snapshot of the current import for the test hooks (window.__forge). */
export const lastImport: { pending: Pending | null; plan: Plan | null; message: string | null } = {
  pending: null,
  plan: null,
  message: null,
};
let counter = 0;
/** Node-id prefix for a new import plan (unique within the session). */
export const importStamp = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;
