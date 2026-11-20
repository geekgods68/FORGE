import {
  createProject,
  DEFAULT_SNAP,
  ForgeEngine,
  makeCommand,
  parseProjectFile,
  projectFileName,
  serializeProject,
  type CommandResult,
  type CommandSource,
  type CommandType,
  type HistoryInfo,
  type PayloadInput,
  type Project,
  type SnapSettings,
} from '@forge/engineering-core';
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
  cameraPreset: CameraPreset | null;

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
  const engine = new ForgeEngine(initial);
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
      set({ baselineRevision: engine.getProject().revision, status, collapsed: {} });
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
      cameraPreset: null,

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
        const [x, , z] = zone.pose.position;
        set({
          currentZoneId: zoneId,
          cameraPreset: {
            position: zone.kind === 'corridor' ? [x + 10, 5, z + 9] : [x, 13, z + 9.5],
            target: [x, 0.8, z],
            nonce: (get().cameraPreset?.nonce ?? 0) + 1,
          },
          status: { tone: 'info', text: `Entered ${zone.name}.` },
        });
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
  engine.subscribe(() =>
    store.setState({
      project: engine.getProject(),
      selection: engine.getSelection(),
      history: engine.getHistory(),
    }),
  );
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
