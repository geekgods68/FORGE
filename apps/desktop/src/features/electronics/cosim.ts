import type { ElectricalDefinition, Project } from '@forge/engineering-core';
import { CoSimulation, physicsPortOf, type CosimEvent, type Logic, type McuState } from '@forge/electronics';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EditorState } from '@/app/store';
import { simulationFor, type SimRuntimeHook } from '@/features/simulation/controller';
import { circuitOf } from './state';

/**
 * Electronics runtime in Simulation mode. It owns a CoSimulation built from the project's
 * circuit and — when the project has a physics setup — the Phase 5 physics session, which it
 * steps on the shared clock. Runtime inputs (serial text, moving a target, a potentiometer)
 * never enter the undo history or the project; leaving Simulation mode discards the run.
 */
export interface McuUi {
  label: string;
  state: McuState;
  firmware: string;
  serial: { t: number; text: string }[];
  serialBytes: number;
  errors: { line: number | null; message: string }[];
}

export interface CosimUi {
  active: boolean;
  state: 'off' | 'ready' | 'running' | 'paused' | 'fault';
  /** Simulated time (s). */
  time: number;
  physics: boolean;
  netLevels: Record<string, Logic> | null;
  mcus: McuUi[];
  devices: { id: string; label: string; type: string; status: string }[];
  events: CosimEvent[];
  fault: string | null;
  stats: {
    lastAdvanceMs: number;
    maxAdvanceMs: number;
    analogSolves: number;
    events: number;
    lagged: number;
    samples: number;
    transitions: number;
    telemetryBytes: number;
  } | null;
  channels: { key: string; label: string; unit: string; kind: string }[];
  /** Incremented on every refresh (instruments re-read the buffers). */
  frame: number;
}

const EMPTY: CosimUi = {
  active: false,
  state: 'off',
  time: 0,
  physics: false,
  netLevels: null,
  mcus: [],
  devices: [],
  events: [],
  fault: null,
  stats: null,
  channels: [],
  frame: 0,
};

export class CosimController implements SimRuntimeHook {
  readonly ui: StoreApi<CosimUi> = createStore<CosimUi>(() => ({ ...EMPTY }));
  cosim: CoSimulation | null = null;
  private def: ElectricalDefinition | null = null;
  private running = false;
  private lastUi = 0;
  private unsub: (() => void) | null = null;
  speed = 1;

  constructor(readonly editor: StoreApi<EditorState>) {
    simulationFor(editor).runtime = this;
  }

  private get project(): Project {
    return this.editor.getState().project;
  }

  drives(): boolean {
    return this.cosim !== null;
  }

  rebuilt(): void {
    this.build();
    if (!this.unsub)
      this.unsub = this.editor.subscribe((s, prev) => {
        if (this.editor.getState().workMode !== 'simulation') return;
        if (s.project !== prev.project && circuitOf(s.project.scene) !== this.def) this.build();
      });
  }

  changed(): void {
    this.refresh(true);
  }

  exited(): void {
    this.unsub?.();
    this.unsub = null;
    this.cosim?.dispose();
    this.cosim = null;
    this.def = null;
    this.running = false;
    this.editor.getState().setContinuous('electronics', false);
    this.ui.setState({ ...EMPTY });
  }

  private build(): void {
    this.cosim?.dispose();
    this.cosim = null;
    const p = this.project;
    const def = circuitOf(p.scene);
    this.def = def;
    if (!def) {
      this.ui.setState({ ...EMPTY });
      return;
    }
    const session = simulationFor(this.editor).session;
    const ok = session && session.ok;
    this.cosim = new CoSimulation(def, {
      physics: ok ? physicsPortOf(session, p.scene) : null,
      scene: p.scene,
      project: { id: p.id, name: p.name, revision: p.revision },
      physicsEngine: ok ? `rapier3d-compat ${session.rapierVersion}` : null,
    });
    try {
      this.cosim.start();
    } catch (e) {
      this.ui.setState({
        ...EMPTY,
        active: true,
        state: 'fault',
        fault: e instanceof Error ? e.message : String(e),
      });
      this.cosim = null;
      return;
    }
    this.running = false;
    this.refresh(true);
  }

  /** Physics present: its run state governs; otherwise the electronics controls do. */
  private get isRunning(): boolean {
    const s = simulationFor(this.editor).session;
    return this.ui.getState().physics && s ? s.state === 'running' : this.running;
  }

  tick(realDtS: number): void {
    const c = this.cosim;
    if (!c) return;
    if (this.isRunning && !c.fault) {
      const speed = this.ui.getState().physics
        ? (simulationFor(this.editor).session?.speed ?? 1)
        : this.speed;
      const target = c.now + Math.round(Math.min(realDtS, 0.25) * speed * 1e9);
      c.advanceTo(target, 12);
    }
    this.refresh(false);
  }

  step(n: number): void {
    const c = this.cosim;
    if (!c) return;
    const h = simulationFor(this.editor).session?.definition.solver.timestepS ?? 1 / 120;
    c.advanceTo(c.now + Math.round(n * h * 1e9));
    this.refresh(true);
  }

  /** Controls used when the project has no physics setup. */
  start(): void {
    this.running = true;
    this.editor.getState().setContinuous('electronics', true);
    this.refresh(true);
  }
  pause(): void {
    this.running = false;
    this.editor.getState().setContinuous('electronics', false);
    this.refresh(true);
  }
  reset(): void {
    this.editor.getState().setContinuous('electronics', false);
    this.build();
  }

  sendSerial(label: string, text: string): boolean {
    const m = this.cosim?.mcus.find((x) => x.part.label === label);
    const ok = m?.sendSerial(text) ?? false;
    this.refresh(true);
    return ok;
  }

  /** Move a fixed body (e.g. a test target) — a runtime experiment input. */
  moveNode(nodeId: string, position: [number, number, number]): { ok: boolean; error?: string } {
    const s = simulationFor(this.editor).session;
    if (!s || !this.cosim) return { ok: false, error: 'No physics run.' };
    const r = physicsPortOf(s, this.project.scene).moveNode(nodeId, position);
    this.refresh(true);
    return r;
  }

  setPot(partId: string, position: number) {
    this.cosim?.setPot(partId, position);
    this.refresh(true);
  }
  setPressed(partId: string, pressed: boolean) {
    this.cosim?.setPressed(partId, pressed);
    this.refresh(true);
  }

  refresh(force: boolean): void {
    const c = this.cosim;
    const now = performance.now();
    if (!force && now - this.lastUi < 100) return;
    this.lastUi = now;
    if (!c) return;
    const running = this.isRunning;
    this.ui.setState({
      active: true,
      state: c.fault ? 'fault' : running ? 'running' : c.now > 0 ? 'paused' : 'ready',
      time: c.now / 1e9,
      physics: c.meta.physicsStepS !== null,
      netLevels: c.netLevels(),
      mcus: c.mcus.map((m) => ({
        label: m.part.label,
        state: m.state,
        firmware: m.firmware ? `${m.firmware.name} rev ${m.firmware.revision}` : '(none)',
        serial: m.serial.slice(-200),
        serialBytes: m.serialBytes,
        errors: m.events.filter((e) => e.kind === 'error').map((e) => ({ line: e.line, message: e.message })),
      })),
      devices: c.devices.map((d) => ({
        id: d.part.id,
        label: d.part.label,
        type: d.part.device.type,
        status: d.status(),
      })),
      events: c.events(80),
      fault: c.fault,
      stats: {
        ...c.stats,
        samples: c.recorder.size,
        transitions: c.net.log.size,
        telemetryBytes: c.recorder.bytes + c.net.log.bytes,
      },
      channels: c.recorder.channels,
      frame: this.ui.getState().frame + 1,
    });
  }

  exportCsv(): { fileName: string; text: string } | null {
    const c = this.cosim;
    if (!c) return null;
    return { fileName: `${c.meta.runId}.electrical.csv`, text: c.recorder.toCSV(c.meta) };
  }
  exportJson(): { fileName: string; text: string } | null {
    const c = this.cosim;
    if (!c) return null;
    const transitions = c.netlist.nets
      .filter((n) => c.net.kind[n.index] !== 'analog')
      .map((n) => ({ net: n.name, ...c.net.log.of(n.index) }));
    const json = {
      ...c.recorder.toJSON(c.meta),
      serial: c.mcus.map((m) => ({ mcu: m.part.label, output: m.serial })),
      transitions,
      events: c.events(1000),
    };
    return { fileName: `${c.meta.runId}.electrical.json`, text: JSON.stringify(json) };
  }
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
