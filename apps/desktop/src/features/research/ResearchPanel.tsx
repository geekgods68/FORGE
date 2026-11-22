import { listTargets, type ExperimentDraft } from '@forge/research';
import {
  armPayloadExperiment,
  controllerComparisonExperiment,
  convergenceExperiment,
  modelFingerprint,
  rcSweepExperiment,
  sensorNoiseExperiment,
} from '@forge/research';
import { FlaskConical, Plus, Redo2, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { useEditor, useEditorStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { researchFor } from './controller';

/** Research mode side panel: the project's experiments, templates and protocol undo/redo. */
const TEMPLATES: {
  key: string;
  label: string;
  needs: string;
  make: (p: Parameters<typeof armPayloadExperiment>[0]) => ExperimentDraft;
}[] = [
  {
    key: 'a',
    label: 'A — Arm payload study',
    needs: 'physics.payload.payload-ee.massKg',
    make: armPayloadExperiment,
  },
  {
    key: 'b',
    label: 'B — Sensor uncertainty',
    needs: 'firmware.fw-responsive.const.THRESHOLD_CM',
    make: sensorNoiseExperiment,
  },
  {
    key: 'c',
    label: 'C — Controller comparison',
    needs: 'electrical.part.U1.firmwareId',
    make: controllerComparisonExperiment,
  },
  {
    key: 'd',
    label: 'D — RC sweep (verification)',
    needs: 'electrical.part.C1.capacitanceF',
    make: rcSweepExperiment,
  },
  {
    key: 'e',
    label: 'E — Timestep convergence',
    needs: 'physics.solver.timestepS',
    make: convergenceExperiment,
  },
];

export function ResearchPanel() {
  const editor = useEditorStore();
  const c = researchFor(editor);
  const ui = useStore(c.ui);
  const project = useEditor((s) => s.project);
  const [tpl, setTpl] = useState('blank');
  const targets = useMemo(() => new Set(listTargets(project).map((t) => t.id)), [project]);
  const available = TEMPLATES.filter(
    (t) =>
      targets.has(t.needs) && (t.key !== 'c' || targets.has('firmware.fw-conservative.const.HYSTERESIS_CM')),
  );
  void ui.version;
  const exps = c.engine.document.experiments;
  const create = () => {
    const t = TEMPLATES.find((x) => x.key === tpl);
    const draft: ExperimentDraft = t
      ? t.make(project)
      : {
          id: `exp-${Date.now().toString(36)}`,
          title: 'New experiment',
          description: '',
          researchQuestion: '',
          mode: 'hypothesis',
          hypothesis: null,
          variables: [],
          measurements: [],
          protocol: {
            model: {
              kind:
                project.scene.nodes[project.scene.rootId]?.kind === 'root' &&
                (project.scene.nodes[project.scene.rootId] as { simulation?: unknown }).simulation
                  ? 'physics'
                  : 'circuit',
              projectId: project.id,
              projectName: project.name,
              fingerprint: modelFingerprint(project),
            },
            durationS: 2,
            warmupS: 0,
            sampleRateHz: 120,
            stopConditions: [],
            recordSignals: [],
            analysisPlan: '',
            randomizationPlan: '',
            notes: '',
          },
          design: {
            kind: 'oat',
            replicates: 1,
            samples: 20,
            baseSeed: 1,
            pairedSeeds: true,
            randomizeOrder: false,
          },
          successCriteria: [],
          limitations: [],
          notebook: [],
        };
    if (exps.some((x) => x.id === draft.id)) draft.id = `${draft.id}-${Date.now().toString(36)}`;
    if (c.exec({ type: 'experiment.create', payload: { experiment: draft } }, `Created “${draft.title}”.`))
      c.select(draft.id);
  };
  return (
    <section aria-label="Research" data-testid="research-panel" className="space-y-3 p-3 text-sm">
      <header className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Research</h2>
        <span className="text-[11px] text-muted-foreground">
          {exps.length} experiment(s) · {c.engine.document.runs.length} runs
        </span>
      </header>
      <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px]">
        Experiments run the simulation models of this project. Results describe the models under stated
        assumptions; they are not empirical validation unless compared with independent measured data.
      </p>
      {!ui.persistent && (
        <p className="text-[11px] text-destructive">
          IndexedDB is unavailable: raw run data is kept in memory only.
        </p>
      )}
      <div className="space-y-1">
        <div className="flex gap-1">
          <select
            aria-label="Template"
            data-testid="res-template"
            className="min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs"
            value={tpl}
            onChange={(e) => setTpl(e.target.value)}
          >
            <option value="blank">Blank experiment</option>
            {available.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={create} data-testid="res-new">
            <Plus /> New
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Templates appear only when this project has the parameters they vary.
        </p>
      </div>
      <ul className="divide-y divide-border rounded border border-border" data-testid="res-experiments">
        {exps.map((e) => (
          <li key={e.id}>
            <button
              className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${ui.experimentId === e.id ? 'bg-secondary' : 'hover:bg-secondary/50'}`}
              onClick={() => c.select(e.id)}
              data-testid={`res-exp-${e.id}`}
            >
              <FlaskConical className="size-3 shrink-0" />
              <span className="flex-1 truncate">{e.title}</span>
              <span className="text-muted-foreground">{c.engine.runsOf(e.id).length}</span>
            </button>
          </li>
        ))}
        {!exps.length && <li className="p-2 text-xs text-muted-foreground">No experiments yet.</li>}
      </ul>
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={!c.engine.canUndo}
          onClick={() => c.engine.undo()}
          data-testid="res-undo"
          title="Undo the last protocol change (recorded results are never undone)"
        >
          <Undo2 /> Undo protocol
        </Button>
        <Button size="sm" variant="outline" disabled={!c.engine.canRedo} onClick={() => c.engine.redo()}>
          <Redo2 /> Redo
        </Button>
      </div>
      {ui.message && (
        <p
          role={ui.message.tone === 'error' ? 'alert' : 'status'}
          className={`text-xs ${ui.message.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
          data-testid="res-message"
        >
          {ui.message.text}
        </p>
      )}
    </section>
  );
}
