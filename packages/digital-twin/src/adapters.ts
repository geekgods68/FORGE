import { mulberry32, normal } from '@forge/research';
import { encode, type Message } from './protocol';

/**
 * Telemetry adapters (transports). The interface is RECEIVE-ONLY by construction: there is
 * no write/send method, and `canActuate` is the literal type `false`. Implementations:
 *  - Web Serial (Chromium desktop browsers; apps/desktop/src/features/twin/webSerial.ts);
 *  - local bridge (tools/serial-bridge: serial → Server-Sent Events on 127.0.0.1);
 *  - synthetic (this file, deterministic; recordings are labelled synthetic);
 *  - replay of a recording.
 * Future transports (network devices, other MCUs, ROS bridges) implement the same interface.
 */
export type AdapterKind = 'web-serial' | 'bridge' | 'synthetic' | 'replay';
export interface AdapterHandlers {
  line(text: string, hostMs: number): void;
  state(open: boolean, hostMs: number, detail?: string): void;
}
export interface TelemetryAdapter {
  readonly kind: AdapterKind;
  /** True when the data are generated, never measured. */
  readonly synthetic: boolean;
  readonly canActuate: false;
  open(h: AdapterHandlers): Promise<void>;
  close(): Promise<void>;
}

/**
 * Physical actuation boundary. Phase 8 is observation only: FORGE never sends commands to
 * hardware (no command message exists in the protocol, no adapter can write, and loading a
 * project, simulating, replaying or running an experiment cannot move anything). Any
 * request — from the UI, an experiment or a future VCI integration — is refused here.
 * A software refusal is not a safety system: physical setups still need a hardware
 * emergency stop and independent protection.
 */
export const ACTUATION_POLICY = {
  implemented: false,
  reason:
    'Physical actuation is not implemented in FORGE Phase 8 (observation only). No transport can send commands to a device.',
} as const;
export function requestActuation(_request: { requester: string; target: string; value: number }): {
  granted: false;
  reason: string;
} {
  return { granted: false, reason: ACTUATION_POLICY.reason };
}

// -- synthetic adapter ------------------------------------------------------------------------
export interface SyntheticScenario {
  seed: number;
  durationS: number;
  rateHz: number;
  /** Device clock drift relative to the host (ppm) and initial offset (ms). */
  driftPpm: number;
  clockOffsetMs: number;
  /** Transport latency: mean + uniform jitter (ms). */
  latencyMs: number;
  jitterMs: number;
  /** Distance: base + amplitude · sin(2π f t) (mm) with Gaussian noise (mm). */
  distance: { baseMm: number; amplitudeMm: number; frequencyHz: number; noiseMm: number };
  faults: {
    dropRate: number;
    duplicateRate: number;
    reorderRate: number;
    corruptRate: number;
    /** Probability that a reading has no echo (missing value + E message). */
    noEchoRate: number;
    /** Host-time intervals (s) with no transmission and the transport closed. */
    disconnects: [number, number][];
    /** Host-time intervals (s) where the device stops sending but the port stays open. */
    stalls: [number, number][];
    /** Report the distance in cm while declaring mm (a wrong unit; for mapping tests). */
    wrongUnit: boolean;
  };
}
export const DEFAULT_SCENARIO: SyntheticScenario = {
  seed: 1,
  durationS: 10,
  rateHz: 20,
  driftPpm: 0,
  clockOffsetMs: 0,
  latencyMs: 4,
  jitterMs: 2,
  distance: { baseMm: 250, amplitudeMm: 150, frequencyHz: 0.2, noiseMm: 2 },
  faults: {
    dropRate: 0,
    duplicateRate: 0,
    reorderRate: 0,
    corruptRate: 0,
    noEchoRate: 0,
    disconnects: [],
    stalls: [],
    wrongUnit: false,
  },
};

export interface ScheduledLine {
  hostMs: number;
  line: string;
}
export interface SyntheticStream {
  lines: ScheduledLine[];
  /** Transport open/close transitions (host ms). */
  transport: { hostMs: number; open: boolean }[];
  /** Ground truth used by tests (distance actually "seen", commanded angle). */
  truth: { tS: number; distanceMm: number; angleDeg: number }[];
}

/**
 * Deterministic synthetic telemetry that follows the example firmware's logic (distance →
 * commanded servo angle) with injectable faults. Device id and firmware name state that it
 * is synthetic; recordings made from it are labelled synthetic by the adapter flag.
 */
export function syntheticStream(sc: SyntheticScenario): SyntheticStream {
  const rand = mulberry32(sc.seed);
  const lines: ScheduledLine[] = [];
  const transport: SyntheticStream['transport'] = [{ hostMs: 0, open: true }];
  const truth: SyntheticStream['truth'] = [];
  const inside = (t: number, iv: [number, number][]) => iv.some(([a, b]) => t >= a && t < b);
  for (const [a, b] of sc.faults.disconnects)
    transport.push({ hostMs: a * 1000, open: false }, { hostMs: b * 1000, open: true });
  transport.sort((x, y) => x.hostMs - y.hostMs);
  let seq = 0;
  // Device millis(): drifting clock, wrapping at 2³² like the UNO's.
  const devMs = (hostS: number) =>
    Math.round((hostS * 1000 - sc.clockOffsetMs) / (1 + sc.driftPpm * 1e-6)) >>> 0;
  const send = (hostS: number, m: Message, opts: { corrupt?: boolean } = {}) => {
    let line = encode(m);
    if (opts.corrupt)
      line = line.replace(
        /\*(..)$/,
        (_, cc: string) =>
          `*${((parseInt(cc, 16) ^ 0x5a) & 0xff).toString(16).toUpperCase().padStart(2, '0')}`,
      );
    lines.push({ hostMs: hostS * 1000 + sc.latencyMs + (rand() * 2 - 1) * sc.jitterMs, line });
  };
  const announce = (t: number) => {
    send(t, {
      type: 'hello',
      version: 1,
      deviceId: 'SYNTHETIC-ARM-01',
      firmware: 'forge-synthetic',
      firmwareVersion: '1.0.0',
    });
    send(t, {
      type: 'channel',
      id: 'd',
      kind: 'measured',
      unit: 'mm',
      label: 'HC-SR04 distance (synthetic)',
    });
    send(t, { type: 'channel', id: 'a', kind: 'commanded', unit: 'deg', label: 'servo command (synthetic)' });
  };
  let angle = 90;
  let nextAnnounce = 0;
  const dt = 1 / sc.rateHz;
  for (let k = 0; k * dt < sc.durationS; k++) {
    const t = k * dt;
    if (inside(t, sc.faults.disconnects) || inside(t, sc.faults.stalls)) continue;
    if (t >= nextAnnounce) {
      announce(t);
      nextAnnounce = t + 5;
    }
    const d = sc.distance;
    const trueMm = d.baseMm + d.amplitudeMm * Math.sin(2 * Math.PI * d.frequencyHz * t);
    const noEcho = rand() < sc.faults.noEchoRate;
    const mm = noEcho ? null : Math.max(0, Math.round(trueMm + d.noiseMm * normal(rand)));
    if (mm !== null) angle = Math.round(((Math.min(500, Math.max(50, mm)) - 50) * 180) / 450);
    truth.push({ tS: t, distanceMm: trueMm, angleDeg: angle });
    const reported = mm === null ? null : sc.faults.wrongUnit ? mm / 10 : mm;
    const m: Message = { type: 'data', seq: seq & 0xffff, ms: devMs(t), values: { d: reported, a: angle } };
    seq++;
    if (rand() < sc.faults.dropRate) continue;
    send(t, m, { corrupt: rand() < sc.faults.corruptRate });
    if (rand() < sc.faults.duplicateRate) send(t + 0.001, m);
    if (noEcho) {
      send(t, { type: 'error', seq: seq & 0xffff, ms: devMs(t), code: 'no-echo', detail: '' });
      seq++;
    }
  }
  // Reordering: swap a fraction of adjacent arrival times.
  lines.sort((a, b) => a.hostMs - b.hostMs);
  for (let i = 1; i < lines.length; i++)
    if (rand() < sc.faults.reorderRate) {
      const h = lines[i - 1]!.hostMs;
      lines[i - 1]!.hostMs = lines[i]!.hostMs;
      lines[i]!.hostMs = h;
    }
  lines.sort((a, b) => a.hostMs - b.hostMs);
  return { lines, transport, truth };
}

/** Adapter that plays a synthetic stream in real time through a scheduler callback. */
export class SyntheticAdapter implements TelemetryAdapter {
  readonly kind = 'synthetic' as const;
  readonly synthetic = true;
  readonly canActuate = false as const;
  private stopped = false;
  constructor(
    readonly scenario: SyntheticScenario,
    private readonly clock: { now(): number; after(ms: number, f: () => void): void },
  ) {}
  async open(h: AdapterHandlers) {
    const s = syntheticStream(this.scenario);
    const t0 = this.clock.now();
    const events = [
      ...s.lines.map((l) => ({ at: l.hostMs, f: () => h.line(l.line, t0 + l.hostMs) })),
      ...s.transport.map((x) => ({
        at: x.hostMs,
        f: () => h.state(x.open, t0 + x.hostMs, x.open ? 'synthetic device' : 'synthetic disconnect'),
      })),
    ].sort((a, b) => a.at - b.at);
    let i = 0;
    const pump = () => {
      if (this.stopped) return;
      const now = this.clock.now() - t0;
      while (i < events.length && events[i]!.at <= now) events[i++]!.f();
      if (i < events.length) this.clock.after(Math.max(1, events[i]!.at - now), pump);
      else h.state(false, this.clock.now(), 'synthetic stream ended');
    };
    pump();
  }
  async close() {
    this.stopped = true;
  }
}
