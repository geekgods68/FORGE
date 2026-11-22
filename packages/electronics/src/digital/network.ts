import { devicePins, type ElectricalDefinition } from '@forge/engineering-core';
import type { AnalogOverrides } from '../analog/build';
import type { OperatingPoint, OpResult } from '../analog/circuit';
import type { Netlist } from '../netlist';
import { threshold, type Logic, type Thresholds } from './logic';
import type { Ns, Scheduler } from './scheduler';

/**
 * Signal network: the runtime meeting point of digital and analog behaviour.
 *
 *  - DIGITAL nets (only digital device pins on them) are resolved by driver strength: strong
 *    drivers (push-pull outputs) and weak pulls (e.g. a microcontroller pull-up). Conflicting
 *    strong drivers resolve to 'X' and raise a contention event; no driver → 'Z'.
 *  - MIXED nets (a digital pin and any analog element: resistor, LED, supply…) are solved
 *    by the MNA solver: digital outputs become Thevenin sources (level × V_OH behind R_out),
 *    pulls become resistors. Each reader then applies ITS OWN input thresholds to the solved
 *    voltage — the documented analog→digital boundary.
 *
 * Readers on digital nets also threshold the driver's output voltage, so a 3.3 V output into
 * a 5 V input with V_IH = 3 V reads 'X', not '1'. A wire existing never implies a level.
 */
export type NetKind = 'digital' | 'mixed' | 'analog';

export interface DriveSpec {
  /** Output-high voltage (V) relative to refNet. */
  vHigh: number;
  /** Output resistance (Ω) used on mixed nets. */
  rOut: number;
  refNet: number;
}

export interface NetEvent {
  t: Ns;
  kind: 'contention' | 'floating-read' | 'analog-failure' | 'oscillation' | 'invalid-input' | 'info';
  message: string;
  parts: string[];
  nets: string[];
}

interface Driver extends DriveSpec {
  level: Logic;
}
interface Pull {
  toNet: number;
  r: number;
  level: '1' | '0';
}
interface Watcher {
  partId: string;
  pin: string;
  net: number;
  th: Thresholds;
  refNet: number;
  last: Logic;
  cb: (level: Logic, t: Ns) => void;
}

/** Bounded transition log (logic analyser / oscilloscope source). */
export class TransitionLog {
  readonly t: Float64Array;
  readonly net: Int32Array;
  readonly level: Uint8Array;
  readonly v: Float64Array;
  head = 0;
  size = 0;
  dropped = 0;
  constructor(readonly capacity: number) {
    this.t = new Float64Array(capacity);
    this.net = new Int32Array(capacity);
    this.level = new Uint8Array(capacity);
    this.v = new Float64Array(capacity);
  }
  push(t: Ns, net: number, level: Logic, v: number | null) {
    const i = (this.head + this.size) % this.capacity;
    if (this.size === this.capacity) {
      this.head = (this.head + 1) % this.capacity;
      this.dropped++;
    } else this.size++;
    this.t[i] = t;
    this.net[i] = net;
    this.level[i] = LEVEL_CODE[level];
    this.v[i] = v ?? NaN;
  }
  /** Transitions of one net, oldest first: [t (ns), level, voltage]. */
  of(net: number): { t: number[]; level: Logic[]; v: number[] } {
    const out = { t: [] as number[], level: [] as Logic[], v: [] as number[] };
    for (let k = 0; k < this.size; k++) {
      const i = (this.head + k) % this.capacity;
      if (this.net[i] !== net) continue;
      out.t.push(this.t[i]!);
      out.level.push(LEVELS[this.level[i]!]!);
      out.v.push(this.v[i]!);
    }
    return out;
  }
  get bytes() {
    return this.capacity * (8 + 4 + 1 + 8);
  }
  clear() {
    this.head = 0;
    this.size = 0;
    this.dropped = 0;
  }
}
const LEVELS: Logic[] = ['0', '1', 'Z', 'X'];
const LEVEL_CODE: Record<Logic, number> = { '0': 0, '1': 1, Z: 2, X: 3 };

const DIGITAL_TYPES = new Set(['logic-gate', 'dff', 'counter', 'clock']);
/** Display-only levels for mixed nets in the transition log (5 V CMOS thresholds). */
export const DISPLAY_THRESHOLDS: Thresholds = { vil: 1.5, vih: 3.0 };

export class SignalNetwork {
  readonly kind: NetKind[];
  readonly log: TransitionLog;
  events: NetEvent[] = [];
  eventsDropped = 0;
  /** Latest analog operating point (mixed + power nets); null before the first solve or on failure. */
  op: OperatingPoint | null = null;
  analogSolves = 0;
  private drivers: Map<string, Driver>[];
  private pulls: Map<string, Pull>[];
  private levels: Logic[];
  private watchers: Watcher[][];
  private overrides: Required<
    Pick<AnalogOverrides, 'potPosition' | 'pressed' | 'sensorOutputV' | 'regulated'>
  > = {
    potPosition: new Map(),
    pressed: new Map(),
    sensorOutputV: new Map(),
    regulated: new Set(),
  };
  private lastMixedV: (number | null)[];
  private inMixed = false;
  private resolveAgain = false;

  constructor(
    readonly def: ElectricalDefinition,
    readonly netlist: Netlist,
    readonly sched: Scheduler,
    private readonly analog: (o: AnalogOverrides) => OpResult,
    opts: { maxTransitions?: number; maxEvents?: number } = {},
  ) {
    const n = netlist.nets.length;
    this.drivers = Array.from({ length: n }, () => new Map());
    this.pulls = Array.from({ length: n }, () => new Map());
    this.levels = new Array<Logic>(n).fill('Z');
    this.watchers = Array.from({ length: n }, () => []);
    this.lastMixedV = new Array<number | null>(n).fill(null);
    this.log = new TransitionLog(opts.maxTransitions ?? 50_000);
    this.maxEvents = opts.maxEvents ?? 2000;
    const digitalPin = new Set<string>();
    for (const p of def.parts)
      for (const pin of devicePins(p.device))
        if (
          pin.domain === 'digital' ||
          (pin.domain === 'mixed' && p.device.type === 'mcu') ||
          DIGITAL_TYPES.has(p.device.type)
        )
          digitalPin.add(`${p.id}\u0000${pin.id}`);
    this.kind = netlist.nets.map((net) => {
      const dig = net.pins.filter((x) => digitalPin.has(`${x.partId}\u0000${x.pin}`)).length;
      if (dig === 0) return 'analog';
      return dig === net.pins.length && !net.isGround ? 'digital' : 'mixed';
    });
  }
  private readonly maxEvents: number;

  netName = (n: number) => this.netlist.nets[n]?.name ?? `net${n}`;

  event(e: Omit<NetEvent, 't'>) {
    if (this.events.length >= this.maxEvents) {
      this.events.shift();
      this.eventsDropped++;
    }
    this.events.push({ ...e, t: this.sched.now });
  }

  pinNet(partId: string, pin: string): number {
    const n = this.netlist.pinNet(partId, pin);
    if (n === undefined) throw new Error(`Unknown pin ${partId}.${pin}`);
    return n;
  }

  /** Drive a pin (level 'Z' releases it). */
  drive(partId: string, pin: string, level: Logic, spec: DriveSpec): void {
    const net = this.pinNet(partId, pin);
    const key = `${partId}\u0000${pin}`;
    const m = this.drivers[net]!;
    const prev = m.get(key);
    if (level === 'Z') {
      if (!prev) return;
      m.delete(key);
    } else {
      if (prev && prev.level === level && prev.vHigh === spec.vHigh && prev.rOut === spec.rOut) return;
      m.set(key, { ...spec, level });
    }
    this.update(net);
  }

  /** Weak pull on a pin (e.g. INPUT_PULLUP); null removes it. */
  pull(partId: string, pin: string, p: Pull | null): void {
    const net = this.pinNet(partId, pin);
    const key = `${partId}\u0000${pin}`;
    if (p) this.pulls[net]!.set(key, p);
    else if (!this.pulls[net]!.delete(key)) return;
    this.update(net);
  }

  /** Watch a pin's level as seen through its own thresholds. Returns an unsubscribe function. */
  watch(
    partId: string,
    pin: string,
    th: Thresholds,
    refNet: number,
    cb: (level: Logic, t: Ns) => void,
  ): () => void {
    const net = this.pinNet(partId, pin);
    const w: Watcher = { partId, pin, net, th, refNet, last: 'Z', cb };
    w.last = this.readerLevel(w);
    this.watchers[net]!.push(w);
    return () => {
      const list = this.watchers[net]!;
      const i = list.indexOf(w);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Current level of a pin through the given thresholds (no subscription). */
  read(partId: string, pin: string, th: Thresholds, refNet: number): Logic {
    const net = this.pinNet(partId, pin);
    return this.readerLevel({ partId, pin, net, th, refNet, last: 'Z', cb: () => undefined });
  }

  netLevel(net: number): Logic {
    return this.levels[net]!;
  }

  /** Net voltage relative to the circuit reference (V); null = undefined (floating/unknown). */
  voltage(net: number): number | null {
    if (net === this.netlist.ground) return 0;
    if (this.kind[net] === 'digital') {
      const l = this.levels[net]!;
      if (l === '0') return 0;
      if (l !== '1') return null;
      const ds = [...this.drivers[net]!.values()].filter((d) => d.level === '1');
      if (ds.length) return Math.min(...ds.map((d) => d.vHigh + this.refV(d.refNet)));
      const ps = [...this.pulls[net]!.values()];
      return ps.length ? Math.min(...ps.map((p) => this.voltage(p.toNet) ?? 0)) : null;
    }
    return this.op?.v[net] ?? null;
  }
  private refV(net: number) {
    return net === this.netlist.ground ? 0 : (this.op?.v[net] ?? 0);
  }

  /** Runtime analog parameters (potentiometer wiper, switch state, sensor output). */
  setPot(partId: string, position: number) {
    if (this.overrides.potPosition.get(partId) === position) return;
    this.overrides.potPosition.set(partId, position);
    this.solveMixed();
  }
  setPressed(partId: string, pressed: boolean) {
    if (this.overrides.pressed.get(partId) === pressed) return;
    this.overrides.pressed.set(partId, pressed);
    this.solveMixed();
  }
  setSensorOutput(partId: string, v: number | null) {
    const prev = this.overrides.sensorOutputV.get(partId);
    if (prev === v || (prev === undefined && v === null)) return;
    if (v === null) this.overrides.sensorOutputV.delete(partId);
    else this.overrides.sensorOutputV.set(partId, v);
    this.solveMixed();
  }
  setRegulated(partId: string, on: boolean) {
    if (this.overrides.regulated.has(partId) === on) return;
    if (on) this.overrides.regulated.add(partId);
    else this.overrides.regulated.delete(partId);
    this.solveMixed();
  }

  /** Initial analog solve (power rails, static levels). */
  start(): void {
    this.solveMixed();
    for (let n = 0; n < this.levels.length; n++) if (this.kind[n] === 'digital') this.update(n, true);
  }

  // -- resolution -------------------------------------------------------------------------
  private update(net: number, force = false): void {
    if (this.kind[net] !== 'digital') {
      this.solveMixed();
      return;
    }
    const prev = this.levels[net]!;
    const next = this.resolveDigital(net);
    this.levels[net] = next;
    if (next !== prev || force) {
      this.log.push(this.sched.now, net, next, this.voltage(net));
      this.notify(net);
    }
  }

  private resolveDigital(net: number): Logic {
    const strong = [...this.drivers[net]!.entries()];
    if (strong.length) {
      const vals = new Set(strong.map(([, d]) => d.level));
      if (vals.size === 1) return strong[0]![1].level;
      if (vals.has('0') && vals.has('1'))
        this.event({
          kind: 'contention',
          message: `Output contention on net ${this.netName(net)}: ${strong.map(([k, d]) => `${this.label(k)} drives ${d.level}`).join(', ')}.`,
          parts: [...new Set(strong.map(([k]) => k.split('\u0000')[0]!))],
          nets: [this.netName(net)],
        });
      return 'X';
    }
    const pulls = [...this.pulls[net]!.values()];
    if (pulls.length) {
      const vals = new Set(pulls.map((p) => p.level));
      return vals.size === 1 ? pulls[0]!.level : 'X';
    }
    return 'Z';
  }

  private label(key: string) {
    const [partId, pin] = key.split('\u0000');
    return `${this.netlist.partById.get(partId!)?.label ?? partId}.${pin}`;
  }

  private readerLevel(w: Watcher): Logic {
    if (this.kind[w.net] === 'digital') {
      const l = this.levels[w.net]!;
      if (l !== '1' && l !== '0') return l;
      const v = this.voltage(w.net);
      return v === null ? l : threshold(v - this.refV(w.refNet), w.th);
    }
    const v = this.op?.v[w.net];
    if (v === undefined || v === null) return 'Z';
    return threshold(v - this.refV(w.refNet), w.th);
  }

  private notify(net: number) {
    for (const w of [...this.watchers[net]!]) {
      const l = this.readerLevel(w);
      if (l !== w.last) {
        w.last = l;
        w.cb(l, this.sched.now);
      }
    }
  }

  /** Re-solve the analog network with the current digital drivers and pulls (quasi-static). */
  solveMixed(): void {
    // A watcher that changes a driver while we are notifying asks for another pass (deferred,
    // never dropped); a bounded number of passes guards against zero-delay oscillation.
    if (this.inMixed) {
      this.resolveAgain = true;
      return;
    }
    this.inMixed = true;
    let passes = 0;
    try {
      do {
        this.resolveAgain = false;
        this.solveOnce();
        if (++passes > 50) {
          this.event({
            kind: 'oscillation',
            message: 'Mixed-signal network did not settle (zero-delay feedback); the last solution is kept.',
            parts: [],
            nets: [],
          });
          break;
        }
      } while (this.resolveAgain);
    } finally {
      this.inMixed = false;
    }
  }

  private solveOnce(): void {
    {
      const drivers: NonNullable<AnalogOverrides['drivers']> = [];
      const resistors: NonNullable<AnalogOverrides['resistors']> = [];
      this.drivers.forEach((m, net) => {
        if (this.kind[net] === 'digital') return;
        for (const [key, d] of m) {
          if (d.level !== '0' && d.level !== '1') continue;
          const [partId, pin] = key.split('\u0000');
          const lbl = this.netlist.partById.get(partId!)?.label ?? partId;
          drivers.push({
            id: `${lbl}:${pin}:drv`,
            part: partId!,
            net,
            refNet: d.refNet,
            v: d.level === '1' ? d.vHigh : 0,
            r: d.rOut,
          });
        }
      });
      this.pulls.forEach((m, net) => {
        if (this.kind[net] === 'digital') return;
        for (const [key, p] of m) {
          const [partId, pin] = key.split('\u0000');
          const lbl = this.netlist.partById.get(partId!)?.label ?? partId;
          resistors.push({ id: `${lbl}:${pin}:pull`, part: partId!, a: net, b: p.toNet, r: p.r });
        }
      });
      const r = this.analog({ ...this.overrides, drivers, resistors });
      this.analogSolves++;
      if (!r.ok) {
        if (this.op !== null || this.analogSolves === 1)
          this.event({
            kind: 'analog-failure',
            message: `Analog solve failed: ${r.diagnostics.map((d) => d.message).join(' ')} Mixed-signal nets are undefined until this is fixed.`,
            parts: r.diagnostics.flatMap((d) => d.elements),
            nets: r.diagnostics.flatMap((d) => d.nets),
          });
        this.op = null;
      } else this.op = r;
      for (let net = 0; net < this.kind.length; net++) {
        if (this.kind[net] === 'digital') continue;
        const v = this.op?.v[net] ?? null;
        const prev = this.lastMixedV[net];
        if (v !== prev && (v === null || prev === null || Math.abs(v - prev!) > 1e-9)) {
          this.lastMixedV[net] = v;
          if (this.kind[net] === 'mixed')
            this.log.push(this.sched.now, net, threshold(v, DISPLAY_THRESHOLDS), v);
        }
      }
      // Digital nets whose drivers are referenced to a rail may change voltage too.
      for (let net = 0; net < this.kind.length; net++) this.notify(net);
    }
  }
}
