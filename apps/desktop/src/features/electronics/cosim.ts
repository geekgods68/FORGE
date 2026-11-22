import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EditorState } from '@/app/store';

/**
 * Electronics runtime (co-simulation) controller — owned by Simulation mode. Milestone A
 * only exposes the live net levels the schematic colours wires with (null = not running).
 */
export interface CosimUi {
  netLevels: Record<string, '0' | '1' | 'Z' | 'X'> | null;
}

export class CosimController {
  readonly ui: StoreApi<CosimUi> = createStore<CosimUi>(() => ({ netLevels: null }));
  constructor(readonly editor: StoreApi<EditorState>) {}
}

const controllers = new WeakMap<StoreApi<EditorState>, CosimController>();
export function cosimFor(editor: StoreApi<EditorState>): CosimController {
  let c = controllers.get(editor);
  if (!c) {
    c = new CosimController(editor);
    controllers.set(editor, c);
  }
  return c;
}
