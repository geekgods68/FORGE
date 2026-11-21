import {
  canConvertMate,
  CONSTRAINT_TYPES,
  convertMate,
  degToRad,
  makeCommand,
  MATE_COORDINATES,
  MATE_TYPES,
  radToDeg,
  type AssemblyConstraint,
  type CommandResult,
  type CommandType,
  type Mate,
  type PayloadInput,
  type SceneGraph,
  type SceneNode,
} from '@forge/engineering-core';
import { bodyInterfaces } from '@forge/mechanics';
import { Ruler } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useEditor } from '@/app/store';
import {
  currentValue,
  fmt,
  fromUi,
  keyFromRef,
  num,
  ORIGIN_AXES,
  refFromKey,
  toUi,
  unitOf,
  type Kind,
} from './relationshipUnits';

/**
 * Phase 4.1 relationship editors (assembly inspector):
 * - MateEditor: type (safe conversions only), alignment, offset, limits, home, suppression.
 * - ConstraintEditor: value, references, driving / check-only.
 * - NewConstraint: distance / angle / concentric / coincident / parallel / perpendicular.
 * Drafts are validated continuously by an engine DRY RUN (the exact command, solved, never
 * committed); Preview shows the dry-run pose in the viewport; Apply issues ONE validated,
 * undoable command. A refused command leaves the assembly untouched and the reason —
 * including any conflicting relationship the solver names — is shown.
 * Units: degrees and millimetres here only; the commands carry radians and metres.
 */
type AssemblyNode = Extract<SceneNode, { kind: 'assembly' }>;
const selCls = 'h-7 w-full min-w-0 rounded border border-border bg-background px-1 text-xs';
const inCls =
  'h-7 w-full min-w-0 rounded border bg-background px-1 text-right font-mono text-xs tabular-nums outline-none focus:border-ring';

/** Engine dry run of a command against the current project (validation only; nothing is shown or committed). */
function useDryRun<T extends CommandType>(type: T, payload: PayloadInput<T> | null): CommandResult | null {
  const engine = useEditor((s) => s.engine);
  const revision = useEditor((s) => s.project.revision);
  const key = payload ? JSON.stringify(payload) : '';
  return useMemo(
    () => (payload ? engine.preview(makeCommand(type, payload, 'desktop-ui')).result : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, type, key, revision],
  );
}

function Field({
  label,
  unit,
  value,
  onChange,
  testId,
  disabled,
}: {
  label: string;
  unit?: string;
  value: string;
  onChange: (v: string) => void;
  testId?: string;
  disabled?: boolean;
}) {
  const bad = num(value) === null;
  return (
    <label className="flex min-w-0 items-center gap-1">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <input
        aria-label={`${label}${unit ? ` (${unit})` : ''}`}
        data-testid={testId}
        inputMode="decimal"
        disabled={disabled}
        className={`${inCls} ${bad ? 'border-destructive' : 'border-border'}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {unit && <span className="shrink-0 text-muted-foreground">{unit}</span>}
    </label>
  );
}

/** Dry-run verdict + Preview / Apply / Cancel row shared by the editors. */
function Actions({
  verdict,
  error,
  onPreview,
  onApply,
  onCancel,
  applyLabel,
  prefix,
  disabled,
}: {
  verdict: CommandResult | null;
  error: string | null;
  onPreview: () => void;
  onApply: () => void;
  onCancel: () => void;
  applyLabel: string;
  prefix: string;
  disabled?: boolean;
}) {
  const problem = error ?? (verdict && !verdict.ok ? verdict.error.message : null);
  return (
    <div className="space-y-1">
      {problem ? (
        <p role="alert" className="text-red-300" data-testid={`${prefix}-error`}>
          {problem}
        </p>
      ) : verdict?.ok ? (
        <p className="text-emerald-300" data-testid={`${prefix}-valid`}>
          {verdict.noop ? 'No change.' : 'Valid — the solver accepts this change.'}
        </p>
      ) : null}
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || !!problem || !verdict?.ok}
          data-testid={`${prefix}-preview`}
          onClick={onPreview}
        >
          Preview
        </Button>
        <Button size="sm" disabled={disabled || !!error} data-testid={`${prefix}-apply`} onClick={onApply}>
          {applyLabel}
        </Button>
        <Button size="sm" variant="outline" data-testid={`${prefix}-cancel`} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ mate editor

interface CoordDraft {
  limited: boolean;
  min: string;
  max: string;
  home: string;
}
function coordDrafts(m: Pick<Mate, 'type' | 'limits' | 'home'>): CoordDraft[] {
  return MATE_COORDINATES[m.type].map((kind, i) => {
    const l = m.limits[i] ?? null;
    return {
      limited: !!l,
      min: l ? fmt(toUi(kind, l.min)) : kind === 'angle' ? '-180' : '-100',
      max: l ? fmt(toUi(kind, l.max)) : kind === 'angle' ? '180' : '100',
      home: fmt(toUi(kind, m.home[i] ?? 0)),
    };
  });
}

export function MateEditor({
  assemblyId,
  mate,
  onClose,
}: {
  assemblyId: string;
  mate: Mate;
  onClose: () => void;
}) {
  const run = useEditor((s) => s.run);
  const previewCommand = useEditor((s) => s.previewCommand);
  const clearPreview = useEditor((s) => s.clearPreview);
  const [name, setName] = useState(mate.name);
  const [type, setType] = useState<Mate['type']>(mate.type);
  const [alignment, setAlignment] = useState(mate.alignment);
  const [offset, setOffset] = useState(fmt(radToDeg(mate.offsetRad)));
  const [suppressed, setSuppressed] = useState(mate.suppressed);
  const [coords, setCoords] = useState<CoordDraft[]>(() => coordDrafts(mate));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const kinds = MATE_COORDINATES[type];

  const changeType = (t: Mate['type']) => {
    const c = convertMate(mate, t);
    setType(t);
    if (c.ok) setCoords(coordDrafts({ type: t, limits: c.limits, home: c.home }));
    setMsg(null);
  };

  // Build the patch (radians / metres) or a local input error.
  const buildMate = (): { patch: PayloadInput<'assembly.mate.update'>['patch'] } | { error: string } => {
    const off = num(offset);
    if (off === null) return { error: 'Offset must be a number.' };
    const limits: Mate['limits'] = [];
    const home: number[] = [];
    for (const [i, kind] of kinds.entries()) {
      const c = coords[i]!;
      const h = num(c.home);
      if (h === null) return { error: `Home ${i + 1} must be a number.` };
      home.push(fromUi(kind, h));
      if (!c.limited) {
        limits.push(null);
        continue;
      }
      const lo = num(c.min);
      const hi = num(c.max);
      if (lo === null || hi === null) return { error: `Limits ${i + 1} must be numbers.` };
      if (lo > hi) return { error: `Limit ${i + 1}: minimum is greater than maximum.` };
      limits.push({ min: fromUi(kind, lo), max: fromUi(kind, hi) });
    }
    if (!name.trim()) return { error: 'The mate needs a name.' };
    return {
      patch: {
        name: name.trim(),
        ...(type !== mate.type ? { type } : {}),
        alignment,
        offsetRad: degToRad(off),
        limits,
        home,
        suppressed,
      },
    };
  };
  const built = buildMate();
  const payload = 'patch' in built ? { assemblyId, mateId: mate.id, patch: built.patch } : null;
  const verdict = useDryRun('assembly.mate.update', payload);

  return (
    <div
      className="space-y-1.5 rounded border border-sky-800/60 bg-sky-950/20 p-1.5"
      data-testid="mate-editor"
    >
      <label className="flex items-center gap-1">
        <span className="w-16 shrink-0 text-muted-foreground">Name</span>
        <input
          aria-label="Mate name"
          className={`${selCls} text-left`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="grid grid-cols-2 gap-1">
        <select
          aria-label="Edit mate type"
          className={selCls}
          value={type}
          onChange={(e) => changeType(e.target.value as Mate['type'])}
        >
          {MATE_TYPES.filter((t) => canConvertMate(mate.type, t)).map((t) => (
            <option key={t} value={t}>
              {t} ({MATE_COORDINATES[t].length} DOF)
            </option>
          ))}
        </select>
        <select
          aria-label="Edit mate alignment"
          className={selCls}
          value={alignment}
          onChange={(e) => setAlignment(e.target.value as Mate['alignment'])}
        >
          <option value="opposed">opposed (face to face)</option>
          <option value="aligned">aligned (same direction)</option>
        </select>
      </div>
      {(mate.type === 'ball' || mate.type === 'planar') && (
        <p className="text-[10px] text-muted-foreground">
          {mate.type} joints cannot be converted safely; delete and re-create to change the type.
        </p>
      )}
      <Field label="Offset" unit="°" value={offset} onChange={setOffset} testId="mate-edit-offset" />
      {kinds.map((kind, i) => {
        const c = coords[i]!;
        const set = (p: Partial<CoordDraft>) =>
          setCoords((cs) => cs.map((x, k) => (k === i ? { ...x, ...p } : x)));
        const u = unitOf(kind);
        return (
          <fieldset key={`${type}-${i}`} className="space-y-1 rounded border border-border/60 p-1">
            <legend className="px-0.5 text-muted-foreground">
              Coordinate {i + 1} ({kind}, now {fmt(toUi(kind, mate.coordinates[i] ?? 0))} {u})
            </legend>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                aria-label={`Limit coordinate ${i + 1}`}
                checked={c.limited}
                onChange={(e) => set({ limited: e.target.checked })}
              />
              limited
            </label>
            {c.limited && (
              <div className="grid grid-cols-2 gap-1">
                <Field
                  label="Min"
                  unit={u}
                  value={c.min}
                  onChange={(v) => set({ min: v })}
                  testId={`mate-edit-min-${i}`}
                />
                <Field
                  label="Max"
                  unit={u}
                  value={c.max}
                  onChange={(v) => set({ max: v })}
                  testId={`mate-edit-max-${i}`}
                />
              </div>
            )}
            <Field
              label="Home"
              unit={u}
              value={c.home}
              onChange={(v) => set({ home: v })}
              testId={`mate-edit-home-${i}`}
            />
          </fieldset>
        );
      })}
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          aria-label="Suppress mate"
          checked={suppressed}
          onChange={(e) => setSuppressed(e.target.checked)}
        />
        Suppressed (ignored by the solver; bodies keep their pose)
      </label>
      <Actions
        prefix="mate-edit"
        verdict={verdict}
        error={'error' in built ? built.error : null}
        applyLabel="Apply"
        onPreview={() => {
          if (!payload) return;
          const r = previewCommand('assembly.mate.update', payload);
          setMsg(
            r.ok
              ? { ok: true, text: 'Preview shown in the viewport.' }
              : { ok: false, text: r.error.message },
          );
        }}
        onApply={() => {
          if (!payload) return;
          clearPreview();
          const r = run('assembly.mate.update', payload, { label: `Edit ${mate.name}` });
          if (r.ok) onClose();
          else setMsg({ ok: false, text: r.error.message });
        }}
        onCancel={() => {
          clearPreview();
          onClose();
        }}
      />
      {msg && (
        <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-emerald-300' : 'text-red-300'}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------- reference picking

function RefPicker({
  label,
  scene,
  bodies,
  body,
  refKey,
  onBody,
  onRef,
  customFrame,
}: {
  label: string;
  scene: SceneGraph;
  bodies: string[];
  body: string;
  refKey: string;
  onBody: (id: string) => void;
  onRef: (k: string) => void;
  customFrame?: boolean;
}) {
  const ifcs = body ? bodyInterfaces(scene, body) : [];
  return (
    <div className="grid grid-cols-2 gap-1">
      <select
        aria-label={`Constraint body ${label}`}
        className={selCls}
        value={body}
        onChange={(e) => onBody(e.target.value)}
      >
        <option value="">Body {label}…</option>
        {bodies.map((id) => (
          <option key={id} value={id}>
            {scene.nodes[id]!.name}
          </option>
        ))}
      </select>
      <select
        aria-label={`Constraint reference ${label}`}
        className={selCls}
        value={refKey}
        disabled={!body}
        onChange={(e) => onRef(e.target.value)}
      >
        <option value="">Reference…</option>
        {Array.isArray(ifcs) &&
          ifcs.map((i) => (
            <option key={i.id} value={`ifc:${i.id}`}>
              {i.name} (interface)
            </option>
          ))}
        {Object.entries(ORIGIN_AXES).map(([k, o]) => (
          <option key={k} value={k}>
            {o.label}
          </option>
        ))}
        {customFrame && <option value="frame:custom">existing frame (unchanged)</option>}
      </select>
    </div>
  );
}

const NEEDS_VALUE = (t: AssemblyConstraint['type']) => t === 'distance' || t === 'angle';
const CONSTRAINT_HELP: Record<AssemblyConstraint['type'], string> = {
  distance: 'distance between the two reference origins',
  angle: 'angle between the two reference axes (0–180°)',
  concentric: 'axes collinear',
  coincident: 'origins coincide',
  parallel: 'axes parallel',
  perpendicular: 'axes perpendicular',
};

// ------------------------------------------------------------ constraint editor

export function ConstraintEditor({
  assembly,
  constraint: c,
  onClose,
}: {
  assembly: AssemblyNode;
  constraint: AssemblyConstraint;
  onClose: () => void;
}) {
  const scene = useEditor((s) => s.project.scene);
  const run = useEditor((s) => s.run);
  const previewCommand = useEditor((s) => s.previewCommand);
  const clearPreview = useEditor((s) => s.clearPreview);
  const bodies = assembly.childIds.filter((id) => !['group', 'assembly'].includes(scene.nodes[id]!.kind));
  const kind: Kind = c.type === 'angle' ? 'angle' : 'length';
  const [name, setName] = useState(c.name);
  const [value, setValue] = useState(c.value === null ? '' : fmt(toUi(kind, c.value)));
  const [driving, setDriving] = useState(c.driving);
  const [a, setA] = useState(c.a.nodeId);
  const [ra, setRa] = useState(keyFromRef(c.a.ref));
  const [b, setB] = useState(c.b.nodeId);
  const [rb, setRb] = useState(keyFromRef(c.b.ref));
  const [msg, setMsg] = useState<string | null>(null);
  const buildConstraint = ():
    { patch: PayloadInput<'assembly.constraint.update'>['patch'] } | { error: string } => {
    const v = NEEDS_VALUE(c.type) ? num(value) : null;
    if (NEEDS_VALUE(c.type) && v === null) return { error: `The ${c.type} needs a number.` };
    const end = (id: string, key: string, orig: AssemblyConstraint['a']) =>
      key === 'frame:custom' && id === orig.nodeId ? orig : { nodeId: id, ref: refFromKey(key) };
    const ea = end(a, ra, c.a);
    const eb = end(b, rb, c.b);
    if (!ea.ref || !eb.ref) return { error: 'Pick a reference on both bodies.' };
    return {
      patch: {
        name: name.trim() || c.name,
        a: ea as AssemblyConstraint['a'],
        b: eb as AssemblyConstraint['b'],
        driving,
        ...(NEEDS_VALUE(c.type) ? { value: fromUi(kind, v!) } : {}),
      },
    };
  };
  const built = buildConstraint();
  const payload =
    'patch' in built ? { assemblyId: assembly.id, constraintId: c.id, patch: built.patch } : null;
  const verdict = useDryRun('assembly.constraint.update', payload);
  return (
    <div
      className="space-y-1.5 rounded border border-sky-800/60 bg-sky-950/20 p-1.5"
      data-testid="constraint-editor"
    >
      <p className="text-muted-foreground">
        {c.type}: {CONSTRAINT_HELP[c.type]}
      </p>
      <label className="flex items-center gap-1">
        <span className="w-16 shrink-0 text-muted-foreground">Name</span>
        <input
          aria-label="Constraint name"
          className={`${selCls} text-left`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <RefPicker
        label="A"
        scene={scene}
        bodies={bodies}
        body={a}
        refKey={ra}
        onBody={(id) => (setA(id), setRa(''))}
        onRef={setRa}
        customFrame={ra === 'frame:custom'}
      />
      <RefPicker
        label="B"
        scene={scene}
        bodies={bodies}
        body={b}
        refKey={rb}
        onBody={(id) => (setB(id), setRb(''))}
        onRef={setRb}
        customFrame={rb === 'frame:custom'}
      />
      {NEEDS_VALUE(c.type) && (
        <Field
          label="Value"
          unit={unitOf(kind)}
          value={value}
          onChange={setValue}
          testId="constraint-edit-value"
        />
      )}
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          aria-label="Driving constraint"
          checked={driving}
          onChange={(e) => setDriving(e.target.checked)}
        />
        Driving (positions bodies); off = check only (reported, not enforced)
      </label>
      <Actions
        prefix="constraint-edit"
        verdict={verdict}
        error={'error' in built ? built.error : null}
        applyLabel="Apply"
        onPreview={() => {
          if (!payload) return;
          const r = previewCommand('assembly.constraint.update', payload);
          setMsg(r.ok ? null : r.error.message);
        }}
        onApply={() => {
          if (!payload) return;
          clearPreview();
          const r = run('assembly.constraint.update', payload, { label: `Edit ${c.name}` });
          if (r.ok) onClose();
          else setMsg(r.error.message);
        }}
        onCancel={() => {
          clearPreview();
          onClose();
        }}
      />
      {msg && (
        <p role="alert" className="text-red-300">
          {msg}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------ new constraint

export function NewConstraint({ node }: { node: AssemblyNode }) {
  const scene = useEditor((s) => s.project.scene);
  const run = useEditor((s) => s.run);
  const previewCommand = useEditor((s) => s.previewCommand);
  const clearPreview = useEditor((s) => s.clearPreview);
  const bodies = node.childIds.filter((id) => !['group', 'assembly'].includes(scene.nodes[id]!.kind));
  const [type, setType] = useState<AssemblyConstraint['type']>('distance');
  const [a, setA] = useState('');
  const [ra, setRa] = useState('');
  const [b, setB] = useState('');
  const [rb, setRb] = useState('');
  const [value, setValue] = useState('');
  const [driving, setDriving] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const kind: Kind = type === 'angle' ? 'angle' : 'length';
  const refA = refFromKey(ra);
  const refB = refFromKey(rb);
  const v = num(value);
  const ready = a && b && refA && refB && (!NEEDS_VALUE(type) || v !== null);
  const payload: PayloadInput<'assembly.constraint.add'> | null = ready
    ? {
        assemblyId: node.id,
        constraint: {
          type,
          a: { nodeId: a, ref: refA! },
          b: { nodeId: b, ref: refB! },
          driving,
          ...(NEEDS_VALUE(type) ? { value: fromUi(kind, v!) } : {}),
        },
      }
    : null;
  const verdict = useDryRun('assembly.constraint.add', payload);
  const reset = () => {
    clearPreview();
    setMsg(null);
  };
  // Current measured value of the quantity (so the user can start from where things are).
  const measured =
    refA && refB && a && b && NEEDS_VALUE(type) ? currentValue(scene, type, a, refA, b, refB) : null;
  return (
    <details data-testid="new-constraint" onToggle={reset}>
      <summary className="cursor-pointer font-semibold">
        <Ruler className="mr-1 inline size-3.5" />
        New constraint
      </summary>
      <div className="mt-1 space-y-1">
        <select
          aria-label="Constraint type"
          className={selCls}
          value={type}
          onChange={(e) => {
            setType(e.target.value as AssemblyConstraint['type']);
            reset();
          }}
        >
          {CONSTRAINT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t} — {CONSTRAINT_HELP[t]}
            </option>
          ))}
        </select>
        <RefPicker
          label="A"
          scene={scene}
          bodies={bodies}
          body={a}
          refKey={ra}
          onBody={(id) => (setA(id), setRa(''), reset())}
          onRef={(k) => (setRa(k), reset())}
        />
        <RefPicker
          label="B"
          scene={scene}
          bodies={bodies}
          body={b}
          refKey={rb}
          onBody={(id) => (setB(id), setRb(''), reset())}
          onRef={(k) => (setRb(k), reset())}
        />
        {NEEDS_VALUE(type) && (
          <Field
            label="Value"
            unit={unitOf(kind)}
            value={value}
            onChange={(x) => (setValue(x), reset())}
            testId="constraint-value"
          />
        )}
        {measured !== null && (
          <p className="flex items-center justify-between text-muted-foreground">
            <span data-testid="constraint-measured">
              currently {fmt(+toUi(kind, measured).toFixed(3))} {unitOf(kind)}
            </span>
            <button
              type="button"
              className="text-sky-300 hover:underline"
              onClick={() => (setValue(fmt(+toUi(kind, measured).toFixed(3))), reset())}
            >
              Use current
            </button>
          </p>
        )}
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            aria-label="New constraint driving"
            checked={driving}
            onChange={(e) => (setDriving(e.target.checked), reset())}
          />
          Driving (off = check only)
        </label>
        <Actions
          prefix="constraint"
          verdict={verdict}
          error={a && b && a === b ? 'Pick two different bodies.' : null}
          disabled={!payload}
          applyLabel="Add constraint"
          onPreview={() => {
            if (!payload) return;
            const r = previewCommand('assembly.constraint.add', payload);
            setMsg(
              r.ok
                ? { ok: true, text: 'Preview shown in the viewport. Add to apply, or cancel.' }
                : { ok: false, text: r.error.message },
            );
          }}
          onApply={() => {
            if (!payload) return;
            clearPreview();
            const r = run('assembly.constraint.add', payload, { label: `Constraint (${type})` });
            setMsg(r.ok ? { ok: true, text: 'Constraint added.' } : { ok: false, text: r.error.message });
          }}
          onCancel={reset}
        />
        {msg && (
          <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-emerald-300' : 'text-red-300'}>
            {msg.text}
          </p>
        )}
      </div>
    </details>
  );
}
