import {
  CATEGORIES,
  evaluate,
  getDefinition,
  getMaterial,
  TIER_LABELS,
  type ParamValues,
} from '@forge/components';
import type { SceneNode } from '@forge/engineering-core';
import { useMemo } from 'react';
import { useEditor } from '@/app/store';
import { formatLength, formatMass, formatVolume } from '@/components3d/format';
import { ParamField, SpecRow, TierBadge } from '@/features/library/LibraryPanel';

type ComponentNode = Extract<SceneNode, { kind: 'component-instance' }>;

/**
 * Engineering inspector for a component-library instance. Editable: variant,
 * parameters (dimensions in mm), material — each change is ONE validated, undoable
 * `scene.component.configure` command. Read-only: identity, dimensions, mass (with its
 * source), specs, interfaces, provenance and simulation status.
 */
export function ComponentInspector({ node, locked }: { node: ComponentNode; locked: boolean }) {
  const run = useEditor((s) => s.run);
  const c = node.component!;
  const def = getDefinition(node.definitionId);
  const evaluation = useMemo(
    () => (def ? evaluate(def, c.parameters as ParamValues, c.materialId) : null),
    [def, c.parameters, c.materialId],
  );
  const configure = (payload: Record<string, unknown>, label: string) =>
    run('scene.component.configure', { nodeId: node.id, ...payload }, { label });
  const cat = CATEGORIES.find((x) => x.id === c.snapshot.categoryId);
  const sub = cat?.subcategories.find((s) => s.id === c.snapshot.subcategoryId);

  if (!def)
    return (
      <section
        aria-label="Component"
        className="space-y-1 rounded border border-amber-500/60 p-2 text-xs"
        data-testid="component-inspector"
      >
        <p className="font-semibold text-amber-300" role="alert">
          Definition “{node.definitionId}” is not in this component library.
        </p>
        <p>
          Stored identity: {c.snapshot.name} ({cat?.name ?? c.snapshot.categoryId}), tier {c.snapshot.tier}.
          Shown as a placeholder of the recorded size {c.snapshot.boundsM.map(formatLength).join(' × ')}. Its
          data is preserved and saved unchanged.
        </p>
      </section>
    );

  return (
    <section aria-label="Component" className="space-y-2 text-xs" data-testid="component-inspector">
      <div>
        <p className="flex items-center gap-1 font-semibold">
          <TierBadge tier={def.tier} /> <span data-testid="component-family">{def.name}</span>
        </p>
        <p className="text-muted-foreground">
          {cat?.name} › {sub?.name} · {TIER_LABELS[def.tier]} · data: {def.dataStatus}
        </p>
        <p className="mt-1">{def.description}</p>
      </div>
      {def.variants.length > 0 && (
        <label className="flex items-center gap-2">
          <span className="w-20 text-muted-foreground">Variant</span>
          <select
            data-testid="component-variant"
            disabled={locked}
            className="h-8 flex-1 rounded border border-border bg-background px-1"
            value={c.variantId ?? ''}
            onChange={(e) => configure({ variantId: e.target.value || null }, 'Change variant')}
          >
            <option value="">Default</option>
            {def.variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {def.parameters.length > 0 && (
        <fieldset className="space-y-1 rounded border border-border p-2">
          <legend className="px-1 text-muted-foreground">
            Parameters (editable · resize via parameters, not scale)
          </legend>
          {def.parameters.map((p) => (
            <ParamField
              key={p.id}
              def={p}
              value={c.parameters[p.id]}
              disabled={locked}
              testId={`component-param-${p.id}`}
              onChange={(v) => configure({ parameters: { [p.id]: v } }, `Set ${p.label}`)}
            />
          ))}
        </fieldset>
      )}
      <label className="flex items-center gap-2">
        <span className="w-20 text-muted-foreground">Material</span>
        {def.allowedMaterialIds.length > 0 ? (
          <select
            data-testid="component-material"
            disabled={locked}
            className="h-8 flex-1 rounded border border-border bg-background px-1"
            value={c.materialId ?? ''}
            onChange={(e) => configure({ materialId: e.target.value || null }, 'Change material')}
          >
            {def.allowedMaterialIds.map((m) => (
              <option key={m} value={m}>
                {getMaterial(m)?.name ?? m}
              </option>
            ))}
          </select>
        ) : (
          <span>
            {c.materialId ? getMaterial(c.materialId)?.name : 'Fixed by the product (not specified)'}
          </span>
        )}
      </label>
      {evaluation && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5" aria-label="Component data (read-only)">
          <dt className="text-muted-foreground">Dimensions</dt>
          <dd data-testid="component-dimensions">{evaluation.size.map(formatLength).join(' × ')}</dd>
          <dt className="text-muted-foreground">Volume</dt>
          <dd>{formatVolume(evaluation.volumeM3)}</dd>
          <dt className="text-muted-foreground">Mass</dt>
          <dd data-testid="component-mass" title={evaluation.mass.note}>
            {formatMass(evaluation.mass.massKg)}{' '}
            <span className="text-muted-foreground">({evaluation.mass.source})</span>
          </dd>
          {evaluation.material && (
            <>
              <dt className="text-muted-foreground">Material data</dt>
              <dd>
                {evaluation.material.densityKgM3 ?? 'unknown'} kg/m³ · E{' '}
                {evaluation.material.youngsModulusPa
                  ? `${(evaluation.material.youngsModulusPa / 1e9).toFixed(1)} GPa`
                  : 'unknown'}{' '}
                · [{evaluation.material.status}]
              </dd>
            </>
          )}
          {def.specs.mechanical.map((s) => (
            <SpecRow
              key={`m-${s.key}`}
              label={s.label}
              value={s.value}
              unit={s.unit}
              status={s.status}
              note={s.note}
            />
          ))}
          {def.specs.electrical.map((s) => (
            <SpecRow
              key={`e-${s.key}`}
              label={s.label}
              value={s.value}
              unit={s.unit}
              status={s.status}
              note={s.note}
            />
          ))}
          <dt className="text-muted-foreground">Simulation</dt>
          <dd>{def.capabilities.map((x) => `${x.domain}: ${x.status}`).join(' · ')}</dd>
        </dl>
      )}
      {evaluation && (
        <details>
          <summary className="cursor-pointer text-muted-foreground" data-testid="component-interfaces-toggle">
            Connection interfaces ({evaluation.interfaces.length})
          </summary>
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto" data-testid="component-interfaces">
            {evaluation.interfaces.map((i) => (
              <li key={i.id} className="flex gap-1">
                <span className="w-24 truncate text-muted-foreground">{i.type}</span>
                <span className="flex-1 truncate" title={i.compatibility.join(', ')}>
                  {i.name}
                  {i.signal ? ` (${i.signal})` : ''}
                </span>
                <span className="text-muted-foreground">{i.gender ?? '—'}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {def.references.length > 0 && (
        <ul className="text-muted-foreground" aria-label="Provenance">
          {def.references.map((r) => (
            <li key={r.title}>
              {r.kind}: {r.title}
              {r.url ? ` — ${r.url}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
