import type { Project } from '@forge/engineering-core';
import type { Rapier } from '@forge/physics';
import { DEFAULT_BUDGET, generatePlan, type Budget, type Plan } from './design';
import type { ResearchEngine } from './engine';
import { simulationOfScene } from './params';
import { executeRun, type RunEnv } from './runner';
import type { RunRecord } from './schemas';
import type { RunDataStore } from './store';

/**
 * Campaign scheduler: executes an experiment's plan SEQUENTIALLY (one run at a time — the
 * development machine has 8 GB), persisting each run as soon as it finishes. Completed results
 * are never lost to a later failure or cancellation. Deterministic runs whose configuration hash
 * already has a COMPLETED record (same model fingerprint, configuration, seed and versions) are
 * reused, not rerun; anything that differs is rerun.
 */
export type CampaignPhase = 'idle' | 'running' | 'paused' | 'cancelled' | 'completed' | 'stopped';
export interface CampaignProgress {
  phase: CampaignPhase;
  total: number;
  done: number;
  completed: number;
  failed: number;
  reused: number;
  current: string | null;
  message: string | null;
  records: RunRecord[];
}

export interface CampaignOptions {
  budget?: Budget;
  retryFailed?: boolean;
  /** Free disk (bytes), where measurable; the campaign stops below budget.minFreeDiskBytes. */
  freeDiskBytes?: () => Promise<number | null>;
  onProgress?: (p: CampaignProgress) => void;
  env?: Omit<RunEnv, 'R' | 'isCancelled'>;
}

export class Campaign {
  readonly plan: Plan;
  progress: CampaignProgress;
  private cancelled = false;
  private pauseRequested = false;
  private readonly budget: Budget;
  constructor(
    readonly engine: ResearchEngine,
    readonly store: RunDataStore,
    /** Immutable snapshot of the project taken when the campaign was created. */
    readonly project: Project,
    readonly experimentId: string,
    readonly R: Rapier,
    readonly opts: CampaignOptions = {},
  ) {
    this.project = JSON.parse(JSON.stringify(project)) as Project;
    const e = engine.experiment(experimentId);
    if (!e) throw new Error(`No experiment ${experimentId}`);
    this.budget = opts.budget ?? DEFAULT_BUDGET;
    this.experiment = JSON.parse(JSON.stringify(e)) as typeof e; // frozen protocol for this campaign
    this.plan = generatePlan(this.experiment, {
      stepS: simulationOfScene(this.project.scene)?.solver.timestepS ?? null,
      budget: this.budget,
    });
    this.progress = {
      phase: 'idle',
      total: this.plan.runs.length,
      done: 0,
      completed: 0,
      failed: 0,
      reused: 0,
      current: null,
      message: null,
      records: [],
    };
  }
  readonly experiment: NonNullable<ReturnType<ResearchEngine['experiment']>>;

  cancel() {
    this.cancelled = true;
  }
  pause() {
    this.pauseRequested = true;
  }

  private emit(patch: Partial<CampaignProgress>) {
    this.progress = { ...this.progress, ...patch };
    this.opts.onProgress?.(this.progress);
  }

  async run(): Promise<CampaignProgress> {
    if (this.plan.errors.length) {
      this.emit({ phase: 'stopped', message: this.plan.errors.join(' ') });
      return this.progress;
    }
    this.cancelled = false;
    this.pauseRequested = false;
    this.emit({ phase: 'running', done: 0, completed: 0, failed: 0, reused: 0, records: [] });
    let written = await this.store.bytes();
    const conditions = new Map(this.plan.conditions.map((c) => [c.id, c]));
    for (const pr of this.plan.runs) {
      if (this.cancelled) return this.end('cancelled', 'Cancelled: completed runs are kept.');
      if (this.pauseRequested)
        return this.end('paused', 'Paused: resume to continue with the remaining runs.');
      const disk = await this.opts.freeDiskBytes?.();
      if (disk !== null && disk !== undefined && disk < this.budget.minFreeDiskBytes)
        return this.end(
          'stopped',
          `Free disk ${(disk / 1024 ** 3).toFixed(1)} GiB is below the ${(this.budget.minFreeDiskBytes / 1024 ** 3).toFixed(0)} GiB safety floor: the campaign stopped.`,
        );
      const cond = conditions.get(pr.conditionId)!;
      this.emit({ current: `${cond.label} · replicate ${pr.replicate + 1}` });
      const prior = this.engine
        .runsOf(this.experimentId)
        .filter(
          (r) => r.conditionId === cond.id && r.replicate === pr.replicate && r.config.seed === pr.seed,
        );
      const latest = prior[prior.length - 1];
      const res = await executeRunCached(this, cond, pr, prior, latest);
      if (res.record === 'reused') {
        const rr = (res as { reusedRecord: RunRecord }).reusedRecord;
        this.emit({
          done: this.progress.done + 1,
          reused: this.progress.reused + 1,
          records: [...this.progress.records, rr],
        });
        continue;
      }
      const { record, data } = res as {
        record: RunRecord;
        data: Awaited<ReturnType<typeof executeRun>>['data'];
      };
      if (data && record.data) {
        if (written + record.data.bytes > this.budget.maxStorageBytes)
          return this.end(
            'stopped',
            `Storage budget (${(this.budget.maxStorageBytes / 1e6).toFixed(0)} MB) reached: the campaign stopped; completed runs are kept.`,
          );
        await this.store.put(record.data.key, data);
        written += record.data.bytes;
      }
      const r = this.engine.recordRun(record);
      if (!r.ok) return this.end('stopped', `Could not record run: ${r.error}`);
      const ok = record.state === 'COMPLETED';
      this.emit({
        done: this.progress.done + 1,
        completed: this.progress.completed + (ok ? 1 : 0),
        failed: this.progress.failed + (ok ? 0 : 1),
        records: [...this.progress.records, record],
      });
      if (record.state === 'CANCELLED')
        return this.end('cancelled', 'Cancelled during a run: completed runs are kept.');
    }
    return this.end('completed', null);
  }

  private end(phase: CampaignPhase, message: string | null) {
    this.emit({ phase, current: null, message });
    return this.progress;
  }
}

async function executeRunCached(
  c: Campaign,
  cond: Parameters<typeof executeRun>[2],
  pr: Parameters<typeof executeRun>[3],
  prior: RunRecord[],
  latest: RunRecord | undefined,
) {
  const env = {
    ...c.opts.env,
    R: c.R,
    isCancelled: () => (c as unknown as { cancelled: boolean }).cancelled,
    maxWallMs: c.opts.budget?.maxWallMsPerRun,
    maxSamplesPerRun: c.opts.budget?.maxSamplesPerRun,
  };
  const retryOf = latest && latest.state !== 'COMPLETED' && c.opts.retryFailed ? latest.id : null;
  // Reuse an identical COMPLETED configuration (same model fingerprint, configuration, seed and
  // versions) without simulating; an identical FAILED one is only rerun when retry is requested.
  const res = await executeRun(c.project, c.experiment, cond, pr, env, retryOf, (hash) =>
    prior.find((p) => p.configHash === hash && (p.state === 'COMPLETED' || !c.opts.retryFailed)),
  );
  if (res.reused) return { record: 'reused' as const, data: null, reusedRecord: res.record };
  return res;
}
