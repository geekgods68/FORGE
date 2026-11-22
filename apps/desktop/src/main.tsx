import { auditProjectComponents, catalogStats } from '@forge/components';
import { FACILITY, getZone, itemChain, pointToFacility, requiredZones, roomCode } from '@forge/facility';
import { BrowserStorageProjectRepository, BrowserStorageWorkspaceRepository } from '@forge/persistence';
import { loadedZoneModules, renderedSigns } from './facility/loaded';
import { signTextureStats } from './facility/signTextures';
import { transitions, zoneLifecycle } from './facility/zoneRuntime';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { analyse, circuitDiagnostics, circuitOf } from './features/electronics/state';
import { createEditorStore } from './app/store';
import { createDefaultAssetStore } from './assets/assetStore';
import './styles/index.css';

const namespace = import.meta.env.VITE_FORGE_STORAGE_NAMESPACE || 'forge';
const store = createEditorStore(
  new BrowserStorageProjectRepository(window.localStorage, namespace),
  window.localStorage,
  new BrowserStorageWorkspaceRepository(window.localStorage, namespace),
  createDefaultAssetStore(namespace),
);
void store.getState().auditAssets();

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
  nodeCount: () => Object.keys(engine.getProject().scene.nodes).length,
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
  navMode: () => store.getState().navMode,
  conjure: () => store.getState().conjure,
  libraryOpen: () => store.getState().libraryOpen,
  catalogStats: () => catalogStats(),
  componentWarnings: () => auditProjectComponents(engine.getProject()),
  missingAssets: () => store.getState().missingAssets,
  customModels: () => store.getState().customModels,
  assetStoreKind: () => store.getState().assetStore.kind,
  currentZone: () => store.getState().currentZoneId,
  loadedZoneModules: () => loadedZoneModules(),
  /** Zone lifecycle snapshot (non-unloaded zones): state + role (+ error). */
  zoneStates: () => zoneLifecycle.snapshot(),
  /** Static facility registry summary (read-only data). */
  zones: () =>
    FACILITY.zones.map((z) => ({
      id: z.id,
      name: z.name,
      kind: z.kind,
      code: roomCode(z),
      corridorId: z.kind === 'corridor' ? null : z.portals[0]!.toZoneId,
    })),
  requiredZones: (id: string) => requiredZones(id),
  zoneCounters: () => ({
    loads: zoneLifecycle.loadsCompleted,
    staleIgnored: zoneLifecycle.staleResultsIgnored,
  }),
  transitions: () => transitions.map((t) => ({ ...t })),
  renderedSigns: () => renderedSigns(),
  signTextures: () => signTextureStats(),
  /** Compiled circuit (read-only): parts, nets (explicit connectivity) and rule codes. */
  circuit: () => {
    const p = engine.getProject();
    const def = circuitOf(p.scene);
    if (!def) return null;
    const { netlist, issues } = analyse(def, p.scene);
    const label = (id: string) => netlist.partById.get(id)?.label ?? id;
    return {
      parts: def.parts.map((x) => ({ id: x.id, label: x.label, type: x.device.type, nodeId: x.nodeId })),
      wires: def.wires.length,
      firmware: def.firmware.map((f) => ({ id: f.id, revision: f.revision })),
      nets: netlist.nets
        .filter((n) => n.pins.length > 1)
        .map((n) => ({ name: n.name, pins: n.pins.map((x) => `${label(x.partId)}.${x.pin}`) })),
      issues: issues.map((i) => i.code),
    };
  },
  /** World position of a drawn 3D circuit pin ("<partId>.<pin>"), or null. */
  pin3d: (key: string) => circuitDiagnostics.pins.get(key) ?? null,
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
