import type { ElectricalPart, Firmware } from '@forge/engineering-core';
import { UNO } from '../analog/build';
import type { Logic } from '../digital/logic';
import type { SignalNetwork } from '../digital/network';
import type { EventHandle, Ns, Scheduler } from '../digital/scheduler';
import { hashOf } from '../netlist';
import {
  compileFirmware,
  FirmwareRuntimeError,
  Interpreter,
  type Builtin,
  type CompileResult,
  type Gen,
  type MethodTable,
  type Request,
} from './interpreter';
import type { Pos } from './parse';
import { convert, val, type CType, type Value } from './types';

/**
 * Arduino UNO R3 runtime model (Level 2). Firmware in the FORGE Arduino subset runs against
 * a MODELLED Arduino API; the ATmega328P, its registers and its timers are not emulated.
 * Modelled behaviour and its sources are listed in docs/EMBEDDED_RUNTIME.md; the main ones:
 *  - I/O through the signal network: outputs at the 5 V rail behind 25 Ω, inputs read with
 *    the ATmega328P thresholds (V_IL 0.3·VCC, V_IH 0.6·VCC); floating reads are flagged.
 *  - millis() resolution 1 ms, micros() resolution 4 µs (16 MHz UNO, Arduino reference).
 *  - analogRead: 10-bit, AVCC (5 V rail) reference, ≈ 100 µs per conversion (Arduino reference).
 *  - analogWrite PWM: ≈ 490 Hz on D3/D9/D10/D11, ≈ 980 Hz on D5/D6 (Arduino reference).
 *  - Servo library: 50 Hz frames, pulses issued one after another (Timer1 style), default
 *    544–2400 µs range; attaching a servo disables analogWrite on D9/D10 (Arduino reference).
 *  - UART: 10 bits per byte at the configured baud, 64-byte TX/RX buffers.
 *  - Built-in call costs are approximations (e.g. digitalWrite ≈ 4 µs), not measured cycles.
 */
export const UNO_TIMING = {
  pinIoNs: 4_000,
  analogReadNs: 100_000,
  pwmHz: { 3: 490.2, 5: 976.56, 6: 976.56, 9: 490.2, 10: 490.2, 11: 490.2 } as Record<number, number>,
  servoFrameNs: 20_000_000,
  servoDefaultUs: 1500,
  servoMinUs: 544,
  servoMaxUs: 2400,
  uartBufferBytes: 64,
  /** ATmega328P at 16 MHz needs 4.5–5.5 V (datasheet speed grade). */
  minSupplyV: 4.5,
};

export type McuState = 'idle' | 'running' | 'unpowered' | 'error' | 'stopped';
export interface SerialChunk {
  /** Time the last byte finished transmitting (ns). */
  t: Ns;
  text: string;
}
export interface McuEvent {
  t: Ns;
  kind: 'error' | 'warning' | 'info';
  message: string;
  line: number | null;
}

interface PinState {
  mode: 'INPUT' | 'OUTPUT' | 'INPUT_PULLUP';
  out: 0 | 1;
  pwm: { stop: () => void; duty: number } | null;
  warnedFloat: boolean;
}

interface ServoState {
  pin: number | null;
  min: number;
  max: number;
  us: number;
}

const pinName = (n: number) => (n <= 13 ? `D${n}` : `A${n - 14}`);

export class UnoRuntime {
  state: McuState = 'idle';
  compile: CompileResult;
  serial: SerialChunk[] = [];
  serialBytes = 0;
  events: McuEvent[] = [];
  readonly firmwareHash: string;
  readonly pins: PinState[] = Array.from({ length: 20 }, () => ({
    mode: 'INPUT',
    out: 0,
    pwm: null,
    warnedFloat: false,
  }));
  readonly servos: ServoState[] = [];
  private interp: Interpreter | null = null;
  private gen: Gen<void> | null = null;
  private wake: EventHandle | null = null;
  private baud = 0;
  private txFree: Ns = 0;
  private rx: number[] = [];
  private interruptsOn = true;
  private pendingIsr: string[] = [];
  private isrWatch = new Map<number, () => void>();
  private servoFrame: EventHandle | null = null;
  private cleanups: (() => void)[] = [];
  private seed = 1;
  private readonly gnd: number;
  private readonly rail: number;

  constructor(
    readonly part: ElectricalPart,
    readonly firmware: Firmware | null,
    readonly net: SignalNetwork,
    readonly sched: Scheduler,
    private readonly opts: { opCostNs: number; seed?: number; maxSerialBytes?: number },
  ) {
    this.gnd = net.pinNet(part.id, 'GND.1');
    this.rail = net.pinNet(part.id, '5V');
    this.seed = opts.seed ?? 1;
    this.firmwareHash = firmware ? hashOf(firmware.source) : '—';
    this.compile = firmware
      ? compileFirmware(firmware.source, this.builtins(), this.methods())
      : {
          ok: false,
          program: null,
          errors: [{ line: 1, col: 1, message: 'No firmware assigned.' }],
          warnings: [],
          stats: { functions: 0, globals: 0, nodes: 0, sramBytes: 0 },
        };
  }

  /** Compile-check a sketch against the UNO API without a running board (same front end). */
  static check(source: string): CompileResult {
    const shell = Object.create(UnoRuntime.prototype) as UnoRuntime;
    return compileFirmware(source, shell.builtins(), shell.methods());
  }

  // -- lifecycle ---------------------------------------------------------------------------
  get vcc(): number {
    const v = this.net.voltage(this.rail);
    const g = this.net.voltage(this.gnd) ?? 0;
    return v === null ? 0 : v - g;
  }
  get powered(): boolean {
    return this.vcc >= UNO_TIMING.minSupplyV;
  }
  /** Local firmware time: scheduler time plus the not-yet-paid execution debt. */
  get localNs(): Ns {
    return this.sched.now + (this.interp?.debtNs ?? 0);
  }

  start(): void {
    if (!this.compile.ok || !this.compile.program) {
      this.state = 'error';
      for (const e of this.compile.errors) this.log('error', `Compile error: ${e.message}`, e.line);
      return;
    }
    if (!this.powered) {
      this.state = 'unpowered';
      this.log(
        'warning',
        `${this.part.label} is not powered (5 V rail at ${this.vcc.toFixed(2)} V; the ATmega328P needs ≥ ${UNO_TIMING.minSupplyV} V at 16 MHz). Firmware does not run.`,
        null,
      );
      return;
    }
    this.interp = new Interpreter(this.compile.program, this.builtins(), this.methods(), {
      opCostNs: this.opts.opCostNs,
      newServo: () => {
        this.servos.push({
          pin: null,
          min: UNO_TIMING.servoMinUs,
          max: UNO_TIMING.servoMaxUs,
          us: UNO_TIMING.servoDefaultUs,
        });
        return this.servos.length - 1;
      },
    });
    const interp = this.interp;
    this.gen = (function* (): Gen<void> {
      yield* interp.init();
      yield* interp.call('setup');
      for (;;) yield* interp.call('loop');
    })();
    this.state = 'running';
    this.log(
      'info',
      `Firmware "${this.firmware!.name}" rev ${this.firmware!.revision} started (Level 2 runtime; not cycle-accurate).`,
      null,
    );
    this.sched.at(this.sched.now, () => this.resume(undefined));
  }

  stop(): void {
    this.wake?.cancel();
    this.servoFrame?.cancel();
    this.cleanups.forEach((c) => c());
    this.cleanups = [];
    this.pins.forEach((p, i) => {
      p.pwm?.stop();
      p.pwm = null;
      this.net.drive(this.part.id, pinName(i), 'Z', this.spec());
      this.net.pull(this.part.id, pinName(i), null);
    });
    if (this.state === 'running') this.state = 'stopped';
  }

  private fail(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const line = e instanceof FirmwareRuntimeError ? (e.pos?.line ?? null) : null;
    this.log('error', `Runtime error: ${msg}`, line);
    this.state = 'error';
    this.stop();
    this.state = 'error';
  }

  log(kind: McuEvent['kind'], message: string, line: number | null) {
    if (this.events.length >= 500) this.events.shift();
    this.events.push({ t: this.sched.now, kind, message, line });
  }

  /** Drive the generator until it waits on simulated time. */
  private resume(value: unknown): void {
    if (this.state !== 'running' || !this.gen || !this.interp) return;
    if (!this.powered) {
      this.log('warning', 'Supply dropped below the operating range: firmware halted (brown-out).', null);
      this.state = 'unpowered';
      this.stop();
      this.state = 'unpowered';
      return;
    }
    const interp = this.interp;
    for (let guard = 0; guard < 100_000; guard++) {
      let r: IteratorResult<Request, void>;
      try {
        r = this.gen.next(value);
      } catch (e) {
        return this.fail(e);
      }
      value = undefined;
      if (r.done) {
        this.state = 'stopped';
        return;
      }
      const req = r.value;
      if (req.k === 'slice' || req.k === 'sync') {
        const d = interp.debtNs;
        if (d <= 0) continue;
        interp.debtNs = 0;
        this.wake = this.sched.at(this.sched.now + d, () => this.resume(undefined));
        return;
      }
      if (req.k === 'sleep') {
        const d = interp.debtNs + req.ns;
        interp.debtNs = 0;
        this.wake = this.sched.at(this.sched.now + Math.max(1, d), () => this.resume(undefined));
        return;
      }
      if (req.k === 'host' && req.name === 'pulseIn')
        return this.pulseWait(req.data as { pin: number; level: 0 | 1; timeoutNs: number });
      return this.fail(new Error(`Unknown runtime request ${req.k}.`));
    }
    this.fail(new Error('Firmware made no progress in simulated time (internal guard).'));
  }

  // -- pins ----------------------------------------------------------------------------------
  private spec() {
    return { vHigh: Math.max(0, this.vcc), rOut: UNO.outputOhm, refNet: this.gnd };
  }
  private th() {
    const v = Math.max(0, this.vcc);
    return { vil: UNO.vilFrac * v, vih: UNO.vihFrac * v };
  }
  private checkPin(n: number, pos: Pos): number {
    if (!Number.isInteger(n) || n < 0 || n > 19)
      throw new FirmwareRuntimeError(`Pin ${n} does not exist on the UNO (0–13, A0–A5 = 14–19).`, pos);
    return n;
  }
  private apply(n: number) {
    const p = this.pins[n]!;
    const name = pinName(n);
    if (p.mode === 'OUTPUT' && !p.pwm) this.net.drive(this.part.id, name, p.out ? '1' : '0', this.spec());
    else if (p.mode !== 'OUTPUT') this.net.drive(this.part.id, name, 'Z', this.spec());
    // AVR: writing HIGH to an input pin enables its pull-up (PORT bit), as does INPUT_PULLUP.
    const pull = p.mode === 'INPUT_PULLUP' || (p.mode === 'INPUT' && p.out === 1);
    this.net.pull(this.part.id, name, pull ? { toNet: this.rail, r: UNO.pullUpOhm, level: '1' } : null);
  }
  private readPin(n: number): Logic {
    return this.net.read(this.part.id, pinName(n), this.th(), this.gnd);
  }

  private pulseWait(d: { pin: number; level: 0 | 1; timeoutNs: number }) {
    const want: Logic = d.level ? '1' : '0';
    const deadline = this.sched.now + d.timeoutNs;
    let phase: 0 | 1 | 2 = this.readPin(d.pin) === want ? 0 : 1;
    let start = 0;
    let done = false;
    const finish = (v: number) => {
      if (done) return;
      done = true;
      unwatch();
      timer.cancel();
      this.resume(v);
    };
    const unwatch = this.net.watch(this.part.id, pinName(d.pin), this.th(), this.gnd, (l, t) => {
      if (phase === 0 && l !== want) phase = 1;
      else if (phase === 1 && l === want) {
        phase = 2;
        start = t;
      } else if (phase === 2 && l !== want) finish(Math.round((t - start) / 1000));
    });
    const timer = this.sched.at(deadline, () => finish(0));
  }

  // -- serial --------------------------------------------------------------------------------
  private print(text: string): Gen<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- generator functions cannot capture `this` lexically
    const self = this;
    return (function* () {
      if (!self.baud) {
        self.log('warning', 'Serial.print before Serial.begin: nothing is transmitted.', null);
        return;
      }
      const byteNs = (10 / self.baud) * 1e9;
      const bytes = [...text].length;
      // Block while the 64-byte TX buffer has no room (as HardwareSerial does).
      const queued = () => Math.max(0, Math.ceil((self.txFree - self.localNs) / byteNs));
      if (queued() + bytes > UNO_TIMING.uartBufferBytes) {
        const wait = (queued() + bytes - UNO_TIMING.uartBufferBytes) * byteNs;
        yield { k: 'sleep', ns: Math.ceil(wait) } as Request;
      }
      self.txFree = Math.max(self.txFree, self.localNs) + bytes * byteNs;
      const max = self.opts.maxSerialBytes ?? 32_768;
      self.serial.push({ t: Math.round(self.txFree), text });
      self.serialBytes += text.length;
      while (self.serialBytes > max && self.serial.length > 1)
        self.serialBytes -= self.serial.shift()!.text.length;
    })();
  }

  /** Text typed into the serial monitor (arrives byte by byte at the configured baud). */
  sendSerial(text: string): boolean {
    if (!this.baud) return false;
    const byteNs = (10 / this.baud) * 1e9;
    [...text].forEach((ch, i) =>
      this.sched.at(this.sched.now + (i + 1) * byteNs, () => {
        if (this.rx.length >= UNO_TIMING.uartBufferBytes)
          this.log('warning', 'Serial RX buffer overflow: byte dropped.', null);
        else this.rx.push(ch.charCodeAt(0) & 0xff);
      }),
    );
    return true;
  }

  private format(v: Value, fmt: Value | undefined): string {
    if (v.t === 'void') return this.interp!.string(v.v);
    if (v.t === 'char' && !fmt) return String.fromCharCode(v.v & 0xff);
    if (v.t === 'float') {
      const digits = fmt ? Math.max(0, Math.min(10, fmt.v)) : 2;
      if (Number.isNaN(v.v)) return 'nan';
      if (!Number.isFinite(v.v)) return 'inf';
      if (Math.abs(v.v) > 4294967040) return 'ovf';
      return v.v.toFixed(digits);
    }
    const base = fmt ? fmt.v : 10;
    if (base === 10) return String(v.v);
    const u = convert(v.v, 'ulong');
    return u.toString(base).toUpperCase();
  }

  // -- API tables ----------------------------------------------------------------------------
  private builtins(): Record<string, Builtin> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- generator functions cannot capture `this` lexically
    const self = this;
    const b = (
      arity: [number, number],
      ret: CType,
      fn: Builtin['fn'],
      extra: Partial<Builtin> = {},
    ): Builtin => ({ arity, ret, fn, ...extra });
    const math1 = (f: (x: number) => number) => b([1, 1], 'float', ([x]) => val('float', f(x!.v)));
    const pinCost = () => {
      self.interp!.debtNs += UNO_TIMING.pinIoNs;
    };
    return {
      pinMode: b(
        [2, 2],
        'void',
        function ([p, m], pos) {
          pinCost();
          const n = self.checkPin(p!.v, pos);
          const pin = self.pins[n]!;
          pin.mode = m!.v === 1 ? 'OUTPUT' : m!.v === 2 ? 'INPUT_PULLUP' : 'INPUT';
          if (pin.mode === 'INPUT_PULLUP') pin.out = 1;
          self.apply(n);
          return { t: 'void', v: 0 };
        },
        { io: true },
      ),
      digitalWrite: b(
        [2, 2],
        'void',
        function ([p, l], pos) {
          pinCost();
          const n = self.checkPin(p!.v, pos);
          const pin = self.pins[n]!;
          if (pin.pwm) {
            pin.pwm.stop();
            pin.pwm = null;
          }
          if ((n === 0 || n === 1) && self.baud)
            self.log('warning', `digitalWrite on D${n} while Serial uses it (${n ? 'TX' : 'RX'}).`, pos.line);
          pin.out = l!.v ? 1 : 0;
          self.apply(n);
          return { t: 'void', v: 0 };
        },
        { io: true },
      ),
      digitalRead: b(
        [1, 1],
        'int',
        function ([p], pos) {
          pinCost();
          const n = self.checkPin(p!.v, pos);
          const l = self.readPin(n);
          if (l === '1') return { t: 'int', v: 1 };
          if (l !== '0' && !self.pins[n]!.warnedFloat) {
            self.pins[n]!.warnedFloat = true;
            self.log(
              'warning',
              `digitalRead(${pinName(n)}) on a ${l === 'Z' ? 'floating (undriven, no pull-up)' : 'between-thresholds (undefined)'} input: the level is undefined on hardware; FORGE returns LOW.`,
              pos.line,
            );
            self.net.event({
              kind: 'floating-read',
              message: `${self.part.label} read ${pinName(n)} while it was ${l}.`,
              parts: [self.part.id],
              nets: [],
            });
          }
          return { t: 'int', v: 0 };
        },
        { io: true },
      ),
      analogRead: b([1, 1], 'int', function* ([p], pos) {
        self.interp!.debtNs += UNO_TIMING.analogReadNs;
        const raw = p!.v;
        const n = self.checkPin(raw >= 0 && raw <= 5 ? raw + 14 : raw, pos);
        if (n < 14) throw new FirmwareRuntimeError(`analogRead needs A0–A5 (got pin ${raw}).`, pos);
        yield { k: 'sync' };
        const v = self.net.voltage(self.net.pinNet(self.part.id, pinName(n)));
        const vref = self.vcc;
        if (v === null) {
          self.log(
            'warning',
            `analogRead(${pinName(n)}) on a floating input: undefined on hardware; FORGE returns 0.`,
            pos.line,
          );
          return { t: 'int', v: 0 };
        }
        const code = Math.max(
          0,
          Math.min(1023, Math.floor(((v - (self.net.voltage(self.gnd) ?? 0)) / vref) * 1024)),
        );
        return { t: 'int', v: code };
      }),
      analogWrite: b(
        [2, 2],
        'void',
        function ([p, d], pos) {
          pinCost();
          const n = self.checkPin(p!.v, pos);
          const pin = self.pins[n]!;
          pin.mode = 'OUTPUT';
          pin.pwm?.stop();
          pin.pwm = null;
          const duty = d!.v;
          const hz = UNO_TIMING.pwmHz[n];
          if ((n === 9 || n === 10) && self.servos.some((s) => s.pin !== null)) {
            self.log(
              'warning',
              `analogWrite(${n}) has no effect while a Servo is attached: the Servo library uses Timer1 (pins 9 and 10).`,
              pos.line,
            );
            return { t: 'void', v: 0 };
          }
          if (duty <= 0 || duty >= 255 || !hz) {
            pin.out = duty >= (hz ? 255 : 128) ? 1 : 0;
            self.apply(n);
            return { t: 'void', v: 0 };
          }
          const periodNs = 1e9 / hz;
          const highNs = (duty / 255) * periodNs;
          let stopped = false;
          const cycle = (k: number) =>
            self.sched.at(Math.round(k * periodNs), () => {
              if (stopped) return;
              self.net.drive(self.part.id, pinName(n), '1', self.spec());
              self.sched.at(Math.round(k * periodNs + highNs), () => {
                if (!stopped) self.net.drive(self.part.id, pinName(n), '0', self.spec());
              });
              cycle(k + 1);
            });
          cycle(Math.ceil(self.localNs / periodNs));
          pin.pwm = { stop: () => (stopped = true), duty: duty / 255 };
          return { t: 'void', v: 0 };
        },
        { io: true },
      ),
      delay: b(
        [1, 1],
        'void',
        function* ([ms]) {
          yield { k: 'sleep', ns: ms!.v * 1e6 };
          return { t: 'void', v: 0 };
        },
        { params: ['ulong'] },
      ),
      delayMicroseconds: b(
        [1, 1],
        'void',
        function* ([us]) {
          yield { k: 'sleep', ns: us!.v * 1e3 };
          return { t: 'void', v: 0 };
        },
        { params: ['uint'] },
      ),
      millis: b([0, 0], 'ulong', () => val('ulong', Math.floor(self.localNs / 1e6))),
      micros: b([0, 0], 'ulong', () => val('ulong', Math.floor(self.localNs / 4000) * 4)),
      pulseIn: b(
        [2, 3],
        'ulong',
        function* ([p, l, to], pos) {
          const n = self.checkPin(p!.v, pos);
          yield { k: 'sync' };
          const v = (yield {
            k: 'host',
            name: 'pulseIn',
            data: { pin: n, level: l!.v ? 1 : 0, timeoutNs: (to?.v ?? 1_000_000) * 1000 },
          }) as number;
          return val('ulong', v);
        },
        { params: ['uchar', 'uchar', 'ulong'] },
      ),
      map: b(
        [5, 5],
        'long',
        ([x, a, bb, c, d], pos) => {
          if (bb!.v === a!.v)
            throw new FirmwareRuntimeError('map(): in_min equals in_max (division by zero).', pos);
          return val('long', Math.trunc(((x!.v - a!.v) * (d!.v - c!.v)) / (bb!.v - a!.v)) + c!.v);
        },
        { params: ['long', 'long', 'long', 'long', 'long'] },
      ),
      constrain: b([3, 3], 'int', ([x, lo, hi]) => ({
        t: x!.t,
        v: convert(x!.v < lo!.v ? lo!.v : x!.v > hi!.v ? hi!.v : x!.v, x!.t),
      })),
      min: b([2, 2], 'int', ([x, y]) => (x!.v <= y!.v ? x! : y!)),
      max: b([2, 2], 'int', ([x, y]) => (x!.v >= y!.v ? x! : y!)),
      abs: b([1, 1], 'int', ([x]) => ({ t: x!.t, v: convert(Math.abs(x!.v), x!.t) })),
      sq: b([1, 1], 'float', ([x]) =>
        x!.t === 'float'
          ? val('float', x!.v * x!.v)
          : val(x!.t === 'long' || x!.t === 'ulong' ? x!.t : 'int', x!.v * x!.v),
      ),
      sqrt: math1(Math.sqrt),
      sin: math1(Math.sin),
      cos: math1(Math.cos),
      tan: math1(Math.tan),
      atan: math1(Math.atan),
      exp: math1(Math.exp),
      log: math1(Math.log),
      fabs: math1(Math.abs),
      floor: math1(Math.floor),
      ceil: math1(Math.ceil),
      round: b([1, 1], 'long', ([x]) => val('long', Math.sign(x!.v) * Math.round(Math.abs(x!.v)))),
      atan2: b([2, 2], 'float', ([y, x]) => val('float', Math.atan2(y!.v, x!.v))),
      pow: b([2, 2], 'float', ([x, y]) => val('float', Math.pow(x!.v, y!.v))),
      fmod: b([2, 2], 'float', ([x, y]) => val('float', x!.v % y!.v)),
      bitRead: b([2, 2], 'int', ([x, n]) => ({
        t: 'int',
        v: Math.floor(convert(x!.v, 'ulong') / 2 ** n!.v) & 1,
      })),
      bit: b([1, 1], 'ulong', ([n]) => val('ulong', 2 ** n!.v)),
      lowByte: b([1, 1], 'uchar', ([x]) => val('uchar', x!.v)),
      highByte: b([1, 1], 'uchar', ([x]) => val('uchar', Math.floor(convert(x!.v, 'uint') / 256))),
      random: b([1, 2], 'long', ([a, c]) => {
        // Deterministic LCG (seeded): reproducible runs; NOT avr-libc's sequence.
        self.seed = (Math.imul(self.seed, 1103515245) + 12345) >>> 0;
        const r = (self.seed >>> 1) & 0x7fffffff;
        const [lo, hi] = c ? [a!.v, c.v] : [0, a!.v];
        return hi <= lo ? val('long', lo) : val('long', lo + (r % (hi - lo)));
      }),
      randomSeed: b([1, 1], 'void', ([s]) => {
        self.seed = convert(s!.v, 'ulong') || 1;
        return { t: 'void', v: 0 };
      }),
      digitalPinToInterrupt: b([1, 1], 'int', ([p]) => ({
        t: 'int',
        v: p!.v === 2 ? 0 : p!.v === 3 ? 1 : -1,
      })),
      attachInterrupt: b([3, 3], 'void', ([i, f, m], pos) => {
        if (i!.v !== 0 && i!.v !== 1)
          throw new FirmwareRuntimeError('The UNO has external interrupts 0 (D2) and 1 (D3) only.', pos);
        if (m!.v === 0)
          throw new FirmwareRuntimeError(
            'LOW-level interrupts are not supported by the FORGE runtime (use RISING, FALLING or CHANGE).',
            pos,
          );
        const pin = i!.v === 0 ? 2 : 3;
        const name = self.interp!.functionName(f!.v)!;
        self.isrWatch.get(pin)?.();
        let last = self.readPin(pin);
        const unwatch = self.net.watch(self.part.id, pinName(pin), self.th(), self.gnd, (l) => {
          const prev = last;
          last = l;
          const rise = prev === '0' && l === '1';
          const fall = prev === '1' && l === '0';
          if ((m!.v === 3 && rise) || (m!.v === 2 && fall) || (m!.v === 1 && (rise || fall))) self.isr(name);
        });
        self.isrWatch.set(pin, unwatch);
        self.cleanups.push(unwatch);
        return { t: 'void', v: 0 };
      }),
      detachInterrupt: b([1, 1], 'void', ([i]) => {
        self.isrWatch.get(i!.v === 0 ? 2 : 3)?.();
        return { t: 'void', v: 0 };
      }),
      noInterrupts: b([0, 0], 'void', () => {
        self.interruptsOn = false;
        return { t: 'void', v: 0 };
      }),
      interrupts: b([0, 0], 'void', () => {
        self.interruptsOn = true;
        for (const n of self.pendingIsr.splice(0)) self.isr(n);
        return { t: 'void', v: 0 };
      }),
    };
  }

  /** Run an interrupt handler at the current simulated time (between main-program steps). */
  private isr(name: string) {
    if (!this.interruptsOn) {
      if (!this.pendingIsr.includes(name)) this.pendingIsr.push(name);
      return;
    }
    this.sched.at(this.sched.now, () => {
      if (this.state !== 'running' || !this.interp) return;
      const g = this.interp.call(name);
      try {
        for (let i = 0; i < 1_000_000; i++) {
          const r = g.next();
          if (r.done) return;
          if (r.value.k === 'sleep' || r.value.k === 'host')
            throw new FirmwareRuntimeError(
              `${name}(): delay()/pulseIn() do not work inside an interrupt handler.`,
              null,
            );
        }
        throw new FirmwareRuntimeError(`${name}(): interrupt handler did not finish.`, null);
      } catch (e) {
        this.fail(e);
      }
    });
  }

  private methods(): MethodTable {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- generator functions cannot capture `this` lexically
    const self = this;
    const servoOf = (h: number) => self.servos[h]!;
    const ensureFrames = () => {
      if (self.servoFrame) return;
      const frame = (t0: Ns) => {
        self.servoFrame = self.sched.at(t0, () => {
          let t = t0;
          for (const s of self.servos) {
            if (s.pin === null) continue;
            const pin = s.pin;
            const us = s.us;
            self.sched.at(t, () => self.net.drive(self.part.id, pinName(pin), '1', self.spec()));
            t += us * 1000;
            self.sched.at(t, () => self.net.drive(self.part.id, pinName(pin), '0', self.spec()));
          }
          frame(Math.max(t0 + UNO_TIMING.servoFrameNs, t));
        });
      };
      frame(Math.ceil(self.localNs / 1000) * 1000);
    };
    const v = (t: CType, x: number): Value => val(t, x);
    return {
      Serial: {
        begin: {
          arity: [1, 2],
          ret: 'void',
          fn: ([baud]) => ((self.baud = baud!.v), v('void', 0)),
          params: ['ulong'],
        },
        end: { arity: [0, 0], ret: 'void', fn: () => ((self.baud = 0), v('void', 0)) },
        print: {
          arity: [1, 2],
          ret: 'uint',
          io: true,
          fn: ([x, f]) => self.printGen(self.format(x!, f), false),
        },
        println: {
          arity: [0, 2],
          ret: 'uint',
          io: true,
          fn: ([x, f]) => self.printGen(x ? self.format(x, f) : '', true),
        },
        write: {
          arity: [1, 1],
          ret: 'uint',
          io: true,
          fn: ([x]) =>
            self.printGen(
              x!.t === 'void' ? self.interp!.string(x!.v) : String.fromCharCode(x!.v & 0xff),
              false,
            ),
        },
        available: { arity: [0, 0], ret: 'int', fn: () => v('int', self.rx.length) },
        read: { arity: [0, 0], ret: 'int', fn: () => v('int', self.rx.length ? self.rx.shift()! : -1) },
        peek: { arity: [0, 0], ret: 'int', fn: () => v('int', self.rx.length ? self.rx[0]! : -1) },
        flush: { arity: [0, 0], ret: 'void', fn: () => v('void', 0) },
        parseInt: {
          arity: [0, 0],
          ret: 'long',
          fn: () => {
            // Non-blocking: parses from the bytes already received (Arduino waits up to 1 s).
            while (self.rx.length && !/[-0-9]/.test(String.fromCharCode(self.rx[0]!))) self.rx.shift();
            let s = '';
            while (
              self.rx.length &&
              /[-0-9]/.test(String.fromCharCode(self.rx[0]!)) &&
              !(s.length && self.rx[0] === 45)
            )
              s += String.fromCharCode(self.rx.shift()!);
            return v('long', s && s !== '-' ? parseInt(s, 10) : 0);
          },
        },
      },
      Servo: {
        attach: {
          arity: [2, 4],
          ret: 'uchar',
          fn: ([h, p, mn, mx], pos) => {
            const s = servoOf(h!.v);
            s.pin = self.checkPin(p!.v, pos);
            if (mn) s.min = mn.v;
            if (mx) s.max = mx.v;
            self.pins[s.pin]!.mode = 'OUTPUT';
            self.pins[s.pin]!.pwm?.stop();
            self.pins[s.pin]!.pwm = null;
            self.pins[s.pin]!.out = 0;
            self.apply(s.pin);
            ensureFrames();
            return v('uchar', h!.v);
          },
        },
        detach: {
          arity: [1, 1],
          ret: 'void',
          fn: ([h]) => {
            servoOf(h!.v).pin = null;
            return v('void', 0);
          },
        },
        write: {
          arity: [2, 2],
          ret: 'void',
          fn: ([h, a]) => {
            const s = servoOf(h!.v);
            let x = a!.v;
            if (x < UNO_TIMING.servoMinUs) {
              // Values below 544 are angles (Servo library): constrain to 0–180 and map.
              x = Math.max(0, Math.min(180, Math.trunc(x)));
              x = Math.trunc(((x - 0) * (s.max - s.min)) / 180) + s.min;
            }
            s.us = Math.max(s.min, Math.min(s.max, Math.trunc(x)));
            return v('void', 0);
          },
        },
        writeMicroseconds: {
          arity: [2, 2],
          ret: 'void',
          fn: ([h, us]) => {
            const s = servoOf(h!.v);
            s.us = Math.max(s.min, Math.min(s.max, Math.trunc(us!.v)));
            return v('void', 0);
          },
        },
        read: {
          arity: [1, 1],
          ret: 'int',
          fn: ([h]) => {
            const s = servoOf(h!.v);
            return v('int', Math.trunc(((s.us + 1 - s.min) * 180) / (s.max - s.min)));
          },
        },
        readMicroseconds: { arity: [1, 1], ret: 'int', fn: ([h]) => v('int', servoOf(h!.v).us) },
        attached: { arity: [1, 1], ret: 'bool', fn: ([h]) => v('bool', servoOf(h!.v).pin !== null ? 1 : 0) },
      },
    };
  }

  private printGen(text: string, newline: boolean): Gen<Value> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- generator functions cannot capture `this` lexically
    const self = this;
    return (function* () {
      const s = newline ? `${text}\r\n` : text;
      yield* self.print(s);
      return { t: 'uint', v: s.length } as Value;
    })();
  }
}
