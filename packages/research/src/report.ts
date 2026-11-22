import { compareConditions, summarize } from './analysis';
import type { Experiment, ResearchDocument, RunRecord } from './schemas';
import { validationStatus } from './verification';

/**
 * Research report generated ONLY from recorded experiment data (protocol, run records,
 * calibration/validation records, notebook). Language is deliberately restrained: results are
 * described as properties of the model under the stated conditions; a hypothesis is never
 * "proven"; numerical verification, calibration and empirical validation are reported apart.
 */
const fmt = (x: number | null | undefined, d = 4) =>
  x === null || x === undefined || !Number.isFinite(x) ? '—' : Number(x.toPrecision(d)).toString();

export interface ReportOptions {
  /** Missing raw-data keys (the report says so instead of presenting itself as complete). */
  missingData?: string[];
  generatedAt?: Date;
}

export function hypothesisAssessment(e: Experiment, runs: RunRecord[]): string {
  const h = e.hypothesis;
  if (!h || !h.outcome || !h.independentVariable || h.relationship === 'exploratory')
    return 'No directional hypothesis was evaluated (exploratory study).';
  const xv = e.variables.find((v) => v.id === h.independentVariable);
  // Only conditions in which every OTHER independent variable is at its default: in a one-at-a-time
  // design the other variables' sweeps share this variable's baseline value and must not be mixed in.
  const others = e.variables.filter((v) => v.role === 'independent' && v.id !== h.independentVariable);
  const s = summarize(runs, h.outcome).filter(
    (c) => c.runs > 0 && others.every((v) => c.values[v.id] === undefined || c.values[v.id] === v.default),
  );
  // Numeric variables are ordered by value; categorical ones along their declared level order.
  const numeric = typeof xv?.default === 'number';
  const levels = xv?.levels ?? [];
  const pts = s
    .map((c) => {
      const raw = c.values[h.independentVariable!];
      const x = numeric ? raw : levels.indexOf(raw as never);
      return { x: typeof x === 'number' && (numeric || x >= 0) ? x : NaN, y: c.stats.mean };
    })
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return 'Not enough completed conditions to assess the stated relationship.';
  pts.sort((a, b) => a.x - b.x);
  const along = numeric
    ? ''
    : ` (direction taken along the declared level order: ${levels.map(String).join(' → ')})`;
  const rising = pts.every((p, i) => i === 0 || p.y >= pts[i - 1]!.y);
  const falling = pts.every((p, i) => i === 0 || p.y <= pts[i - 1]!.y);
  const name = xv?.name ?? h.independentVariable;
  const want =
    h.relationship === 'increase'
      ? rising && !falling
      : h.relationship === 'decrease'
        ? falling && !rising
        : null;
  if (want === null)
    return `Observed condition means are reported below; the "${h.relationship}" relationship is assessed from the comparisons, not declared.`;
  return want
    ? `Within this model and the tested range of ${name}, the recorded condition means are consistent with the predicted ${h.relationship}${along}. This supports the hypothesis for the model only; it does not prove it, and it is not evidence about the physical system unless validated.`
    : `Within this model and the tested range of ${name}, the recorded condition means are NOT consistently in the predicted direction (${h.relationship})${along}. See the results for where the relationship changes.`;
}

export function generateReport(
  doc: ResearchDocument,
  experimentId: string,
  opts: ReportOptions = {},
): { markdown: string; json: Record<string, unknown> } {
  const e = doc.experiments.find((x) => x.id === experimentId);
  if (!e) throw new Error('No such experiment.');
  const runs = doc.runs.filter((r) => r.experimentId === experimentId);
  const done = runs.filter((r) => r.state === 'COMPLETED');
  const notDone = runs.filter((r) => r.state !== 'COMPLETED');
  const revisions = [...new Set(runs.map((r) => r.experimentRevision))];
  const fps = [...new Set(runs.map((r) => r.model.fingerprint))];
  const status = validationStatus(doc.validations, experimentId);
  const L: string[] = [];
  const h2 = (t: string) => L.push('', `## ${t}`, '');
  L.push(
    `# ${e.title}`,
    '',
    `_Generated ${(opts.generatedAt ?? new Date()).toISOString()} from ${runs.length} recorded run(s) of experiment \`${e.id}\` (protocol revision ${e.revision}). FORGE Phase 7 research report._`,
  );
  if (opts.missingData?.length)
    L.push(
      '',
      `> **Incomplete:** raw data for ${opts.missingData.length} run(s) is missing (${opts.missingData.slice(0, 5).join(', ')}). Summary values come from the run records; analyses that need raw traces are omitted.`,
    );
  h2('1. Research question');
  L.push(e.researchQuestion || '_Not stated._');
  h2('2. Hypothesis');
  L.push(
    e.hypothesis
      ? `${e.hypothesis.statement}\n\n- Relationship: ${e.hypothesis.relationship}\n- Reference: ${e.hypothesis.referenceCondition || '—'}; comparison: ${e.hypothesis.comparisonCondition || '—'}\n- Criterion: ${e.hypothesis.criterion || '—'}`
      : '_Exploratory study (no hypothesis)._',
  );
  h2('3. Model description');
  L.push(
    `- Model kind: **${e.protocol.model.kind}** (project "${e.protocol.model.projectName}", \`${e.protocol.model.projectId}\`)`,
    `- Model fingerprint(s) used by the runs: ${fps.map((f) => `\`${f.slice(0, 16)}…\``).join(', ') || '—'}`,
    `- Software: ${
      runs[0]
        ? Object.entries(runs[0].versions)
            .map(([k, v]) => `${k} ${v}`)
            .join('; ')
        : '—'
    }`,
  );
  if (fps.length > 1) L.push('', '> Runs used different model fingerprints: compare them only with care.');
  h2('4. Assumptions');
  L.push(
    ...(e.limitations.length
      ? e.limitations.map((l) => `- ${l}`)
      : ['- See the model documentation (SIMULATION_VALIDITY.md).']),
  );
  h2('5. Experimental design');
  L.push(
    `- Design: **${e.design.kind}**, ${e.design.replicates} replicate(s), base seed ${e.design.baseSeed}, ${e.design.pairedSeeds ? 'paired' : 'independent'} seeds, ${e.design.randomizeOrder ? 'randomised' : 'fixed'} order.`,
    `- Randomisation plan: ${e.protocol.randomizationPlan || '—'}`,
    `- Analysis plan: ${e.protocol.analysisPlan || '—'}`,
  );
  h2('6. Variables and controls');
  L.push(
    '| Variable | Role | Type | Target parameter | Unit | Default | Levels / distribution |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const v of e.variables)
    L.push(
      `| ${v.name} | ${v.role} | ${v.type} | \`${v.target}\` | ${v.unit || '—'} | ${String(v.default)} | ${v.distribution ? JSON.stringify(v.distribution) : v.levels.map(String).join(', ') || '—'} |`,
    );
  L.push(
    '',
    '| Measurement | Source | Reduction | Window (s) | Required |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const m of e.measurements)
    L.push(
      `| ${m.name} | ${m.source.kind === 'signal' ? `\`${m.source.signal}\`` : `\`${m.source.expression}\``} | ${m.reduction} | ${m.window.fromS}–${m.window.toS ?? 'end'} | ${m.required ? 'yes' : 'no'} |`,
    );
  h2('7. Simulation settings');
  L.push(
    `- Duration ${e.protocol.durationS} s, warm-up ${e.protocol.warmupS} s, sampling ${e.protocol.sampleRateHz} Hz.`,
  );
  if (runs[0])
    L.push(`- Solver configuration (first run): \`${JSON.stringify(runs[0].config.solver).slice(0, 600)}\``);
  if (revisions.length > 1) L.push(`- Runs come from protocol revisions ${revisions.join(', ')}.`);
  h2('8. Results');
  L.push(
    `${done.length} completed, ${notDone.length} not completed (${[...new Set(notDone.map((r) => r.state))].join(', ') || 'none'}).`,
  );
  for (const m of e.measurements) {
    const s = summarize(runs, m.id);
    L.push(
      '',
      `**${m.name}**`,
      '',
      '| Condition | n | Mean | SD | Min | Max | Unit |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const c of s)
      L.push(
        `| ${c.label} | ${c.stats.n} | ${fmt(c.stats.mean)} | ${fmt(c.stats.sd)} | ${fmt(c.stats.min)} | ${fmt(c.stats.max)} | ${c.unit || '—'} |`,
      );
    if (s.some((c) => c.identicalReplicates))
      L.push(
        '',
        '_Replicates of deterministic conditions are identical; their spread does not represent real-world uncertainty._',
      );
  }
  for (const r of notDone.slice(0, 10))
    L.push(`- Run \`${r.id}\` (${r.conditionLabel}): ${r.state} — ${r.error ?? ''}`);
  h2('9. Statistical analysis');
  const h = e.hypothesis;
  if (h?.outcome) {
    const s = summarize(runs, h.outcome);
    if (s.length >= 2) {
      const ref = s[0]!;
      for (const c of s.slice(1)) {
        const cmp = compareConditions(runs, h.outcome, ref.conditionId, c.conditionId);
        if (!cmp) continue;
        L.push(
          `- ${c.label} vs ${ref.label}: difference of means ${fmt(cmp.differenceOfMeans)} ${cmp.unit}${cmp.relativeChange !== null ? ` (${fmt(cmp.relativeChange * 100, 3)} %)` : ''}${cmp.inference?.ci ? `; ${cmp.inference.method}: ${Math.round(cmp.inference.level * 100)} % CI [${fmt(cmp.inference.ci[0])}, ${fmt(cmp.inference.ci[1])}]${cmp.inference.pValue !== null ? `, p = ${fmt(cmp.inference.pValue, 3)}` : ''}` : ''}.`,
        );
      }
      L.push('', '_Statistical significance is not engineering significance. Each run is one observation._');
    }
  } else L.push('_No outcome designated; see the results tables._');
  L.push('', `Hypothesis assessment: ${hypothesisAssessment(e, runs)}`);
  h2('10. Numerical verification');
  L.push(
    'Numerical verification (does the code solve its equations?) is separate from validation. Phase 5/6 reference cases: PHYSICS_VALIDATION.md, ELECTRICAL_VALIDATION.md. Study-specific checks (refinement, analytical references) are listed in the notebook when performed.',
  );
  h2('11. Validation status');
  L.push(status);
  for (const c of doc.calibrations.filter((x) => x.experimentId === experimentId))
    L.push(
      `- Calibration \`${c.id}\` against dataset \`${c.datasetId}\`: ${c.parameters.map((p) => `${p.variableId} ${fmt(p.nominal)} → ${fmt(p.fitted)} ${p.unit}`).join(', ')} (RMSE ${fmt(c.residual.rmse)}). Calibration data cannot validate the same fit.`,
    );
  for (const v of doc.validations.filter((x) => x.experimentId === experimentId))
    L.push(
      `- Validation \`${v.id}\` against dataset \`${v.datasetId}\`: ${v.status}${v.synthetic ? ' (synthetic data: not empirical evidence)' : ''}.`,
    );
  h2('12. Limitations');
  L.push(
    '- Results describe the simulation model under the stated assumptions, not the physical system.',
    '- No universal accuracy is claimed for FORGE; validity depends on the model, its inputs and the operating range.',
    ...e.limitations.map((l) => `- ${l}`),
  );
  h2('13. Conclusions');
  const concl = e.notebook.filter((n) => n.kind === 'conclusion');
  L.push(
    concl.length ? concl.map((n) => n.markdown).join('\n\n') : '_No conclusions recorded by the researcher._',
  );
  h2('14. Notebook');
  for (const n of e.notebook.filter((x) => x.kind !== 'conclusion'))
    L.push(`### ${n.kind} (${n.updatedAt})`, '', n.markdown, '');
  if (!e.notebook.length) L.push('_Empty._');
  h2('15. Reproduction instructions');
  L.push(
    `1. Open project \`${e.protocol.model.projectId}\` with model fingerprint \`${fps[0] ?? e.protocol.model.fingerprint}\` (a different fingerprint is a different model).`,
    `2. Import this experiment (forge-research-export) or recreate the protocol above (revision ${e.revision}).`,
    `3. Run with the recorded seeds (base seed ${e.design.baseSeed}; per-run seeds and configuration hashes are in the run records) using the software versions listed in section 3.`,
    '4. Deterministic replay is expected within the same build and environment; bitwise identity across browsers, platforms or solver versions is not claimed.',
  );
  const json = {
    format: 'forge-research-report',
    version: 1,
    experiment: { id: e.id, title: e.title, revision: e.revision },
    runs: runs.map((r) => ({
      id: r.id,
      condition: r.conditionLabel,
      replicate: r.replicate,
      state: r.state,
      seed: r.config.seed,
      configHash: r.configHash,
      outcomes: r.outcomes,
      integrityHash: r.integrityHash,
    })),
    validationStatus: status,
    hypothesisAssessment: hypothesisAssessment(e, runs),
    incomplete: !!opts.missingData?.length,
  };
  return { markdown: L.join('\n') + '\n', json };
}

/** Outcomes table as CSV (one row per run) for independent analysis. */
export function outcomesCsv(e: Experiment, runs: RunRecord[]): string {
  const vars = e.variables.map((v) => v.id);
  const ms = e.measurements.map((m) => m.id);
  const head = [
    'run_id',
    'condition',
    'replicate',
    'state',
    'seed',
    'config_hash',
    ...vars.map((v) => `var:${v}`),
    ...ms.map((m) => `${m} [${runs.find((r) => r.outcomes[m])?.outcomes[m]?.unit ?? ''}]`),
  ];
  const esc = (s: string) => (/[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = runs.map((r) =>
    [
      r.id,
      esc(r.conditionLabel),
      String(r.replicate),
      r.state,
      String(r.config.seed),
      r.configHash,
      ...vars.map((v) => esc(String(r.config.variables[v] ?? ''))),
      ...ms.map((m) => ((r.outcomes[m]?.value ?? '') === '' ? '' : String(r.outcomes[m]?.value ?? ''))),
    ].join(','),
  );
  return (
    [
      `# FORGE experiment outcomes: ${e.title} (${e.id}, revision ${e.revision}); empty cell = missing value`,
      head.join(','),
      ...rows,
    ].join('\n') + '\n'
  );
}
