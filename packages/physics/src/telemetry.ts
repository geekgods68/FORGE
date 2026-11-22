/**
 * Bounded simulation telemetry (docs/SIMULATION_TELEMETRY.md). Samples are stored in one
 * preallocated Float64Array ring buffer: when it is full the OLDEST samples are overwritten
 * and counted as dropped, so a long run never grows memory. Events (warnings, contacts,
 * faults) are kept in a separate bounded list.
 *
 * Every channel states what it is:
 *   measured   — read from the simulation state (positions, velocities, joint angles, drift)
 *   commanded  — what the controller asked for (targets, raw command)
 *   applied    — what was actually applied after saturation
 *   configured — an input setting (payload mass)
 */
export type ChannelKind = 'measured' | 'commanded' | 'applied' | 'configured';
export interface Channel {
  key: string;
  label: string;
  unit: string;
  kind: ChannelKind;
  group: string;
}

export type EventSeverity = 'info' | 'warning' | 'fault';
export interface SimEvent {
  t: number;
  kind: string;
  severity: EventSeverity;
  message: string;
  refs: string[];
}

export interface RunMetadata {
  runId: string;
  createdAt: string;
  engine: { name: 'rapier3d-compat'; version: string };
  solver: { timestepS: number; substeps: number; solverIterations: number; maxCatchUpSteps: number };
  gravity: [number, number, number] | null;
  project: { id: string; name: string; revision: number };
  simulationName: string;
  sampleRateHz: number;
  assumptions: { topic: string; status: string; text: string }[];
  /** Validity of the run as a whole (the weakest input model; docs/SIMULATION_VALIDITY.md). */
  status: 'approximate';
}

export class TelemetryRecorder {
  readonly channels: readonly Channel[];
  readonly capacity: number;
  private readonly data: Float64Array;
  private readonly width: number;
  private head = 0; // next write slot
  private count = 0;
  dropped = 0;
  readonly events: SimEvent[] = [];
  eventsDropped = 0;
  readonly maxEvents: number;

  constructor(channels: readonly Channel[], capacity: number, maxEvents = 2000) {
    this.channels = channels;
    this.capacity = capacity;
    this.width = channels.length + 1;
    this.data = new Float64Array(capacity * this.width);
    this.maxEvents = maxEvents;
  }

  get size(): number {
    return this.count;
  }
  get bytes(): number {
    return this.data.byteLength;
  }

  record(t: number, values: ArrayLike<number>): void {
    const o = this.head * this.width;
    this.data[o] = t;
    for (let i = 0; i < this.channels.length; i++) this.data[o + 1 + i] = values[i] ?? Number.NaN;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    else this.dropped++;
  }

  event(e: SimEvent): void {
    if (this.events.length >= this.maxEvents) {
      this.events.shift();
      this.eventsDropped++;
    }
    this.events.push(e);
  }

  private slot(i: number): number {
    const start = this.count < this.capacity ? 0 : this.head;
    return ((start + i) % this.capacity) * this.width;
  }

  /** Time and values of one channel, oldest first. */
  series(key: string): { t: Float64Array; v: Float64Array } {
    const c = this.channels.findIndex((x) => x.key === key);
    const t = new Float64Array(this.count);
    const v = new Float64Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const o = this.slot(i);
      t[i] = this.data[o]!;
      v[i] = c >= 0 ? this.data[o + 1 + c]! : Number.NaN;
    }
    return { t, v };
  }

  latest(key: string): number | null {
    if (!this.count) return null;
    const c = this.channels.findIndex((x) => x.key === key);
    if (c < 0) return null;
    return this.data[this.slot(this.count - 1) + 1 + c]!;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.dropped = 0;
    this.events.length = 0;
    this.eventsDropped = 0;
  }

  toCSV(meta: RunMetadata): string {
    const q = (s: string) => (/[",\n#]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [
      `# FORGE simulation telemetry — run ${meta.runId}`,
      `# created ${meta.createdAt}; ${meta.engine.name} ${meta.engine.version}; step ${meta.solver.timestepS} s × ${meta.solver.substeps} substeps, ${meta.solver.solverIterations} iterations`,
      `# project ${q(meta.project.name)} (${meta.project.id}) revision ${meta.project.revision}; status: ${meta.status} (see docs/SIMULATION_VALIDITY.md)`,
      `# samples ${this.count}${this.dropped ? ` (oldest ${this.dropped} overwritten by the bounded buffer)` : ''}`,
      ['t [s]', ...this.channels.map((c) => q(`${c.label} [${c.unit}] (${c.kind})`))].join(','),
    ];
    for (let i = 0; i < this.count; i++) {
      const o = this.slot(i);
      const row: string[] = [];
      for (let k = 0; k < this.width; k++) {
        const v = this.data[o + k]!;
        row.push(Number.isFinite(v) ? String(+v.toPrecision(9)) : '');
      }
      lines.push(row.join(','));
    }
    return lines.join('\n') + '\n';
  }

  toJSON(meta: RunMetadata): {
    format: 'forge-telemetry';
    version: 1;
    meta: RunMetadata;
    channels: readonly Channel[];
    t: number[];
    values: Record<string, (number | null)[]>;
    events: SimEvent[];
    dropped: { samples: number; events: number };
  } {
    const t: number[] = [];
    const values: Record<string, (number | null)[]> = Object.fromEntries(
      this.channels.map((c) => [c.key, []]),
    );
    for (let i = 0; i < this.count; i++) {
      const o = this.slot(i);
      t.push(this.data[o]!);
      this.channels.forEach((c, k) => {
        const v = this.data[o + 1 + k]!;
        values[c.key]!.push(Number.isFinite(v) ? v : null);
      });
    }
    return {
      format: 'forge-telemetry',
      version: 1,
      meta,
      channels: this.channels,
      t,
      values,
      events: [...this.events],
      dropped: { samples: this.dropped, events: this.eventsDropped },
    };
  }
}
