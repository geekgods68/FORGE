import { MATE_COORDINATES, MATE_TYPES, type Mate } from '@forge/engineering-core';
import { Magnet } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { useEditor } from '@/app/store';
import { snapContext } from './snapLogic';

/**
 * Drag-to-snap overlay (over the viewport): a hint while snap mode is on, and — after a
 * snap drag is released near compatible interfaces — the choice of target, mate type and
 * alignment with a live dry-run preview, then Confirm (one validated, undoable command)
 * or Cancel (nothing changes; the component returns to its position).
 */
export function SnapPanel() {
  const mode = useEditor((s) => s.mateSnapMode);
  const pending = useEditor((s) => s.mateSnap);
  const update = useEditor((s) => s.updateMateSnap);
  const confirm = useEditor((s) => s.confirmMateSnap);
  const cancel = useEditor((s) => s.cancelMateSnap);
  const setMode = useEditor((s) => s.setMateSnapMode);
  const id = useEditor((s) => (s.selection.length === 1 ? s.selection[0] : undefined));
  const scene = useEditor((s) => s.project.scene);
  const exploded = useEditor((s) => s.explode !== null);
  const ctx = useMemo(() => (mode && id ? snapContext(scene, id) : null), [mode, id, scene]);
  if (!mode) return null;
  const sel = 'h-7 w-full min-w-0 rounded border border-border bg-background px-1 text-xs';
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-4">
      <div
        className="pointer-events-auto w-full max-w-md space-y-1.5 rounded-md border border-emerald-700/60 bg-card/95 p-2 text-xs shadow-lg"
        data-testid="snap-panel"
      >
        <p className="flex items-center gap-1 font-semibold">
          <Magnet className="size-3.5 text-emerald-300" /> Snap to interface
          <button
            type="button"
            className="ml-auto font-normal text-muted-foreground hover:underline"
            onClick={() => setMode(false)}
          >
            Exit snap mode (S)
          </button>
        </p>
        {!pending ? (
          <p className="text-muted-foreground" data-testid="snap-hint">
            {exploded
              ? 'Snapping is paused while the assembly is exploded.'
              : !id
                ? 'Select a component, then drag it onto a highlighted compatible interface.'
                : ctx && !ctx.ok
                  ? ctx.reason
                  : `Drag the selected component: compatible interfaces are highlighted (amber); release within reach of one (green) to preview its mate. ${ctx?.ok ? ctx.targets.length : 0} compatible pairing(s).`}
          </p>
        ) : (
          <>
            <fieldset className="space-y-0.5" aria-label="Snap target">
              <legend className="text-muted-foreground">
                Target interface ({pending.candidates.length} in reach)
              </legend>
              {pending.candidates.map((c, i) => (
                <label key={c.key} className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="snap-target"
                    data-testid={`snap-candidate-${i}`}
                    checked={pending.chosen === c.key}
                    onChange={() => update({ chosen: c.key, type: c.suggestedType })}
                  />
                  <span className="truncate">
                    {c.sourceName} → {c.targetBodyName} · {c.targetName}{' '}
                    <span className="text-muted-foreground">({c.shared.join(', ')})</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="grid grid-cols-2 gap-1">
              <select
                aria-label="Snap mate type"
                className={sel}
                value={pending.type}
                onChange={(e) => update({ type: e.target.value as Mate['type'] })}
              >
                {MATE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t} ({MATE_COORDINATES[t].length} DOF)
                  </option>
                ))}
              </select>
              <select
                aria-label="Snap mate alignment"
                className={sel}
                value={pending.alignment}
                onChange={(e) => update({ alignment: e.target.value as Mate['alignment'] })}
              >
                <option value="opposed">opposed (face to face)</option>
                <option value="aligned">aligned (same direction)</option>
              </select>
            </div>
            {pending.message && (
              <p
                role={pending.message.ok ? 'status' : 'alert'}
                data-testid="snap-message"
                className={pending.message.ok ? 'text-emerald-300' : 'text-red-300'}
              >
                {pending.message.text}
              </p>
            )}
            <div className="flex gap-1">
              <Button
                size="sm"
                data-testid="snap-confirm"
                disabled={!pending.message?.ok}
                onClick={() => confirm()}
              >
                Confirm mate
              </Button>
              <Button size="sm" variant="outline" data-testid="snap-cancel" onClick={() => cancel()}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
