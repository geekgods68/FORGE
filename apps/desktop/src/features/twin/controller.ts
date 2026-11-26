import {
  compare,
  DEFAULT_SCENARIO,
  designate,
  emptyTwinDocument,
  observedSignal,
  Recorder,
  recordingToDataset,
  replay,
  SyntheticAdapter,
  TelemetryPipeline,
  toModel,
  upsertTwin,
  validateMappings,
  veyrisArmTwin,
  verifyRecording,
  type Comparison,
  type LinkState,
  type MappingIssue,
  type Recording,
  type SyntheticScenario,
  type TelemetryAdapter,
  type Twin,
  type TwinDocument,
} from '@forge/digital-twin';
import { CoSimulation, physicsPortOf } from '@forge/electronics';
import { makeCommand, type CommandInput, type Project } from '@forge/engineering-core';
import { BrowserStorageTwinRepository, type StorageLike } from '@forge/persistence';
import { loadRapier, PhysicsSession, simulationOf } from '@forge/physics';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EditorState } from '@/app/store';
import { researchFor } from '@/features/research/controller';
import { BridgeAdapter, WebSerialAdapter } from './transports';

/**
 * Digital-twin mode controller. Modes are explicit and exclusive:
 *   simulation  — the virtual system only (no device attached);
 *   observation — a device feeds the pipeline (READ-ONLY: nothing can be sent to it);
 *   replay      — a stored recording is played back deterministically;
 *   comparison  — an observed recording against a simulation on one timeline.
 * High-rate telemetry never touches the project or its undo history: the virtual pose is
 * shown through the viewport's preview scene (an engine dry run), not through commands.
 */
export type TwinMode = 'simulation' | 'observation' | 'replay' | 'comparison';
export type AdapterChoice = 'synthetic' | 'web-serial' | 'bridge';
export interface TwinUi {
  projectId: string | null;
  doc: TwinDocument;
  twinId: string | null;
  mode: TwinMode;
  adapter: AdapterChoice;
  bridge: { port: number; token: string };
  synthetic: 'nominal' | 'faults' | 'disconnects';
  connected: boolean;
  link: LinkState | 'idle';
  recording: boolean;
  recordings: {
    id: string;
    synthetic: boolean;
    adapter: string;
    startedAt: string;
    lines: number;
    durationMs: number;
  }[];
  selectedRecording: string | null;
  comparison: (Comparison & { recordingId: string; signal: string }) | { error: string } | null;
  mappingIssues: MappingIssue[];
  message: { tone: 'info' | 'error'; text: string } | null;
  version: number;
  previewWristRad: number | null;
  /** Host time of the last UI tick (ms); render code reads time from here. */
  tickMs: number;
}

const SCENARIOS: Record<TwinUi['synthetic'], SyntheticScenario> = {
  nominal: { ...DEFAULT_SCENARIO, durationS: 120 },
  faults: {
    ...DEFAULT_SCENARIO,
    durationS: 120,
    seed: 5,
    faults: {
      ...DEFAULT_SCENARIO.faults,
      dropRate: 0.03,
      duplicateRate: 0.03,
      reorderRate: 0.05,
      corruptRate: 0.02,
      noEchoRate: 0.05,
    },
  },
  disconnects: {
    ...DEFAULT_SCENARIO,
    durationS: 120,
    faults: { ...DEFAULT_SCENARIO.faults, disconnects: [[4, 6]], stalls: [[9, 11]] },
  },
};

let config: { storage: StorageLike; namespace: string } | null = null;
export function configureTwin(c: { storage: StorageLike; namespace: string }) {
  config = c;
}

/** Minimal IndexedDB key-value store for recordings (memory fallback). */
class RecordingStore {
  private mem = new Map<string, Recording>();
  private db: Promise<IDBDatabase | null>;
  constructor(ns: string) {
    this.db = new Promise((resolve) => {
      try {
        const r = indexedDB.open(`${ns}-twin-recordings`, 1);
        r.onupgradeneeded = () => r.result.createObjectStore('r');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  private async tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
    const db = await this.db;
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const req = f(db.transaction('r', mode).objectStore('r'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async put(r: Recording) {
    this.mem.set(r.id, r);
    await this.tx('readwrite', (s) => s.put(r, r.id));
  }
  async get(id: string): Promise<Recording | null> {
    return (
      this.mem.get(id) ?? ((await this.tx('readonly', (s) => s.get(id))) as Recording | undefined) ?? null
    );
  }
  async all(projectTwinIds: string[]): Promise<Recording[]> {
    const vals = ((await this.tx('readonly', (s) => s.getAll())) as Recording[] | null) ?? [
      ...this.mem.values(),
    ];
    return vals.filter((r) => projectTwinIds.includes(r.twinId));
  }
}

export class TwinController {
  readonly ui: StoreApi<TwinUi>;
  pipeline: TelemetryPipeline | null = null;
  private adapter: TelemetryAdapter | null = null;
  private recorder: Recorder | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly repo: BrowserStorageTwinRepository;
  readonly recordings: RecordingStore;
  private t0 = 0;
  /** Latest raw hello / channel-declaration lines received (written first into every recording). */
  private declarations = new Map<string, string>();

  constructor(readonly editor: StoreApi<EditorState>) {
    const c = config ?? { storage: window.localStorage, namespace: 'forge' };
    this.repo = new BrowserStorageTwinRepository(c.storage, c.namespace);
    this.recordings = new RecordingStore(c.namespace);
    const p = editor.getState().project;
    this.ui = createStore<TwinUi>(() => ({
      projectId: p.id,
      doc: emptyTwinDocument(p.id),
      twinId: null,
      mode: 'simulation',
      adapter: 'synthetic',
      bridge: { port: 8765, token: '' },
      synthetic: 'nominal',
      connected: false,
      link: 'idle',
      recording: false,
      recordings: [],
      selectedRecording: null,
      comparison: null,
      mappingIssues: [],
      message: null,
      version: 0,
      previewWristRad: null,
      tickMs: 0,
    }));
    this.load(p);
    editor.subscribe((s, prev) => {
      if (s.project.id !== prev.project.id) {
        void this.disconnect();
        this.load(s.project);
      } else if (s.project !== prev.project) this.revalidate();
      if (s.workMode !== 'twin' && prev.workMode === 'twin') void this.leave();
    });
  }

  private load(p: Project) {
    const r = this.repo.load(p.id);
    const doc = r.ok && r.doc ? r.doc : emptyTwinDocument(p.id);
    this.ui.setState({
      projectId: p.id,
      doc,
      twinId: doc.twins[0]?.id ?? null,
      comparison: null,
      recordings: [],
      selectedRecording: null,
      message: r.ok
        ? null
        : { tone: 'error', text: `Saved twin data is invalid and was not loaded: ${r.error}` },
    });
    this.revalidate();
    void this.refreshRecordings();
  }
  get twin(): Twin | null {
    const u = this.ui.getState();
    return u.doc.twins.find((t) => t.id === u.twinId) ?? null;
  }
  private save(doc: TwinDocument) {
    const s = this.repo.save(doc);
    this.ui.setState({
      doc,
      version: this.ui.getState().version + 1,
      ...(s.ok ? {} : { message: { tone: 'error', text: s.message } }),
    });
  }
  revalidate() {
    const t = this.twin;
    this.ui.setState({
      mappingIssues: t
        ? validateMappings(
            t,
            this.editor.getState().project,
            this.pipeline?.device ? this.pipeline.channels : null,
          )
        : [],
    });
  }

  /** Create the reference twin for the VEYRIS arm project (or a project with US1/SV4). */
  createDefaultTwin() {
    const project = this.editor.getState().project;
    const t = veyrisArmTwin(project);
    const r = upsertTwin(this.ui.getState().doc, t);
    if (!r.ok) return this.ui.setState({ message: { tone: 'error', text: r.error } });
    this.save(r.doc);
    this.ui.setState({
      twinId: t.id,
      message: {
        tone: 'info',
        text: `Twin "${t.name}" created (configuration only; no device is contacted).`,
      },
    });
    this.revalidate();
  }

  // -- observation ----------------------------------------------------------------------------
  async connect() {
    await this.disconnect();
    this.declarations.clear();
    const u = this.ui.getState();
    const now = () => performance.now();
    this.t0 = now();
    this.pipeline = new TelemetryPipeline(this.t0, { staleAfterMs: this.twin?.staleAfterMs ?? 500 });
    const adapter: TelemetryAdapter =
      u.adapter === 'synthetic'
        ? new SyntheticAdapter(SCENARIOS[u.synthetic], { now, after: (ms, f) => void setTimeout(f, ms) })
        : u.adapter === 'web-serial'
          ? new WebSerialAdapter(this.twin?.device.baud ?? 115200)
          : new BridgeAdapter(u.bridge.port, u.bridge.token);
    this.adapter = adapter;
    this.ui.setState({
      mode: 'observation',
      connected: true,
      link: 'waiting',
      comparison: null,
      message: {
        tone: 'info',
        text: adapter.synthetic
          ? 'SYNTHETIC telemetry (generated by FORGE — not a physical device).'
          : 'Waiting for the device… (read-only: FORGE never sends commands)',
      },
    });
    try {
      await adapter.open({
        line: (l, h) => {
          if (l.startsWith('@H,')) this.declarations.set('H', l);
          else if (l.startsWith('@C,')) this.declarations.set(`C:${l.split(',')[1]}`, l);
          this.pipeline?.ingestLine(l, h);
          this.recorder?.line(l, h);
        },
        state: (open, h, detail) => {
          this.pipeline?.setTransport(open, h);
          this.recorder?.state(open, h);
          if (!open && detail) this.ui.setState({ message: { tone: 'info', text: `Connection: ${detail}` } });
        },
      });
    } catch (e) {
      this.adapter = null;
      this.ui.setState({
        connected: false,
        link: 'idle',
        mode: 'simulation',
        message: { tone: 'error', text: e instanceof Error ? e.message : String(e) },
      });
      return;
    }
    this.timer = setInterval(() => this.tick(), 200);
  }
  async disconnect() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.recorder) await this.stopRecording();
    await this.adapter?.close();
    this.adapter = null;
    if (this.pipeline) this.pipeline.setTransport(false, performance.now());
    this.ui.setState({
      connected: false,
      link: this.pipeline ? 'disconnected' : 'idle',
      mode: this.ui.getState().mode === 'observation' ? 'simulation' : this.ui.getState().mode,
    });
    this.showPose(null);
  }
  private async leave() {
    await this.disconnect();
    this.editor.setState({ previewScene: null });
  }
  private tick() {
    const p = this.pipeline;
    if (!p) return;
    const now = performance.now();
    p.flush(now);
    const link = p.linkState(now);
    const t = this.twin;
    const wrist = t?.channels.find((c) => c.target.kind === 'joint');
    const latest = wrist ? p.latest(wrist.channel, now) : null;
    const q =
      latest && wrist && (link === 'live' || link === 'delayed') ? toModel(wrist, latest.value) : null;
    this.showPose(q);
    this.ui.setState({ link, version: this.ui.getState().version + 1, previewWristRad: q, tickMs: now });
    if (this.ui.getState().mappingIssues.length === 0 && p.device) this.revalidate();
  }
  /** Virtual pose from the COMMANDED joint value, as a viewport preview (no history entry). */
  private showPose(q: number | null) {
    const t = this.twin;
    const m = t?.channels.find((c) => c.target.kind === 'joint');
    if (!m || m.target.kind !== 'joint') return;
    const mateId = m.target.mateId;
    const s = this.editor.getState();
    if (q === null) {
      if (s.previewScene) this.editor.setState({ previewScene: null });
      return;
    }
    const asm = Object.values(s.project.scene.nodes).find(
      (n) => n.kind === 'assembly' && n.mechanical.mates.some((x) => x.id === mateId),
    );
    if (!asm || asm.kind !== 'assembly') return;
    const mate = asm.mechanical.mates.find((x) => x.id === mateId)!;
    const lim = mate.limits[0];
    const qc = lim ? Math.min(lim.max, Math.max(lim.min, q)) : q;
    const r = s.engine.preview(
      makeCommand(
        'assembly.joint.setPosition',
        { assemblyId: asm.id, mateId, coordinates: [qc] },
        'desktop-ui',
      ) as CommandInput,
    );
    if (r.scene) this.editor.setState({ previewScene: r.scene });
  }

  // -- recording, replay, comparison, research ------------------------------------------------
  startRecording() {
    const t = this.twin;
    if (!this.pipeline || !this.adapter || !t) return;
    this.recorder = new Recorder(this.t0, {
      id: `rec-${Date.now().toString(36)}`,
      twinId: t.id,
      adapter: this.adapter.kind,
      synthetic: this.adapter.synthetic,
      startedAt: new Date().toISOString(),
    });
    const now = performance.now();
    this.recorder.state(true, now);
    // Declarations received before the recording started (raw lines, as received), so the
    // recording is self-describing when replayed.
    for (const l of this.declarations.values()) this.recorder.line(l, now);
    this.ui.setState({ recording: true });
  }
  async stopRecording() {
    if (!this.recorder || !this.pipeline) return;
    const rec = this.recorder.finish(this.pipeline);
    this.recorder = null;
    await this.recordings.put(rec);
    const t = this.twin;
    if (t && !rec.synthetic) {
      const r = upsertTwin(this.ui.getState().doc, {
        ...t,
        evidence: { ...t.evidence, recordings: [...t.evidence.recordings, rec.id] },
      });
      if (r.ok) this.save(r.doc);
    }
    this.ui.setState({ recording: false, selectedRecording: rec.id });
    await this.refreshRecordings();
  }
  async refreshRecordings() {
    const ids = this.ui.getState().doc.twins.map((t) => t.id);
    const all = await this.recordings.all(ids);
    this.ui.setState({
      recordings: all
        .map((r) => ({
          id: r.id,
          synthetic: r.synthetic,
          adapter: r.adapter,
          startedAt: r.startedAt,
          lines: r.lines.length,
          durationMs: r.durationMs,
        }))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    });
  }
  /** Replay: the pipeline is rebuilt from the recording (deterministic), not from a device. */
  async replay(id: string) {
    await this.disconnect();
    const r = await this.recordings.get(id);
    if (!r) return this.ui.setState({ message: { tone: 'error', text: 'Recording not found.' } });
    if (!verifyRecording(r))
      return this.ui.setState({
        message: { tone: 'error', text: 'Recording failed its integrity check (modified?).' },
      });
    this.pipeline = replay(r);
    this.pipeline.setTransport(false, r.durationMs, true);
    this.ui.setState({
      mode: 'replay',
      link: 'replay',
      selectedRecording: id,
      tickMs: r.durationMs,
      version: this.ui.getState().version + 1,
      message: {
        tone: 'info',
        text: `Replaying ${r.synthetic ? 'SYNTHETIC ' : ''}recording ${id} (${r.lines.length} lines).`,
      },
    });
  }
  /** Observed (recording) vs simulated (co-simulation of this project) for one channel. */
  async compare(id: string, channel: string) {
    const t = this.twin;
    const r = await this.recordings.get(id);
    const m = t?.channels.find((c) => c.channel === channel);
    if (!t || !r || !m?.simulationSignal)
      return this.ui.setState({
        comparison: { error: 'Choose a recording and a mapped channel with a simulation signal.' },
      });
    const project = this.editor.getState().project;
    const root = project.scene.nodes[project.scene.rootId];
    const sim = simulationOf(project.scene);
    if (root?.kind !== 'root' || !root.electrical || !sim)
      return this.ui.setState({
        comparison: { error: 'The project needs a circuit and a simulation setup.' },
      });
    const p = replay(r);
    const s = p.series.get(channel);
    if (!s?.t.length)
      return this.ui.setState({ comparison: { error: 'The recording has no samples on this channel.' } });
    const R = await loadRapier();
    const session = PhysicsSession.fromScene(R, project.scene, sim);
    const cs = new CoSimulation(root.electrical, {
      physics: physicsPortOf(session, project.scene),
      scene: project.scene,
    });
    cs.start();
    cs.advanceTo(Math.ceil((s.t[s.t.length - 1]! + 0.2) * 1e9));
    const ss = cs.recorder.series(m.simulationSignal);
    session.dispose();
    if (!ss)
      return this.ui.setState({
        comparison: { error: `Signal ${m.simulationSignal} is not recorded by the co-simulation.` },
      });
    const simSig = {
      key: m.simulationSignal,
      unit: m.modelUnit,
      t: Float64Array.from(ss.t),
      v: Float64Array.from(ss.v),
      source: 'FORGE co-simulation',
    };
    const c = compare(observedSignal(s, m), simSig, { lagRangeS: 0.5, lagStepS: 0.01 });
    this.ui.setState({
      mode: 'comparison',
      comparison: 'error' in c ? c : { ...c, recordingId: id, signal: m.simulationSignal },
    });
  }
  /** Store a recording's measured channels as a Phase 7 dataset (synthetic flag preserved). */
  async toResearch(id: string) {
    const t = this.twin;
    const r = await this.recordings.get(id);
    if (!t || !r) return;
    const ds = recordingToDataset(r, t, `ds-twin-${id}`);
    if ('error' in ds) return this.ui.setState({ message: { tone: 'error', text: ds.error } });
    const rc = researchFor(this.editor);
    await rc.store.put(ds.record.dataKey, ds.data as never);
    const res = rc.engine.recordDataset(ds.record);
    this.ui.setState({
      message: res.ok
        ? {
            tone: 'info',
            text: `Dataset ${ds.record.id} (${ds.record.rows} rows${ds.record.provenance.synthetic ? ', SYNTHETIC' : ''}) added to the Research document.`,
          }
        : { tone: 'error', text: res.error },
    });
  }
  async designation() {
    const t = this.twin;
    if (!t) return null;
    const project = this.editor.getState().project;
    const root = project.scene.nodes[project.scene.rootId];
    const recs = await this.recordings.all([t.id]);
    const sync: Record<string, { latencyP95Ms: number; missingFraction: number }> = {};
    for (const r of recs) {
      const p = replay(r);
      const total = (p.series.get(t.channels[0]?.channel ?? '')?.t.length ?? 0) + p.stats.missingMessages;
      sync[r.id] = {
        latencyP95Ms: p.clock.latencyP95Ms,
        missingFraction: total ? p.stats.missingMessages / total : 1,
      };
    }
    const doc = researchFor(this.editor).engine.document;
    return designate({
      hasModel: true,
      hasSimulation: root?.kind === 'root' && (!!root.simulation || !!root.electrical),
      twin: t,
      recordings: recs,
      sync,
      datasets: doc.datasets,
      calibrations: doc.calibrations,
      validations: doc.validations,
    });
  }
}

const controllers = new WeakMap<StoreApi<EditorState>, TwinController>();
export function twinFor(editor: StoreApi<EditorState>): TwinController {
  let c = controllers.get(editor);
  if (!c) controllers.set(editor, (c = new TwinController(editor)));
  return c;
}
