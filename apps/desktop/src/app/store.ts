import {
  createProject,
  DEFAULT_SNAP,
  ForgeEngine,
  makeCommand,
  newId,
  parseProjectFile,
  projectFileName,
  serializeProject,
  type CommandResult,
  type CommandSource,
  type CommandType,
  type HistoryInfo,
  type Mate,
  type PayloadInput,
  type Project,
  ModelRefSchema,
  type ModelRef,
  type SceneGraph,
  type SnapSettings,
} from '@forge/engineering-core';
import { createMemoryAssetStore, type AssetStore } from '@/assets/assetStore';
import { readBundle, writeBundle } from '@/assets/bundle';
import { snapCommand, type SnapTarget } from '@/features/snap/snapLogic';
import { checkInterference, createMechanicsService, type InterferenceResult } from '@forge/mechanics';
import { createRoboticArmSimulationSample } from '@forge/physics';
import {
  assemblyCommands,
  AssemblyTemplateSchema,
  templateAssetHashes,
  auditProjectComponents,
  createCatalogResolver,
  templateFromGroup,
  type AssemblyTemplate,
  parsePrefs,
  recordRecent,
  toggleFavorite as toggleFavoritePref,
  type LibraryPrefs,
  type ParamValues,
} from '@forge/components';
import {
  CENTRAL_WORKSHOP_ID,
  defaultWorkspaceLayout,
  getEquipment,
  getZone,
  makeWorkspaceCommand,
  WorkspaceEngine,
  type WorkspaceCommandType,
  type WorkspaceLayout,
  type WorkspaceResult,
  type Zone,
} from '@forge/facility';
import {
  BrowserStorageWorkspaceRepository,
  MemoryStorage,
  parseWorkspaceFile,
  serializeWorkspace,
  type ProjectRepository,
  type ProjectSummary,
} from '@forge/persistence';
import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type ToolMode = 'translate' | 'rotate' | 'scale';
export type Status = { tone: 'info' | 'success' | 'error'; text: string; details?: string[] };
export type PhysicsStatus = { state: 'loading' | 'ready' | 'error'; detail?: string };
/** Which 3D context is shown: the project at its own origin, or the facility. */
export type ViewMode = 'project' | 'facility';
/** Which layer editing tools act on in the facility view (the facility itself is never editable). */
export type EditLayer = 'project' | 'layout';
/**
 * Overview camera for a zone: rooms are viewed from above their doorway side (zone-local
 * +Z, so yaw-π rooms are handled), corridors from beside their long axis. Lab 20 keeps
 * its revision-1 preset exactly ([x, 13, z + 9.5]).
 */
export function zoneCameraPreset(zone: Zone): Omit<CameraPreset, 'nonce'> {
  const [x, , z] = zone.pose.position;
  const c = Math.cos(zone.pose.yaw);
  const s = Math.sin(zone.pose.yaw);
  const local = (lx: number, ly: number, lz: number): [number, number, number] => [
    x + lx * c + lz * s,
    ly,
    z - lx * s + lz * c,
  ];
  if (zone.kind === 'corridor') {
    const w = zone.footprint.max[0] - zone.footprint.min[0];
    const d = zone.footprint.max[1] - zone.footprint.min[1];
    return { position: w >= d ? [x + 3, 12, z + 9] : [x + 9, 12, z + 3], target: [x, 0.5, z] };
  }
  const big = zone.kind === 'environment';
  return { position: local(0, big ? 22 : 13, big ? 20 : 9.5), target: [x, big ? 1.5 : 0.8, z] };
}

export interface ConjureState {
  definitionId: string;
  variantId: string | null;
  /** Parameter overrides (metres/radians/options). */
  parameters: ParamValues;
  materialId: string | null | undefined;
  /** Yaw about +Y (radians), changed with R / Shift+R during placement. */
  yaw: number;
}

const PREFS_KEY = 'forge:library-prefs';
const CUSTOM_MODELS_KEY = 'forge:custom-models';
function loadCustomModels(): ModelRef[] {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(CUSTOM_MODELS_KEY) ?? '[]');
    return Array.isArray(raw)
      ? raw.flatMap((t) => {
          const r = ModelRefSchema.safeParse(t);
          return r.success ? [r.data] : [];
        })
      : [];
  } catch {
    return [];
  }
}
function saveCustomModels(list: ModelRef[]) {
  try {
    globalThis.localStorage?.setItem(CUSTOM_MODELS_KEY, JSON.stringify(list));
  } catch {
    /* user library data; the asset bytes live in the asset store */
  }
}
/** Model assets referenced anywhere in a scene. */
const referencedAssets = (p: Project) => [
  ...new Set(
    Object.values(p.scene.nodes).flatMap((n) => (n.kind === 'model-instance' ? [n.model.assetHash] : [])),
  ),
];
const ASSEMBLIES_KEY = 'forge:assemblies';
function loadAssemblies(): AssemblyTemplate[] {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(ASSEMBLIES_KEY) ?? '[]');
    return Array.isArray(raw)
      ? raw.flatMap((t) => {
          const r = AssemblyTemplateSchema.safeParse(t);
          return r.success ? [r.data] : [];
        })
      : [];
  } catch {
    return [];
  }
}
function saveAssemblies(list: AssemblyTemplate[]) {
  try {
    globalThis.localStorage?.setItem(ASSEMBLIES_KEY, JSON.stringify(list));
  } catch {
    /* user convenience data */
  }
}
function loadLibraryPrefs(): LibraryPrefs {
  try {
    return parsePrefs(JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) ?? 'null'));
  } catch {
    return parsePrefs(null);
  }
}
function saveLibraryPrefs(p: LibraryPrefs) {
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* preferences are a convenience; ignore storage failures */
  }
}

/** A drag-to-snap released near compatible interfaces, awaiting confirm/cancel (Phase 4.1). */
export interface MateSnapPending {
  nodeId: string;
  /** Candidate targets in reach at release, nearest first. */
  candidates: SnapTarget[];
  chosen: string;
  type: Mate['type'];
  alignment: Mate['alignment'];
  message: { ok: boolean; text: string } | null;
}

export type CameraPreset = {
  position: [number, number, number];
  target: [number, number, number];
  nonce: number;
};

/**
 * UI state for the editor. Engineering truth lives in the ForgeEngine; this store
 * mirrors engine snapshots for React and adds purely presentational state.
 * Every engineering change goes through `run` → engine.execute (validated command).
 */
export interface EditorState {
  engine: ForgeEngine;
  project: Project;
  selection: readonly string[];
  history: HistoryInfo;
  /** Revision at the last new/open/save/import; used for unsaved-change tracking. */
  baselineRevision: number;
  toolMode: ToolMode;
  snap: SnapSettings;
  status: Status;
  physics: PhysicsStatus;
  cameraResetRequest: number;
  /** Incremented to frame the selected node in the viewport. */
  frameRequest: number;
  /** Drag-to-snap mode: dragging the selected body offers interface mates instead of the gizmo. */
  mateSnapMode: boolean;
  mateSnap: MateSnapPending | null;
  dragging: boolean;
  cancelDragRequest: number;
  collapsed: Record<string, boolean>;
  /** Subsystems currently requiring continuous rendering (empty → demand rendering). */
  continuousReasons: readonly string[];

  // ---- Phase 2: facility / workspace (separate layer, separate engine, separate store) ----
  workspace: WorkspaceEngine;
  layout: WorkspaceLayout;
  workspaceHistory: ReturnType<WorkspaceEngine['getHistory']>;
  layoutBaselineRevision: number;
  view: ViewMode;
  editLayer: EditLayer;
  itemSelection: string | null;
  currentZoneId: string;
  /** Component library panel open. */
  libraryOpen: boolean;
  libraryPrefs: LibraryPrefs;
  /** Active conjuring (ghost placement) — nothing exists in the project until confirmed. */
  conjure: ConjureState | null;
  /** User-saved assembly templates (local user data, not project data). */
  assemblies: AssemblyTemplate[];
  /** Interface whose compatible counterparts are highlighted (metadata-only preview). */
  connectionFocus: { nodeId: string; interfaceId: string } | null;
  /** At most one destination whose code is prefetched (directory hover/focus). */
  prefetchZoneId: string | null;
  /** Facility camera: orbit/overview (editing) or first-person walking (camera only). */
  navMode: 'orbit' | 'walk';
  /** CAD editing, or Simulation mode (physics runtime; the CAD model is read-only there). */
  workMode: 'cad' | 'simulation';
  cameraPreset: CameraPreset | null;
  /** View-only exploded view of one assembly (never written to the model; 0 restores exactly). */
  explode: { assemblyId: string; factor: number } | null;
  /** Dry-run result shown in the viewport before a command is confirmed (never committed). */
  previewScene: SceneGraph | null;
  /** Local content-addressed store for imported model bytes (IndexedDB in the app). */
  assetStore: AssetStore;
  /** User-saved custom components made from imported models (local user library). */
  customModels: ModelRef[];
  /** Incremented whenever assets are added to the store (renderers retry missing models). */
  assetsVersion: number;
  /** Model assets the open project references that are not in the asset store. */
  missingAssets: readonly string[];
  /** Last interference check (view-only highlights). */
  interference: { assemblyId: string; revision: number; results: InterferenceResult[] } | null;

  run<T extends CommandType>(
    type: T,
    payload: PayloadInput<T>,
    opts?: { label?: string; source?: CommandSource },
  ): CommandResult;
  report(result: CommandResult | null, label?: string): void;
  undo(): void;
  redo(): void;
  select(id: string | null): void;
  setToolMode(mode: ToolMode): void;
  setSnap(patch: Partial<SnapSettings>): void;
  setDragging(dragging: boolean): void;
  requestCancelDrag(): void;
  toggleCollapsed(id: string): void;
  setContinuous(reason: string, on: boolean): void;
  requestCameraReset(): void;
  requestFrameSelection(): void;
  setMateSnapMode(on: boolean): void;
  /** A snap drag was released near compatible interfaces: preview the nearest one's mate. */
  beginMateSnap(p: Omit<MateSnapPending, 'message'>): void;
  updateMateSnap(patch: Partial<Pick<MateSnapPending, 'chosen' | 'type' | 'alignment'>>): void;
  /** Commit the previewed snap mate (one validated, undoable command). */
  confirmMateSnap(): boolean;
  /** Discard the snap: nothing is committed; the body is shown at its unchanged position. */
  cancelMateSnap(text?: string): void;
  setPhysics(status: PhysicsStatus): void;
  setStatus(status: Status): void;

  newProject(): void;
  save(): void;
  listSaved(): ProjectSummary[];
  openSaved(id: string): void;
  exportProject(): { fileName: string; text: string };
  importProjectText(text: string): boolean;

  setView(view: ViewMode): void;
  setEditLayer(layer: EditLayer): void;
  selectItem(id: string | null): void;
  goToZone(zoneId: string): void;
  setPrefetchZone(zoneId: string | null): void;
  setLibraryOpen(open: boolean): void;
  openSample(): void;
  saveAssembly(groupId: string): boolean;
  insertAssembly(templateId: string): string | null;
  deleteAssembly(templateId: string): void;
  setConnectionFocus(f: { nodeId: string; interfaceId: string } | null): void;
  setExplode(assemblyId: string | null, factor?: number): void;
  /** Store the model bytes (verified) and add a custom component to the local library. */
  saveCustomModel(bytes: Uint8Array, ref: ModelRef): Promise<boolean>;
  insertCustomModel(assetHash: string): string | null;
  removeCustomModel(assetHash: string): void;
  /** Replace a custom component's declared interfaces (library definition; placed instances keep theirs). */
  updateCustomModelInterfaces(assetHash: string, interfaces: ModelRef['interfaces']): boolean;
  /** Re-check which referenced model assets are missing from the asset store. */
  auditAssets(): Promise<readonly string[]>;
  /** Project + every referenced model asset in one portable file (refused if any is missing). */
  exportBundle(): Promise<{ fileName: string; text: string } | null>;
  importBundleText(text: string): Promise<boolean>;
  exportAssemblyFile(templateId: string): Promise<{ fileName: string; text: string } | null>;
  importAssemblyText(text: string): Promise<boolean>;
  /** Validate + run a command without committing; shows its result in the viewport. */
  previewCommand<T extends CommandType>(type: T, payload: PayloadInput<T>): CommandResult;
  clearPreview(): void;
  checkAssemblyInterference(assemblyId: string): InterferenceResult[];
  clearInterference(): void;
  toggleFavorite(definitionId: string): void;
  /** Begin ghost placement of a configured component (validated before any preview appears). */
  startConjure(c: Omit<ConjureState, 'yaw'>): boolean;
  rotateConjure(deltaRad: number): void;
  cancelConjure(): void;
  /** Create the component at a project-frame floor point via the validated command. */
  confirmConjure(position: [number, number, number]): string | null;
  /** Zone change while walking: lifecycle follows, camera stays with the walker. */
  setCurrentZone(zoneId: string): void;
  setNavMode(mode: 'orbit' | 'walk'): void;
  setWorkMode(mode: 'cad' | 'simulation'): void;
  focusItem(itemId: string): void;
  runWorkspace<T extends WorkspaceCommandType>(
    type: T,
    payload: Parameters<typeof makeWorkspaceCommand<T>>[1],
    opts?: { label?: string; expectedRevision?: number },
  ): WorkspaceResult;
  placeEquipment(equipmentId: string): WorkspaceResult | null;
  mountProjectOn(itemId: string | null): void;
  saveLayout(): void;
  exportLayout(): { fileName: string; text: string };
  importLayoutText(text: string): boolean;
}

const SNAP_KEY = 'forge:editor:snap';

function loadSnap(storage?: Pick<Storage, 'getItem'>): SnapSettings {
  try {
    const raw = storage?.getItem(SNAP_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<SnapSettings>;
      if (typeof s.enabled === 'boolean' && s.translationM! > 0 && s.rotationRad! > 0)
        return s as SnapSettings;
    }
  } catch {
    /* preference only — fall back to defaults */
  }
  return { ...DEFAULT_SNAP };
}

export function createEditorStore(
  repo: ProjectRepository,
  prefs?: Pick<Storage, 'getItem' | 'setItem'>,
  workspaceRepo: BrowserStorageWorkspaceRepository = new BrowserStorageWorkspaceRepository(
    new MemoryStorage(),
  ),
  assetStore: AssetStore = createMemoryAssetStore(),
): StoreApi<EditorState> {
  let initialStatus: Status = { tone: 'info', text: 'New project (not yet saved).' };
  let initial: Project = createProject();
  const latest = repo.list()[0];
  if (latest) {
    const r = repo.load(latest.id);
    if (r.ok) {
      initial = r.value;
      initialStatus = {
        tone: 'info',
        text: `Opened saved project “${r.value.name}”${r.migratedFrom ? ` (migrated from schema v${r.migratedFrom})` : ''}.`,
      };
    }
  }
  const resolver = createCatalogResolver();
  const mechanics = createMechanicsService();
  const engine = new ForgeEngine(initial, { componentResolver: resolver, mechanics });
  const workspace = new WorkspaceEngine(workspaceRepo.latest() ?? defaultWorkspaceLayout());
  const layoutLayer = () => store.getState().view === 'facility' && store.getState().editLayer === 'layout';

  const store = createStore<EditorState>()((set, get) => {
    const replace = (project: Project, status: Status) => {
      const r = engine.replaceProject(project);
      if (!r.ok) {
        set({
          status: {
            tone: 'error',
            text: 'Project failed validation; nothing was changed.',
            details: r.errors.slice(0, 6),
          },
        });
        return false;
      }
      // Catalogue references are audited on every load: problems are recoverable warnings.
      const warnings = auditProjectComponents(engine.getProject());
      set({
        baselineRevision: engine.getProject().revision,
        status: warnings.length
          ? {
              tone: 'error',
              text: `${status.text} ${warnings.length} component reference warning${warnings.length === 1 ? '' : 's'} — affected parts are shown as labelled placeholders.`,
              details: warnings.slice(0, 6).map((w) => w.message),
            }
          : status,
        collapsed: {},
      });
      void get().auditAssets();
      return true;
    };
    const dirty = () => engine.getProject().revision !== get().baselineRevision;
    const confirmDiscard = () =>
      !dirty() ||
      typeof window === 'undefined' ||
      window.confirm('Discard unsaved changes in the current project?');

    return {
      engine,
      project: engine.getProject(),
      selection: engine.getSelection(),
      history: engine.getHistory(),
      baselineRevision: engine.getProject().revision,
      toolMode: 'translate',
      snap: loadSnap(prefs),
      status: initialStatus,
      physics: { state: 'loading' },
      cameraResetRequest: 0,
      frameRequest: 0,
      mateSnapMode: false,
      mateSnap: null,
      dragging: false,
      cancelDragRequest: 0,
      collapsed: {},
      continuousReasons: [],
      workspace,
      layout: workspace.getLayout(),
      workspaceHistory: workspace.getHistory(),
      layoutBaselineRevision: workspace.getLayout().revision,
      view: 'project',
      editLayer: 'project',
      itemSelection: null,
      currentZoneId: CENTRAL_WORKSHOP_ID,
      prefetchZoneId: null,
      libraryOpen: false,
      libraryPrefs: loadLibraryPrefs(),
      conjure: null,
      assemblies: loadAssemblies(),
      connectionFocus: null,
      navMode: 'orbit',
      workMode: 'cad',
      cameraPreset: null,
      explode: null,
      assetStore,
      customModels: loadCustomModels(),
      missingAssets: [],
      assetsVersion: 0,
      previewScene: null,
      interference: null,

      run(type, payload, opts = {}) {
        const r = engine.execute(
          makeCommand(type, payload, opts.source ?? 'desktop-ui', opts.label ? { label: opts.label } : {}),
        );
        get().report(r, opts.label);
        return r;
      },

      report(r, label) {
        if (!r) return;
        if (r.ok) {
          if (!r.noop)
            set({
              status: {
                tone: 'success',
                text: `${label ?? engine.getHistory().undoLabel ?? r.type} · revision ${r.revision}`,
              },
            });
        } else {
          set({
            status: {
              tone: 'error',
              text: r.error.message,
              ...(r.error.issues
                ? { details: r.error.issues.map((i) => `${i.path}: ${i.message}`).slice(0, 6) }
                : {}),
            },
          });
        }
      },

      undo() {
        if (get().dragging) return;
        get().cancelMateSnap();
        if (layoutLayer()) {
          // Layout edits have their own history, independent of the engineering project.
          const w = workspace.undo();
          set({ status: { tone: 'info', text: w.ok ? `Undid layout “${w.label}”` : w.message } });
          return;
        }
        const r = engine.undo();
        set({
          status: r.ok
            ? { tone: 'info', text: `Undid “${r.label}” · revision ${r.revision}` }
            : { tone: 'info', text: r.error.message },
        });
      },

      redo() {
        if (get().dragging) return;
        get().cancelMateSnap();
        if (layoutLayer()) {
          const w = workspace.redo();
          set({ status: { tone: 'info', text: w.ok ? `Redid layout “${w.label}”` : w.message } });
          return;
        }
        const r = engine.redo();
        set({
          status: r.ok
            ? { tone: 'info', text: `Redid “${r.label}” · revision ${r.revision}` }
            : { tone: 'info', text: r.error.message },
        });
      },

      select(id) {
        if (layoutLayer()) {
          set({ itemSelection: id });
          return;
        }
        engine.select(id ? [id] : []);
      },
      setToolMode: (toolMode) => set({ toolMode }),
      setSnap(patch) {
        const snap = { ...get().snap, ...patch };
        set({ snap });
        try {
          prefs?.setItem(SNAP_KEY, JSON.stringify(snap));
        } catch {
          /* ignore */
        }
      },
      setDragging: (dragging) => set({ dragging }),
      requestCancelDrag: () => set({ cancelDragRequest: get().cancelDragRequest + 1 }),
      toggleCollapsed: (id) => set({ collapsed: { ...get().collapsed, [id]: !get().collapsed[id] } }),
      setContinuous(reason, on) {
        const cur = get().continuousReasons;
        const next = on ? [...new Set([...cur, reason])] : cur.filter((r) => r !== reason);
        if (next.length !== cur.length) set({ continuousReasons: next });
      },
      requestCameraReset: () => set({ cameraResetRequest: get().cameraResetRequest + 1 }),
      requestFrameSelection: () => set({ frameRequest: get().frameRequest + 1 }),

      setWorkMode(workMode) {
        if (workMode === get().workMode) return;
        if (workMode === 'simulation') {
          // CAD-only interactions end: snap drags, gizmo drags, previews, exploded views, placement.
          if (get().mateSnap) get().cancelMateSnap();
          set({ mateSnapMode: false, previewScene: null, explode: null, conjure: null });
        }
        set({
          workMode,
          status: {
            tone: 'info',
            text:
              workMode === 'simulation'
                ? 'Simulation mode: the CAD design is read-only here; runs never change it. Setup changes are undoable.'
                : 'CAD mode: the design shows its engineering pose again.',
          },
        });
      },

      setMateSnapMode(on) {
        if (on && get().workMode === 'simulation') return;
        if (!on && get().mateSnap) get().cancelMateSnap();
        set({
          mateSnapMode: on,
          status: {
            tone: 'info',
            text: on
              ? 'Snap mode: drag the selected component onto a compatible interface, then confirm the mate.'
              : 'Snap mode off: the transform gizmo is back.',
          },
        });
      },

      beginMateSnap(p) {
        set({ mateSnap: { ...p, message: null } });
        get().updateMateSnap({});
      },

      updateMateSnap(patch) {
        const cur = get().mateSnap;
        if (!cur) return;
        const next = { ...cur, ...patch };
        const target = next.candidates.find((c) => c.key === next.chosen);
        if (!target) return;
        const cmd = snapCommand(engine.getProject().scene, next.nodeId, target, next.type, next.alignment);
        const r = get().previewCommand(cmd.type, cmd.payload as never);
        set({
          mateSnap: {
            ...next,
            message: r.ok
              ? { ok: true, text: 'Preview: the solved mate is shown. Confirm to apply, or cancel.' }
              : { ok: false, text: r.error.message },
          },
        });
      },

      confirmMateSnap() {
        const cur = get().mateSnap;
        const target = cur?.candidates.find((c) => c.key === cur.chosen);
        if (!cur || !target) return false;
        const cmd = snapCommand(engine.getProject().scene, cur.nodeId, target, cur.type, cur.alignment);
        get().clearPreview();
        const r = get().run(cmd.type, cmd.payload as never, {
          label: `Snap mate (${cur.type}) to ${target.targetBodyName}`,
        });
        if (!r.ok) {
          // Rejected: nothing changed; keep the choices open so another target can be tried.
          set({ mateSnap: { ...cur, message: { ok: false, text: r.error.message } } });
          return false;
        }
        set({ mateSnap: null });
        return true;
      },

      cancelMateSnap(text = 'Snap cancelled — nothing was changed.') {
        if (!get().mateSnap) return;
        get().clearPreview();
        set({ mateSnap: null, status: { tone: 'info', text } });
      },
      setPhysics: (physics) => set({ physics }),
      setStatus: (status) => set({ status }),

      newProject() {
        if (!confirmDiscard()) return;
        replace(createProject(), { tone: 'info', text: 'New project created (not yet saved).' });
      },

      save() {
        const project = engine.touchSaved();
        const r = repo.save(project);
        if (r.ok)
          set({
            project,
            baselineRevision: project.revision,
            status: {
              tone: 'success',
              text: 'Saved to this browser’s local storage (quick-save; export a file for a durable copy).',
            },
          });
        else
          set({
            status: {
              tone: 'error',
              text: r.error.message,
              ...(r.error.code === 'invalid' ? { details: r.error.details } : {}),
            },
          });
      },

      listSaved: () => repo.list(),

      openSaved(id) {
        if (!confirmDiscard()) return;
        const r = repo.load(id);
        if (!r.ok) {
          set({
            status: {
              tone: 'error',
              text: `Could not open: ${r.error.message} The current project was left unchanged.`,
              ...('details' in r.error ? { details: r.error.details.slice(0, 6) } : {}),
            },
          });
          return;
        }
        replace(r.value, {
          tone: 'success',
          text: `Opened “${r.value.name}”${r.migratedFrom ? ` (migrated from schema v${r.migratedFrom})` : ''}.`,
        });
      },

      exportProject() {
        const p = engine.getProject();
        const out = { fileName: projectFileName(p.name), text: serializeProject(p) };
        set({ status: { tone: 'success', text: `Exported ${out.fileName}` } });
        return out;
      },

      importProjectText(text) {
        const r = parseProjectFile(text);
        if (!r.ok) {
          set({
            status: {
              tone: 'error',
              text: `Import failed: ${r.error.message} The current project was left unchanged.`,
              ...('details' in r.error ? { details: r.error.details.slice(0, 6) } : {}),
            },
          });
          return false;
        }
        if (!confirmDiscard()) return false;
        return replace(r.project, {
          tone: 'success',
          text: `Imported “${r.project.name}”${r.migratedFrom ? ` (migrated from schema v${r.migratedFrom})` : ''}.`,
        });
      },

      // ------------------------------------------------ facility / workspace layer

      setView(view) {
        if (get().dragging) return;
        if (get().navMode === 'walk') {
          set({ navMode: 'orbit' });
          get().setContinuous('walk', false);
        }
        set({ view, editLayer: 'project', itemSelection: null });
        if (view === 'facility') get().goToZone(get().currentZoneId);
      },

      setEditLayer(editLayer) {
        if (get().dragging) return;
        set({ editLayer, itemSelection: null });
        if (editLayer === 'layout') engine.select([]);
      },

      selectItem: (itemSelection) => set({ itemSelection }),

      goToZone(zoneId) {
        const zone = getZone(zoneId);
        if (!zone || zone.status !== 'implemented') {
          set({ status: { tone: 'error', text: `${zone?.name ?? zoneId} is planned and not built yet.` } });
          return;
        }
        set({
          currentZoneId: zoneId,
          prefetchZoneId: get().prefetchZoneId === zoneId ? null : get().prefetchZoneId,
          itemSelection: null,
          cameraPreset: { ...zoneCameraPreset(zone), nonce: (get().cameraPreset?.nonce ?? 0) + 1 },
          status: { tone: 'info', text: `Entered ${zone.name}.` },
        });
      },

      setCurrentZone(zoneId) {
        const zone = getZone(zoneId);
        if (!zone || zoneId === get().currentZoneId) return;
        set({
          currentZoneId: zoneId,
          prefetchZoneId: null,
          itemSelection: null,
          status: { tone: 'info', text: `Entered ${zone.name}.` },
        });
      },

      setNavMode(mode) {
        if (get().dragging || mode === get().navMode) return;
        if (mode === 'walk' && get().view !== 'facility') return;
        engine.select([]);
        set({ navMode: mode, itemSelection: null });
        get().setContinuous('walk', mode === 'walk'); // walking animates every frame
        if (mode === 'orbit')
          get().goToZone(get().currentZoneId); // back to the zone overview
        else
          set({
            status: { tone: 'info', text: 'Walking: WASD to move, drag or click to look, Esc to stop.' },
          });
      },

      setLibraryOpen(libraryOpen) {
        set({ libraryOpen });
        if (!libraryOpen && get().conjure) set({ conjure: null });
      },

      openSample() {
        if (!confirmDiscard()) return;
        replace(createRoboticArmSimulationSample(), {
          tone: 'success',
          text: 'Opened the robotic-arm sample: a constrained assembly with a simulation setup (generic servo model; see Simulation mode for its assumptions).',
        });
      },

      saveAssembly(groupId) {
        const r = templateFromGroup(engine.getProject(), groupId, newId());
        if (!r.ok) {
          set({ status: { tone: 'error', text: r.message } });
          return false;
        }
        const assemblies = [...get().assemblies.filter((a) => a.name !== r.template.name), r.template];
        saveAssemblies(assemblies);
        set({
          assemblies,
          status: {
            tone: 'success',
            text: `Saved “${r.template.name}” as a reusable assembly (${r.template.members.length} members).`,
          },
        });
        return true;
      },

      insertAssembly(templateId) {
        const t = get().assemblies.find((a) => a.id === templateId);
        if (!t) return null;
        const { rootId, commands } = assemblyCommands(t, engine.getProject().scene.rootId, [0, 0, 0], newId);
        const r = get().run('scene.batch', { commands }, { label: `Insert assembly “${t.name}”` });
        if (!r.ok) return null;
        get().select(rootId);
        return rootId;
      },

      deleteAssembly(templateId) {
        const assemblies = get().assemblies.filter((a) => a.id !== templateId);
        saveAssemblies(assemblies);
        set({ assemblies });
      },

      setConnectionFocus(connectionFocus) {
        set({ connectionFocus });
      },

      async saveCustomModel(bytes, ref) {
        try {
          await assetStore.put({ hash: ref.assetHash, mediaType: ref.mediaType, name: ref.name, bytes });
        } catch (e) {
          set({
            status: {
              tone: 'error',
              text: `Could not store the model: ${e instanceof Error ? e.message : String(e)}`,
            },
          });
          return false;
        }
        const customModels = [...get().customModels.filter((m) => m.assetHash !== ref.assetHash), ref];
        saveCustomModels(customModels);
        set({
          customModels,
          assetsVersion: get().assetsVersion + 1,
          status: { tone: 'success', text: `Saved “${ref.name}” as a custom component (stored locally).` },
        });
        void get().auditAssets();
        return true;
      },

      insertCustomModel(assetHash) {
        const ref = get().customModels.find((m) => m.assetHash === assetHash);
        if (!ref) return null;
        // Base on y = 0 at the project origin.
        const r = get().run(
          'model.instance.create',
          { model: ref, name: ref.name, transform: { position: [0, -ref.minM[1], 0] } },
          { label: `Insert “${ref.name}”` },
        );
        if (!r.ok) return null;
        get().select(r.affectedIds[0]!);
        return r.affectedIds[0]!;
      },

      updateCustomModelInterfaces(assetHash, interfaces) {
        const parsed = ModelRefSchema.shape.interfaces.safeParse(interfaces);
        const ref = get().customModels.find((m) => m.assetHash === assetHash);
        if (!ref || !parsed.success) return false;
        const customModels = get().customModels.map((m) =>
          m.assetHash === assetHash ? { ...m, interfaces: parsed.data } : m,
        );
        saveCustomModels(customModels);
        set({
          customModels,
          status: {
            tone: 'success',
            text: `Saved ${parsed.data.length} interface${parsed.data.length === 1 ? '' : 's'} to the custom component “${ref.name}”.`,
          },
        });
        return true;
      },

      removeCustomModel(assetHash) {
        // Library entry only: the bytes stay in the asset store so projects that use the
        // model keep working (no silently broken references).
        const customModels = get().customModels.filter((m) => m.assetHash !== assetHash);
        saveCustomModels(customModels);
        set({ customModels });
      },

      async auditAssets() {
        const p = engine.getProject();
        const missing: string[] = [];
        for (const h of referencedAssets(p)) if (!(await assetStore.has(h))) missing.push(h);
        if (engine.getProject() === p) set({ missingAssets: missing });
        return missing;
      },

      async exportBundle() {
        const p = engine.getProject();
        const r = await writeBundle(
          'forge-bundle',
          JSON.parse(serializeProject(p)),
          referencedAssets(p),
          assetStore,
        );
        if (!r.ok) {
          set({ status: { tone: 'error', text: r.message, details: r.missing.slice(0, 6) } });
          return null;
        }
        const fileName = projectFileName(p.name).replace(/\.forge\.json$|\.json$/, '') + '.forge-bundle.json';
        set({
          status: {
            tone: 'success',
            text: `Exported ${fileName} (project + ${referencedAssets(p).length} model asset(s)).`,
          },
        });
        return { fileName, text: r.text };
      },

      async importBundleText(text) {
        const r = await readBundle(text, assetStore, 'forge-bundle');
        if (!r.ok) {
          set({
            status: {
              tone: 'error',
              text: `Bundle import failed: ${r.message} The current project was left unchanged.`,
            },
          });
          return false;
        }
        set({ assetsVersion: get().assetsVersion + 1 });
        const ok = get().importProjectText(JSON.stringify(r.bundle.content));
        if (ok) void get().auditAssets();
        return ok;
      },

      async exportAssemblyFile(templateId) {
        const t = get().assemblies.find((a) => a.id === templateId);
        if (!t) return null;
        const r = await writeBundle('forge-assembly', t, templateAssetHashes(t), assetStore);
        if (!r.ok) {
          set({ status: { tone: 'error', text: r.message, details: r.missing.slice(0, 6) } });
          return null;
        }
        const fileName = `${t.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'assembly'}.forge-assembly.json`;
        set({ status: { tone: 'success', text: `Exported ${fileName}.` } });
        return { fileName, text: r.text };
      },

      async importAssemblyText(text) {
        const r = await readBundle(text, assetStore, 'forge-assembly');
        if (!r.ok) {
          set({ status: { tone: 'error', text: `Assembly import failed: ${r.message}` } });
          return false;
        }
        set({ assetsVersion: get().assetsVersion + 1 });
        const t = AssemblyTemplateSchema.safeParse(r.bundle.content);
        if (!t.success) {
          set({
            status: {
              tone: 'error',
              text: 'Assembly import failed: the template is invalid; nothing was imported.',
              details: t.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`),
            },
          });
          return false;
        }
        // Fresh template id; a clashing name gets a suffix (ids of inserted nodes are always new).
        const names = new Set(get().assemblies.map((a) => a.name));
        let name = t.data.name;
        for (let k = 2; names.has(name); k++) name = `${t.data.name} (${k})`;
        const template = { ...t.data, id: newId(), name };
        const assemblies = [...get().assemblies, template];
        saveAssemblies(assemblies);
        set({
          assemblies,
          status: {
            tone: 'success',
            text: `Imported reusable assembly “${name}” (${template.members.length} members).`,
          },
        });
        return true;
      },

      setExplode(assemblyId, factor = 0) {
        set({ explode: assemblyId && factor > 0 ? { assemblyId, factor } : null });
      },

      previewCommand(type, payload) {
        const { result, scene } = engine.preview(makeCommand(type, payload, 'desktop-ui'));
        set({ previewScene: scene });
        return result;
      },

      clearPreview() {
        set({ previewScene: null });
      },

      checkAssemblyInterference(assemblyId) {
        const p = engine.getProject();
        const asm = p.scene.nodes[assemblyId];
        if (!asm) return [];
        const mated = new Set<string>();
        if (asm.kind === 'assembly')
          for (const r of [...asm.mechanical.mates, ...asm.mechanical.constraints])
            mated.add(`${r.a.nodeId}|${r.b.nodeId}`);
        const results = checkInterference(p.scene, asm.childIds, mated);
        set({ interference: { assemblyId, revision: p.revision, results } });
        return results;
      },

      clearInterference() {
        set({ interference: null });
      },

      toggleFavorite(definitionId) {
        const libraryPrefs = toggleFavoritePref(get().libraryPrefs, definitionId);
        saveLibraryPrefs(libraryPrefs);
        set({ libraryPrefs });
      },

      startConjure(c) {
        if (get().navMode === 'walk') get().setNavMode('orbit');
        const r = resolver.resolve({
          definitionId: c.definitionId,
          variantId: c.variantId,
          parameters: c.parameters,
          materialId: c.materialId,
        });
        if (!r.ok) {
          set({ status: { tone: 'error', text: r.message } });
          return false;
        }
        const libraryPrefs = recordRecent(get().libraryPrefs, c.definitionId, c.variantId);
        saveLibraryPrefs(libraryPrefs);
        if (get().view === 'facility') set({ editLayer: 'project', itemSelection: null });
        set({
          conjure: { ...c, yaw: 0 },
          libraryPrefs,
          status: {
            tone: 'info',
            text: `Placing ${r.defaultName}: move over the ${get().view === 'facility' ? 'workbench' : 'build area'}, R / Shift+R to rotate, click to place, Esc to cancel.`,
          },
        });
        return true;
      },

      rotateConjure(delta) {
        const c = get().conjure;
        if (c) set({ conjure: { ...c, yaw: Math.atan2(Math.sin(c.yaw + delta), Math.cos(c.yaw + delta)) } });
      },

      cancelConjure() {
        if (get().conjure)
          set({
            conjure: null,
            status: { tone: 'info', text: 'Conjuring cancelled — nothing was created.' },
          });
      },

      confirmConjure(position) {
        const c = get().conjure;
        if (!c) return null;
        const half = c.yaw / 2;
        const r = get().run(
          'scene.node.create',
          {
            node: {
              kind: 'component-instance',
              definitionId: c.definitionId,
              variantId: c.variantId,
              parameters: c.parameters,
              ...(c.materialId !== undefined ? { materialId: c.materialId } : {}),
              transform: { position, rotation: [0, Math.sin(half), 0, Math.cos(half)] },
            },
          },
          { label: 'Conjure component', source: 'desktop-ui' },
        );
        if (!r.ok) return null;
        const id = r.affectedIds[0]!;
        set({ conjure: null });
        get().select(id);
        return id;
      },

      setPrefetchZone(prefetchZoneId) {
        if (prefetchZoneId !== get().prefetchZoneId) set({ prefetchZoneId });
      },

      focusItem(itemId) {
        const it = workspace.getItem(itemId);
        const zone = it && getZone(it.zoneId);
        if (!it || !zone) return;
        const [zx, , zz] = zone.pose.position;
        const tx = zx + it.pose.position[0];
        const tz = zz + it.pose.position[2];
        set({
          cameraPreset: {
            position: [tx + 1.4, 1.9, tz + 1.9],
            target: [tx, 0.95, tz],
            nonce: (get().cameraPreset?.nonce ?? 0) + 1,
          },
        });
      },

      runWorkspace(type, payload, opts = {}) {
        const r = workspace.execute(makeWorkspaceCommand(type, payload, 'desktop-ui', opts));
        set({
          status: r.ok
            ? r.noop
              ? get().status
              : { tone: 'success', text: `${opts.label ?? type} · layout revision ${r.revision}` }
            : {
                tone: 'error',
                text: r.error.message,
                ...(r.error.issues ? { details: r.error.issues.map((i) => `${i.path}: ${i.message}`) } : {}),
              },
        });
        return r;
      },

      placeEquipment(equipmentId) {
        const eq = getEquipment(equipmentId);
        const zone = getZone(get().currentZoneId);
        const area = zone?.placementAreas.find((a) => eq && a.allowedCategories.includes(eq.category));
        if (!eq || !zone || !area) {
          set({
            status: {
              tone: 'error',
              text: `No placement area in this zone accepts ${eq?.name ?? equipmentId}.`,
            },
          });
          return null;
        }
        // Scan the area on a 0.25 m grid for the first free, valid spot (validated by the engine).
        for (let z = area.rect.min[1]; z <= area.rect.max[1]; z += 0.25)
          for (let x = area.rect.min[0]; x <= area.rect.max[0]; x += 0.25) {
            const r = workspace.execute(
              makeWorkspaceCommand(
                'workspace.item.place',
                { equipmentId, zoneId: zone.id, areaId: area.id, position: [+x.toFixed(3), +z.toFixed(3)] },
                'desktop-ui',
                { label: `Place ${eq.name}` },
              ),
            );
            if (r.ok) {
              set({
                itemSelection: r.affectedIds[0]!,
                status: { tone: 'success', text: `Placed ${eq.name}.` },
              });
              return r;
            }
            if (r.error.code !== 'collision' && r.error.code !== 'out-of-bounds') {
              set({ status: { tone: 'error', text: r.error.message } });
              return r;
            }
          }
        set({ status: { tone: 'error', text: `No free space for ${eq.name} in ${area.name}.` } });
        return null;
      },

      mountProjectOn(itemId) {
        const pid = engine.getProject().id;
        const current = workspace.benchForProject(pid);
        const target = itemId ?? current?.id;
        if (!target) return;
        get().runWorkspace(
          'workspace.bench.mount',
          { itemId: target, projectId: itemId ? pid : null },
          {
            label: itemId ? 'Mount project' : 'Unmount project',
          },
        );
      },

      saveLayout() {
        const r = workspaceRepo.save(workspace.getLayout());
        set(
          r.ok
            ? {
                layoutBaselineRevision: workspace.getLayout().revision,
                status: { tone: 'success', text: 'Workspace layout saved (separately from the project).' },
              }
            : { status: { tone: 'error', text: r.message } },
        );
      },

      exportLayout() {
        const out = {
          fileName: 'workspace-layout.forge-workspace.json',
          text: serializeWorkspace(workspace.getLayout()),
        };
        set({ status: { tone: 'success', text: `Exported ${out.fileName}` } });
        return out;
      },

      importLayoutText(text) {
        const r = parseWorkspaceFile(text);
        if (!r.ok) {
          set({
            status: {
              tone: 'error',
              text: `Layout import failed: ${r.error.message} The current layout was left unchanged.`,
              ...('details' in r.error ? { details: r.error.details.slice(0, 6) } : {}),
            },
          });
          return false;
        }
        const rr = workspace.replaceLayout(r.layout);
        if (!rr.ok) return false;
        set({
          itemSelection: null,
          layoutBaselineRevision: workspace.getLayout().revision,
          status: { tone: 'success', text: `Imported layout “${r.layout.name}”.` },
        });
        return true;
      },
    };
  });

  workspace.subscribe(() =>
    store.setState({
      layout: workspace.getLayout(),
      workspaceHistory: workspace.getHistory(),
      itemSelection: workspace.getItem(store.getState().itemSelection ?? '')
        ? store.getState().itemSelection
        : null,
    }),
  );
  engine.subscribe(() => {
    const project = engine.getProject();
    const explode = store.getState().explode;
    store.setState({
      project,
      selection: engine.getSelection(),
      history: engine.getHistory(),
      // Any committed change makes a pending preview stale.
      previewScene: null,
      explode: explode && project.scene.nodes[explode.assemblyId]?.kind === 'assembly' ? explode : null,
    });
  });
  return store;
}

export const isDirty = (s: Pick<EditorState, 'project' | 'baselineRevision'>) =>
  s.project.revision !== s.baselineRevision;

export const EditorStoreContext = createContext<StoreApi<EditorState> | null>(null);

export function useEditor<T>(selector: (s: EditorState) => T): T {
  const store = useContext(EditorStoreContext);
  if (!store) throw new Error('EditorStoreContext missing');
  return useStore(store, selector);
}

export function useEditorStore(): StoreApi<EditorState> {
  const store = useContext(EditorStoreContext);
  if (!store) throw new Error('EditorStoreContext missing');
  return store;
}
