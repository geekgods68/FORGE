import type { Project, SceneGraph, SimulationDefinition } from '@forge/engineering-core';
import {
  buildPhysicsModel,
  loadRapier,
  PhysicsSession,
  simulationOf,
  suggestSimulationDefinition,
  type Assumption,
  type BodyState,
  type Issue,
  type JointState,
  type MotorCommand,
  type SessionStats,
  type SimEvent,
} from '@forge/physics';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EditorState } from '@/app/store';

/**
 * Simulation-mode controller (desktop). It owns the physics SESSION — an isolated runtime
 * built from the engineering project — and never mutates engineering state: setup changes
 * go through undoable `physics.*` engine commands; runtime inputs (start, pause, motor
 * targets, forces) go to the session only and never enter the undo history.
 */
export type SimPhase = 'off' | 'loading' | 'no-setup' | 'ready' | 'running' | 'paused' | 'faulted' | 'error';

export interface SimUi {
  phase: SimPhase;
  error: string | null;
  time: number;
  steps: number;
  speed: number;
  stopped: boolean;
  fault: string | null;
  /** The setup changed structurally and a reset is needed to apply it. */
  needsReset: boolean;
  /** The CAD model changed since the session was built. */
  cadChanged: boolean;
  issues: Issue[];
  assumptions: Assumption[];
  joints: JointState[];
  body: BodyState | null;
  events: SimEvent[];
  eventCount: number;
  stats: SessionStats | null;
  telemetry: {
    samples: number;
    dropped: number;
    bytes: number;
    channels: { key: string; label: string; unit: string; kind: string }[];
  };
  runId: string | null;
  engineVersion: string | null;
  /** Unit node ids moved by the simulation (excluded from instancing while simulating). */
  movingUnits: string[];
  showColliders: boolean;
  showContacts: boolean;
}

const EMPTY: SimUi = {
  phase: 'off',
  error: null,
  time: 0,
  steps: 0,
  speed: 1,
  stopped: false,
  fault: null,
  needsReset: false,
  cadChanged: false,
  issues: [],
  assumptions: [],
  joints: [],
  body: null,
  events: [],
  eventCount: 0,
  stats: null,
  telemetry: { samples: 0, dropped: 0, bytes: 0, channels: [] },
  runId: null,
  engineVersion: null,
  movingUnits: [],
  showColliders: false,
  showContacts: false,
};

/** Everything except the root's simulation definition: a change here is a CAD change. */
function cadIdentity(scene: SceneGraph): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const [id, n] of Object.entries(scene.nodes))
    m.set(id, n.kind === 'root' ? JSON.stringify({ ...n, simulation: undefined }) : n);
  return m;
}
function sameCad(a: Map<string, unknown>, b: Map<string, unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * A runtime that co-simulates with the physics session (Phase 6 electronics). When it
 * `drives()`, it advances the shared clock and takes the physics steps itself.
 */
export interface SimRuntimeHook {
  drives(): boolean;
  tick(realDtS: number): void;
  step(n: number): void;
  /** The physics session was (re)built or reset: restart the runtime at t = 0. */
  rebuilt(): void;
  exited(): void;
  /** Run state changed (start/pause): refresh the runtime's view. */
  changed(): void;
}

export class SimulationController {
  readonly ui: StoreApi<SimUi> = createStore<SimUi>(() => ({ ...EMPTY }));
  session: PhysicsSession | null = null;
  runtime: SimRuntimeHook | null = null;
  private unsub: (() => void) | null = null;
  private cad: Map<string, unknown> | null = null;
  private lastUi = 0;
  private lastDefinition: SimulationDefinition | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly editor: StoreApi<EditorState>) {}

  private get project(): Project {
    return this.editor.getState().project;
  }

  async enter(): Promise<void> {
    if (this.ui.getState().phase !== 'off') return;
    this.ui.setState({
      ...EMPTY,
      phase: 'loading',
      showColliders: this.ui.getState().showColliders,
      showContacts: this.ui.getState().showContacts,
    });
    this.unsub = this.editor.subscribe((s, prev) => {
      if (s.project !== prev.project) this.onProject(s.project);
    });
    this.loading = this.build();
    await this.loading;
  }

  exit(): void {
    this.runtime?.exited();
    this.unsub?.();
    this.unsub = null;
    this.session?.dispose();
    this.session = null;
    this.editor.getState().setContinuous('simulation', false);
    this.ui.setState({
      ...EMPTY,
      showColliders: this.ui.getState().showColliders,
      showContacts: this.ui.getState().showContacts,
    });
  }

  private async build(): Promise<void> {
    const p = this.project;
    const def = simulationOf(p.scene);
    this.cad = cadIdentity(p.scene);
    this.lastDefinition = def;
    if (!def) {
      this.session?.dispose();
      this.session = null;
      this.ui.setState({ phase: 'no-setup', issues: [], joints: [], movingUnits: [] });
      this.runtime?.rebuilt();
      return;
    }
    try {
      const R = await loadRapier();
      this.session?.dispose();
      this.session = new PhysicsSession(R, buildPhysicsModel(p.scene, def), {
        project: { id: p.id, name: p.name, revision: p.revision },
      });
      this.refresh(true);
      this.runtime?.rebuilt();
    } catch (e) {
      this.ui.setState({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  private onProject(p: Project): void {
    if (this.ui.getState().phase === 'off') return;
    const def = simulationOf(p.scene);
    const cadNow = cadIdentity(p.scene);
    const cadChanged = !!this.cad && !sameCad(this.cad, cadNow);
    if (!this.session || !def || !this.lastDefinition) {
      // Setup created/removed (or undone): rebuild from scratch.
      void this.build();
      return;
    }
    if (def !== this.lastDefinition) {
      this.lastDefinition = def;
      this.session.updateDefinition(def);
    }
    this.ui.setState({ cadChanged });
    this.refresh(true);
  }

  /** Rebuild the session from the current CAD model and setup (time 0). */
  rebuild(): void {
    const p = this.project;
    const def = simulationOf(p.scene);
    if (!this.session || !def) return void this.build();
    this.session.reinitialize(p.scene, def, { id: p.id, name: p.name, revision: p.revision });
    this.cad = cadIdentity(p.scene);
    this.lastDefinition = def;
    this.ui.setState({ cadChanged: false });
    this.refresh(true);
    this.runtime?.rebuilt();
  }

  createSetup(): boolean {
    const r = this.editor
      .getState()
      .run(
        'physics.simulation.create',
        { definition: suggestSimulationDefinition(this.project.scene) },
        { label: 'Create simulation setup' },
      );
    return r.ok;
  }

  /** Persisted, undoable world/solver change (applied live or after a reset). */
  configure(patch: Record<string, unknown>, label: string): boolean {
    return this.editor.getState().run('physics.configure', { patch } as never, { label }).ok;
  }

  start(): void {
    const s = this.session;
    if (!s || !s.ok) return;
    s.run();
    this.editor.getState().setContinuous('simulation', true);
    this.refresh(true);
    this.runtime?.changed();
  }
  pause(): void {
    this.session?.pause();
    this.editor.getState().setContinuous('simulation', false);
    this.refresh(true);
    this.runtime?.changed();
  }
  reset(): void {
    const s = this.session;
    if (!s) return;
    if (s.needsReset || this.ui.getState().cadChanged) return this.rebuild();
    s.reset();
    this.editor.getState().setContinuous('simulation', false);
    this.refresh(true);
    this.runtime?.rebuilt();
  }
  step(n = 1): void {
    if (!this.session) return;
    if (this.session.state === 'running') this.session.pause();
    if (this.runtime?.drives()) {
      this.runtime.step(n);
      this.refresh(true);
      return;
    }
    this.session.step(n);
    this.refresh(true);
  }
  setSpeed(speed: number): void {
    if (this.session) this.session.speed = speed;
    this.ui.setState({ speed });
  }
  emergencyStop(): void {
    this.session?.emergencyStop();
    this.refresh(true);
  }
  releaseStop(): void {
    this.session?.releaseStop();
    this.refresh(true);
  }
  motor(cmd: Omit<MotorCommand, 'source'>): { ok: boolean; error?: string } {
    if (!this.session) return { ok: false, error: 'No simulation.' };
    const r = this.session.setMotorTarget({ ...cmd, source: 'desktop-ui' });
    this.refresh(true);
    return r.ok ? { ok: true } : r;
  }
  applyForce(nodeId: string, forceN: [number, number, number], durationS: number) {
    const r = this.session?.applyForce(nodeId, forceN, { durationS }) ?? {
      ok: false as const,
      error: 'No simulation.',
    };
    this.refresh(true);
    return r;
  }
  applyTorque(nodeId: string, torqueNm: [number, number, number], durationS: number) {
    const r = this.session?.applyTorque(nodeId, torqueNm, { durationS }) ?? {
      ok: false as const,
      error: 'No simulation.',
    };
    this.refresh(true);
    return r;
  }
  /** Persist a payload mass (undoable command); the running session picks it up live. */
  setPayloadMass(payloadId: string, massKg: number): boolean {
    const def = simulationOf(this.project.scene);
    const p = def?.payloads.find((x) => x.id === payloadId);
    if (!p) return false;
    return this.editor
      .getState()
      .run('physics.payload.set', { payload: { ...p, massKg } }, { label: `Payload ${massKg} kg` }).ok;
  }
  setVisual(patch: Partial<Pick<SimUi, 'showColliders' | 'showContacts'>>): void {
    this.ui.setState(patch);
  }

  /** Display-loop tick: advance in fixed steps by real elapsed time; refresh the UI at ~10 Hz. */
  tick(realDtS: number): void {
    const s = this.session;
    if (this.runtime?.drives()) {
      // The electronics co-simulation owns the clock and takes the physics steps.
      this.runtime.tick(realDtS);
      if (s) {
        if (s.state === 'faulted' && this.ui.getState().phase === 'running')
          this.editor.getState().setContinuous('simulation', false);
        this.refresh(false);
      }
      return;
    }
    if (!s) return;
    try {
      if (s.state === 'running') s.advance(realDtS);
    } catch (e) {
      this.ui.setState({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
      this.editor.getState().setContinuous('simulation', false);
      return;
    }
    if (s.state === 'faulted' && this.ui.getState().phase === 'running')
      this.editor.getState().setContinuous('simulation', false);
    this.refresh(false);
  }

  refresh(force: boolean): void {
    const s = this.session;
    const now = performance.now();
    if (!force && now - this.lastUi < 100) return;
    this.lastUi = now;
    if (!s) return;
    const selected = this.editor.getState().selection[0];
    const bodyId = selected ? s.model.bodyOfNode[selected] : undefined;
    const t = s.telemetry;
    const phase: SimPhase =
      s.state === 'faulted'
        ? 'faulted'
        : s.state === 'running'
          ? 'running'
          : s.state === 'paused'
            ? 'paused'
            : 'ready';
    this.ui.setState({
      phase,
      error: null,
      time: s.time,
      steps: s.steps,
      speed: s.speed,
      stopped: s.stopped,
      fault: s.fault,
      needsReset: s.needsReset,
      issues: s.model.issues,
      assumptions: s.model.assumptions,
      joints: s.jointStates(),
      body: bodyId ? s.bodyState(bodyId) : null,
      events: t.events.slice(-60),
      eventCount: t.events.length + t.eventsDropped,
      stats: { ...s.stats },
      telemetry: {
        samples: t.size,
        dropped: t.dropped,
        bytes: t.bytes,
        channels: t.channels.map((c) => ({ key: c.key, label: c.label, unit: c.unit, kind: c.kind })),
      },
      runId: s.meta.runId,
      engineVersion: s.rapierVersion,
      movingUnits: this.movingUnits(s),
    });
  }

  private moving: string[] = [];
  /** Stable array identity while unchanged (it keys the renderer's instancing plan). */
  private movingUnits(s: PhysicsSession): string[] {
    const next = s.model.bodies.filter((b) => b.mode !== 'fixed').flatMap((b) => b.unitIds);
    if (next.length !== this.moving.length || next.some((x, i) => x !== this.moving[i])) this.moving = next;
    return this.moving;
  }

  exportCsv(): { fileName: string; text: string } | null {
    const s = this.session;
    if (!s) return null;
    return { fileName: `${s.meta.runId}.telemetry.csv`, text: s.telemetry.toCSV(s.meta) };
  }
  exportJson(): { fileName: string; text: string } | null {
    const s = this.session;
    if (!s) return null;
    return { fileName: `${s.meta.runId}.telemetry.json`, text: JSON.stringify(s.telemetry.toJSON(s.meta)) };
  }
}

const controllers = new WeakMap<StoreApi<EditorState>, SimulationController>();
/** One controller per editor store (the app has one; tests may create more). */
export function simulationFor(editor: StoreApi<EditorState>): SimulationController {
  let c = controllers.get(editor);
  if (!c) {
    c = new SimulationController(editor);
    controllers.set(editor, c);
  }
  return c;
}
