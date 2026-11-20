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
import type { ProjectRepository, ProjectSummary } from '@forge/persistence';
import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type ToolMode = 'translate' | 'rotate' | 'scale';
export type Status = { tone: 'info' | 'success' | 'error'; text: string; details?: string[] };
export type PhysicsStatus = { state: 'loading' | 'ready' | 'error'; detail?: string };

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
        const r = engine.undo();
        set({
          status: r.ok
            ? { tone: 'info', text: `Undid “${r.label}” · revision ${r.revision}` }
            : { tone: 'info', text: r.error.message },
        });
      },

      redo() {
        if (get().dragging) return;
        const r = engine.redo();
        set({
          status: r.ok
            ? { tone: 'info', text: `Redid “${r.label}” · revision ${r.revision}` }
            : { tone: 'info', text: r.error.message },
        });
      },

      select(id) {
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
    };
  });

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
