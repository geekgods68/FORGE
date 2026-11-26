import { parseLine, type ChannelKind, type Message } from './protocol';

/**
 * Telemetry ingestion: protocol lines + host arrival times → per-channel time series with
 * explicit quality, plus link and synchronisation diagnostics. Pure and deterministic: the
 * host clock is passed in, so recordings replay bit-identically.
 *
 * Policies (all explicit):
 *  - duplicates (same unwrapped sequence number) are dropped and counted;
 *  - out-of-order messages are held for `reorderWindowMs` and released in sequence order;
 *    a message arriving after its slot was released is kept, flagged "late";
 *  - sequence gaps count as MISSING messages — nothing is invented for them;
 *  - an empty value is a MISSING sample (never zero, never a simulated value);
 *  - device time (millis, wrapping at 2³²) is unwrapped and mapped onto the host timeline by
 *    the clock fit; sample times come from the DEVICE clock (no transport jitter);
 *  - a device restart (hello + sequence/time reset) starts a new epoch.
 */
export interface PipelineOptions {
  reorderWindowMs: number;
  /** No message for this long while connected → "stale". */
  staleAfterMs: number;
  /** p95 transport latency above this → "delayed". */
  delayedAboveMs: number;
  /** Samples kept per channel (ring buffer; oldest dropped and counted). */
  capacity: number;
  /** Device-time span used for the clock fit (ms), and the bucket in which the least-delayed message is kept. */
  clockWindowMs: number;
  clockBucketMs: number;
}
export const DEFAULT_PIPELINE: PipelineOptions = {
  reorderWindowMs: 100,
  staleAfterMs: 500,
  delayedAboveMs: 250,
  capacity: 100_000,
  clockWindowMs: 30_000,
  clockBucketMs: 50,
};

export type Quality = 'ok' | 'missing' | 'late';
export const QUALITY_CODE: Record<Quality, number> = { ok: 0, missing: 1, late: 2 };
export type LinkState = 'waiting' | 'live' | 'delayed' | 'stale' | 'disconnected' | 'replay';

export interface ChannelInfo {
  id: string;
  kind: ChannelKind;
  unit: string;
  label: string;
}
export interface Series {
  /** Seconds on the host timeline (from the session start): device time mapped by the CURRENT clock fit. */
  t: number[];
  /** Unwrapped device time (ms) of each sample, as received. */
  dev: number[];
  /** Epoch of each sample (increments on a device restart). */
  epoch: number[];
  /** NaN = missing. */
  v: number[];
  quality: Quality[];
  seq: number[];
  dropped: number;
}
export interface ClockFit {
  n: number;
  /** host_ms ≈ offsetMs + (1 + driftPpm·1e-6) · device_ms (current epoch). */
  offsetMs: number;
  driftPpm: number;
  /** Transport latency above the lower envelope (ms): mean and 95th percentile. */
  latencyMeanMs: number;
  latencyP95Ms: number;
}
export interface PipelineStats {
  lines: number;
  valid: number;
  invalid: Record<string, number>;
  duplicates: number;
  late: number;
  reordered: number;
  missingMessages: number;
  missingValues: number;
  deviceErrors: Record<string, number>;
  statusMessages: number;
  epochs: number;
  undeclaredChannels: number;
}

interface Pending {
  seq: number;
  dev: number;
  host: number;
  m: Extract<Message, { type: 'data' | 'status' | 'error' }>;
}

export class TelemetryPipeline {
  readonly opts: PipelineOptions;
  device: { deviceId: string; firmware: string; firmwareVersion: string } | null = null;
  readonly channels = new Map<string, ChannelInfo>();
  private readonly raw = new Map<string, Series>();
  private fitVersion = 0;
  private cache: { version: number; map: Map<string, Series> } | null = null;
  private epochFits: ClockFit[] = [];
  readonly stats: PipelineStats = {
    lines: 0,
    valid: 0,
    invalid: {},
    duplicates: 0,
    late: 0,
    reordered: 0,
    missingMessages: 0,
    missingValues: 0,
    deviceErrors: {},
    statusMessages: 0,
    epochs: 0,
    undeclaredChannels: 0,
  };
  readonly events: { hostMs: number; kind: string; detail: string }[] = [];
  private open = false;
  private replay = false;
  private lastHost = -Infinity;
  private lastSeqU = -1; // highest unwrapped seq seen this epoch
  private released = -1; // highest released seq this epoch
  private seen = new Set<number>();
  private pending: Pending[] = [];
  private lastDevU = -1;
  private devBase = 0; // added to raw millis for unwrapping (k · 2³²)
  private clockPts: { dev: number; host: number }[] = [];
  private fit: ClockFit = { n: 0, offsetMs: 0, driftPpm: 0, latencyMeanMs: 0, latencyP95Ms: 0 };
  private epochHostStart = 0;

  constructor(
    readonly startHostMs: number,
    opts: Partial<PipelineOptions> = {},
  ) {
    this.opts = { ...DEFAULT_PIPELINE, ...opts };
  }

  setTransport(open: boolean, hostMs: number, replay = false) {
    if (open !== this.open)
      this.events.push({ hostMs, kind: open ? 'connected' : 'disconnected', detail: '' });
    this.open = open;
    this.replay = replay;
    if (!open) this.flush(Infinity);
  }

  ingestLine(line: string, hostMs: number) {
    this.stats.lines++;
    const r = parseLine(line);
    if (!r.ok) {
      this.stats.invalid[r.reason] = (this.stats.invalid[r.reason] ?? 0) + 1;
      return;
    }
    this.stats.valid++;
    this.lastHost = hostMs;
    const m = r.message;
    if (m.type === 'hello') {
      const changed = !this.device || this.device.deviceId !== m.deviceId;
      // A hello after data with a sequence reset marks a device restart (new epoch).
      if (this.device && !changed) {
        /* periodic re-announcement */
      } else if (this.device && changed)
        this.events.push({
          hostMs,
          kind: 'device-changed',
          detail: `${this.device.deviceId} → ${m.deviceId}`,
        });
      this.device = { deviceId: m.deviceId, firmware: m.firmware, firmwareVersion: m.firmwareVersion };
      return;
    }
    if (m.type === 'channel') {
      this.channels.set(m.id, { id: m.id, kind: m.kind, unit: m.unit, label: m.label });
      if (!this.raw.has(m.id))
        this.raw.set(m.id, { t: [], dev: [], epoch: [], v: [], quality: [], seq: [], dropped: 0 });
      return;
    }
    // Sequenced message.
    let su = this.unwrapSeq(m.seq);
    let du = this.unwrapDev(m.ms);
    // Restart: sequence and device time both jump far backwards.
    if (this.lastSeqU >= 0 && su < this.lastSeqU - 1000 && du < this.lastDevU - 1000) {
      this.flush(Infinity);
      this.newEpoch(hostMs);
      su = m.seq;
      du = m.ms;
    }
    if (this.seen.has(su)) {
      this.stats.duplicates++;
      return;
    }
    this.seen.add(su);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!); // oldest first
    if (su < this.lastSeqU) this.stats.reordered++;
    this.lastSeqU = Math.max(this.lastSeqU, su);
    this.lastDevU = Math.max(this.lastDevU, du);
    this.addClockPoint(du, hostMs);
    const p: Pending = { seq: su, dev: du, host: hostMs, m };
    if (su <= this.released) {
      this.stats.late++;
      this.emit(p, 'late');
      return;
    }
    this.pending.push(p);
    this.pending.sort((a, b) => a.seq - b.seq);
    this.flush(hostMs);
  }

  /** Release pending messages older than the reorder window (or all, with Infinity). */
  flush(hostMs: number) {
    while (this.pending.length) {
      const p = this.pending[0]!;
      const overdue = hostMs === Infinity || hostMs - p.host >= this.opts.reorderWindowMs;
      const contiguous = p.seq === this.released + 1 || this.released < 0;
      if (!overdue && !contiguous) break;
      this.pending.shift();
      if (this.released >= 0 && p.seq > this.released + 1) {
        const gap = p.seq - this.released - 1;
        this.stats.missingMessages += gap;
        this.events.push({
          hostMs: p.host,
          kind: 'gap',
          detail: `${gap} message(s) missing before seq ${p.seq}`,
        });
      }
      this.released = p.seq;
      this.emit(p, 'ok');
    }
  }

  private emit(p: Pending, q: Quality) {
    const m = p.m;
    if (m.type === 'status') {
      this.stats.statusMessages++;
      return;
    }
    if (m.type === 'error') {
      this.stats.deviceErrors[m.code] = (this.stats.deviceErrors[m.code] ?? 0) + 1;
      return;
    }
    for (const [id, value] of Object.entries(m.values)) {
      if (!this.channels.has(id)) {
        this.stats.undeclaredChannels++;
        continue;
      }
      const s = this.raw.get(id)!;
      const quality: Quality = value === null ? 'missing' : q;
      if (value === null) this.stats.missingValues++;
      // Keep series ordered by (epoch, device time); late samples are inserted in place.
      const ep = this.stats.epochs;
      let i = s.dev.length;
      while (i > 0 && (s.epoch[i - 1]! > ep || (s.epoch[i - 1]! === ep && s.dev[i - 1]! > p.dev))) i--;
      s.dev.splice(i, 0, p.dev);
      s.epoch.splice(i, 0, ep);
      s.v.splice(i, 0, value === null ? NaN : value);
      s.quality.splice(i, 0, quality);
      s.seq.splice(i, 0, p.seq);
      if (s.dev.length > this.opts.capacity) {
        s.dev.shift();
        s.epoch.shift();
        s.v.shift();
        s.quality.shift();
        s.seq.shift();
        s.dropped++;
      }
    }
    this.fitVersion++;
  }

  /** Per-channel series, with times mapped through each epoch's current clock fit. */
  get series(): Map<string, Series> {
    if (this.cache && this.cache.version === this.fitVersion) return this.cache.map;
    const map = new Map<string, Series>();
    for (const [id, s] of this.raw) {
      const t = s.dev.map((d, i) => {
        const f = s.epoch[i] === this.stats.epochs ? this.fit : (this.epochFits[s.epoch[i]!] ?? this.fit);
        return (f.offsetMs + (1 + f.driftPpm * 1e-6) * d - this.startHostMs) / 1000;
      });
      map.set(id, {
        ...s,
        t,
        dev: [...s.dev],
        epoch: [...s.epoch],
        v: [...s.v],
        quality: [...s.quality],
        seq: [...s.seq],
      });
    }
    this.cache = { version: this.fitVersion, map };
    return map;
  }

  private unwrapSeq(seq: number): number {
    if (this.lastSeqU < 0) return seq;
    const base = this.lastSeqU - (this.lastSeqU % 65536);
    const cands = [base - 65536 + seq, base + seq, base + 65536 + seq].filter((x) => x >= 0);
    return cands.reduce((a, b) => (Math.abs(b - this.lastSeqU) < Math.abs(a - this.lastSeqU) ? b : a));
  }
  private unwrapDev(ms: number): number {
    const W = 2 ** 32;
    let u = this.devBase + ms;
    if (this.lastDevU >= 0 && u < this.lastDevU - W / 2) {
      this.devBase += W;
      u += W;
    }
    return u;
  }
  private newEpoch(hostMs: number) {
    this.epochFits[this.stats.epochs] = this.fit;
    this.stats.epochs++;
    this.events.push({ hostMs, kind: 'device-restart', detail: 'sequence and device clock reset' });
    this.lastSeqU = -1;
    this.released = -1;
    this.seen.clear();
    this.lastDevU = -1;
    this.devBase = 0;
    this.clockPts = [];
    this.latencies = [];
    this.lastDevForLatency = [];
    this.epochHostStart = hostMs;
  }

  /**
   * Clock fit robust to transport jitter and independent of the message rate: device time
   * is divided into buckets (clockBucketMs); each bucket keeps its LEAST-delayed message
   * (smallest host − device offset). Over a sliding clockWindowMs of device time, the drift
   * is the least-squares slope through those minima and the offset is their lower
   * envelope, so latency = host − mapped ≥ 0 for every message.
   */
  private addClockPoint(dev: number, host: number) {
    const b = Math.floor(dev / this.opts.clockBucketMs);
    const last = this.clockPts[this.clockPts.length - 1];
    const lastB = last ? Math.floor(last.dev / this.opts.clockBucketMs) : null;
    if (last && lastB === b) {
      if (host - dev < last.host - last.dev) this.clockPts[this.clockPts.length - 1] = { dev, host };
    } else if (!last || dev > last.dev) this.clockPts.push({ dev, host });
    // Late (out-of-order) messages are not used for the fit.
    while (this.clockPts.length && this.clockPts[0]!.dev < dev - this.opts.clockWindowMs)
      this.clockPts.shift();
    this.latencies.push(host - dev);
    if (this.latencies.length > 2000) this.latencies.shift();
    this.lastDevForLatency.push(dev);
    if (this.lastDevForLatency.length > 2000) this.lastDevForLatency.shift();
    this.refit();
  }
  private latencies: number[] = [];
  private lastDevForLatency: number[] = [];
  private refit() {
    const pts = this.clockPts;
    const n = pts.length;
    this.fitVersion++;
    if (!n) return;
    let slope = 1;
    if (n >= 3) {
      const md = pts.reduce((a, x) => a + x.dev, 0) / n;
      const mo = pts.reduce((a, x) => a + (x.host - x.dev), 0) / n;
      let sxy = 0;
      let sxx = 0;
      for (const x of pts) {
        sxy += (x.dev - md) * (x.host - x.dev - mo);
        sxx += (x.dev - md) ** 2;
      }
      if (sxx > 0) slope = 1 + sxy / sxx;
    }
    let off = Infinity;
    for (const p of pts) off = Math.min(off, p.host - slope * p.dev);
    this.fit = {
      n: this.latencies.length,
      offsetMs: off,
      driftPpm: (slope - 1) * 1e6,
      latencyMeanMs: 0,
      latencyP95Ms: 0,
    };
    this.latencyCache = null;
  }
  private latencyCache: { mean: number; p95: number } | null = null;
  /** Latency of recent messages above the fitted lower envelope (computed on demand). */
  private latencyStats() {
    if (this.latencyCache) return this.latencyCache;
    const k = 1 + this.fit.driftPpm * 1e-6;
    const lat = this.latencies
      .map((o, i) => o + this.lastDevForLatency[i]! * (1 - k) - this.fit.offsetMs)
      .sort((a, b) => a - b);
    const m = lat.length;
    this.latencyCache = {
      mean: m ? Math.max(0, lat.reduce((a, b) => a + b, 0) / m) : 0,
      p95: m ? Math.max(0, lat[Math.min(m - 1, Math.floor(0.95 * m))]!) : 0,
    };
    return this.latencyCache;
  }
  toHost(devMs: number): number {
    return this.fit.offsetMs + (1 + this.fit.driftPpm * 1e-6) * devMs;
  }
  get clock(): ClockFit {
    const l = this.latencyStats();
    return { ...this.fit, latencyMeanMs: l.mean, latencyP95Ms: l.p95 };
  }

  linkState(hostMs: number): LinkState {
    if (this.replay) return 'replay';
    if (!this.open) return 'disconnected';
    if (!this.device && this.lastHost === -Infinity) return 'waiting';
    if (hostMs - this.lastHost > this.opts.staleAfterMs) return 'stale';
    if (this.fit.n >= 20 && this.latencyStats().p95 > this.opts.delayedAboveMs) return 'delayed';
    return 'live';
  }
  /** Latest valid sample of a channel, with its age; null when none. */
  latest(id: string, hostMs: number): { value: number; tS: number; ageMs: number; quality: Quality } | null {
    const s = this.series.get(id);
    if (!s) return null;
    for (let i = s.t.length - 1; i >= 0; i--)
      if (Number.isFinite(s.v[i]!))
        return {
          value: s.v[i]!,
          tS: s.t[i]!,
          ageMs: hostMs - (this.startHostMs + s.t[i]! * 1000),
          quality: s.quality[i]!,
        };
    return null;
  }
  get epochStartHostMs() {
    return this.epochHostStart;
  }
}

/**
 * Value of a series at time t under an explicit policy. Returns null (missing) when the
 * nearest valid samples are further apart than maxGapS — a gap is never bridged silently.
 */
export function valueAt(
  s: Pick<Series, 't' | 'v'>,
  tS: number,
  policy: 'hold' | 'linear',
  maxGapS: number,
): number | null {
  let lo = 0;
  let hi = s.t.length - 1;
  if (hi < 0 || tS < s.t[0]!) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.t[mid]! <= tS) lo = mid;
    else hi = mid - 1;
  }
  let i = lo;
  while (i >= 0 && !Number.isFinite(s.v[i]!)) i--;
  if (i < 0) return null;
  if (policy === 'hold') return tS - s.t[i]! <= maxGapS ? s.v[i]! : null;
  let j = lo + 1;
  while (j < s.t.length && !Number.isFinite(s.v[j]!)) j++;
  if (j >= s.t.length) return tS - s.t[i]! <= 1e-12 ? s.v[i]! : null;
  if (s.t[j]! - s.t[i]! > maxGapS) return null;
  const a = (tS - s.t[i]!) / (s.t[j]! - s.t[i]!);
  return s.v[i]! + a * (s.v[j]! - s.v[i]!);
}
