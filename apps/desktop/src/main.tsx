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
import { cosimFor } from './features/electronics/cosim';
import { configureResearch, researchFor } from './features/research/controller';
import { configureTwin, twinFor } from './features/twin/controller';
import { lastImport } from './features/interop/state';
import { importStatus } from '@forge/interop';
import { ACTUATION_POLICY } from '@forge/digital-twin';
import { createEditorStore } from './app/store';
import { createDefaultAssetStore } from './assets/assetStore';
import './styles/index.css';

const namespace = import.meta.env.VITE_FORGE_STORAGE_NAMESPACE || 'forge';
configureResearch({ storage: window.localStorage, namespace });
configureTwin({ storage: window.localStorage, namespace });
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
  /** Electronics co-simulation snapshot (read-only). */
  cosim: () => {
    const c = cosimFor(store);
    const cs = c.cosim;
    const u = c.ui.getState();
    if (!cs) return { state: u.state, active: false };
    return {
      state: u.state,
      active: true,
      time: cs.now / 1e9,
      physicsSteps: cs.k,
      mcus: cs.mcus.map((m) => ({
        label: m.part.label,
        state: m.state,
        serial: m.serial.map((x) => x.text).join(''),
        errors: m.events.filter((e) => e.kind === 'error').map((e) => e.message),
      })),
      devices: cs.devices.map((d) => {
        const x = d as unknown as {
          measurements?: { geometricM: number | null; reportedM: number | null; echoUs: number }[];
          targetRad?: number | null;
          angleDeg?: number | null;
          lastWidthUs?: number | null;
          measure?: () => number | null;
        };
        return {
          label: d.part.label,
          type: d.part.device.type,
          status: d.status(),
          lastMeasurement: x.measurements?.[x.measurements.length - 1] ?? null,
          geometricNow: x.measure ? x.measure() : null,
          targetRad: x.targetRad ?? null,
          angleDeg: x.angleDeg ?? null,
          pulseUs: x.lastWidthUs ?? null,
        };
      }),
      events: cs.events(50),
    };
  },
  /** Import provenance records with their modification status (read-only). */
  imports: () => {
    const p = engine.getProject();
    const root = p.scene.nodes[p.scene.rootId];
    return (root?.kind === 'root' ? (root.imports ?? []) : []).map((r) => ({
      ...r,
      status: importStatus(r, p.scene),
    }));
  },
  /** Last import analysis/plan in the dialog (read-only summary). */
  importPreview: () => {
    const { pending, plan } = lastImport;
    return {
      kind: pending?.kind ?? null,
      format: pending?.detection.format ?? null,
      ok: plan?.ok ?? null,
      dryRun: plan?.dryRun ?? null,
      commands: plan?.commands.length ?? 0,
      diagnostics: plan?.diagnostics.map((d) => `${d.severity}:${d.code}`) ?? [],
    };
  },
  /** Digital twin snapshot (read-only; no method here can send anything to a device). */
  twin: () => {
    const c = twinFor(store);
    const u = c.ui.getState();
    const p = c.pipeline;
    return {
      mode: u.mode,
      adapter: u.adapter,
      connected: u.connected,
      link: u.link,
      twin: c.twin
        ? {
            id: c.twin.id,
            revision: c.twin.revision,
            channels: c.twin.channels.map((m) => [m.channel, m.kind]),
          }
        : null,
      device: p?.device ?? null,
      channels: p ? [...p.channels.values()] : [],
      samples: p ? Object.fromEntries([...p.series].map(([k, s]) => [k, s.t.length])) : {},
      stats: p ? JSON.parse(JSON.stringify(p.stats)) : null,
      clock: p?.clock ?? null,
      recordings: u.recordings,
      comparison:
        u.comparison && !('error' in u.comparison)
          ? { n: u.comparison.metrics.n, rmse: u.comparison.metrics.rmse, lagS: u.comparison.lag.bestS }
          : u.comparison,
      previewWristRad: u.previewWristRad,
      mappingIssues: u.mappingIssues,
      actuation: ACTUATION_POLICY,
    };
  },
  /** Research document summary (read-only). */
  research: () => {
    const c = researchFor(store);
    const d = c.engine.document;
    const u = c.ui.getState();
    return {
      projectId: d.projectId,
      experiments: d.experiments.map((e) => ({
        id: e.id,
        title: e.title,
        revision: e.revision,
        variables: e.variables.length,
        measurements: e.measurements.length,
        notes: e.notebook.length,
        runs: c.engine.runsOf(e.id).map((r) => ({
          id: r.id,
          state: r.state,
          condition: r.conditionLabel,
          outcomes: Object.fromEntries(Object.entries(r.outcomes).map(([k, o]) => [k, o.value])),
        })),
      })),
      selected: u.experimentId,
      progress: u.progress && {
        phase: u.progress.phase,
        total: u.progress.total,
        done: u.progress.done,
        completed: u.progress.completed,
        failed: u.progress.failed,
      },
      persistent: u.persistent,
      integrity: c.engine.integrityReport(),
    };
  },
  cosimSeries: (key: string) => cosimFor(store).cosim?.recorder.series(key) ?? null,
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
