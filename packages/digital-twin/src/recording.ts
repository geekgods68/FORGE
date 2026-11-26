import { canonicalJson, sha256 } from '@forge/engineering-core';
import { datasetRecord, type Dataset, type ParsedDataset } from '@forge/research';
import type { AdapterKind } from './adapters';
import { toModel } from './mapping';
import { TelemetryPipeline, type ChannelInfo, type PipelineOptions, type PipelineStats } from './pipeline';
import type { Twin } from './schemas';

/**
 * Recordings keep the RAW protocol lines with their host arrival offsets (and transport
 * transitions). Replaying them through a fresh pipeline reproduces every series, statistic
 * and diagnostic exactly — the recording, not a processed copy, is the observation.
 */
export const RECORDING_FORMAT = 'forge-twin-recording' as const;
export interface Recording {
  format: typeof RECORDING_FORMAT;
  version: 1;
  id: string;
  twinId: string;
  /** True for generated (synthetic) data — never presented as a physical measurement. */
  synthetic: boolean;
  adapter: AdapterKind;
  device: { deviceId: string; firmware: string; firmwareVersion: string } | null;
  channels: ChannelInfo[];
  startedAt: string;
  durationMs: number;
  /** [host ms since start, line] and [host ms, open] transitions. */
  lines: [number, string][];
  transport: [number, boolean][];
  stats: PipelineStats;
  hash: string;
}

export class Recorder {
  private lines: [number, string][] = [];
  private transport: [number, boolean][] = [];
  constructor(
    readonly t0HostMs: number,
    readonly meta: {
      id: string;
      twinId: string;
      adapter: AdapterKind;
      synthetic: boolean;
      startedAt: string;
    },
    private readonly maxLines = 500_000,
  ) {}
  line(text: string, hostMs: number) {
    if (this.lines.length < this.maxLines) this.lines.push([hostMs - this.t0HostMs, text]);
  }
  state(open: boolean, hostMs: number) {
    this.transport.push([hostMs - this.t0HostMs, open]);
  }
  get size() {
    return this.lines.length;
  }
  finish(p: TelemetryPipeline): Recording {
    const body = {
      format: RECORDING_FORMAT,
      version: 1 as const,
      ...this.meta,
      device: p.device,
      channels: [...p.channels.values()],
      durationMs: this.lines.length ? this.lines[this.lines.length - 1]![0] : 0,
      lines: this.lines,
      transport: this.transport,
      stats: structuredCloneStats(p.stats),
    };
    return {
      ...body,
      hash: `sha256-${sha256(canonicalJson({ lines: body.lines, transport: body.transport, synthetic: body.synthetic }))}`,
    };
  }
}
function structuredCloneStats(s: PipelineStats): PipelineStats {
  return JSON.parse(JSON.stringify(s)) as PipelineStats;
}

export function verifyRecording(r: Recording): boolean {
  return (
    r.hash ===
    `sha256-${sha256(canonicalJson({ lines: r.lines, transport: r.transport, synthetic: r.synthetic }))}`
  );
}

/** Deterministic replay: identical inputs → identical pipeline state. */
export function replay(
  r: Recording,
  opts: Partial<PipelineOptions> = {},
  untilMs = Infinity,
): TelemetryPipeline {
  const p = new TelemetryPipeline(0, opts);
  const events: [number, () => void][] = [
    ...r.transport.map(([h, open]) => [h, () => p.setTransport(open, h)] as [number, () => void]),
    ...r.lines.map(([h, l]) => [h, () => p.ingestLine(l, h)] as [number, () => void]),
  ];
  if (!r.transport.length) p.setTransport(true, 0);
  events.sort((a, b) => a[0] - b[0]);
  for (const [h, f] of events) {
    if (h > untilMs) break;
    f();
  }
  p.flush(Infinity);
  return p;
}

/**
 * Phase 7 dataset from a recording: one row per data message, columns in MODEL units for
 * the twin's measured channels (commanded/estimated channels are excluded: they are not
 * observations). Provenance carries the synthetic flag and the recording hash.
 */
export function recordingToDataset(r: Recording, twin: Twin, id: string, now = new Date()) {
  const p = replay(r);
  const measured = twin.channels.filter((m) => m.kind === 'measured' && p.series.has(m.channel));
  if (!measured.length)
    return { error: 'The recording has no measured channel mapped by this twin.' } as const;
  const times = [...new Set(measured.flatMap((m) => p.series.get(m.channel)!.t))].sort((a, b) => a - b);
  const index = new Map(times.map((t, i) => [t, i]));
  const values = [Float64Array.from(times)];
  const columns: ParsedDataset['columns'] = [{ name: 't', unit: 's', uncertainty: null }];
  for (const m of measured) {
    const col = new Float64Array(times.length).fill(NaN);
    const s = p.series.get(m.channel)!;
    s.t.forEach((t, i) => {
      if (Number.isFinite(s.v[i]!)) col[index.get(t)!] = toModel(m, s.v[i]!);
    });
    values.push(col);
    const u = twin.uncertainties.find((x) => x.channel === m.channel);
    columns.push({ name: m.channel, unit: m.modelUnit, uncertainty: u ? u.sd : null });
  }
  const parsed: ParsedDataset = {
    ok: true,
    errors: [],
    warnings: [],
    timeColumn: 't',
    columns,
    rows: times.length,
    values,
  };
  const rec = datasetRecord(
    id,
    `${twin.name} recording ${r.startedAt}`,
    'manual',
    parsed,
    {
      origin: `FORGE twin recording ${r.id} (${r.hash})`,
      instrument: r.synthetic
        ? 'synthetic telemetry adapter'
        : `${r.device?.deviceId ?? 'unknown device'} via ${r.adapter} (${r.device?.firmware ?? ''} ${r.device?.firmwareVersion ?? ''})`,
      collectedAt: r.startedAt,
      operator: '',
      notes: r.synthetic
        ? 'SYNTHETIC: generated by FORGE, not measured.'
        : 'Physical observation recorded by FORGE.',
      synthetic: r.synthetic,
    },
    now,
  );
  return rec as { record: Dataset; data: { signals: ReturnType<typeof datasetRecord>['data']['signals'] } };
}
