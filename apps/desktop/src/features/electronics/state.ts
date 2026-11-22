import { newId, type ElectricalDefinition, type PinRef, type SceneGraph } from '@forge/engineering-core';
import {
  compileNetlist,
  structuralChecks,
  type Netlist,
  type OpResult,
  type TransientResult,
} from '@forge/electronics';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EditorState } from '@/app/store';

/**
 * Electronics-mode UI state (view state only — never engineering data). The circuit itself
 * is read from the project (root node `electrical`) and changed only through `electrical.*`
 * commands, so the schematic and the 3D view always show the same authoritative netlist.
 */
export type ElecTab = 'parts' | 'wiring' | 'checks' | 'analysis' | 'code';
export interface ElecUi {
  tab: ElecTab;
  schematicOpen: boolean;
  tool: 'select' | 'wire';
  selectedPart: string | null;
  selectedWire: string | null;
  /** Net highlighted in both views. */
  selectedNet: string | null;
  /** First pin of a wire being drawn. */
  pending: PinRef | null;
  dc: { revision: number; result: OpResult } | null;
  transient: { revision: number; result: TransientResult } | null;
  message: { tone: 'info' | 'error'; text: string } | null;
}

const INITIAL: ElecUi = {
  tab: 'parts',
  schematicOpen: false,
  tool: 'select',
  selectedPart: null,
  selectedWire: null,
  selectedNet: null,
  pending: null,
  dc: null,
  transient: null,
  message: null,
};

const stores = new WeakMap<StoreApi<EditorState>, StoreApi<ElecUi>>();
export function elecUiFor(editor: StoreApi<EditorState>): StoreApi<ElecUi> {
  let s = stores.get(editor);
  if (!s) {
    s = createStore<ElecUi>(() => ({ ...INITIAL }));
    stores.set(editor, s);
  }
  return s;
}

export function circuitOf(scene: SceneGraph): ElectricalDefinition | null {
  const r = scene.nodes[scene.rootId];
  return r?.kind === 'root' ? (r.electrical ?? null) : null;
}

/** Renderer diagnostics for automated tests (read-only): world position of each drawn 3D pin. */
export const circuitDiagnostics = { pins: new Map<string, [number, number, number]>() };

/** Netlist + structural checks, memoised by definition identity. */
const cache = new WeakMap<
  ElectricalDefinition,
  { netlist: Netlist; issues: ReturnType<typeof structuralChecks> }
>();
export function analyse(def: ElectricalDefinition, scene?: SceneGraph) {
  let c = cache.get(def);
  if (!c) {
    const netlist = compileNetlist(def);
    c = { netlist, issues: structuralChecks(def, netlist, scene) };
    cache.set(def, c);
  }
  return c;
}

/**
 * Wire-tool click on a pin: the first click arms, the second commits ONE undoable
 * `electrical.wire.add` (the same command whether the pin was clicked in 3D or in the schematic).
 */
export function clickPin(editor: StoreApi<EditorState>, pin: PinRef): void {
  const ui = elecUiFor(editor);
  const u = ui.getState();
  if (u.tool !== 'wire') {
    ui.setState({ selectedPart: pin.partId, selectedWire: null });
    return;
  }
  if (!u.pending) {
    ui.setState({
      pending: pin,
      message: { tone: 'info', text: `Wiring from ${pin.pin}: pick the second pin (Esc cancels).` },
    });
    return;
  }
  if (u.pending.partId === pin.partId && u.pending.pin === pin.pin) {
    ui.setState({ pending: null, message: null });
    return;
  }
  const r = editor
    .getState()
    .run(
      'electrical.wire.add',
      { wire: { id: newId(), a: u.pending, b: pin, route: [], color: null } },
      { label: 'Add wire' },
    );
  ui.setState({
    pending: null,
    message: r.ok ? { tone: 'info', text: 'Wire added.' } : { tone: 'error', text: r.error.message },
  });
}
