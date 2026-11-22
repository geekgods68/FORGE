import type { Project } from '@forge/engineering-core';
import { loadRapier, type Rapier } from '@forge/physics';
import { BrowserStorageResearchRepository, type StorageLike } from '@forge/persistence';
import {
  DEFAULT_BUDGET,
  ResearchApi,
  ResearchEngine,
  signalCatalog,
  type CampaignProgress,
  type ResearchCommand,
  type SignalInfo,
  type ValidationReport,
} from '@forge/research';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EditorState } from '@/app/store';
import { IdbRunDataStore } from './idbStore';

/**
 * Research mode controller. One ResearchEngine per open project (auto-saved to its own
 * document after every change — not the project file, not the engineering undo history).
 * Campaigns run sequentially through @forge/research, yielding between chunks, so the display
 * loop and its frame rate play no part in the results.
 */
export type ResearchTab = 'protocol' | 'runs' | 'results' | 'analysis' | 'validation' | 'notebook' | 'report';
export interface ResearchUi {
  projectId: string | null;
  experimentId: string | null;
  tab: ResearchTab;
  version: number;
  progress: CampaignProgress | null;
  validation: ValidationReport | null;
  catalog: SignalInfo[] | null;
  busy: string | null;
  message: { tone: 'info' | 'error'; text: string } | null;
  selectedRun: string | null;
  persistent: boolean;
}

let config: { storage: StorageLike; namespace: string } | null = null;
export function configureResearch(c: { storage: StorageLike; namespace: string }) {
  config = c;
}

export class ResearchController {
  readonly ui: StoreApi<ResearchUi> = createStore<ResearchUi>(() => ({
    projectId: null,
    experimentId: null,
    tab: 'protocol',
    version: 0,
    progress: null,
    validation: null,
    catalog: null,
    busy: null,
    message: null,
    selectedRun: null,
    persistent: true,
  }));
  engine!: ResearchEngine;
  readonly store: IdbRunDataStore;
  api!: ResearchApi;
  private repo: BrowserStorageResearchRepository;
  private R: Promise<Rapier> | null = null;
  private unsubEngine: (() => void) | null = null;

  constructor(readonly editor: StoreApi<EditorState>) {
    const c = config ?? { storage: window.localStorage, namespace: 'forge' };
    this.repo = new BrowserStorageResearchRepository(c.storage, c.namespace);
    this.store = new IdbRunDataStore(c.namespace);
    this.load(editor.getState().project);
    editor.subscribe((s, prev) => {
      if (s.project.id !== prev.project.id) this.load(s.project);
      else if (s.project !== prev.project) this.ui.setState({ catalog: null, validation: null });
    });
  }

  rapier(): Promise<Rapier> {
    this.R ??= loadRapier();
    return this.R;
  }
  get project(): Project {
    return this.editor.getState().project;
  }

  private load(p: Project) {
    this.unsubEngine?.();
    const r = this.repo.load(p.id);
    if (!r.ok)
      this.ui.setState({
        message: {
          tone: 'error',
          text: `The saved research data for this project is invalid and was not loaded: ${r.error}`,
        },
      });
    this.engine = r.ok && r.doc ? new ResearchEngine(r.doc) : ResearchEngine.empty(p.id);
    this.api = new ResearchApi(
      this.engine,
      this.store,
      () => this.project,
      () => this.rapier(),
      DEFAULT_BUDGET,
    );
    this.unsubEngine = this.engine.subscribe(() => {
      const s = this.repo.save(this.engine.document);
      this.ui.setState({
        version: this.ui.getState().version + 1,
        ...(s.ok ? {} : { message: { tone: 'error', text: s.message } }),
      });
    });
    const first = this.engine.document.experiments[0]?.id ?? null;
    this.ui.setState({
      projectId: p.id,
      experimentId: first,
      version: this.ui.getState().version + 1,
      progress: null,
      validation: null,
      catalog: null,
      selectedRun: null,
      persistent: this.store.persistent,
    });
  }

  exec(cmd: ResearchCommand, okText?: string): boolean {
    const r = this.engine.execute(cmd);
    this.ui.setState({
      message: r.ok ? (okText ? { tone: 'info', text: okText } : null) : { tone: 'error', text: r.error },
      validation: null,
    });
    return r.ok;
  }
  select(experimentId: string | null) {
    this.ui.setState({ experimentId, validation: null, catalog: null, selectedRun: null });
  }

  async loadCatalog() {
    const e = this.experiment;
    if (!e) return;
    this.ui.setState({ busy: 'Reading the model’s signals…' });
    try {
      this.ui.setState({
        catalog: signalCatalog(this.project, e.protocol.model.kind, await this.rapier()),
        busy: null,
      });
    } catch (x) {
      this.ui.setState({ busy: null, message: { tone: 'error', text: String(x) } });
    }
  }

  get experiment() {
    const id = this.ui.getState().experimentId;
    return id ? (this.engine.experiment(id) ?? null) : null;
  }

  async validate() {
    const e = this.experiment;
    if (!e) return null;
    this.ui.setState({ busy: 'Validating against the model…' });
    const v = await this.api.validate(e.id);
    this.ui.setState({ validation: v, busy: null });
    return v;
  }

  async launch(retryFailed = false) {
    const e = this.experiment;
    if (!e) return;
    this.ui.setState({ busy: null, tab: 'runs', message: null });
    const r = await this.api.run(e.id, {
      retryFailed,
      onProgress: (p) => this.ui.setState({ progress: { ...p } }),
    });
    if (!r.ok) this.ui.setState({ message: { tone: 'error', text: r.error } });
    else
      this.ui.setState({
        message: {
          tone: 'info',
          text:
            r.progress.message ??
            `Campaign ${r.progress.phase}: ${r.progress.completed} completed, ${r.progress.failed} failed, ${r.progress.reused} reused.`,
        },
      });
  }
  cancel() {
    this.api.cancel();
  }
}

const controllers = new WeakMap<StoreApi<EditorState>, ResearchController>();
export function researchFor(editor: StoreApi<EditorState>): ResearchController {
  let c = controllers.get(editor);
  if (!c) {
    c = new ResearchController(editor);
    controllers.set(editor, c);
  }
  return c;
}
