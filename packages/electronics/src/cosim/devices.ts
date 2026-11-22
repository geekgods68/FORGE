import { evaluate, getDefinition, resolveParameters } from '@forge/components';
import { transformPoint, type DeviceOf, type ElectricalPart, type SceneGraph } from '@forge/engineering-core';
import type { Logic, Thresholds } from '../digital/logic';
import type { SignalNetwork } from '../digital/network';
import type { Ns, Scheduler } from '../digital/scheduler';
import type { PhysicsPort } from './physics';

type V3 = [number, number, number];

/**
 * Sensor and actuator models of the co-simulation. Sensors derive their measurements from the
 * simulated world (ray casts, joint coordinates) — never from tables of expected outputs.
 * Actuators turn decoded control signals into Phase 5 motor COMMANDS; the physics engine,
 * with the actuator's speed and effort limits, decides the actual motion.
 */
export interface DeviceEvent {
  t: Ns;
  part: string;
  kind: 'info' | 'warning' | 'invalid-input';
  message: string;
}

export interface DeviceContext {
  net: SignalNetwork;
  sched: Scheduler;
  physics: PhysicsPort | null;
  scene: SceneGraph | null;
  ambientC: number;
  rand: () => number;
  event: (e: Omit<DeviceEvent, 't'>) => void;
}

export interface Channel {
  key: string;
  label: string;
  unit: string;
  kind: 'measured' | 'commanded' | 'derived' | 'true-geometry';
}

export interface DeviceModel {
  part: ElectricalPart;
  start(): void;
  stop(): void;
  /** Called after each physics step (time = the step's end). */
  afterPhysics?(t0: Ns, t1: Ns): void;
  channels(): Channel[];
  sample(): Record<string, number>;
  /** Short live status for the UI. */
  status(): string;
}

/** TTL-compatible input thresholds (V_IL 0.8 V, V_IH 2.0 V) — an assumption for module inputs. */
export const TTL: Thresholds = { vil: 0.8, vih: 2.0 };
/** Speed of sound in dry air, linear approximation c = 331.3 + 0.606·T (m/s, T in °C). */
export const speedOfSound = (tempC: number) => 331.3 + 0.606 * tempC;

const supplyOf = (net: SignalNetwork, part: ElectricalPart, vcc: string, gnd: string) => {
  const v = net.voltage(net.pinNet(part.id, vcc));
  const g = net.voltage(net.pinNet(part.id, gnd));
  return v === null || g === null ? null : v - g;
};

function localInterfaces(scene: SceneGraph | null, nodeId: string | null, ids: string[]): Map<string, V3> {
  const out = new Map<string, V3>();
  const n = nodeId ? scene?.nodes[nodeId] : undefined;
  if (!n || n.kind !== 'component-instance') return out;
  const def = getDefinition(n.definitionId);
  if (!def) return out;
  const r = resolveParameters(def, n.component?.variantId ?? null, n.component?.parameters ?? {});
  try {
    for (const i of evaluate(def, r.values, n.component?.materialId ?? def.materialId).interfaces)
      if (ids.includes(i.id)) out.set(i.id, [...i.position] as V3);
  } catch {
    /* geometry unavailable: no mount */
  }
  return out;
}

// -- HC-SR04 ------------------------------------------------------------------------------------
export interface RangeMeasurement {
  t: Ns;
  /** Distance to the nearest hit along the modelled beam (m), null = nothing within range. */
  geometricM: number | null;
  /** Distance encoded in the echo (with noise), null = no-echo pulse. */
  reportedM: number | null;
  echoUs: number;
}

export class HcSr04Model implements DeviceModel {
  measurements: RangeMeasurement[] = [];
  private unwatch: (() => void) | null = null;
  private busy = false;
  private rise: Ns | null = null;
  private trig: Logic = 'Z';
  private local: { origin: V3; dir: V3 } | null = null;
  private lastInvalid = -Infinity;
  constructor(
    readonly part: ElectricalPart & { device: DeviceOf<'hc-sr04'> },
    private readonly c: DeviceContext,
  ) {}

  get d() {
    return this.part.device;
  }

  start() {
    const ifs = localInterfaces(this.c.scene, this.part.nodeId, ['tx', 'rx']);
    const tx = ifs.get('tx');
    const rx = ifs.get('rx');
    if (tx && rx)
      this.local = {
        origin: [(tx[0] + rx[0]) / 2, (tx[1] + rx[1]) / 2, (tx[2] + rx[2]) / 2],
        dir: [0, 0, 1],
      };
    else if (this.part.nodeId)
      this.c.event({
        part: this.part.id,
        kind: 'warning',
        message: `${this.part.label}: no transducer geometry; it cannot sense.`,
      });
    const gnd = this.c.net.pinNet(this.part.id, 'gnd');
    this.trig = this.c.net.read(this.part.id, 'trig', TTL, gnd);
    this.unwatch = this.c.net.watch(this.part.id, 'trig', TTL, gnd, (l, t) => this.onTrig(l, t));
  }
  stop() {
    this.unwatch?.();
  }

  private powered() {
    const v = supplyOf(this.c.net, this.part, 'vcc', 'gnd');
    // Assumption: the module works within ±10 % of its cited 5 V working voltage.
    return v !== null && v >= 4.5 && v <= 5.5 ? v : null;
  }

  private onTrig(l: Logic, t: Ns) {
    const prev = this.trig;
    this.trig = l;
    if (prev === '0' && l === '1') this.rise = t;
    if (!(prev === '1' && l === '0') || this.rise === null) return;
    const widthUs = (t - this.rise) / 1000;
    this.rise = null;
    const vcc = this.powered();
    if (vcc === null) return; // unpowered: no response at all
    if (widthUs < this.d.minTriggerUs) {
      if (t - this.lastInvalid > 1e8) {
        this.lastInvalid = t;
        this.c.event({
          part: this.part.id,
          kind: 'invalid-input',
          message: `${this.part.label}: trigger pulse ${widthUs.toFixed(1)} µs is shorter than ${this.d.minTriggerUs} µs; ignored.`,
        });
      }
      return;
    }
    if (this.busy) return; // still measuring: the module ignores new triggers
    this.busy = true;
    const geometric = this.measure();
    const temp = this.d.temperatureC ?? this.c.ambientC;
    let reported: number | null = null;
    let echoUs = this.d.noEchoPulseUs;
    if (geometric !== null && geometric >= this.d.minRangeM && geometric <= this.d.maxRangeM) {
      reported = geometric;
      if (this.d.noiseStdM > 0) {
        // Box–Muller on the seeded generator (deterministic for a given seed).
        const u = Math.max(1e-12, this.c.rand());
        const v = this.c.rand();
        reported += this.d.noiseStdM * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      }
      echoUs = ((2 * Math.max(0, reported)) / speedOfSound(temp)) * 1e6;
    }
    const gnd = this.c.net.pinNet(this.part.id, 'gnd');
    const spec = { vHigh: vcc, rOut: 100, refNet: gnd };
    const tRise = t + Math.round(this.d.burstDelayUs * 1000);
    const tFall = tRise + Math.round(echoUs * 1000);
    this.c.sched.at(tRise, () => this.c.net.drive(this.part.id, 'echo', '1', spec));
    this.c.sched.at(tFall, () => {
      this.c.net.drive(this.part.id, 'echo', '0', spec);
      this.busy = false;
    });
    if (this.measurements.length >= 2000) this.measurements.shift();
    this.measurements.push({ t, geometricM: geometric, reportedM: reported, echoUs });
  }

  /** Nearest hit along the beam (central ray, or centre + 6 rays on the cone). */
  measure(): number | null {
    const p = this.c.physics;
    if (!p || !this.local || !this.part.nodeId) return null;
    const m = p.nodeMatrix(this.part.nodeId);
    if (!m) return null;
    const o = transformPoint(m, this.local.origin);
    const tip = transformPoint(m, [this.local.origin[0], this.local.origin[1], this.local.origin[2] + 1]);
    const dir: V3 = [tip[0] - o[0], tip[1] - o[1], tip[2] - o[2]];
    const dirs: V3[] = [dir];
    if (this.d.rays === 7 && this.d.beamHalfAngleRad > 0) {
      const a = this.d.beamHalfAngleRad;
      const ref: V3 = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const cross = (x: V3, y: V3): V3 => [
        x[1] * y[2] - x[2] * y[1],
        x[2] * y[0] - x[0] * y[2],
        x[0] * y[1] - x[1] * y[0],
      ];
      const norm = (x: V3): V3 => {
        const l = Math.hypot(...x);
        return [x[0] / l, x[1] / l, x[2] / l];
      };
      const u = norm(cross(dir, ref));
      const w = norm(cross(dir, u));
      for (let k = 0; k < 6; k++) {
        const phi = (k * Math.PI) / 3;
        dirs.push(
          [0, 1, 2].map(
            (i) => Math.cos(a) * dir[i]! + Math.sin(a) * (Math.cos(phi) * u[i]! + Math.sin(phi) * w[i]!),
          ) as V3,
        );
      }
    }
    let best: number | null = null;
    for (const d of dirs) {
      const hit = p.castRay(o, d, this.d.maxRangeM * 1.5, [this.part.nodeId]);
      if (hit && (best === null || hit.distance < best)) best = hit.distance;
    }
    return best;
  }

  channels(): Channel[] {
    const k = this.part.label;
    return [
      { key: `${k}.geometric`, label: `${k} distance (ray geometry)`, unit: 'm', kind: 'true-geometry' },
      { key: `${k}.reported`, label: `${k} distance encoded in echo`, unit: 'm', kind: 'measured' },
      { key: `${k}.echo`, label: `${k} echo pulse`, unit: 'µs', kind: 'measured' },
    ];
  }
  sample() {
    const m = this.measurements[this.measurements.length - 1];
    const k = this.part.label;
    return {
      [`${k}.geometric`]: m?.geometricM ?? NaN,
      [`${k}.reported`]: m?.reportedM ?? NaN,
      [`${k}.echo`]: m?.echoUs ?? NaN,
    };
  }
  status() {
    const m = this.measurements[this.measurements.length - 1];
    if (this.powered() === null) return 'unpowered';
    if (!m) return 'waiting for trigger';
    return m.reportedM === null
      ? `no echo (${(m.echoUs / 1000).toFixed(1)} ms pulse)`
      : `${(m.reportedM * 100).toFixed(1)} cm → ${m.echoUs.toFixed(0)} µs echo`;
  }
}

// -- Servo ----------------------------------------------------------------------------------------
export class ServoModel implements DeviceModel {
  lastWidthUs: number | null = null;
  appliedWidthUs: number | null = null;
  targetRad: number | null = null;
  angleDeg: number | null = null;
  pulses = 0;
  invalid = 0;
  private rise: Ns | null = null;
  private sig: Logic = 'Z';
  private unwatch: (() => void) | null = null;
  private enabled: boolean | null = null;
  constructor(
    readonly part: ElectricalPart & { device: DeviceOf<'servo'> },
    private readonly c: DeviceContext,
  ) {}
  get d() {
    return this.part.device;
  }

  start() {
    const gnd = this.c.net.pinNet(this.part.id, 'gnd');
    this.sig = this.c.net.read(this.part.id, 'signal', TTL, gnd);
    this.unwatch = this.c.net.watch(this.part.id, 'signal', TTL, gnd, (l, t) => this.onSignal(l, t));
    // No valid pulse yet: the servo applies no torque (limp) until it is commanded.
    this.setEnabled(false, 'no control pulses yet');
  }
  stop() {
    this.unwatch?.();
  }

  private supplyOk(): { ok: boolean; v: number | null } {
    const v = supplyOf(this.c.net, this.part, 'vplus', 'gnd');
    return { ok: v !== null && v >= this.d.minSupplyV && v <= this.d.maxSupplyV, v };
  }

  private setEnabled(on: boolean, why: string) {
    if (this.enabled === on) return;
    this.enabled = on;
    if (this.d.mateId && this.c.physics)
      this.c.physics.setMotorTarget({ mateId: this.d.mateId, enabled: on, source: 'electronics' });
    if (!on && why !== 'no control pulses yet')
      this.c.event({
        part: this.part.id,
        kind: 'warning',
        message: `${this.part.label}: actuator off (${why}).`,
      });
  }

  private onSignal(l: Logic, t: Ns) {
    const prev = this.sig;
    this.sig = l;
    if (prev === '0' && l === '1') this.rise = t;
    if (!(prev === '1' && l === '0') || this.rise === null) return;
    const w = (t - this.rise) / 1000;
    this.rise = null;
    this.lastWidthUs = w;
    const s = this.supplyOk();
    if (!s.ok) {
      this.setEnabled(
        false,
        s.v === null
          ? 'no supply'
          : `supply ${s.v.toFixed(2)} V outside ${this.d.minSupplyV}–${this.d.maxSupplyV} V`,
      );
      return;
    }
    if (w < this.d.validMinUs || w > this.d.validMaxUs) {
      this.invalid++;
      if (this.invalid === 1 || this.invalid % 50 === 0)
        this.c.event({
          part: this.part.id,
          kind: 'invalid-input',
          message: `${this.part.label}: ${w.toFixed(0)} µs pulse is outside ${this.d.validMinUs}–${this.d.validMaxUs} µs; ignored.`,
        });
      return;
    }
    this.pulses++;
    if (
      this.appliedWidthUs !== null &&
      Math.abs(w - this.appliedWidthUs) <= this.d.deadbandUs &&
      this.enabled
    )
      return;
    this.appliedWidthUs = w;
    const span = this.d.pulseMaxUs - this.d.pulseMinUs;
    const angle = Math.max(
      0,
      Math.min(this.d.angleRangeDeg, ((w - this.d.pulseMinUs) / span) * this.d.angleRangeDeg),
    );
    this.angleDeg = angle;
    this.targetRad =
      this.d.jointCentreRad + (this.d.direction * (angle - this.d.angleRangeDeg / 2) * Math.PI) / 180;
    if (this.d.mateId && this.c.physics) {
      const r = this.c.physics.setMotorTarget({
        mateId: this.d.mateId,
        mode: 'position',
        target: this.targetRad,
        source: 'electronics',
      });
      if (!r.ok)
        this.c.event({ part: this.part.id, kind: 'warning', message: `${this.part.label}: ${r.error}` });
    }
    this.setEnabled(true, '');
  }

  channels(): Channel[] {
    const k = this.part.label;
    return [
      { key: `${k}.pulse`, label: `${k} control pulse width`, unit: 'µs', kind: 'measured' },
      { key: `${k}.target`, label: `${k} joint target from pulse`, unit: 'rad', kind: 'commanded' },
      ...(this.d.mateId
        ? [{ key: `${k}.q`, label: `${k} joint angle (physics)`, unit: 'rad', kind: 'measured' as const }]
        : []),
      { key: `${k}.supply`, label: `${k} supply voltage`, unit: 'V', kind: 'measured' },
    ];
  }
  sample() {
    const k = this.part.label;
    const out: Record<string, number> = {
      [`${k}.pulse`]: this.lastWidthUs ?? NaN,
      [`${k}.target`]: this.targetRad ?? NaN,
      [`${k}.supply`]: supplyOf(this.c.net, this.part, 'vplus', 'gnd') ?? NaN,
    };
    if (this.d.mateId) out[`${k}.q`] = this.c.physics?.jointQ(this.d.mateId) ?? NaN;
    return out;
  }
  status() {
    if (!this.supplyOk().ok) return 'unpowered / out of supply range';
    if (this.lastWidthUs === null) return 'no pulses';
    return `${this.lastWidthUs.toFixed(0)} µs → ${this.angleDeg?.toFixed(1) ?? '—'}°${this.d.mateId ? '' : ' (not linked to a joint)'}`;
  }
}

// -- Joint-linked sensors ---------------------------------------------------------------------
export class EncoderModel implements DeviceModel {
  private count: number | null = null;
  constructor(
    readonly part: ElectricalPart & { device: DeviceOf<'encoder'> },
    private readonly c: DeviceContext,
  ) {}
  private spec() {
    const v = supplyOf(this.c.net, this.part, 'vcc', 'gnd');
    return v !== null && v > 2.5
      ? { vHigh: v, rOut: 100, refNet: this.c.net.pinNet(this.part.id, 'gnd') }
      : null;
  }
  private drive(count: number) {
    const s = this.spec();
    if (!s) return;
    // Quadrature: state = count mod 4 → (A, B) = 00, 10, 11, 01.
    const q = ((count % 4) + 4) % 4;
    this.c.net.drive(this.part.id, 'a', q === 1 || q === 2 ? '1' : '0', s);
    this.c.net.drive(this.part.id, 'b', q >= 2 ? '1' : '0', s);
  }
  private countOf(q: number) {
    return Math.floor((q / (2 * Math.PI)) * this.part.device.pulsesPerRev * 4);
  }
  start() {
    const q = this.part.device.mateId ? (this.c.physics?.jointQ(this.part.device.mateId) ?? 0) : 0;
    this.count = this.countOf(q);
    this.drive(this.count);
  }
  stop() {}
  afterPhysics(t0: Ns, t1: Ns) {
    if (!this.part.device.mateId || this.count === null) return;
    const q = this.c.physics?.jointQ(this.part.device.mateId);
    if (q === null || q === undefined) return;
    const next = this.countOf(q);
    const n = next - this.count;
    if (n === 0) return;
    // Spread the quadrature steps evenly over the step interval (the joint moved continuously).
    const steps = Math.min(Math.abs(n), 10_000);
    const dir = Math.sign(n);
    for (let i = 1; i <= steps; i++) {
      const c = this.count + dir * i;
      this.c.sched.at(Math.round(t0 + ((t1 - t0) * i) / (steps + 1)), () => this.drive(c));
    }
    this.count = next;
  }
  channels(): Channel[] {
    return [
      {
        key: `${this.part.label}.count`,
        label: `${this.part.label} quadrature count`,
        unit: '',
        kind: 'measured',
      },
    ];
  }
  sample() {
    return { [`${this.part.label}.count`]: this.count ?? NaN };
  }
  status() {
    return `count ${this.count ?? '—'}`;
  }
}

export class JointPotModel implements DeviceModel {
  position: number;
  constructor(
    readonly part: ElectricalPart & { device: DeviceOf<'potentiometer'> },
    private readonly c: DeviceContext,
  ) {
    this.position = part.device.position;
  }
  start() {
    this.afterPhysics();
  }
  stop() {}
  /** Manual wiper (runtime input from the UI). */
  set(position: number) {
    this.position = Math.min(1, Math.max(0, position));
    this.c.net.setPot(this.part.id, this.position);
  }
  afterPhysics() {
    const l = this.part.device.link;
    if (l.kind !== 'joint') return;
    const q = this.c.physics?.jointQ(l.mateId);
    if (q === null || q === undefined || l.qMax === l.qMin) return;
    const pos = Math.min(1, Math.max(0, (q - l.qMin) / (l.qMax - l.qMin)));
    if (Math.abs(pos - this.position) > 1e-6) this.set(pos);
  }
  channels(): Channel[] {
    return [
      {
        key: `${this.part.label}.wiper`,
        label: `${this.part.label} wiper position`,
        unit: '',
        kind: 'measured',
      },
    ];
  }
  sample() {
    return { [`${this.part.label}.wiper`]: this.position };
  }
  status() {
    return `wiper ${(this.position * 100).toFixed(1)} %`;
  }
}

export class LimitSwitchModel implements DeviceModel {
  pressed: boolean;
  constructor(
    readonly part: ElectricalPart & { device: DeviceOf<'limit-switch'> },
    private readonly c: DeviceContext,
  ) {
    this.pressed = part.device.link.kind === 'manual' ? part.device.link.pressed : false;
  }
  start() {
    this.afterPhysics();
  }
  stop() {}
  set(pressed: boolean) {
    this.pressed = pressed;
    this.c.net.setPressed(this.part.id, pressed);
  }
  afterPhysics() {
    const l = this.part.device.link;
    if (l.kind !== 'joint') return;
    const q = this.c.physics?.jointQ(l.mateId);
    if (q === null || q === undefined) return;
    const p = l.pressedWhen === 'above' ? q >= l.thresholdQ : q <= l.thresholdQ;
    if (p !== this.pressed) this.set(p);
  }
  channels(): Channel[] {
    return [
      { key: `${this.part.label}.pressed`, label: `${this.part.label} pressed`, unit: '', kind: 'measured' },
    ];
  }
  sample() {
    return { [`${this.part.label}.pressed`]: this.pressed ? 1 : 0 };
  }
  status() {
    return this.pressed ? 'pressed' : 'released';
  }
}

export class TempSensorModel implements DeviceModel {
  constructor(
    readonly part: ElectricalPart & { device: DeviceOf<'temp-sensor'> },
    private readonly c: DeviceContext,
  ) {}
  start() {
    const v = supplyOf(this.c.net, this.part, 'vcc', 'gnd');
    // Generic 2.7 V minimum supply (assumption); unpowered → output undefined (no source).
    this.c.net.setSensorOutput(
      this.part.id,
      v !== null && v >= 2.7
        ? this.part.device.offsetV + this.part.device.slopeVPerC * this.c.ambientC
        : null,
    );
  }
  stop() {}
  channels(): Channel[] {
    return [
      { key: `${this.part.label}.out`, label: `${this.part.label} output`, unit: 'V', kind: 'measured' },
    ];
  }
  sample() {
    return { [`${this.part.label}.out`]: this.c.net.voltage(this.c.net.pinNet(this.part.id, 'out')) ?? NaN };
  }
  status() {
    return `ambient ${this.c.ambientC} °C (no thermal simulation)`;
  }
}

export function createDeviceModels(parts: readonly ElectricalPart[], c: DeviceContext): DeviceModel[] {
  const out: DeviceModel[] = [];
  for (const p of parts) {
    const d = p.device;
    if (d.type === 'hc-sr04') out.push(new HcSr04Model(p as ElectricalPart & { device: typeof d }, c));
    else if (d.type === 'servo') out.push(new ServoModel(p as ElectricalPart & { device: typeof d }, c));
    else if (d.type === 'encoder') out.push(new EncoderModel(p as ElectricalPart & { device: typeof d }, c));
    else if (d.type === 'potentiometer')
      out.push(new JointPotModel(p as ElectricalPart & { device: typeof d }, c));
    else if (d.type === 'limit-switch')
      out.push(new LimitSwitchModel(p as ElectricalPart & { device: typeof d }, c));
    else if (d.type === 'temp-sensor')
      out.push(new TempSensorModel(p as ElectricalPart & { device: typeof d }, c));
  }
  return out;
}
