/**
 * Discrete-event scheduler on SIMULATION time — integer nanoseconds held in a JS number
 * (exact up to 2^53 ns ≈ 104 days). Events run in (time, sequence) order, so equal-time
 * events run in the order they were scheduled: the simulation is deterministic and never
 * depends on browser frame timing.
 */
export type Ns = number;
export const NS_PER_S = 1e9;
export const sToNs = (s: number): Ns => Math.round(s * NS_PER_S);
export const nsToS = (ns: Ns): number => ns / NS_PER_S;

interface Ev {
  t: Ns;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

export interface EventHandle {
  cancel(): void;
  readonly t: Ns;
}

export class Scheduler {
  now: Ns = 0;
  /** Events executed (statistics). */
  executed = 0;
  private heap: Ev[] = [];
  private seq = 0;

  get pending(): number {
    return this.heap.length;
  }

  /** Schedule fn at absolute time t (≥ now). */
  at(t: Ns, fn: () => void): EventHandle {
    if (!(t >= this.now)) t = this.now;
    const ev: Ev = { t: Math.round(t), seq: this.seq++, fn, cancelled: false };
    this.push(ev);
    return {
      cancel: () => {
        ev.cancelled = true;
      },
      t: ev.t,
    };
  }

  after(dt: Ns, fn: () => void): EventHandle {
    return this.at(this.now + Math.max(0, dt), fn);
  }

  /** Time of the next pending event (Infinity if none). */
  peek(): Ns {
    while (this.heap.length && this.heap[0]!.cancelled) this.pop();
    return this.heap.length ? this.heap[0]!.t : Infinity;
  }

  /**
   * Run every event with time ≤ tEnd (inclusive when `inclusive`), then set now = tEnd.
   * maxEvents bounds the work (a runaway oscillation cannot freeze the caller).
   */
  runUntil(tEnd: Ns, inclusive = true, maxEvents = 5_000_000): { events: number; truncated: boolean } {
    let n = 0;
    for (;;) {
      const t = this.peek();
      if (t > tEnd || (!inclusive && t === tEnd)) break;
      if (n >= maxEvents) return { events: n, truncated: true };
      const ev = this.pop()!;
      this.now = ev.t;
      ev.fn();
      n++;
      this.executed++;
    }
    this.now = Math.max(this.now, tEnd);
    return { events: n, truncated: false };
  }

  clear(): void {
    this.heap = [];
    this.now = 0;
    this.seq = 0;
    this.executed = 0;
  }

  private less(a: Ev, b: Ev) {
    return a.t < b.t || (a.t === b.t && a.seq < b.seq);
  }
  private push(ev: Ev) {
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  private pop(): Ev | undefined {
    const h = this.heap;
    if (!h.length) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}
