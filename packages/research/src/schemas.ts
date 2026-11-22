import { z } from 'zod';

/**
 * Research document (Phase 7): everything scientific about ONE engineering project — the
 * experiment protocols, the append-only run records, imported datasets, calibration and
 * validation records. It is a separate document from the engineering project (like the
 * workspace layout), so experiments never modify the project and run results never enter
 * the engineering undo history. Raw telemetry is NOT stored here: run records reference
 * data in a run-data store by key and SHA-256 hash.
 */
export const RESEARCH_SCHEMA_VERSION = 1 as const;

const finite = z.number().finite();
const Id = z.string().min(1).max(128);
const Text = (max: number) => z.string().max(max);
const iso = z.iso.datetime();

export const VARIABLE_TYPES = [
  'continuous',
  'integer',
  'boolean',
  'categorical',
  'enumeration',
  'vector',
  'angle',
  'material',
  'variant',
  'controller',
] as const;
export const VARIABLE_ROLES = [
  'independent',
  'dependent',
  'controlled',
  'nuisance',
  'calibration',
  'environmental',
] as const;

export const ParamValueSchema = z.union([finite, z.boolean(), z.string().max(200), z.array(finite).max(16)]);
export type ParamValue = z.infer<typeof ParamValueSchema>;

export const DistributionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), value: finite }),
  z.object({ kind: z.literal('uniform'), min: finite, max: finite }),
  z.object({ kind: z.literal('normal'), mean: finite, sd: finite.min(0) }),
  /** Normal truncated to [min, max] (rejection sampling). */
  z.object({ kind: z.literal('bounded-normal'), mean: finite, sd: finite.min(0), min: finite, max: finite }),
  /** Values supplied by the user (sampled with replacement). */
  z.object({ kind: z.literal('empirical'), values: z.array(finite).min(1).max(10_000) }),
]);
export type Distribution = z.infer<typeof DistributionSchema>;

export const VariableSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(200),
  type: z.enum(VARIABLE_TYPES),
  role: z.enum(VARIABLE_ROLES),
  /** Unit the user works in (converted to the target's unit; dimensions must match). */
  unit: Text(32),
  /** Parameter target id (params.ts). Must resolve in the experiment's model. */
  target: z.string().min(1).max(256),
  min: finite.nullable(),
  max: finite.nullable(),
  default: ParamValueSchema,
  /** Values used by designs (levels of a sweep / categories compared). */
  levels: z.array(ParamValueSchema).max(1000),
  /** Input uncertainty (Monte Carlo); null = treated as exact. */
  distribution: DistributionSchema.nullable(),
  description: Text(2000),
  constraints: Text(500),
});
export type Variable = z.infer<typeof VariableSchema>;

export const REDUCTIONS = [
  'max',
  'min',
  'mean',
  'rms',
  'std',
  'final',
  'initial',
  'range',
  'peak-abs',
  'settling-time',
  'overshoot',
  'iae',
  'time-above',
  'count-above',
  'crossings',
  'change-count',
  'frequency',
  'duty-cycle',
  'pulse-width',
  'first-crossing',
] as const;
export type Reduction = (typeof REDUCTIONS)[number];

export const MeasurementSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(200),
  /** Recorded signal key, or a derived expression over aliases (expr.ts). */
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('signal'), signal: z.string().min(1).max(200) }),
    z.object({
      kind: z.literal('derived'),
      expression: z.string().min(1).max(500),
      /** alias → recorded signal key */
      aliases: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().min(1).max(200)),
    }),
  ]),
  reduction: z.enum(REDUCTIONS),
  /** Analysis window (s, simulation time); toS null = end of run. */
  window: z.object({ fromS: finite.min(0), toS: finite.min(0).nullable() }),
  params: z
    .object({
      threshold: finite.optional(),
      /** Settling band as a fraction of the step (default 0.02) or an absolute band. */
      bandFraction: finite.positive().optional(),
      bandAbsolute: finite.positive().optional(),
    })
    .default({}),
  /** A required measurement that cannot be computed makes the run FAILED, not completed. */
  required: z.boolean(),
  description: Text(1000),
});
export type Measurement = z.infer<typeof MeasurementSchema>;

export const DESIGN_KINDS = [
  'single',
  'replicates',
  'oat',
  'grid',
  'random',
  'lhs',
  'paired',
  'monte-carlo',
] as const;
export const DesignSchema = z.object({
  kind: z.enum(DESIGN_KINDS),
  replicates: z.number().int().min(1).max(1000),
  /** Samples for random / LHS / Monte Carlo designs. */
  samples: z.number().int().min(1).max(10_000),
  baseSeed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1),
  /** Paired designs use the same derived seed for the same replicate in every condition. */
  pairedSeeds: z.boolean(),
  /** Shuffle execution order (seeded). Results do not depend on order for deterministic models. */
  randomizeOrder: z.boolean(),
});
export type Design = z.infer<typeof DesignSchema>;

export const MODEL_KINDS = ['physics', 'cosim', 'circuit'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export const ProtocolSchema = z.object({
  model: z.object({
    kind: z.enum(MODEL_KINDS),
    projectId: Id,
    projectName: z.string().max(200),
    /** Fingerprint of the engineering model when the protocol was defined. */
    fingerprint: z.string().max(64),
  }),
  durationS: finite.positive().max(3600),
  warmupS: finite.min(0).max(3600),
  sampleRateHz: finite.positive().max(10_000),
  /** Stop early when a recorded signal crosses a value (still a completed run). */
  stopConditions: z
    .array(z.object({ signal: z.string().min(1), op: z.enum(['>', '<']), value: finite }))
    .max(8),
  /** Extra recorded signals kept with every run (measurement signals are always kept). */
  recordSignals: z.array(z.string().min(1).max(200)).max(64).default([]),
  analysisPlan: Text(4000),
  randomizationPlan: Text(2000),
  notes: Text(4000),
});
export type Protocol = z.infer<typeof ProtocolSchema>;

export const HypothesisSchema = z.object({
  statement: z.string().trim().min(1).max(2000),
  relationship: z.enum(['increase', 'decrease', 'difference', 'no-difference', 'exploratory']),
  independentVariable: Id.nullable(),
  outcome: Id.nullable(),
  referenceCondition: Text(200),
  comparisonCondition: Text(200),
  criterion: Text(1000),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const NoteSchema = z.object({
  id: Id,
  kind: z.enum([
    'question',
    'hypothesis',
    'protocol',
    'methodology',
    'observation',
    'analysis',
    'conclusion',
    'limitation',
    'note',
  ]),
  markdown: Text(20_000),
  links: z.object({
    runs: z.array(Id).max(500),
    figures: z.array(z.string().max(200)).max(100),
    datasets: z.array(Id).max(100),
  }),
  createdAt: iso,
  updatedAt: iso,
});
export type Note = z.infer<typeof NoteSchema>;

export const ExperimentBaseSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCHEMA_VERSION),
  id: Id,
  title: z.string().trim().min(1).max(200),
  description: Text(4000),
  researchQuestion: Text(2000),
  mode: z.enum(['hypothesis', 'exploratory']),
  hypothesis: HypothesisSchema.nullable(),
  variables: z.array(VariableSchema).max(64),
  measurements: z.array(MeasurementSchema).max(64),
  protocol: ProtocolSchema,
  design: DesignSchema,
  successCriteria: z
    .array(
      z.object({
        measurementId: Id,
        op: z.enum(['<', '<=', '>', '>=']),
        value: finite,
        description: Text(500),
      }),
    )
    .max(32),
  limitations: z.array(z.string().max(1000)).max(64),
  notebook: z.array(NoteSchema).max(500),
  createdAt: iso,
  updatedAt: iso,
  /** Increments on every protocol change; runs record the revision they used. */
  revision: z.number().int().min(1),
});
export const ExperimentSchema = ExperimentBaseSchema.superRefine((e, ctx) => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  const dup = (ids: string[], path: string) => {
    const s = new Set<string>();
    ids.forEach((id) => (s.has(id) ? issue([path], `duplicate id "${id}"`) : s.add(id)));
  };
  dup(
    e.variables.map((v) => v.id),
    'variables',
  );
  dup(
    e.measurements.map((m) => m.id),
    'measurements',
  );
  e.variables.forEach((v, i) => {
    if (v.min !== null && v.max !== null && v.min > v.max) issue(['variables', i], 'min must be ≤ max');
    for (const l of [v.default, ...v.levels])
      if (typeof l === 'number' && ((v.min !== null && l < v.min) || (v.max !== null && l > v.max)))
        issue(['variables', i], `value ${l} is outside [${v.min ?? '−∞'}, ${v.max ?? '∞'}]`);
    if (v.type === 'integer')
      for (const l of [v.default, ...v.levels])
        if (typeof l === 'number' && !Number.isInteger(l)) issue(['variables', i], `${l} is not an integer`);
    const d = v.distribution;
    if (d && (d.kind === 'uniform' || d.kind === 'bounded-normal') && d.min > d.max)
      issue(['variables', i, 'distribution'], 'min must be ≤ max');
  });
  const mids = new Set(e.measurements.map((m) => m.id));
  const vids = new Set(e.variables.map((v) => v.id));
  e.successCriteria.forEach(
    (c, i) =>
      mids.has(c.measurementId) || issue(['successCriteria', i], `unknown measurement "${c.measurementId}"`),
  );
  if (e.hypothesis?.outcome && !mids.has(e.hypothesis.outcome))
    issue(['hypothesis', 'outcome'], 'unknown measurement');
  if (e.hypothesis?.independentVariable && !vids.has(e.hypothesis.independentVariable))
    issue(['hypothesis', 'independentVariable'], 'unknown variable');
  if (e.protocol.warmupS >= e.protocol.durationS)
    issue(['protocol', 'warmupS'], 'warm-up must be shorter than the run');
});
export type Experiment = z.infer<typeof ExperimentSchema>;

export const RUN_STATES = [
  'CREATED',
  'VALIDATED',
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
  'INVALID',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const OutcomeSchema = z.object({
  value: finite.nullable(),
  unit: Text(32),
  status: z.enum(['ok', 'partial', 'missing', 'invalid']),
  samples: z.number().int().min(0),
  missing: z.number().int().min(0),
  method: Text(300),
  warnings: z.array(Text(500)).max(20),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

/** Immutable record of one run (append-only; a retry is a new record). */
export const RunRecordSchema = z.object({
  id: Id,
  experimentId: Id,
  experimentRevision: z.number().int().min(1),
  conditionId: Id,
  conditionLabel: Text(500),
  replicate: z.number().int().min(0),
  state: z.enum(RUN_STATES),
  history: z.array(z.object({ state: z.enum(RUN_STATES), at: iso, note: Text(500) })).max(20),
  /** Configuration snapshot taken before execution (never changes afterwards). */
  config: z.object({
    variables: z.record(Id, ParamValueSchema),
    /** Every model parameter actually applied, in model units. */
    applied: z.array(z.object({ target: z.string(), value: ParamValueSchema, unit: Text(32) })).max(256),
    durationS: finite,
    warmupS: finite,
    sampleRateHz: finite,
    seed: z.number().int(),
    rng: Text(64),
    measurements: z.array(MeasurementSchema).max(64),
    solver: z.record(z.string(), z.unknown()),
  }),
  configHash: z.string().length(64),
  model: z.object({
    kind: z.enum(MODEL_KINDS),
    projectId: Id,
    projectRevision: z.number().int().min(0),
    fingerprint: z.string().length(64),
    /** Fingerprint after the run's parameters were applied to the snapshot. */
    runModelFingerprint: z.string().length(64),
    firmware: z.array(z.object({ id: Id, revision: z.number().int(), hash: z.string() })).max(32),
  }),
  versions: z.record(z.string(), z.string()),
  startedAt: iso.nullable(),
  completedAt: iso.nullable(),
  wallMs: finite.min(0),
  simulatedS: finite.min(0),
  steps: z.number().int().min(0),
  outcomes: z.record(Id, OutcomeSchema),
  warnings: z.array(Text(1000)).max(100),
  error: Text(2000).nullable(),
  data: z
    .object({
      key: z.string(),
      hash: z.string().length(64),
      bytes: z.number().int(),
      samples: z.number().int(),
      signals: z.array(z.object({ key: z.string(), unit: Text(32) })).max(128),
    })
    .nullable(),
  retryOf: Id.nullable(),
  integrityHash: z.string().length(64),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const DatasetSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(200),
  format: z.enum(['csv', 'json', 'manual']),
  provenance: z.object({
    origin: Text(500),
    instrument: Text(300),
    collectedAt: Text(64),
    operator: Text(200),
    notes: Text(2000),
    /** True when the data were generated (e.g. by a model) — never presented as measured. */
    synthetic: z.boolean(),
  }),
  timeColumn: z.string().max(100).nullable(),
  columns: z
    .array(z.object({ name: z.string().max(100), unit: Text(32), uncertainty: finite.min(0).nullable() }))
    .max(64),
  rows: z.number().int().min(0),
  dataKey: z.string(),
  hash: z.string().length(64),
  importedAt: iso,
  warnings: z.array(Text(500)).max(100),
});
export type Dataset = z.infer<typeof DatasetSchema>;

export const CalibrationRecordSchema = z.object({
  id: Id,
  experimentId: Id,
  datasetId: Id,
  parameters: z.array(
    z.object({
      variableId: Id,
      target: z.string(),
      unit: Text(32),
      nominal: finite,
      fitted: finite,
      lower: finite,
      upper: finite,
      standardError: finite.nullable(),
      atBound: z.boolean(),
    }),
  ),
  mapping: z.array(z.object({ column: z.string(), signal: z.string() })).min(1),
  objective: Text(300),
  optimizer: z.object({ method: Text(100), maxIterations: z.number().int(), tolerance: finite }),
  iterations: z.number().int(),
  evaluations: z.number().int(),
  converged: z.boolean(),
  residual: z.object({ rmse: finite, mae: finite, maxAbs: finite, n: z.number().int() }),
  correlations: z.array(z.array(finite.nullable())),
  identifiability: z.array(Text(500)),
  createdAt: iso,
  integrityHash: z.string().length(64),
});
export type CalibrationRecord = z.infer<typeof CalibrationRecordSchema>;

export const ValidationRecordSchema = z.object({
  id: Id,
  experimentId: Id,
  datasetId: Id,
  runId: Id,
  mapping: z.array(z.object({ column: z.string(), signal: z.string() })).min(1),
  metrics: z.array(
    z.object({
      column: z.string(),
      signal: z.string(),
      unit: Text(32),
      n: z.number().int(),
      mae: finite,
      rmse: finite,
      maxAbs: finite,
      bias: finite,
      withinUncertainty: finite.nullable(),
    }),
  ),
  acceptance: z.object({ metric: z.enum(['mae', 'rmse', 'maxAbs']), threshold: finite }).nullable(),
  /** False when the dataset was also used to calibrate the model being validated. */
  independent: z.boolean(),
  synthetic: z.boolean(),
  status: z.enum(['agrees', 'disagrees', 'not-assessed', 'not-independent', 'synthetic-only']),
  operatingRange: Text(500),
  createdAt: iso,
  integrityHash: z.string().length(64),
});
export type ValidationRecord = z.infer<typeof ValidationRecordSchema>;

export const ResearchDocumentSchema = z.object({
  schemaVersion: z.literal(RESEARCH_SCHEMA_VERSION),
  projectId: Id,
  experiments: z.array(ExperimentSchema).max(500),
  runs: z.array(RunRecordSchema).max(100_000),
  datasets: z.array(DatasetSchema).max(1000),
  calibrations: z.array(CalibrationRecordSchema).max(1000),
  validations: z.array(ValidationRecordSchema).max(1000),
  updatedAt: iso,
});
export type ResearchDocument = z.infer<typeof ResearchDocumentSchema>;

export function emptyResearchDocument(projectId: string, now = new Date()): ResearchDocument {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    projectId,
    experiments: [],
    runs: [],
    datasets: [],
    calibrations: [],
    validations: [],
    updatedAt: now.toISOString(),
  };
}
