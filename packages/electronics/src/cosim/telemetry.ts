import type { ElectricalSettings } from '@forge/engineering-core';
import type { Ns } from '../digital/scheduler';
import type { Channel } from './devices';

/**
 * Bounded electrical/electromechanical telemetry: fixed-capacity ring buffers sampled on the
 * co-simulation clock (the same clock as the physics steps), so servo targets, measured joint
 * angles, sensor readings and supply voltages share one timeline. Each channel says what kind
 * of value it is (measured / commanded / true geometry / derived).
 */
export interface CosimMeta {
  runId: string;
  startedAt: string;
  engine: string;
  physicsEngine: string | null;
  project: { id: string; name: string; revision: number } | null;
  circuit: string;
  circuitHash: string;
  firmware: { id: string; name: string; revision: number; hash: string }[];
  settings: ElectricalSettings;
  physicsStepS: number | null;
  assumptions: string[];
}

export class CosimRecorder {
  channels: Channel[] = [];
  private t: Float64Array;
  private data: Float64Array[] = [];
  private head = 0;
  size = 0;
  dropped = 0;
  constructor(readonly capacity: number) {
    this.t = new Float64Array(capacity);
  }
  setChannels(ch: Channel[]) {
    this.channels = ch;
    this.data = ch.map(() => new Float64Array(this.capacity));
    this.head = 0;
    this.size = 0;
    this.dropped = 0;
  }
  push(t: Ns, row: Record<string, number>) {
    const i = (this.head + this.size) % this.capacity;
    if (this.size === this.capacity) {
      this.head = (this.head + 1) % this.capacity;
      this.dropped++;
    } else this.size++;
    this.t[i] = t / 1e9;
    this.channels.forEach((c, k) => (this.data[k]![i] = row[c.key] ?? NaN));
  }
  get bytes() {
    return this.capacity * 8 * (this.channels.length + 1);
  }
  series(key: string): { t: number[]; v: number[] } | null {
    const k = this.channels.findIndex((c) => c.key === key);
    if (k < 0) return null;
    const t: number[] = [];
    const v: number[] = [];
    for (let j = 0; j < this.size; j++) {
      const i = (this.head + j) % this.capacity;
      t.push(this.t[i]!);
      v.push(this.data[k]![i]!);
    }
    return { t, v };
  }
  toCSV(
    meta: CosimMeta,
    extra: { header: string[]; rows: (t: number) => (number | string)[] } | null = null,
  ): string {
    const lines = [
      `# FORGE electrical telemetry; run ${meta.runId}; ${meta.engine}; physics ${meta.physicsEngine ?? 'none'} (step ${meta.physicsStepS ?? '—'} s)`,
      `# circuit "${meta.circuit}" ${meta.circuitHash}; firmware ${meta.firmware.map((f) => `${f.name} rev ${f.revision} (${f.hash})`).join(', ') || 'none'}`,
      `# project ${meta.project ? `${meta.project.name} rev ${meta.project.revision}` : '—'}; started ${meta.startedAt}`,
      ...meta.assumptions.map((a) => `# assumption: ${a}`),
      [
        't_s',
        ...this.channels.map((c) => `${c.key} [${c.unit || '-'}] (${c.kind})`),
        ...(extra?.header ?? []),
      ].join(','),
    ];
    for (let j = 0; j < this.size; j++) {
      const i = (this.head + j) % this.capacity;
      const t = this.t[i]!;
      lines.push(
        [
          t.toFixed(9),
          ...this.data.map((d) => (Number.isFinite(d[i]!) ? String(d[i]) : '')),
          ...(extra?.rows(t) ?? []),
        ].join(','),
      );
    }
    return lines.join('\n') + '\n';
  }
  toJSON(meta: CosimMeta) {
    const s = (k: string) => this.series(k)!;
    return {
      meta,
      channels: this.channels,
      samples: this.size,
      dropped: this.dropped,
      t: Array.from({ length: this.size }, (_, j) => this.t[(this.head + j) % this.capacity]!),
      values: Object.fromEntries(
        this.channels.map((c) => [c.key, s(c.key).v.map((x) => (Number.isFinite(x) ? x : null))]),
      ),
    };
  }
}
