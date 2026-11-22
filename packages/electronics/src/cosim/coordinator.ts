import type { ElectricalDefinition, SceneGraph } from '@forge/engineering-core';
import { buildElements } from '../analog/build';
import { AnalogCircuit } from '../analog/circuit';
import { wallMs } from '../clock';
import { attachLogicDevices } from '../digital/devices';
import type { Logic } from '../digital/logic';
import { SignalNetwork } from '../digital/network';
import { Scheduler, type Ns } from '../digital/scheduler';
import { UnoRuntime } from '../firmware/arduino';
import { compileNetlist, hashOf, type Netlist } from '../netlist';
import { createDeviceModels, type DeviceEvent, type DeviceModel } from './devices';
import type { PhysicsPort } from './physics';
import { CosimRecorder, type CosimMeta } from './telemetry';

/**
 * Electromechanical co-simulation coordinator. ONE simulation clock (integer ns) drives:
 *   digital events and firmware (discrete events at their exact times),
 *   mixed-signal nets (quasi-static MNA re-solve at each event that changes them),
 *   physics (fixed steps of h; step k ends at round(k·h·1e9) ns),
 *   joint-linked sensors (sampled after every physics step).
 * Ordering is deterministic: all events strictly before a physics boundary run first, then the
 * physics step, then events AT the boundary. Firmware sees sensor geometry as of the latest
 * physics step (≤ h old); motor commands take effect at the next physics step (zero-order hold).
 * Browser frame timing never determines signal timing: real time only decides how far to advance.
 */
export const COSIM_VERSION = 'forge-cosim 1';

export interface CosimOptions {
  physics: PhysicsPort | null;
  scene: SceneGraph | null;
  runId?: string;
  now?: () => Date;
  project?: { id: string; name: string; revision: number };
  physicsEngine?: string | null;
}

export type CosimEvent = { t: Ns; source: string; kind: string; message: string; line?: number | null };

export class CoSimulation {
  readonly sched = new Scheduler();
  readonly netlist: Netlist;
  readonly net: SignalNetwork;
  readonly mcus: UnoRuntime[] = [];
  readonly devices: DeviceModel[] = [];
  readonly recorder: CosimRecorder;
  readonly meta: CosimMeta;
  /** Physics steps taken. */
  k = 0;
  fault: string | null = null;
  private deviceEvents: DeviceEvent[] = [];
  private cleanups: (() => void)[] = [];
  private nextSample: Ns = 0;
  private readonly sampleNs: Ns;
  private seed: number;
  readonly stats = { lastAdvanceMs: 0, maxAdvanceMs: 0, analogSolves: 0, events: 0, lagged: 0 };

  constructor(
    readonly def: ElectricalDefinition,
    private readonly opts: CosimOptions,
  ) {
    this.netlist = compileNetlist(def);
    this.net = new SignalNetwork(
      def,
      this.netlist,
      this.sched,
      (o) => new AnalogCircuit(this.netlist, buildElements(def, this.netlist, o), def.settings).dc(),
      { maxTransitions: def.settings.cosim.recording.maxTransitions },
    );
    this.seed = def.settings.cosim.seed || 1;
    this.sampleNs = Math.max(1, Math.round(1e9 / def.settings.cosim.recording.sampleRateHz));
    this.recorder = new CosimRecorder(def.settings.cosim.recording.maxSamples);
    const now = (opts.now ?? (() => new Date()))();
    this.meta = {
      runId: opts.runId ?? `cosim-${now.toISOString().replace(/[:.]/g, '-')}`,
      startedAt: now.toISOString(),
      engine: COSIM_VERSION,
      physicsEngine: opts.physicsEngine ?? null,
      project: opts.project ?? null,
      circuit: def.name,
      circuitHash: hashOf({ parts: def.parts, wires: def.wires, netLabels: def.netLabels }),
      firmware: def.firmware.map((f) => ({
        id: f.id,
        name: f.name,
        revision: f.revision,
        hash: hashOf(f.source),
      })),
      settings: def.settings,
      physicsStepS: opts.physics?.stepS ?? null,
      assumptions: [
        'Level 2 microcontroller runtime: the Arduino API is modelled; the ATmega328P is not emulated (timing is approximate).',
        'Mixed-signal nets are solved quasi-statically (DC operating point at each event); capacitor/inductor dynamics are not part of the co-simulation.',
        'Sensors observe the physics state of the latest completed step; motor commands apply from the next step (zero-order hold).',
        'HC-SR04: generic model; nearest ray hit within the beam cone; speed of sound 331.3 + 0.606·T m/s; no multipath, surface angle or material effects.',
        'Servo: pulse width → joint target; the Phase 5 actuator (speed/effort limits, PID) produces the motion; supply current is not modelled.',
      ],
    };
  }

  private rand = () => {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  };

  get now(): Ns {
    return this.sched.now;
  }

  boundary(k: number): Ns {
    return Math.round(k * (this.opts.physics?.stepS ?? 0) * 1e9);
  }

  start(): void {
    this.cleanups.push(...attachLogicDevices(this.def, this.net, this.sched));
    this.net.start();
    const ctx = {
      net: this.net,
      sched: this.sched,
      physics: this.opts.physics,
      scene: this.opts.scene,
      ambientC: this.def.settings.cosim.ambientC,
      rand: this.rand,
      event: (e: Omit<DeviceEvent, 't'>) => {
        if (this.deviceEvents.length >= 1000) this.deviceEvents.shift();
        this.deviceEvents.push({ ...e, t: this.sched.now });
      },
    };
    this.devices.push(...createDeviceModels(this.def.parts, ctx));
    for (const d of this.devices) d.start();
    for (const p of this.def.parts) {
      if (p.device.type !== 'mcu') continue;
      const fw =
        this.def.firmware.find((f) => f.id === (p.device as { firmwareId: string | null }).firmwareId) ??
        null;
      const m = new UnoRuntime(p, fw, this.net, this.sched, {
        opCostNs: this.def.settings.cosim.opCostNs,
        seed: this.def.settings.cosim.seed,
      });
      this.mcus.push(m);
    }
    for (const m of this.mcus) m.start();
    if (
      !this.opts.physics &&
      this.devices.some(
        (d) => d.part.device.type === 'hc-sr04' || (d.part.device.type === 'servo' && d.part.device.mateId),
      )
    )
      ctx.event({
        part: '',
        kind: 'warning',
        message: 'No physics run: sensors that observe the world report nothing and servos move no joint.',
      });
    this.recorder.setChannels(this.channels());
    this.sample();
  }

  private channels() {
    return [
      ...this.devices.flatMap((d) => d.channels()),
      ...this.mcus.map((m) => ({
        key: `${m.part.label}.vcc`,
        label: `${m.part.label} 5 V rail`,
        unit: 'V',
        kind: 'measured' as const,
      })),
    ];
  }

  private sample() {
    const row: Record<string, number> = {};
    for (const d of this.devices) Object.assign(row, d.sample());
    for (const m of this.mcus) row[`${m.part.label}.vcc`] = m.vcc;
    this.recorder.push(this.sched.now, row);
    this.nextSample = this.sched.now + this.sampleNs;
  }

  /** Advance simulated time to tEnd (ns). Stops early when the wall-clock budget is used up. */
  advanceTo(tEnd: Ns, budgetMs = Infinity): Ns {
    const w0 = wallMs();
    const physics = this.opts.physics;
    try {
      while (this.sched.now < tEnd && !this.fault) {
        if (!physics) {
          const t = Math.min(tEnd, this.nextSample);
          const r = this.sched.runUntil(t);
          if (r.truncated) return this.halt('Too many events at one instant (zero-delay oscillation).');
          if (this.sched.now >= this.nextSample) this.sample();
        } else {
          const b = this.boundary(this.k + 1);
          if (b > tEnd) {
            if (this.sched.runUntil(tEnd).truncated)
              return this.halt('Too many events at one instant (zero-delay oscillation).');
            break;
          }
          if (this.sched.runUntil(b, false).truncated)
            return this.halt('Too many events at one instant (zero-delay oscillation).');
          if (!physics.step()) return this.halt('The physics run faulted; reset to continue.');
          this.k++;
          this.sched.now = b;
          for (const d of this.devices) d.afterPhysics?.(this.boundary(this.k - 1), b);
          if (b >= this.nextSample) this.sample();
        }
        if (wallMs() - w0 > budgetMs) {
          this.stats.lagged++;
          break;
        }
      }
    } finally {
      const ms = wallMs() - w0;
      this.stats.lastAdvanceMs = ms;
      this.stats.maxAdvanceMs = Math.max(this.stats.maxAdvanceMs, ms);
      this.stats.analogSolves = this.net.analogSolves;
      this.stats.events = this.sched.executed;
    }
    return this.sched.now;
  }

  private halt(reason: string): Ns {
    this.fault = reason;
    return this.sched.now;
  }

  /** Logic level of every net with a digital pin (for live schematic colouring). */
  netLevels(): Record<string, Logic> {
    const out: Record<string, Logic> = {};
    this.netlist.nets.forEach((n) => {
      if (this.net.kind[n.index] === 'digital') out[n.name] = this.net.netLevel(n.index);
      else if (this.net.kind[n.index] === 'mixed') {
        const v = this.net.voltage(n.index);
        out[n.name] = v === null ? 'Z' : v <= 1.5 ? '0' : v >= 3 ? '1' : 'X';
      }
    });
    return out;
  }

  events(max = 200): CosimEvent[] {
    const label = (id: string) => this.netlist.partById.get(id)?.label ?? 'circuit';
    const all: CosimEvent[] = [
      ...this.net.events.map((e) => ({ t: e.t, source: 'signals', kind: e.kind, message: e.message })),
      ...this.mcus.flatMap((m) =>
        m.events.map((e) => ({
          t: e.t,
          source: m.part.label,
          kind: e.kind,
          message: e.message,
          line: e.line,
        })),
      ),
      ...this.deviceEvents.map((e) => ({
        t: e.t,
        source: e.part ? label(e.part) : 'co-simulation',
        kind: e.kind,
        message: e.message,
      })),
    ];
    return all.sort((a, b) => a.t - b.t).slice(-max);
  }

  /** Runtime experiment inputs (not persisted). */
  setPot(partId: string, position: number) {
    const d = this.devices.find((x) => x.part.id === partId);
    if (d && 'set' in d && d.part.device.type === 'potentiometer')
      (d as unknown as { set(p: number): void }).set(position);
  }
  setPressed(partId: string, pressed: boolean) {
    const d = this.devices.find((x) => x.part.id === partId);
    if (d && d.part.device.type === 'limit-switch') (d as unknown as { set(p: boolean): void }).set(pressed);
    else if (this.def.parts.find((p) => p.id === partId)?.device.type === 'switch')
      this.net.setPressed(partId, pressed);
  }

  dispose(): void {
    for (const m of this.mcus) m.stop();
    for (const d of this.devices) d.stop();
    this.cleanups.forEach((c) => c());
    this.sched.clear();
  }
}
