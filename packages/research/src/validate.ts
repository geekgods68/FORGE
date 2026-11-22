import type { Project } from '@forge/engineering-core';
import type { SignalInfo } from './catalog';
import { generatePlan, type Budget } from './design';
import { parseExpr } from './expr';
import { listTargets, modelFingerprint, simulationOfScene } from './params';
import { REDUCTIONS, type Experiment } from './schemas';
import { conversion } from './units';

/**
 * Pre-run validation of an experiment against the ACTUAL model: variables must resolve to
 * parameters used by the selected model kind with compatible units; measurements must name
 * recorded signals and be dimensionally valid; the design must fit the budget.
 */
export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  plan: ReturnType<typeof generatePlan> | null;
}

export function validateExperiment(
  e: Experiment,
  p: Project,
  catalog: SignalInfo[] | null,
  budget?: Budget,
): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const kind = e.protocol.model.kind;
  if (p.id !== e.protocol.model.projectId) errors.push('This experiment belongs to a different project.');
  if (modelFingerprint(p) !== e.protocol.model.fingerprint)
    warnings.push(
      'The engineering model has changed since this protocol was defined: runs will record the new fingerprint, and results from different fingerprints are not directly comparable.',
    );
  const targets = new Map(listTargets(p).map((t) => [t.id, t]));
  for (const v of e.variables) {
    if (v.role === 'dependent') {
      errors.push(
        `${v.name}: dependent quantities are measurements, not variables — define a measurement instead.`,
      );
      continue;
    }
    const t = targets.get(v.target);
    if (!t) {
      errors.push(`${v.name}: "${v.target}" is not a parameter of this model.`);
      continue;
    }
    if (!t.kinds.includes(kind))
      errors.push(`${v.name}: ${t.label} is not used by ${kind} runs (it would have no effect).`);
    if (
      typeof v.default === 'number' &&
      t.valueType !== 'enum' &&
      v.unit !== t.unit &&
      conversion(v.unit, t.unit) === null
    )
      errors.push(`${v.name}: unit "${v.unit}" cannot be converted to the parameter's unit "${t.unit}".`);
    if (t.valueType === 'enum')
      for (const l of [v.default, ...v.levels])
        if (!t.options.some((o) => o.value === l))
          errors.push(`${v.name}: "${String(l)}" is not an available option.`);
    if (
      v.role === 'independent' &&
      !v.levels.length &&
      !['random', 'lhs', 'monte-carlo'].includes(e.design.kind)
    )
      warnings.push(`${v.name}: no levels given — only the default is used.`);
  }
  if (catalog) {
    const units = new Map(catalog.map((c) => [c.key, c.unit]));
    for (const m of e.measurements) {
      if (!REDUCTIONS.includes(m.reduction)) errors.push(`${m.name}: unknown reduction.`);
      if (m.source.kind === 'signal' && !units.has(m.source.signal))
        errors.push(`${m.name}: signal "${m.source.signal}" is not recorded by ${kind} runs of this model.`);
      if (m.source.kind === 'derived') {
        const su: Record<string, string> = {};
        for (const [a, k] of Object.entries(m.source.aliases)) {
          if (!units.has(k)) errors.push(`${m.name}: signal "${k}" is not recorded.`);
          su[a] = units.get(k) ?? '';
        }
        try {
          parseExpr(m.source.expression, su);
        } catch (x) {
          errors.push(`${m.name}: ${x instanceof Error ? x.message : String(x)}`);
        }
      }
      if (
        ['time-above', 'count-above', 'crossings'].includes(m.reduction) &&
        m.params.threshold === undefined
      )
        errors.push(`${m.name}: ${m.reduction} needs a threshold.`);
      if (m.window.toS !== null && m.window.toS <= m.window.fromS)
        errors.push(`${m.name}: empty analysis window.`);
      if (m.window.fromS < e.protocol.warmupS)
        warnings.push(`${m.name}: its window starts inside the warm-up period; the warm-up is excluded.`);
    }
    for (const sc of e.protocol.stopConditions)
      if (!units.has(sc.signal)) errors.push(`Stop condition: signal "${sc.signal}" is not recorded.`);
  }
  if (!e.measurements.length) errors.push('Define at least one measurement.');
  if (kind !== 'circuit' && !simulationOfScene(p.scene) && kind === 'physics')
    errors.push('The model has no physics setup.');
  const plan = generatePlan(e, { stepS: simulationOfScene(p.scene)?.solver.timestepS ?? null, budget });
  errors.push(...plan.errors);
  warnings.push(...plan.warnings);
  return { ok: errors.length === 0, errors, warnings, plan };
}
