import {
  calibrate,
  compareConditions,
  configDiff,
  convergenceStudy,
  datasetRecord,
  DESIGN_KINDS,
  errorMetrics,
  exportExperiment,
  generateReport,
  interactionGrid,
  listTargets,
  loadVerified,
  oatSensitivity,
  outcomesCsv,
  parseDatasetCsv,
  parseDatasetJson,
  parseExperimentExport,
  REDUCTIONS,
  summarize,
  uncertaintySummary,
  validationRecord,
  validationStatus,
  VARIABLE_ROLES,
  verifyIntegrity,
  type Distribution,
  type Experiment,
  type Measurement,
  type ParamTarget,
  type RunData,
  type RunRecord,
  type Variable,
} from '@forge/research';
import { Download, Play, Square, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { useEditor, useEditorStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { downloadText } from '@/lib/download';
import { BoxPlot, Heatmap, Histogram, LineChart, ScatterChart } from './charts';
import { researchFor, type ResearchTab } from './controller';

/** Record ids: time-ordered and unique within the session (never used as data). */
let seq = 0;
const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Research workspace (main area in Research mode). */
export function ResearchOverlay() {
  const mode = useEditor((s) => s.workMode);
  if (mode !== 'research') return null;
  return <Workspace />;
}

const inputCls = 'rounded border border-border bg-background px-1 py-0.5 text-xs';
const fmt = (x: number | null | undefined, d = 4) =>
  x === null || x === undefined || !Number.isFinite(x) ? '—' : Number(x.toPrecision(d)).toString();

function Field({
  label,
  value,
  onCommit,
  testId,
  area,
  width = 'w-full',
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  testId?: string;
  area?: boolean;
  width?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  const props = {
    'aria-label': label,
    'data-testid': testId,
    className: `${inputCls} ${width}`,
    value: draft ?? value,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
  };
  return (
    <label className="block space-y-0.5 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      {area ? (
        <textarea rows={3} {...props} />
      ) : (
        <input {...props} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      )}
    </label>
  );
}
function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-1.5 rounded border border-border p-2" data-testid={testId}>
      <h3 className="text-xs font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Workspace() {
  const editor = useEditorStore();
  const c = researchFor(editor);
  const ui = useStore(c.ui);
  void ui.version;
  const e = c.experiment;
  const tabs: [ResearchTab, string][] = [
    ['protocol', 'Protocol'],
    ['runs', 'Runs'],
    ['results', 'Results'],
    ['analysis', 'Analysis'],
    ['validation', 'Validation'],
    ['notebook', 'Notebook'],
    ['report', 'Report'],
  ];
  return (
    <div
      className="absolute inset-0 z-20 overflow-auto bg-background p-3 text-sm"
      data-testid="research-workspace"
    >
      {!e ? (
        <div className="grid h-full place-items-center text-muted-foreground">
          Create or select an experiment in the Research panel.
        </div>
      ) : (
        <div className="mx-auto max-w-4xl space-y-3">
          <header className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-base font-semibold" data-testid="res-title-view">
              {e.title}
            </h2>
            <span className="text-xs text-muted-foreground">
              {e.protocol.model.kind} · revision {e.revision} · {c.engine.runsOf(e.id).length} runs
            </span>
          </header>
          <nav className="flex flex-wrap gap-1 border-b border-border pb-1" role="tablist">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={ui.tab === id}
                data-testid={`res-tab-${id}`}
                className={`rounded px-2 py-0.5 text-xs ${ui.tab === id ? 'bg-secondary font-medium' : 'text-muted-foreground hover:bg-secondary/60'}`}
                onClick={() => c.ui.setState({ tab: id })}
              >
                {label}
              </button>
            ))}
          </nav>
          {ui.busy && <p className="text-xs text-muted-foreground">{ui.busy}</p>}
          {ui.tab === 'protocol' && <Protocol e={e} />}
          {ui.tab === 'runs' && <Runs e={e} />}
          {ui.tab === 'results' && <Results e={e} />}
          {ui.tab === 'analysis' && <Analysis e={e} />}
          {ui.tab === 'validation' && <Validation e={e} />}
          {ui.tab === 'notebook' && <Notebook e={e} />}
          {ui.tab === 'report' && <Report e={e} />}
        </div>
      )}
    </div>
  );
}

// -- Protocol --------------------------------------------------------------------------------
function typeFor(t: ParamTarget): Variable['type'] {
  if (t.id.endsWith('.materialId')) return 'material';
  if (t.id.endsWith('.variantId')) return 'variant';
  if (t.group === 'firmware') return t.valueType === 'enum' ? 'categorical' : 'controller';
  if (t.valueType === 'enum') return 'categorical';
  if (t.valueType === 'integer') return 'integer';
  if (t.unit === 'rad') return 'angle';
  return 'continuous';
}
const parseList = (s: string, numeric: boolean) =>
  s
    .split(/[,;]\s*/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (numeric ? Number(x) : x));

function presets(
  e: Experiment,
  catalog: { key: string; unit: string }[],
): (Measurement & { label: string })[] {
  const out: (Measurement & { label: string })[] = [];
  const has = (k: string) => catalog.some((c) => c.key === k);
  const mk = (
    id: string,
    name: string,
    source: Measurement['source'],
    reduction: Measurement['reduction'],
    params: Measurement['params'] = {},
  ): Measurement & { label: string } => ({
    id,
    name,
    source,
    reduction,
    window: { fromS: 0, toS: null },
    params,
    required: reduction !== 'settling-time',
    description: '',
    label: name,
  });
  for (const c of catalog)
    if (c.key.endsWith('.effort') && has(c.key.replace('.effort', '.target'))) {
      const j = c.key.slice(0, -'.effort'.length);
      out.push(
        mk(
          `${j}-err`,
          `${j} tracking error (final |q − target|)`,
          { kind: 'derived', expression: 'abs(q - target)', aliases: { q: `${j}.q`, target: `${j}.target` } },
          'final',
        ),
        mk(
          `${j}-iae`,
          `${j} integrated |q − target|`,
          { kind: 'derived', expression: 'abs(q - target)', aliases: { q: `${j}.q`, target: `${j}.target` } },
          'iae',
        ),
        mk(`${j}-effort-rms`, `${j} RMS effort`, { kind: 'signal', signal: c.key }, 'rms'),
        mk(`${j}-effort-peak`, `${j} peak effort`, { kind: 'signal', signal: c.key }, 'peak-abs'),
        mk(`${j}-settle`, `${j} settling time`, { kind: 'signal', signal: `${j}.q` }, 'settling-time'),
        mk(
          `${j}-sat`,
          `${j} time at the effort limit`,
          { kind: 'signal', signal: `${j}.sat` },
          'time-above',
          { threshold: 0.5 },
        ),
      );
    }
  for (const c of catalog) {
    if (c.key.endsWith('.reported'))
      out.push(
        mk(`${c.key}-mean`, `${c.key} mean`, { kind: 'signal', signal: c.key }, 'mean'),
        mk(`${c.key}-sd`, `${c.key} spread`, { kind: 'signal', signal: c.key }, 'std'),
      );
    if (c.key.endsWith('.target') && c.key.startsWith('SV'))
      out.push(mk(`${c.key}-changes`, `${c.key} changes`, { kind: 'signal', signal: c.key }, 'change-count'));
    if (c.key.startsWith('V('))
      out.push(mk(`${c.key}-final`, `${c.key} final`, { kind: 'signal', signal: c.key }, 'final'));
  }
  return out.filter((p) => !e.measurements.some((m) => m.id === p.id));
}

function Protocol({ e }: { e: Experiment }) {
  const editor = useEditorStore();
  const c = researchFor(editor);
  const ui = useStore(c.ui);
  const project = useEditor((s) => s.project);
  const targets = useMemo(
    () => listTargets(project).filter((t) => t.kinds.includes(e.protocol.model.kind)),
    [project, e.protocol.model.kind],
  );
  const upd = (patch: Parameters<typeof c.api.update>[1]) =>
    c.exec({ type: 'experiment.update', payload: { experimentId: e.id, patch } });
  const [nv, setNv] = useState({
    target: '',
    role: 'independent',
    unit: '',
    def: '',
    levels: '',
    min: '',
    max: '',
    dist: 'none',
    a: '',
    b: '',
  });
  const [nm, setNm] = useState({
    preset: '',
    name: '',
    signal: '',
    expr: '',
    aliases: '',
    reduction: 'max',
    threshold: '',
    from: '0',
    to: '',
  });
  useEffect(() => {
    if (!ui.catalog) void c.loadCatalog();
  }, [ui.catalog, c]);
  const tgt = targets.find((t) => t.id === nv.target);
  const addVariable = () => {
    if (!tgt) return;
    const numeric = tgt.valueType !== 'enum';
    const num = (s: string) => (s.trim() === '' ? null : Number(s));
    const unit = nv.unit || tgt.unit;
    const def: Variable['default'] = nv.def === '' ? tgt.current : numeric ? Number(nv.def) : nv.def;
    let distribution: Distribution | null = null;
    if (nv.dist === 'uniform') distribution = { kind: 'uniform', min: Number(nv.a), max: Number(nv.b) };
    if (nv.dist === 'normal') distribution = { kind: 'normal', mean: Number(nv.a), sd: Number(nv.b) };
    const id = tgt.id.replace(/[^A-Za-z0-9]+/g, '-').slice(-60);
    const variable: Variable = {
      id,
      name: tgt.label,
      type: typeFor(tgt),
      role: nv.role as Variable['role'],
      unit,
      target: tgt.id,
      min: num(nv.min),
      max: num(nv.max),
      default: def,
      levels: parseList(nv.levels, numeric),
      distribution,
      description: tgt.note,
      constraints: '',
    };
    if (c.exec({ type: 'experiment.defineVariable', payload: { experimentId: e.id, variable } }))
      setNv({ ...nv, target: '', levels: '', def: '' });
  };
  const addMeasurement = () => {
    const p = presets(e, ui.catalog ?? []).find((x) => x.id === nm.preset);
    if (p) {
      const { label: _l, ...m } = p;
      c.exec({ type: 'experiment.addMeasurement', payload: { experimentId: e.id, measurement: m } });
      return;
    }
    const aliases = Object.fromEntries(
      nm.aliases
        .split(/[;,]/)
        .map((x) => x.split('=').map((y) => y.trim()))
        .filter((x) => x.length === 2 && x[0] && x[1]),
    );
    const m: Measurement = {
      id:
        (nm.name || 'measure')
          .replace(/[^A-Za-z0-9]+/g, '-')
          .toLowerCase()
          .slice(0, 60) || `m${e.measurements.length + 1}`,
      name: nm.name || nm.signal || nm.expr,
      source: nm.expr
        ? { kind: 'derived', expression: nm.expr, aliases }
        : { kind: 'signal', signal: nm.signal },
      reduction: nm.reduction as Measurement['reduction'],
      window: { fromS: Number(nm.from) || 0, toS: nm.to === '' ? null : Number(nm.to) },
      params: nm.threshold === '' ? {} : { threshold: Number(nm.threshold) },
      required: true,
      description: '',
    };
    c.exec({ type: 'experiment.addMeasurement', payload: { experimentId: e.id, measurement: m } });
  };
  const v = ui.validation;
  return (
    <div className="space-y-3">
      <Section title="Question and hypothesis">
        <Field label="Title" value={e.title} onCommit={(x) => upd({ title: x })} testId="res-title" />
        <Field
          label="Research question"
          value={e.researchQuestion}
          onCommit={(x) => upd({ researchQuestion: x })}
          testId="res-question"
          area
        />
        <label className="flex items-center gap-1 text-[11px]">
          Mode
          <select
            className={inputCls}
            value={e.mode}
            onChange={(x) => upd({ mode: x.target.value as Experiment['mode'] })}
          >
            <option value="hypothesis">Hypothesis-driven</option>
            <option value="exploratory">Exploratory</option>
          </select>
        </label>
        <Field
          label="Hypothesis"
          value={e.hypothesis?.statement ?? ''}
          testId="res-hypothesis"
          area
          onCommit={(x) =>
            upd({
              hypothesis: x.trim()
                ? {
                    statement: x,
                    relationship: e.hypothesis?.relationship ?? 'increase',
                    independentVariable: e.hypothesis?.independentVariable ?? null,
                    outcome: e.hypothesis?.outcome ?? null,
                    referenceCondition: e.hypothesis?.referenceCondition ?? '',
                    comparisonCondition: e.hypothesis?.comparisonCondition ?? '',
                    criterion: e.hypothesis?.criterion ?? '',
                  }
                : null,
            })
          }
        />
        {e.hypothesis && (
          <div className="flex flex-wrap gap-2 text-[11px]">
            <label>
              Predicted{' '}
              <select
                className={inputCls}
                value={e.hypothesis.relationship}
                onChange={(x) =>
                  upd({ hypothesis: { ...e.hypothesis!, relationship: x.target.value as 'increase' } })
                }
                data-testid="res-relationship"
              >
                {['increase', 'decrease', 'difference', 'no-difference', 'exploratory'].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label>
              Independent variable{' '}
              <select
                className={inputCls}
                value={e.hypothesis.independentVariable ?? ''}
                onChange={(x) =>
                  upd({ hypothesis: { ...e.hypothesis!, independentVariable: x.target.value || null } })
                }
                data-testid="res-hyp-var"
              >
                <option value="">—</option>
                {e.variables.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Outcome{' '}
              <select
                className={inputCls}
                value={e.hypothesis.outcome ?? ''}
                onChange={(x) => upd({ hypothesis: { ...e.hypothesis!, outcome: x.target.value || null } })}
                data-testid="res-hyp-outcome"
              >
                <option value="">—</option>
                {e.measurements.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </Section>

      <Section title="Model and simulation settings">
        <div className="grid grid-cols-4 gap-2">
          <label className="text-[11px]">
            Model
            <select
              className={`${inputCls} w-full`}
              value={e.protocol.model.kind}
              data-testid="res-model-kind"
              onChange={(x) =>
                upd({ protocol: { model: { ...e.protocol.model, kind: x.target.value as 'physics' } } })
              }
            >
              <option value="physics">physics (Phase 5)</option>
              <option value="cosim">co-simulation (Phase 6)</option>
              <option value="circuit">circuit transient (Phase 6)</option>
            </select>
          </label>
          <Field
            label="Duration (s)"
            value={String(e.protocol.durationS)}
            onCommit={(x) => upd({ protocol: { durationS: Number(x) } })}
            testId="res-duration"
          />
          <Field
            label="Warm-up (s)"
            value={String(e.protocol.warmupS)}
            onCommit={(x) => upd({ protocol: { warmupS: Number(x) } })}
          />
          <Field
            label="Sampling (Hz)"
            value={String(e.protocol.sampleRateHz)}
            onCommit={(x) => upd({ protocol: { sampleRateHz: Number(x) } })}
            testId="res-rate"
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          Project “{e.protocol.model.projectName}”, model fingerprint{' '}
          {e.protocol.model.fingerprint.slice(0, 12)}…
        </p>
        <Field
          label="Analysis plan"
          value={e.protocol.analysisPlan}
          onCommit={(x) => upd({ protocol: { analysisPlan: x } })}
          area
        />
      </Section>

      <Section title={`Variables (${e.variables.length})`} testId="res-variables">
        <table className="w-full text-[11px]">
          <tbody>
            {e.variables.map((x) => (
              <tr key={x.id} className="border-b border-border/50">
                <td className="py-0.5">{x.name}</td>
                <td>{x.role}</td>
                <td className="font-mono text-muted-foreground">{x.target}</td>
                <td>
                  {String(x.default)} {x.unit}
                </td>
                <td>{x.distribution ? x.distribution.kind : x.levels.map(String).join(', ')}</td>
                <td>
                  <button
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      c.exec({
                        type: 'experiment.removeVariable',
                        payload: { experimentId: e.id, variableId: x.id },
                      })
                    }
                    aria-label={`Remove ${x.name}`}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid grid-cols-6 items-end gap-1">
          <label className="col-span-2 text-[11px]">
            Model parameter
            <select
              className={`${inputCls} w-full`}
              value={nv.target}
              data-testid="res-var-target"
              onChange={(x) =>
                setNv({
                  ...nv,
                  target: x.target.value,
                  unit: targets.find((t) => t.id === x.target.value)?.unit ?? '',
                })
              }
            >
              <option value="">choose…</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} [{t.unit || '-'}] ={' '}
                  {String(typeof t.current === 'number' ? Number(t.current.toPrecision(4)) : t.current)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px]">
            Role
            <select
              className={`${inputCls} w-full`}
              value={nv.role}
              data-testid="res-var-role"
              onChange={(x) => setNv({ ...nv, role: x.target.value })}
            >
              {VARIABLE_ROLES.filter((r) => r !== 'dependent').map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="text-[11px]">
            Unit
            <input
              className={`${inputCls} w-full`}
              value={nv.unit}
              data-testid="res-var-unit"
              onChange={(x) => setNv({ ...nv, unit: x.target.value })}
            />
          </label>
          <label className="text-[11px]">
            Default
            <input
              className={`${inputCls} w-full`}
              value={nv.def}
              placeholder={tgt ? String(tgt.current) : ''}
              data-testid="res-var-default"
              onChange={(x) => setNv({ ...nv, def: x.target.value })}
            />
          </label>
          <label className="text-[11px]">
            Levels
            <input
              className={`${inputCls} w-full`}
              value={nv.levels}
              placeholder="0, 0.2, 0.4"
              data-testid="res-var-levels"
              onChange={(x) => setNv({ ...nv, levels: x.target.value })}
            />
          </label>
          <label className="text-[11px]">
            Min
            <input
              className={`${inputCls} w-full`}
              value={nv.min}
              onChange={(x) => setNv({ ...nv, min: x.target.value })}
            />
          </label>
          <label className="text-[11px]">
            Max
            <input
              className={`${inputCls} w-full`}
              value={nv.max}
              onChange={(x) => setNv({ ...nv, max: x.target.value })}
            />
          </label>
          <label className="text-[11px]">
            Uncertainty
            <select
              className={`${inputCls} w-full`}
              value={nv.dist}
              onChange={(x) => setNv({ ...nv, dist: x.target.value })}
            >
              <option value="none">none</option>
              <option value="uniform">uniform (min, max)</option>
              <option value="normal">normal (mean, sd)</option>
            </select>
          </label>
          {nv.dist !== 'none' && (
            <>
              <input
                className={inputCls}
                placeholder={nv.dist === 'uniform' ? 'min' : 'mean'}
                value={nv.a}
                onChange={(x) => setNv({ ...nv, a: x.target.value })}
              />
              <input
                className={inputCls}
                placeholder={nv.dist === 'uniform' ? 'max' : 'sd'}
                value={nv.b}
                onChange={(x) => setNv({ ...nv, b: x.target.value })}
              />
            </>
          )}
          <Button size="sm" variant="outline" disabled={!tgt} onClick={addVariable} data-testid="res-var-add">
            Add variable
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Only parameters that this model actually uses are listed; values are applied to a copy of the
          project for each run.
        </p>
      </Section>

      <Section title={`Measurements (${e.measurements.length})`} testId="res-measurements">
        <ul className="space-y-0.5 text-[11px]">
          {e.measurements.map((m) => (
            <li key={m.id} className="flex gap-2">
              <span className="flex-1">
                {m.name} —{' '}
                <span className="font-mono text-muted-foreground">
                  {m.source.kind === 'signal' ? m.source.signal : m.source.expression}
                </span>{' '}
                · {m.reduction}
              </span>
              <button
                className="text-muted-foreground hover:text-destructive"
                onClick={() =>
                  c.exec({
                    type: 'experiment.removeMeasurement',
                    payload: { experimentId: e.id, measurementId: m.id },
                  })
                }
                aria-label={`Remove ${m.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-1">
          <select
            className={`${inputCls} min-w-0 flex-1`}
            value={nm.preset}
            data-testid="res-meas-preset"
            onChange={(x) => setNm({ ...nm, preset: x.target.value })}
          >
            <option value="">{ui.catalog ? 'Preset measurement…' : 'Loading signals…'}</option>
            {presets(e, ui.catalog ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={!nm.preset}
            onClick={addMeasurement}
            data-testid="res-meas-preset-add"
          >
            Add preset
          </Button>
        </div>
        <details>
          <summary className="cursor-pointer text-[11px]">Custom measurement</summary>
          <div className="mt-1 grid grid-cols-4 gap-1">
            <input
              className={inputCls}
              placeholder="name"
              value={nm.name}
              onChange={(x) => setNm({ ...nm, name: x.target.value, preset: '' })}
              data-testid="res-meas-name"
            />
            <select
              className={inputCls}
              value={nm.signal}
              onChange={(x) => setNm({ ...nm, signal: x.target.value, preset: '' })}
              data-testid="res-meas-signal"
            >
              <option value="">signal…</option>
              {(ui.catalog ?? []).map((s) => (
                <option key={s.key} value={s.key}>
                  {s.key} [{s.unit || '-'}]
                </option>
              ))}
            </select>
            <select
              className={inputCls}
              value={nm.reduction}
              onChange={(x) => setNm({ ...nm, reduction: x.target.value })}
              data-testid="res-meas-reduction"
            >
              {REDUCTIONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <input
              className={inputCls}
              placeholder="threshold"
              value={nm.threshold}
              onChange={(x) => setNm({ ...nm, threshold: x.target.value })}
            />
            <input
              className={`${inputCls} col-span-2`}
              placeholder="expression, e.g. abs(q - t)"
              value={nm.expr}
              onChange={(x) => setNm({ ...nm, expr: x.target.value, preset: '' })}
            />
            <input
              className={`${inputCls} col-span-2`}
              placeholder="aliases: q=j-shoulder.q; t=j-shoulder.target"
              value={nm.aliases}
              onChange={(x) => setNm({ ...nm, aliases: x.target.value })}
            />
            <input
              className={inputCls}
              placeholder="window from (s)"
              value={nm.from}
              onChange={(x) => setNm({ ...nm, from: x.target.value })}
            />
            <input
              className={inputCls}
              placeholder="to (s, empty = end)"
              value={nm.to}
              onChange={(x) => setNm({ ...nm, to: x.target.value })}
            />
            <Button size="sm" variant="outline" onClick={addMeasurement} data-testid="res-meas-add">
              Add measurement
            </Button>
          </div>
        </details>
      </Section>

      <Section title="Design and run plan">
        <div className="grid grid-cols-5 gap-2">
          <label className="text-[11px]">
            Design
            <select
              className={`${inputCls} w-full`}
              value={e.design.kind}
              data-testid="res-design"
              onChange={(x) => upd({ design: { kind: x.target.value as 'oat' } })}
            >
              {DESIGN_KINDS.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
          <Field
            label="Replicates"
            value={String(e.design.replicates)}
            onCommit={(x) => upd({ design: { replicates: Number(x) } })}
            testId="res-replicates"
          />
          <Field
            label="Samples"
            value={String(e.design.samples)}
            onCommit={(x) => upd({ design: { samples: Number(x) } })}
          />
          <Field
            label="Base seed"
            value={String(e.design.baseSeed)}
            onCommit={(x) => upd({ design: { baseSeed: Number(x) } })}
          />
          <label className="flex items-center gap-1 text-[11px]">
            <input
              type="checkbox"
              checked={e.design.pairedSeeds}
              onChange={(x) => upd({ design: { pairedSeeds: x.target.checked } })}
            />{' '}
            paired seeds
          </label>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => void c.validate()} data-testid="res-validate">
            Validate design
          </Button>
          <Button
            size="sm"
            disabled={!v?.ok || ui.progress?.phase === 'running'}
            onClick={() => void c.launch()}
            data-testid="res-launch"
          >
            <Play /> Launch
          </Button>
        </div>
        {v && (
          <div className="space-y-0.5 text-[11px]" data-testid="res-validation-result">
            {v.ok && v.plan && (
              <p className="text-emerald-300">
                Valid: {v.plan.estimate.conditions} condition(s) × {v.plan.estimate.replicates} replicate(s) ={' '}
                {v.plan.estimate.runs} run(s); ≈ {v.plan.estimate.totalSteps.toLocaleString()} physics steps;
                ≈ {(v.plan.estimate.totalBytes / 1e6).toFixed(2)} MB raw data; RNG {v.plan.rng}.
              </p>
            )}
            {v.errors.map((x, i) => (
              <p key={i} className="text-destructive">
                {x}
              </p>
            ))}
            {v.warnings.map((x, i) => (
              <p key={i} className="text-amber-300">
                {x}
              </p>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// -- Runs ------------------------------------------------------------------------------------
function Runs({ e }: { e: Experiment }) {
  const editor = useEditorStore();
  const c = researchFor(editor);
  const ui = useStore(c.ui);
  const runs = c.engine.runsOf(e.id);
  const p = ui.progress;
  const sel = runs.find((r) => r.id === ui.selectedRun) ?? null;
  return (
    <div className="space-y-3">
      <Section title="Run manager" testId="res-progress">
        {p ? (
          <>
            <div className="h-2 w-full rounded bg-secondary">
              <div
                className="h-2 rounded bg-sky-400"
                style={{ width: `${p.total ? (100 * p.done) / p.total : 0}%` }}
              />
            </div>
            <p className="text-[11px]" data-testid="res-progress-text">
              {p.phase}: {p.done}/{p.total} done · {p.completed} completed · {p.failed} failed · {p.reused}{' '}
              reused{p.current ? ` · running ${p.current}` : ''}
            </p>
            {p.message && <p className="text-[11px] text-amber-300">{p.message}</p>}
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            No campaign in this session. Validate and launch from the Protocol tab.
          </p>
        )}
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={p?.phase !== 'running'}
            onClick={() => c.cancel()}
            data-testid="res-cancel"
          >
            <Square /> Cancel
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={p?.phase === 'running' || !runs.some((r) => r.state !== 'COMPLETED')}
            onClick={() => void c.launch(true)}
            data-testid="res-retry"
          >
            Retry failed / resume
          </Button>
        </div>
      </Section>
      <table className="w-full text-[11px]" data-testid="res-runs">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th>Condition</th>
            <th>Rep</th>
            <th>State</th>
            <th>Seed</th>
            {e.measurements.slice(0, 3).map((m) => (
              <th key={m.id}>{m.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((r, i) => (
            <tr
              key={r.id}
              className={`cursor-pointer border-b border-border/40 ${ui.selectedRun === r.id ? 'bg-secondary' : 'hover:bg-secondary/50'}`}
              onClick={() => c.ui.setState({ selectedRun: r.id })}
              data-testid={`res-run-row-${i}`}
            >
              <td>{r.conditionLabel}</td>
              <td>{r.replicate + 1}</td>
              <td className={r.state === 'COMPLETED' ? 'text-emerald-300' : 'text-destructive'}>{r.state}</td>
              <td className="font-mono">{r.config.seed}</td>
              {e.measurements.slice(0, 3).map((m) => (
                <td key={m.id} className="font-mono">
                  {fmt(r.outcomes[m.id]?.value)} {r.outcomes[m.id]?.unit}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {sel && <RunDetail r={sel} />}
    </div>
  );
}

function useRunData(key: { key: string; hash: string } | null) {
  const editor = useEditorStore();
  const c = researchFor(editor);
  const [state, setState] = useState<{ key: string; data: RunData | null; reason: string | null } | null>(
    null,
  );
  useEffect(() => {
    if (!key) return;
    let live = true;
    void loadVerified(c.store, key).then(
      (r) => live && setState({ key: key.key, data: r.ok ? r.data : null, reason: r.ok ? null : r.reason }),
    );
    return () => {
      live = false;
    };
  }, [key, c]);
  return state && key && state.key === key.key ? state : null;
}

function RunDetail({ r }: { r: RunRecord }) {
  const d = useRunData(r.data);
  const intact = verifyIntegrity(r);
  return (
    <Section title={`Run ${r.id}`} testId="res-run-detail">
      <p className="text-[11px]">
        {r.conditionLabel} · replicate {r.replicate + 1} · <strong>{r.state}</strong> · seed {r.config.seed} ·{' '}
        {r.simulatedS.toFixed(3)} s simulated in {r.wallMs.toFixed(0)} ms · {r.steps} steps ·{' '}
        <span className={intact ? 'text-emerald-300' : 'text-destructive'} data-testid="res-run-integrity">
          {intact ? 'integrity verified' : 'INTEGRITY CHECK FAILED'}
        </span>
      </p>
      <p className="text-[10px] text-muted-foreground">
        History: {r.history.map((h) => h.state).join(' → ')} · config {r.configHash.slice(0, 12)}… · model{' '}
        {r.model.fingerprint.slice(0, 12)}… ·{' '}
        {Object.entries(r.versions)
          .map(([k, v]) => `${k} ${v}`)
          .join('; ')}
      </p>
      {r.error && <p className="text-[11px] text-destructive">{r.error}</p>}
      {r.warnings.map((w, i) => (
        <p key={i} className="text-[11px] text-amber-300" data-testid="res-run-warning">
          {w}
        </p>
      ))}
      <table className="w-full text-[11px]">
        <tbody>
          {Object.entries(r.outcomes).map(([k, o]) => (
            <tr key={k} title={o.method}>
              <td>{k}</td>
              <td className="font-mono">
                {fmt(o.value)} {o.unit}
              </td>
              <td>{o.status}</td>
              <td className="text-muted-foreground">
                n = {o.samples}
                {o.missing ? `, ${o.missing} missing` : ''} {o.warnings.join(' ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary className="cursor-pointer text-[11px]">
          Applied parameters ({r.config.applied.length})
        </summary>
        <ul className="font-mono text-[10px]">
          {r.config.applied.map((a) => (
            <li key={a.target}>
              {a.target} = {String(typeof a.value === 'number' ? Number(a.value.toPrecision(8)) : a.value)}{' '}
              {a.unit}
            </li>
          ))}
        </ul>
      </details>
      {r.data &&
        (d === null ? (
          <p className="text-[11px] text-muted-foreground">Loading recorded data…</p>
        ) : d.data ? (
          <LineChart
            testId="res-run-chart"
            series={d.data.signals.map((s) => ({
              name: `${s.key} [${s.unit || '-'}]`,
              t: s.t,
              v: s.v,
              hold: s.hold,
            }))}
            xLabel="time (s)"
            yLabel="recorded value"
          />
        ) : (
          <p className="text-[11px] text-destructive" data-testid="res-run-missing">
            Raw data {d.reason === 'missing' ? 'is missing' : 'does not match its recorded hash'}: the run
            record and its summary values remain, but the trace cannot be shown or re-analysed.
          </p>
        ))}
    </Section>
  );
}

// -- Results ---------------------------------------------------------------------------------
function Results({ e }: { e: Experiment }) {
  const editor = useEditorStore();
  const c = researchFor(editor);
  const runs = c.engine.runsOf(e.id);
  const [mid, setMid] = useState(e.measurements[0]?.id ?? '');
  const m = e.measurements.find((x) => x.id === mid);
  const sums = useMemo(() => (m ? summarize(runs, m.id) : []), [runs, m]);
  const numIndep = e.variables.filter((v) => v.role === 'independent' && typeof v.default === 'number');
  if (!m) return <p className="text-xs text-muted-foreground">Define a measurement first.</p>;
  const unit = sums[0]?.unit ?? '';
  const first = numIndep[0];
  return (
    <div className="space-y-3">
      <label className="text-[11px]">
        Measurement{' '}
        <select
          className={inputCls}
          value={mid}
          onChange={(x) => setMid(x.target.value)}
          data-testid="res-results-measure"
        >
          {e.measurements.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <table className="w-full text-[11px]" data-testid="res-summary">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th>Condition</th>
            <th>n</th>
            <th>Mean</th>
            <th>SD</th>
            <th>Median</th>
            <th>Min</th>
            <th>Max</th>
            <th>Excluded</th>
          </tr>
        </thead>
        <tbody>
          {sums.map((s) => (
            <tr key={s.conditionId}>
              <td>{s.label}</td>
              <td>{s.stats.n}</td>
              <td className="font-mono">
                {fmt(s.stats.mean)} {unit}
              </td>
              <td className="font-mono">{fmt(s.stats.sd)}</td>
              <td className="font-mono">{fmt(s.stats.median)}</td>
              <td className="font-mono">{fmt(s.stats.min)}</td>
              <td className="font-mono">{fmt(s.stats.max)}</td>
              <td>{s.excluded}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sums.some((s) => s.identicalReplicates) && (
        <p className="text-[11px] text-amber-300">
          Replicates of deterministic conditions are identical: their spread does not estimate real-world
          uncertainty.
        </p>
      )}
      {first && (
        <ScatterChart
          testId="res-chart-response"
          joined
          xLabel={`${first.name} (${first.unit || '-'})`}
          yLabel={`${m.name} (${unit || '-'})`}
          points={sums
            .filter((s) => typeof s.values[first.id] === 'number')
            .map((s) => ({
              x: s.values[first.id] as number,
              y: s.stats.n ? s.stats.mean : null,
              sd: s.stats.n > 1 ? s.stats.sd : null,
              group: numIndep
                .slice(1)
                .map((v) => `${v.name}=${String(s.values[v.id])}`)
                .join(', '),
            }))}
          caption={`Response curve: condition means (±1 SD where replicated). ${sums.reduce((n, s) => n + s.stats.n, 0)} completed run(s).`}
        />
      )}
      <BoxPlot
        testId="res-chart-box"
        yLabel={`${m.name} (${unit || '-'})`}
        groups={sums.map((s) => ({
          label: s.label,
          values: runs
            .filter((r) => r.conditionId === s.conditionId && r.state === 'COMPLETED')
            .map((r) => r.outcomes[m.id]?.value ?? NaN),
        }))}
      />
      {numIndep.length >= 2 &&
        e.design.kind === 'grid' &&
        (() => {
          const g = interactionGrid(runs, m.id, numIndep[0]!.id, numIndep[1]!.id);
          return (
            <Heatmap
              testId="res-chart-heatmap"
              x={g.x}
              y={g.y}
              z={g.z}
              xLabel={numIndep[0]!.name}
              yLabel={numIndep[1]!.name}
              unit={unit}
            />
          );
        })()}
      <Overlay e={e} runs={runs} />
    </div>
  );
}

function Overlay({ e, runs }: { e: Experiment; runs: RunRecord[] }) {
  const editor = useEditorStore();
  const c = researchFor(editor);
  const signals = [...new Set(runs.flatMap((r) => r.data?.signals.map((s) => s.key) ?? []))];
  const [sig, setSig] = useState(signals[0] ?? '');
  const [series, setSeries] = useState<
    { name: string; t: Float64Array; v: Float64Array; hold?: boolean }[] | null
  >(null);
  const [missing, setMissing] = useState(0);
  const load = async () => {
    const firsts = new Map<string, RunRecord>();
    for (const r of runs)
      if (r.state === 'COMPLETED' && !firsts.has(r.conditionId)) firsts.set(r.conditionId, r);
    const out: NonNullable<typeof series> = [];
    let miss = 0;
    for (const r of [...firsts.values()].slice(0, 8)) {
      if (!r.data) continue;
      const d = await loadVerified(c.store, r.data);
      const s = d.ok ? d.data.signals.find((x) => x.key === sig) : null;
      if (s) out.push({ name: r.conditionLabel, t: s.t, v: s.v, hold: s.hold });
      else miss++;
    }
    setSeries(out);
    setMissing(miss);
  };
  if (!signals.length) return null;
  void e;
  return (
    <Section title="Time series overlay (first completed replicate per condition)">
      <div className="flex gap-1">
        <select
          className={inputCls}
          value={sig}
          onChange={(x) => setSig(x.target.value)}
          data-testid="res-overlay-signal"
        >
          {signals.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={() => void load()} data-testid="res-overlay-load">
          Plot
        </Button>
      </div>
      {series && <LineChart testId="res-chart-overlay" series={series} xLabel="time (s)" yLabel={sig} />}
      {missing > 0 && (
        <p className="text-[11px] text-destructive">
          {missing} run(s) have no stored trace for this signal (missing data, not plotted).
        </p>
      )}
    </Section>
  );
}

// -- Analysis --------------------------------------------------------------------------------
function Analysis({ e }: { e: Experiment }) {
  const editor = useEditorStore();
  const c = researchFor(editor);
  const runs = c.engine.runsOf(e.id);
  const conds = [...new Map(runs.map((r) => [r.conditionId, r.conditionLabel])).entries()];
  const [mid, setMid] = useState(e.hypothesis?.outcome ?? e.measurements[0]?.id ?? '');
  const [a, setA] = useState(conds[0]?.[0] ?? '');
  const [b, setB] = useState(conds[1]?.[0] ?? '');
  const cmp = mid && a && b && a !== b ? compareConditions(runs, mid, a, b) : null;
  const ra = runs.find((r) => r.conditionId === a && r.state === 'COMPLETED');
  const rb = runs.find((r) => r.conditionId === b && r.state === 'COMPLETED');
  const diff = ra && rb ? configDiff(ra, rb) : null;
  const sens = mid ? oatSensitivity(e, runs, mid) : null;
  const unc = mid && e.design.kind === 'monte-carlo' ? uncertaintySummary(runs, mid) : null;
  const [conv, setConv] = useState<Awaited<ReturnType<typeof convergenceStudy>> | null>(null);
  const numVars = e.variables.filter((v) => typeof v.default === 'number' && v.role === 'independent');
  const sigs = [...new Set(runs.flatMap((r) => r.data?.signals.map((s) => s.key) ?? []))];
  const [cv, setCv] = useState({ variable: numVars[0]?.id ?? '', signal: sigs[0] ?? '', threshold: '0.001' });
  return (
    <div className="space-y-3">
      <Section title="Compare conditions" testId="res-compare">
        <div className="flex flex-wrap gap-1 text-[11px]">
          <select
            className={inputCls}
            value={mid}
            onChange={(x) => setMid(x.target.value)}
            data-testid="res-compare-measure"
          >
            {e.measurements.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select
            className={inputCls}
            value={a}
            onChange={(x) => setA(x.target.value)}
            data-testid="res-compare-a"
          >
            {conds.map(([id, l]) => (
              <option key={id} value={id}>
                reference: {l}
              </option>
            ))}
          </select>
          <select
            className={inputCls}
            value={b}
            onChange={(x) => setB(x.target.value)}
            data-testid="res-compare-b"
          >
            {conds.map(([id, l]) => (
              <option key={id} value={id}>
                comparison: {l}
              </option>
            ))}
          </select>
        </div>
        {cmp && (
          <div className="space-y-0.5 text-[11px]" data-testid="res-compare-result">
            <p>
              Difference of means:{' '}
              <strong className="font-mono">
                {fmt(cmp.differenceOfMeans)} {cmp.unit}
              </strong>
              {cmp.relativeChange !== null ? ` (${fmt(cmp.relativeChange * 100, 3)} %)` : ''} · medians{' '}
              {fmt(cmp.differenceOfMedians)} · n = {cmp.reference.stats.n} / {cmp.comparison.stats.n}
            </p>
            {cmp.inference && (
              <p>
                {cmp.inference.method}: {Math.round(cmp.inference.level * 100)} % CI{' '}
                {cmp.inference.ci ? `[${fmt(cmp.inference.ci[0])}, ${fmt(cmp.inference.ci[1])}]` : '—'}
                {cmp.inference.pValue !== null ? `, p = ${fmt(cmp.inference.pValue, 3)}` : ''} · assumptions:{' '}
                {cmp.inference.assumptions.join(' ')}
              </p>
            )}
            {cmp.effect && (
              <p>
                Effect size: Cohen's d = {fmt(cmp.effect.cohensD, 3)}, Hedges' g ={' '}
                {fmt(cmp.effect.hedgesG, 3)}
              </p>
            )}
            {cmp.permutation && (
              <p>
                Permutation test p = {fmt(cmp.permutation.pValue, 3)} ({cmp.permutation.permutations}{' '}
                permutations, seed {cmp.permutation.seed})
              </p>
            )}
            {cmp.notes.map((n, i) => (
              <p key={i} className="text-muted-foreground">
                {n}
              </p>
            ))}
          </div>
        )}
        {diff && (
          <div className="text-[11px]" data-testid="res-config-diff">
            <p className="font-medium">What differs between these conditions:</p>
            <ul className="font-mono text-[10px]">
              {diff.diffs.map((d) => (
                <li key={d.field}>
                  {d.field}: {d.a.slice(0, 80)} → {d.b.slice(0, 80)}
                </li>
              ))}
            </ul>
            {diff.warning && <p className="text-amber-300">{diff.warning}</p>}
          </div>
        )}
      </Section>
      {sens && sens.parameters.length > 0 && (
        <Section title="Sensitivity (one at a time)" testId="res-sensitivity">
          <table className="w-full text-[11px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th>Parameter</th>
                <th>Range</th>
                <th>∂y/∂x at baseline</th>
                <th>Elasticity</th>
                <th>Share of swing</th>
              </tr>
            </thead>
            <tbody>
              {sens.parameters.map((p) => (
                <tr key={p.variableId}>
                  <td>{p.name}</td>
                  <td>
                    {fmt(p.range[0])}–{fmt(p.range[1])} {p.unit}
                  </td>
                  <td className="font-mono">{fmt(p.derivative)}</td>
                  <td className="font-mono">{fmt(p.elasticity, 3)}</td>
                  <td className="font-mono">
                    {p.normalizedSwing === null ? '—' : `${(p.normalizedSwing * 100).toFixed(0)} %`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-muted-foreground">
            {sens.method}; {sens.evaluations} model evaluations. {sens.limitations.join(' ')}
          </p>
        </Section>
      )}
      {unc && (
        <Section title="Uncertainty (Monte Carlo)" testId="res-uncertainty">
          <p className="text-[11px]">
            n = {unc.samples} · mean {fmt(unc.stats.mean)} · SD {fmt(unc.stats.sd)} · 5 %{' '}
            {fmt(unc.quantiles.p05)} · median {fmt(unc.quantiles.p50)} · 95 % {fmt(unc.quantiles.p95)} · mean
            change from half to full sample{' '}
            {unc.meanChangeHalfToFull === null ? '—' : `${(unc.meanChangeHalfToFull * 100).toFixed(2)} %`}
          </p>
          <Histogram
            edges={unc.histogram.edges}
            counts={unc.histogram.counts}
            xLabel={e.measurements.find((m) => m.id === mid)?.name ?? mid}
          />
          <p className="text-[10px] text-amber-300">{unc.statement}</p>
        </Section>
      )}
      {numVars.length > 0 && sigs.length > 0 && (
        <Section title="Numerical convergence (successive refinement)" testId="res-convergence">
          <div className="flex flex-wrap gap-1 text-[11px]">
            <select
              className={inputCls}
              value={cv.variable}
              onChange={(x) => setCv({ ...cv, variable: x.target.value })}
            >
              {numVars.map((v) => (
                <option key={v.id} value={v.id}>
                  refine: {v.name}
                </option>
              ))}
            </select>
            <select
              className={inputCls}
              value={cv.signal}
              onChange={(x) => setCv({ ...cv, signal: x.target.value })}
            >
              {sigs.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input
              className={`${inputCls} w-20`}
              value={cv.threshold}
              onChange={(x) => setCv({ ...cv, threshold: x.target.value })}
              aria-label="Threshold"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={async () =>
                setConv(await convergenceStudy(runs, c.store, cv.signal, cv.variable, Number(cv.threshold)))
              }
              data-testid="res-convergence-run"
            >
              Assess
            </Button>
          </div>
          {conv &&
            ('error' in conv ? (
              <p className="text-[11px] text-destructive">{conv.error}</p>
            ) : (
              <div className="text-[11px]" data-testid="res-convergence-result">
                <p>
                  <strong>{conv.verdict}</strong> — {conv.explanation}
                </p>
                <ul className="font-mono text-[10px]">
                  {conv.differences.map((d, i) => (
                    <li key={i}>
                      {fmt(d.between[0])} → {fmt(d.between[1])}: RMS difference {d.rms.toExponential(3)}, max{' '}
                      {d.max.toExponential(3)}
                      {conv.observedOrders[i - 1] !== undefined && conv.observedOrders[i - 1] !== null
                        ? `, observed order ${fmt(conv.observedOrders[i - 1]!, 3)}`
                        : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </Section>
      )}
    </div>
  );
}

// -- Validation and calibration -------------------------------------------------------------
function Validation({ e }: { e: Experiment }) {
  const editor = useEditorStore();
  const c = researchFor(editor);
  const doc = c.engine.document;
  const runs = c.engine.runsOf(e.id).filter((r) => r.state === 'COMPLETED');
  const file = useRef<HTMLInputElement>(null);
  const [prov, setProv] = useState({ name: '', origin: '', instrument: '', synthetic: false });
  const [msg, setMsg] = useState<string | null>(null);
  const [vf, setVf] = useState({
    dataset: doc.datasets[0]?.id ?? '',
    run: runs[0]?.id ?? '',
    column: '',
    signal: '',
    metric: 'rmse',
    threshold: '',
    range: '',
  });
  const [cal, setCal] = useState({ variable: '', lower: '', upper: '' });
  const ds = doc.datasets.find((d) => d.id === vf.dataset);
  const importFile = async (f: File) => {
    const text = await f.text();
    const parsed = f.name.endsWith('.json') ? parseDatasetJson(text) : parseDatasetCsv(text);
    if (!parsed.ok) return setMsg(`Import refused: ${parsed.errors.join(' ')}`);
    const id = `ds-${uid()}`;
    const rec = datasetRecord(id, prov.name || f.name, f.name.endsWith('.json') ? 'json' : 'csv', parsed, {
      origin: prov.origin,
      instrument: prov.instrument,
      collectedAt: '',
      operator: '',
      notes: '',
      synthetic: prov.synthetic,
    });
    await c.store.put(rec.record.dataKey, rec.data);
    const r = c.engine.recordDataset(rec.record);
    setMsg(
      r.ok
        ? `Imported ${rec.record.rows} rows (${rec.record.columns.length} columns). ${parsed.warnings.join(' ')}`
        : r.error,
    );
    setVf((v) => ({ ...v, dataset: id }));
  };
  const runValidation = async () => {
    const run = runs.find((r) => r.id === vf.run);
    if (!ds || !run?.data) return setMsg('Choose a dataset and a completed run with recorded data.');
    const dd = await c.store.get(ds.dataKey);
    const rd = await loadVerified(c.store, run.data);
    if (!dd || !rd.ok) return setMsg('Dataset or run data is missing.');
    const obs = dd.signals.find((s) => s.key === vf.column);
    const sim = rd.data.signals.find((s) => s.key === vf.signal);
    if (!obs || !sim) return setMsg('Map a dataset column to a recorded signal.');
    const m = errorMetrics(obs, sim, ds.columns.find((x) => x.name === vf.column)?.uncertainty ?? null);
    if ('error' in m) return setMsg(m.error);
    const rec = validationRecord({
      id: `val-${uid()}`,
      experimentId: e.id,
      dataset: ds,
      run,
      mapping: [{ column: vf.column, signal: vf.signal }],
      metrics: [m],
      acceptance: vf.threshold ? { metric: vf.metric as 'rmse', threshold: Number(vf.threshold) } : null,
      calibrations: doc.calibrations,
      operatingRange: vf.range || run.conditionLabel,
    });
    const r = c.engine.recordValidation(rec);
    setMsg(
      r.ok
        ? `Validation record: ${rec.status} (MAE ${fmt(m.mae)}, RMSE ${fmt(m.rmse)}, max ${fmt(m.maxAbs)}, bias ${fmt(m.bias)} ${m.unit}, n = ${m.n}).`
        : r.error,
    );
  };
  const runCalibration = async () => {
    if (!ds) return setMsg('Choose a dataset.');
    const dd = await c.store.get(ds.dataKey);
    if (!dd) return setMsg('Dataset data is missing.');
    setMsg('Calibrating (each evaluation is a full simulation run)…');
    const r = await calibrate({
      project: editor.getState().project,
      experiment: e,
      R: await c.rapier(),
      parameters: [{ variableId: cal.variable, lower: Number(cal.lower), upper: Number(cal.upper) }],
      dataset: ds,
      data: dd,
      mapping: [{ column: vf.column, signal: vf.signal }],
      id: `cal-${uid()}`,
    });
    if ('error' in r) return setMsg(r.error);
    const ok = c.engine.recordCalibration(r.record);
    setMsg(
      ok.ok
        ? `Fitted ${cal.variable}: ${fmt(r.record.parameters[0]!.nominal)} → ${fmt(r.record.parameters[0]!.fitted)} ${r.record.parameters[0]!.unit} (RMSE ${fmt(r.record.residual.rmse)}). The project is unchanged; nominal values are kept. ${r.record.identifiability.join(' ')}`
        : ok.error,
    );
  };
  return (
    <div className="space-y-3">
      <p className="rounded border border-border p-2 text-[11px]" data-testid="res-validation-status">
        <strong>Validation status:</strong> {validationStatus(doc.validations, e.id)}
      </p>
      <Section title="Import a reference dataset (CSV or JSON)" testId="res-datasets">
        <div className="grid grid-cols-4 gap-1">
          <input
            className={inputCls}
            placeholder="name"
            value={prov.name}
            onChange={(x) => setProv({ ...prov, name: x.target.value })}
          />
          <input
            className={inputCls}
            placeholder="origin / provenance"
            value={prov.origin}
            onChange={(x) => setProv({ ...prov, origin: x.target.value })}
            data-testid="res-dataset-origin"
          />
          <input
            className={inputCls}
            placeholder="instrument"
            value={prov.instrument}
            onChange={(x) => setProv({ ...prov, instrument: x.target.value })}
          />
          <label className="flex items-center gap-1 text-[11px]">
            <input
              type="checkbox"
              checked={prov.synthetic}
              onChange={(x) => setProv({ ...prov, synthetic: x.target.checked })}
              data-testid="res-dataset-synthetic"
            />{' '}
            synthetic (generated) data
          </label>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => file.current?.click()}
          data-testid="res-dataset-import"
        >
          <Upload /> Import file
        </Button>
        <input
          ref={file}
          type="file"
          accept=".csv,.json,text/csv,application/json"
          className="hidden"
          data-testid="res-dataset-file"
          onChange={(x) => x.target.files?.[0] && void importFile(x.target.files[0])}
        />
        <p className="text-[10px] text-muted-foreground">
          CSV header: name [unit], e.g. “t [s],angle [deg]”. Timestamps strictly increasing; empty/NA =
          missing (never zero). 5 MB limit.
        </p>
        <ul className="text-[11px]">
          {doc.datasets.map((d) => (
            <li key={d.id}>
              {d.name} — {d.rows} rows · {d.columns.map((x) => `${x.name} [${x.unit}]`).join(', ')} ·{' '}
              {d.provenance.synthetic ? 'SYNTHETIC' : 'measured (per provenance)'} · origin:{' '}
              {d.provenance.origin || '—'}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Compare with a run / calibrate">
        <div className="grid grid-cols-4 gap-1 text-[11px]">
          <select
            className={inputCls}
            value={vf.dataset}
            onChange={(x) => setVf({ ...vf, dataset: x.target.value })}
            data-testid="res-val-dataset"
          >
            <option value="">dataset…</option>
            {doc.datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            className={inputCls}
            value={vf.column}
            onChange={(x) => setVf({ ...vf, column: x.target.value })}
            data-testid="res-val-column"
          >
            <option value="">column…</option>
            {ds?.columns
              .filter((x) => x.name !== ds.timeColumn)
              .map((x) => (
                <option key={x.name}>{x.name}</option>
              ))}
          </select>
          <select
            className={inputCls}
            value={vf.run}
            onChange={(x) => setVf({ ...vf, run: x.target.value })}
            data-testid="res-val-run"
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.conditionLabel} #{r.replicate + 1}
              </option>
            ))}
          </select>
          <select
            className={inputCls}
            value={vf.signal}
            onChange={(x) => setVf({ ...vf, signal: x.target.value })}
            data-testid="res-val-signal"
          >
            <option value="">signal…</option>
            {[...new Set(runs.flatMap((r) => r.data?.signals.map((s) => s.key) ?? []))].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select
            className={inputCls}
            value={vf.metric}
            onChange={(x) => setVf({ ...vf, metric: x.target.value })}
          >
            <option value="rmse">RMSE ≤</option>
            <option value="mae">MAE ≤</option>
            <option value="maxAbs">max |error| ≤</option>
          </select>
          <input
            className={inputCls}
            placeholder="threshold (optional)"
            value={vf.threshold}
            onChange={(x) => setVf({ ...vf, threshold: x.target.value })}
          />
          <input
            className={`${inputCls} col-span-2`}
            placeholder="operating range (e.g. 0–0.3 kg payload)"
            value={vf.range}
            onChange={(x) => setVf({ ...vf, range: x.target.value })}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void runValidation()}
          data-testid="res-validate-data"
        >
          Compare and record
        </Button>
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          Calibrate
          <select
            className={inputCls}
            value={cal.variable}
            onChange={(x) => setCal({ ...cal, variable: x.target.value })}
            data-testid="res-cal-variable"
          >
            <option value="">parameter…</option>
            {e.variables
              .filter((v) => typeof v.default === 'number')
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.unit})
                </option>
              ))}
          </select>
          <input
            className={`${inputCls} w-20`}
            placeholder="lower"
            value={cal.lower}
            onChange={(x) => setCal({ ...cal, lower: x.target.value })}
          />
          <input
            className={`${inputCls} w-20`}
            placeholder="upper"
            value={cal.upper}
            onChange={(x) => setCal({ ...cal, upper: x.target.value })}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!cal.variable || !vf.column || !vf.signal}
            onClick={() => void runCalibration()}
            data-testid="res-calibrate"
          >
            Fit (least squares)
          </Button>
        </div>
        {msg && (
          <p className="text-[11px]" data-testid="res-val-message">
            {msg}
          </p>
        )}
        <ul className="text-[11px]">
          {doc.calibrations
            .filter((x) => x.experimentId === e.id)
            .map((x) => (
              <li key={x.id}>
                Calibration {x.id}:{' '}
                {x.parameters
                  .map(
                    (p) =>
                      `${p.variableId} ${fmt(p.nominal)} → ${fmt(p.fitted)} ± ${fmt(p.standardError)} ${p.unit}`,
                  )
                  .join(', ')}{' '}
                against {x.datasetId} ({x.converged ? 'converged' : 'not converged'})
              </li>
            ))}
          {doc.validations
            .filter((x) => x.experimentId === e.id)
            .map((x) => (
              <li key={x.id}>
                Validation {x.id}: <strong>{x.status}</strong> vs {x.datasetId} (run {x.runId.slice(0, 10)}…)
              </li>
            ))}
        </ul>
      </Section>
    </div>
  );
}

// -- Notebook --------------------------------------------------------------------------------
function Notebook({ e }: { e: Experiment }) {
  const editor = useEditorStore();
  const c = researchFor(editor);
  const [kind, setKind] = useState<Experiment['notebook'][number]['kind']>('observation');
  const [text, setText] = useState('');
  const [link, setLink] = useState(false);
  const runs = c.engine.runsOf(e.id);
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        Notes are interpretation: they are stored with the protocol, never mixed into run records, and editing
        them never changes recorded results.
      </p>
      <div className="space-y-1">
        <select
          className={inputCls}
          value={kind}
          onChange={(x) => setKind(x.target.value as typeof kind)}
          data-testid="res-note-kind"
        >
          {[
            'question',
            'hypothesis',
            'protocol',
            'methodology',
            'observation',
            'analysis',
            'conclusion',
            'limitation',
            'note',
          ].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <textarea
          rows={5}
          className={`${inputCls} w-full font-mono`}
          placeholder="Markdown"
          value={text}
          onChange={(x) => setText(x.target.value)}
          data-testid="res-note-text"
        />
        <label className="flex items-center gap-1 text-[11px]">
          <input type="checkbox" checked={link} onChange={(x) => setLink(x.target.checked)} /> link all{' '}
          {runs.length} runs
        </label>
        <Button
          size="sm"
          disabled={!text.trim()}
          data-testid="res-note-save"
          onClick={() => {
            if (
              c.exec({
                type: 'experiment.note.set',
                payload: {
                  experimentId: e.id,
                  note: {
                    id: `note-${uid()}`,
                    kind,
                    markdown: text,
                    links: { runs: link ? runs.map((r) => r.id) : [], figures: [], datasets: [] },
                  },
                },
              })
            )
              setText('');
          }}
        >
          Add note
        </Button>
      </div>
      {[...e.notebook]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((n) => (
          <article key={n.id} className="rounded border border-border p-2 text-[11px]" data-testid="res-note">
            <header className="flex justify-between text-muted-foreground">
              <span>
                {n.kind} · {n.updatedAt}
                {n.links.runs.length ? ` · ${n.links.runs.length} linked run(s)` : ''}
              </span>
              <button
                onClick={() =>
                  c.exec({ type: 'experiment.note.delete', payload: { experimentId: e.id, noteId: n.id } })
                }
                aria-label="Delete note"
              >
                ×
              </button>
            </header>
            <pre className="whitespace-pre-wrap font-sans">{n.markdown}</pre>
          </article>
        ))}
    </div>
  );
}

// -- Report and export -----------------------------------------------------------------------
function Report({ e }: { e: Experiment }) {
  const editor = useEditorStore();
  const c = researchFor(editor);
  const [md, setMd] = useState<string | null>(null);
  const [json, setJson] = useState<Record<string, unknown> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const generate = async () => {
    const missing: string[] = [];
    for (const r of c.engine.runsOf(e.id)) if (r.data && !(await c.store.get(r.data.key))) missing.push(r.id);
    const r = generateReport(c.engine.document, e.id, { missingData: missing });
    setMd(r.markdown);
    setJson(r.json);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        <Button size="sm" onClick={() => void generate()} data-testid="res-report-generate">
          Generate research summary
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!md}
          onClick={() => md && downloadText(`${e.id}.report.md`, md)}
          data-testid="res-report-md"
        >
          <Download /> Markdown
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!json}
          onClick={() => json && downloadText(`${e.id}.report.json`, JSON.stringify(json, null, 2))}
        >
          <Download /> JSON
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async () =>
            downloadText(
              `${e.id}.forge-experiment.json`,
              JSON.stringify(await exportExperiment(c.engine.document, e.id, c.store)),
            )
          }
          data-testid="res-export"
        >
          <Download /> Export experiment + raw data
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => downloadText(`${e.id}.outcomes.csv`, outcomesCsv(e, c.engine.runsOf(e.id)))}
          data-testid="res-export-csv"
        >
          <Download /> Outcomes CSV
        </Button>
        <Button size="sm" variant="outline" onClick={() => file.current?.click()}>
          <Upload /> Import experiment
        </Button>
        <input
          ref={file}
          type="file"
          accept=".json"
          className="hidden"
          onChange={async (x) => {
            const f = x.target.files?.[0];
            x.target.value = '';
            if (!f) return;
            const r = parseExperimentExport(await f.text());
            if (!r.ok) return setMsg(`Import refused: ${r.error}`);
            if (!c.engine.experiment(r.bundle.experiment.id)) {
              const {
                createdAt: _c,
                updatedAt: _u,
                revision: _r,
                schemaVersion: _s,
                ...draft
              } = r.bundle.experiment;
              c.exec({ type: 'experiment.create', payload: { experiment: draft } });
            }
            let n = 0;
            for (const run of r.bundle.runs) if (c.engine.recordRun(run).ok) n++;
            for (const [k, d] of r.data) await c.store.put(k, d);
            setMsg(
              `Imported ${n} run record(s) and ${r.data.size} raw dataset(s). ${r.dataProblems.join('; ')}`,
            );
          }}
        />
      </div>
      {msg && <p className="text-[11px]">{msg}</p>}
      {md && (
        <pre
          className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded border border-border bg-black/30 p-2 text-[11px]"
          data-testid="res-report"
        >
          {md}
        </pre>
      )}
    </div>
  );
}
