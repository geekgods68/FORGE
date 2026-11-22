import type { Project } from '@forge/engineering-core';
import type { Rapier } from '@forge/physics';
import { compareConditions, oatSensitivity, summarize, uncertaintySummary } from './analysis';
import { signalCatalog } from './catalog';
import { generatePlan, type Budget } from './design';
import type { ResearchCommand, ResearchEngine } from './engine';
import { exportExperiment } from './exchange';
import { simulationOfScene } from './params';
import { generateReport } from './report';
import { Campaign, type CampaignProgress } from './scheduler';
import type { Measurement, Variable } from './schemas';
import type { RunDataStore } from './store';
import type { ExperimentDraft } from './templates';
import { validateExperiment } from './validate';

/**
 * Programmatic research API (prepared for Vey integration, Phase 11; no LLM involvement here).
 * Persistent changes go through the validated ResearchEngine commands; execution has its own
 * lifecycle (Campaign) and never touches the engineering undo history.
 */
export class ResearchApi {
  private campaign: Campaign | null = null;
  constructor(
    readonly engine: ResearchEngine,
    readonly store: RunDataStore,
    private readonly project: () => Project,
    private readonly rapier: () => Promise<Rapier>,
    private readonly budget?: Budget,
  ) {}

  private exec(c: ResearchCommand) {
    return this.engine.execute(c);
  }
  create(draft: ExperimentDraft) {
    return this.exec({ type: 'experiment.create', payload: { experiment: draft } });
  }
  update(
    experimentId: string,
    patch: Extract<ResearchCommand, { type: 'experiment.update' }>['payload']['patch'],
  ) {
    return this.exec({ type: 'experiment.update', payload: { experimentId, patch } });
  }
  defineVariable(experimentId: string, variable: Variable) {
    return this.exec({ type: 'experiment.defineVariable', payload: { experimentId, variable } });
  }
  addMeasurement(experimentId: string, measurement: Measurement) {
    return this.exec({ type: 'experiment.addMeasurement', payload: { experimentId, measurement } });
  }
  createRunPlan(experimentId: string) {
    const e = this.engine.experiment(experimentId);
    if (!e) return null;
    return generatePlan(e, {
      stepS: simulationOfScene(this.project().scene)?.solver.timestepS ?? null,
      budget: this.budget,
    });
  }
  async validate(experimentId: string) {
    const e = this.engine.experiment(experimentId);
    if (!e) return null;
    const p = this.project();
    return validateExperiment(
      e,
      p,
      signalCatalog(p, e.protocol.model.kind, await this.rapier()),
      this.budget,
    );
  }
  async run(
    experimentId: string,
    opts: { retryFailed?: boolean; onProgress?: (p: CampaignProgress) => void } = {},
  ) {
    if (this.campaign && this.campaign.progress.phase === 'running')
      return { ok: false as const, error: 'A campaign is already running.' };
    const v = await this.validate(experimentId);
    if (!v?.ok) return { ok: false as const, error: v?.errors.join(' ') ?? 'No such experiment.' };
    this.campaign = new Campaign(this.engine, this.store, this.project(), experimentId, await this.rapier(), {
      budget: this.budget,
      retryFailed: opts.retryFailed,
      onProgress: opts.onProgress,
    });
    return { ok: true as const, progress: await this.campaign.run() };
  }
  cancel() {
    this.campaign?.cancel();
  }
  retry(experimentId: string, onProgress?: (p: CampaignProgress) => void) {
    return this.run(experimentId, { retryFailed: true, onProgress });
  }
  getStatus() {
    return this.campaign?.progress ?? null;
  }
  getResults(experimentId: string) {
    return this.engine.runsOf(experimentId);
  }
  compare(
    experimentId: string,
    measurementId: string,
    referenceCondition: string,
    comparisonCondition: string,
  ) {
    return compareConditions(
      this.engine.runsOf(experimentId),
      measurementId,
      referenceCondition,
      comparisonCondition,
    );
  }
  analyze(experimentId: string, measurementId: string, kind: 'summary' | 'sensitivity' | 'uncertainty') {
    const e = this.engine.experiment(experimentId);
    if (!e) return null;
    const runs = this.engine.runsOf(experimentId);
    return kind === 'summary'
      ? summarize(runs, measurementId)
      : kind === 'sensitivity'
        ? oatSensitivity(e, runs, measurementId)
        : uncertaintySummary(runs, measurementId);
  }
  async export(experimentId: string, withData = true) {
    return exportExperiment(this.engine.document, experimentId, withData ? this.store : null);
  }
  report(experimentId: string) {
    return generateReport(this.engine.document, experimentId);
  }
}
