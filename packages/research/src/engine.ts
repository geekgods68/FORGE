import { z } from 'zod';
import { hashOfValue } from './hash';
import {
  CalibrationRecordSchema,
  DatasetSchema,
  DesignSchema,
  emptyResearchDocument,
  ExperimentBaseSchema,
  ExperimentSchema,
  HypothesisSchema,
  MeasurementSchema,
  NoteSchema,
  ProtocolSchema,
  RESEARCH_SCHEMA_VERSION,
  ResearchDocumentSchema,
  RunRecordSchema,
  ValidationRecordSchema,
  VariableSchema,
  type CalibrationRecord,
  type Dataset,
  type Experiment,
  type ResearchDocument,
  type RunRecord,
  type RunState,
  type ValidationRecord,
} from './schemas';

/**
 * ResearchEngine: the single authority over a project's research document.
 *
 *  - PROTOCOL edits are validated `experiment.*` commands with their own undo/redo history
 *    (never the engineering project's history). Each change re-validates the whole experiment
 *    and increments its revision.
 *  - RESULTS (run records, datasets, calibrations, validations) are APPEND-ONLY: validated,
 *    integrity-hashed, never edited or undone. A retry is a new record.
 */
const Patch = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000),
    researchQuestion: z.string().max(2000),
    mode: z.enum(['hypothesis', 'exploratory']),
    hypothesis: HypothesisSchema.nullable(),
    protocol: ProtocolSchema.partial(),
    design: DesignSchema.partial(),
    successCriteria: ExperimentBaseSchema.shape.successCriteria,
    limitations: z.array(z.string().max(1000)).max(64),
  })
  .partial();

export const RESEARCH_COMMANDS = {
  'experiment.create': z.object({
    experiment: ExperimentBaseSchema.omit({
      createdAt: true,
      updatedAt: true,
      revision: true,
      schemaVersion: true,
    }),
  }),
  'experiment.update': z.object({ experimentId: z.string(), patch: Patch }),
  'experiment.delete': z.object({ experimentId: z.string() }),
  'experiment.defineVariable': z.object({ experimentId: z.string(), variable: VariableSchema }),
  'experiment.removeVariable': z.object({ experimentId: z.string(), variableId: z.string() }),
  'experiment.addMeasurement': z.object({ experimentId: z.string(), measurement: MeasurementSchema }),
  'experiment.removeMeasurement': z.object({ experimentId: z.string(), measurementId: z.string() }),
  'experiment.note.set': z.object({
    experimentId: z.string(),
    note: NoteSchema.omit({ createdAt: true, updatedAt: true }),
  }),
  'experiment.note.delete': z.object({ experimentId: z.string(), noteId: z.string() }),
} as const;
export type ResearchCommandType = keyof typeof RESEARCH_COMMANDS;
export type ResearchCommand = {
  [K in ResearchCommandType]: { type: K; payload: z.input<(typeof RESEARCH_COMMANDS)[K]> };
}[ResearchCommandType];
export type ResearchResult = { ok: true; experimentId: string | null } | { ok: false; error: string };

/** Allowed run-state transitions (validated state machine). */
export const RUN_TRANSITIONS: Record<RunState, RunState[]> = {
  CREATED: ['VALIDATED', 'INVALID', 'CANCELLED'],
  VALIDATED: ['QUEUED', 'CANCELLED', 'INVALID'],
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: [],
  INVALID: [],
};
export function checkHistory(h: { state: RunState }[]): string | null {
  for (let i = 1; i < h.length; i++)
    if (!RUN_TRANSITIONS[h[i - 1]!.state].includes(h[i]!.state))
      return `invalid transition ${h[i - 1]!.state} → ${h[i]!.state}`;
  return null;
}

/** Integrity hash of a record (all fields except the hash itself). */
export function integrityOf<T extends { integrityHash: string }>(r: T): string {
  const { integrityHash: _h, ...rest } = r;
  return hashOfValue(rest);
}
export function verifyIntegrity<T extends { integrityHash: string }>(r: T): boolean {
  return integrityOf(r) === r.integrityHash;
}

export class ResearchEngine {
  private doc: ResearchDocument;
  private undoStack: ResearchDocument[] = [];
  private redoStack: ResearchDocument[] = [];
  private listeners = new Set<() => void>();
  constructor(
    doc: ResearchDocument,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.doc = ResearchDocumentSchema.parse(doc);
  }

  static empty(projectId: string, now?: () => Date) {
    return new ResearchEngine(emptyResearchDocument(projectId, now?.()), now);
  }

  get document(): ResearchDocument {
    return this.doc;
  }
  experiment(id: string): Experiment | undefined {
    return this.doc.experiments.find((e) => e.id === id);
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  execute(cmd: ResearchCommand): ResearchResult {
    const schema = RESEARCH_COMMANDS[cmd.type];
    const parsed = schema.safeParse(cmd.payload);
    if (!parsed.success)
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
    const p = parsed.data as Record<string, unknown>;
    const stamp = this.now().toISOString();
    const exps = [...this.doc.experiments];
    const idx = (id: unknown) => exps.findIndex((e) => e.id === id);
    let changed: Experiment | null = null;
    let affected: string | null = null;
    const touch = (i: number, next: Omit<Experiment, 'updatedAt' | 'revision'> & Partial<Experiment>) => {
      const prev = exps[i]!;
      changed = { ...next, updatedAt: stamp, revision: prev.revision + 1 } as Experiment;
      exps[i] = changed;
      affected = prev.id;
    };
    switch (cmd.type) {
      case 'experiment.create': {
        const e = p.experiment as Omit<Experiment, 'createdAt' | 'updatedAt' | 'revision' | 'schemaVersion'>;
        if (idx(e.id) >= 0) return { ok: false, error: `Experiment "${e.id}" already exists.` };
        changed = {
          ...e,
          schemaVersion: RESEARCH_SCHEMA_VERSION,
          createdAt: stamp,
          updatedAt: stamp,
          revision: 1,
        };
        exps.push(changed);
        affected = e.id;
        break;
      }
      case 'experiment.delete': {
        const i = idx(p.experimentId);
        if (i < 0) return { ok: false, error: 'No such experiment.' };
        if (this.doc.runs.some((r) => r.experimentId === p.experimentId))
          return {
            ok: false,
            error:
              'This experiment has recorded runs; their records are kept and the experiment cannot be deleted.',
          };
        exps.splice(i, 1);
        break;
      }
      default: {
        const i = idx(p.experimentId);
        if (i < 0) return { ok: false, error: 'No such experiment.' };
        const e = exps[i]!;
        if (cmd.type === 'experiment.update') {
          const patch = p.patch as z.infer<typeof Patch>;
          touch(i, {
            ...e,
            ...patch,
            protocol: { ...e.protocol, ...patch.protocol },
            design: { ...e.design, ...patch.design },
          });
        } else if (cmd.type === 'experiment.defineVariable') {
          const v = p.variable as Experiment['variables'][number];
          touch(i, { ...e, variables: [...e.variables.filter((x) => x.id !== v.id), v] });
        } else if (cmd.type === 'experiment.removeVariable') {
          if (!e.variables.some((x) => x.id === p.variableId))
            return { ok: false, error: 'No such variable.' };
          touch(i, { ...e, variables: e.variables.filter((x) => x.id !== p.variableId) });
        } else if (cmd.type === 'experiment.addMeasurement') {
          const m = p.measurement as Experiment['measurements'][number];
          touch(i, { ...e, measurements: [...e.measurements.filter((x) => x.id !== m.id), m] });
        } else if (cmd.type === 'experiment.removeMeasurement') {
          if (!e.measurements.some((x) => x.id === p.measurementId))
            return { ok: false, error: 'No such measurement.' };
          touch(i, { ...e, measurements: e.measurements.filter((x) => x.id !== p.measurementId) });
        } else if (cmd.type === 'experiment.note.set') {
          const n = p.note as Omit<Experiment['notebook'][number], 'createdAt' | 'updatedAt'>;
          const prev = e.notebook.find((x) => x.id === n.id);
          const note = { ...n, createdAt: prev?.createdAt ?? stamp, updatedAt: stamp };
          // Notes are interpretation: they never change the protocol revision.
          exps[i] = { ...e, notebook: [...e.notebook.filter((x) => x.id !== n.id), note], updatedAt: stamp };
          changed = exps[i]!;
          affected = e.id;
        } else if (cmd.type === 'experiment.note.delete') {
          exps[i] = { ...e, notebook: e.notebook.filter((x) => x.id !== p.noteId), updatedAt: stamp };
          changed = exps[i]!;
          affected = e.id;
        }
      }
    }
    if (changed) {
      const v = ExperimentSchema.safeParse(changed);
      if (!v.success)
        return {
          ok: false,
          error: v.error.issues.map((x) => `${x.path.join('.') || 'experiment'}: ${x.message}`).join('; '),
        };
    }
    this.undoStack.push(this.doc);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.doc = { ...this.doc, experiments: exps, updatedAt: stamp };
    this.emit();
    return { ok: true, experimentId: affected };
  }

  /** Undo the last PROTOCOL change. Recorded results are never removed by undo. */
  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.doc);
    this.doc = { ...this.doc, experiments: prev.experiments };
    this.emit();
    return true;
  }
  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.doc);
    this.doc = { ...this.doc, experiments: next.experiments };
    this.emit();
    return true;
  }

  // -- append-only results --------------------------------------------------------------------
  private append<K extends 'runs' | 'datasets' | 'calibrations' | 'validations'>(
    key: K,
    rec: ResearchDocument[K][number],
    schema: z.ZodType,
  ): { ok: true } | { ok: false; error: string } {
    const v = schema.safeParse(rec);
    if (!v.success)
      return { ok: false, error: v.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') };
    const list = this.doc[key] as { id: string }[];
    if (list.some((x) => x.id === (rec as { id: string }).id))
      return { ok: false, error: `Record "${(rec as { id: string }).id}" already exists and is immutable.` };
    if ('integrityHash' in (rec as object) && !verifyIntegrity(rec as { integrityHash: string }))
      return { ok: false, error: 'Integrity hash does not match the record.' };
    this.doc = { ...this.doc, [key]: [...list, rec], updatedAt: this.now().toISOString() };
    this.emit();
    return { ok: true };
  }
  recordRun(r: RunRecord) {
    const bad = checkHistory(r.history);
    if (bad) return { ok: false as const, error: bad };
    return this.append('runs', r, RunRecordSchema);
  }
  recordDataset(d: Dataset) {
    return this.append('datasets', d, DatasetSchema);
  }
  recordCalibration(c: CalibrationRecord) {
    return this.append('calibrations', c, CalibrationRecordSchema);
  }
  recordValidation(v: ValidationRecord) {
    return this.append('validations', v, ValidationRecordSchema);
  }

  runsOf(experimentId: string): RunRecord[] {
    return this.doc.runs.filter((r) => r.experimentId === experimentId);
  }

  /** Records whose integrity hash no longer matches (tampering or corruption). */
  integrityReport(): { id: string; kind: string }[] {
    const bad: { id: string; kind: string }[] = [];
    for (const k of ['runs', 'calibrations', 'validations'] as const)
      for (const r of this.doc[k] as { id: string; integrityHash: string }[])
        if (!verifyIntegrity(r)) bad.push({ id: r.id, kind: k });
    return bad;
  }
}

/** Serialise / load (untrusted input: size limit + schema). */
export const MAX_RESEARCH_BYTES = 8 * 1024 * 1024;
export function serializeResearch(doc: ResearchDocument): string {
  return JSON.stringify(doc);
}
export function parseResearch(
  text: string,
): { ok: true; doc: ResearchDocument } | { ok: false; error: string } {
  if (text.length > MAX_RESEARCH_BYTES) return { ok: false, error: 'Research document too large.' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  const v = (raw as { schemaVersion?: unknown })?.schemaVersion;
  if (typeof v === 'number' && v > RESEARCH_SCHEMA_VERSION)
    return {
      ok: false,
      error: `Research schema v${v} is newer than this build supports (v${RESEARCH_SCHEMA_VERSION}).`,
    };
  const r = ResearchDocumentSchema.safeParse(raw);
  return r.success
    ? { ok: true, doc: r.data }
    : {
        ok: false,
        error: r.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      };
}
