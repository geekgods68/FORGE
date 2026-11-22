import type { ElectricalDefinition } from '@forge/engineering-core';
import { evalGate, type Logic, type Thresholds } from './logic';
import type { SignalNetwork } from './network';
import type { EventHandle, Scheduler } from './scheduler';

/**
 * Behavioural logic primitives (ideal CMOS-style parts referenced to the circuit ground):
 * gates with INERTIAL propagation delay (pulses shorter than the delay are filtered), a
 * rising-edge D flip-flop, a synchronous counter and an ideal clock/PWM source. Outputs
 * drive V_OH = logicV; on mixed nets they are modelled as sources behind 10 Ω.
 * Power-on state of flip-flops and counters is 0 (an idealisation; real parts power up
 * undefined).
 */
export const LOGIC_OUTPUT_OHM = 10;
export const cmosThresholds = (v: number): Thresholds => ({ vil: 0.3 * v, vih: 0.7 * v });

class Output {
  private pending: EventHandle | null = null;
  private scheduled: Logic | null = null;
  current: Logic = 'Z';
  constructor(
    private readonly net: SignalNetwork,
    private readonly sched: Scheduler,
    private readonly partId: string,
    private readonly pin: string,
    private readonly vHigh: number,
    private readonly ref: number,
  ) {}
  /** Inertial delay: a newer evaluation replaces a pending one. */
  set(level: Logic, delayNs: number) {
    if (this.pending) {
      this.pending.cancel();
      this.pending = null;
      this.scheduled = null;
    }
    if (level === this.current) return;
    this.scheduled = level;
    this.pending = this.sched.after(delayNs, () => {
      this.pending = null;
      this.current = this.scheduled!;
      this.net.drive(this.partId, this.pin, this.current, {
        vHigh: this.vHigh,
        rOut: LOGIC_OUTPUT_OHM,
        refNet: this.ref,
      });
    });
  }
}

export function attachLogicDevices(
  def: ElectricalDefinition,
  net: SignalNetwork,
  sched: Scheduler,
): (() => void)[] {
  const ref = net.netlist.ground;
  const cleanups: (() => void)[] = [];
  for (const p of def.parts) {
    const d = p.device;
    if (d.type === 'logic-gate') {
      const th = cmosThresholds(d.logicV);
      const out = new Output(net, sched, p.id, 'out', d.logicV, ref);
      const pins = Array.from({ length: d.inputs }, (_, i) => `in${i + 1}`);
      const evaluate = () =>
        out.set(
          evalGate(
            d.op,
            pins.map((pin) => net.read(p.id, pin, th, ref)),
          ),
          d.delayNs,
        );
      for (const pin of pins) cleanups.push(net.watch(p.id, pin, th, ref, evaluate));
      sched.at(0, evaluate);
    } else if (d.type === 'dff') {
      const th = cmosThresholds(d.logicV);
      const q = new Output(net, sched, p.id, 'q', d.logicV, ref);
      const qn = new Output(net, sched, p.id, 'qn', d.logicV, ref);
      let state: Logic = '0';
      let clk: Logic = net.read(p.id, 'clk', th, ref);
      const emit = () => {
        q.set(state, d.delayNs);
        qn.set(state === '0' ? '1' : state === '1' ? '0' : 'X', d.delayNs);
      };
      cleanups.push(
        net.watch(p.id, 'clk', th, ref, (l) => {
          const prev = clk;
          clk = l;
          if (prev === '0' && l === '1') {
            const dv = net.read(p.id, 'd', th, ref);
            state = dv === '0' || dv === '1' ? dv : 'X';
            emit();
          } else if ((prev === '0' && l === 'X') || (prev === 'X' && l === '1')) {
            if (net.read(p.id, 'd', th, ref) !== state) {
              state = 'X';
              emit();
            }
          }
        }),
      );
      sched.at(0, emit);
    } else if (d.type === 'counter') {
      const th = cmosThresholds(d.logicV);
      const outs = Array.from(
        { length: d.bits },
        (_, i) => new Output(net, sched, p.id, `q${i}`, d.logicV, ref),
      );
      let count: number | null = 0;
      let clk: Logic = net.read(p.id, 'clk', th, ref);
      const emit = () =>
        outs.forEach((o, i) => o.set(count === null ? 'X' : (count >> i) & 1 ? '1' : '0', d.delayNs));
      cleanups.push(
        net.watch(p.id, 'clk', th, ref, (l) => {
          const prev = clk;
          clk = l;
          if (!(prev === '0' && l === '1')) return;
          const rst = net.read(p.id, 'rst', th, ref);
          if (rst === '1') count = 0;
          else if (rst === '0') count = count === null ? null : (count + 1) % 2 ** d.bits;
          else count = null;
          emit();
        }),
      );
      sched.at(0, emit);
    } else if (d.type === 'clock') {
      const periodNs = 1e9 / d.frequencyHz;
      const highNs = d.duty * periodNs;
      const drive = (l: Logic) =>
        net.drive(p.id, 'out', l, { vHigh: d.logicV, rOut: LOGIC_OUTPUT_OHM, refNet: ref });
      let stopped = false;
      // Edge times are computed from the cycle index (no accumulated rounding drift).
      const cycle = (k: number) => {
        if (stopped) return;
        const t0 = Math.round(k * periodNs);
        sched.at(t0, () => {
          if (stopped) return;
          if (d.duty > 0) drive('1');
          if (d.duty < 1)
            sched.at(Math.round(k * periodNs + highNs), () => {
              if (!stopped) drive('0');
            });
          cycle(k + 1);
        });
      };
      if (d.duty === 0) sched.at(0, () => drive('0'));
      cycle(0);
      cleanups.push(() => {
        stopped = true;
      });
    }
  }
  return cleanups;
}
