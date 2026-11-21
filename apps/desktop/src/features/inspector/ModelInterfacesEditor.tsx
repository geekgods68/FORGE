import {
  degToRad,
  MODEL_INTERFACE_TYPES,
  ModelInterfaceSchema,
  ModelInterfacesSchema,
  radToDeg,
  type ModelInterface,
  type SceneNode,
} from '@forge/engineering-core';
import { cross, defaultXRef, dot, normalize, type V3 } from '@forge/mechanics';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useEditor } from '@/app/store';
import { fmt, num } from './relationshipUnits';

type ModelNode = Extract<SceneNode, { kind: 'model-instance' }>;

/**
 * Connection interfaces of an imported model, DECLARED BY THE USER (Phase 4.1). Nothing is
 * inferred from the mesh or its appearance: name, type, local position (mm, in the model's
 * converted frame — the bounds are shown for reference), mounting axis, roll about it,
 * compatibility tags and dimensions are exactly what is entered. Changes are one validated,
 * undoable command per Apply; "Save to library" copies them to the custom component so new
 * instances carry them. Mates on a removed interface block its removal.
 */
const AXES: Record<string, V3> = {
  '+X': [1, 0, 0],
  '−X': [-1, 0, 0],
  '+Y': [0, 1, 0],
  '−Y': [0, -1, 0],
  '+Z': [0, 0, 1],
  '−Z': [0, 0, -1],
};
const axisKey = (d: readonly number[]) =>
  Object.entries(AXES).find(([, v]) => v.every((x, i) => Math.abs(x - d[i]!) < 1e-9))?.[0] ?? 'custom';

/** In-plane reference: the default xRef of `axis` rotated by `roll` about it (Rodrigues; v ⟂ k). */
function xRefFor(axis: V3, roll: number): V3 {
  const v = defaultXRef(axis);
  const kv = cross(axis, v);
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  return normalize([v[0] * c + kv[0] * s, v[1] * c + kv[1] * s, v[2] * c + kv[2] * s]);
}
function rollOf(axis: V3, xRef: V3): number {
  const v = defaultXRef(axis);
  return Math.atan2(dot(axis, cross(v, xRef)), dot(v, xRef));
}
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'interface';

interface Draft {
  id: string;
  name: string;
  type: ModelInterface['type'];
  gender: '' | 'male' | 'female' | 'neutral';
  pos: [string, string, string];
  axis: string;
  custom: [string, string, string];
  roll: string;
  tags: string;
  diameter: string;
  length: string;
  width: string;
}
const blank = (): Draft => ({
  id: '',
  name: '',
  type: 'mechanical-mount',
  gender: '',
  pos: ['0', '0', '0'],
  axis: '+Y',
  custom: ['0', '1', '0'],
  roll: '0',
  tags: '',
  diameter: '',
  length: '',
  width: '',
});
const toDraft = (i: ModelInterface): Draft => ({
  id: i.id,
  name: i.name,
  type: i.type,
  gender: i.gender ?? '',
  pos: i.position.map((v) => fmt(v * 1000)) as Draft['pos'],
  axis: axisKey(i.direction),
  custom: i.direction.map((v) => fmt(v)) as Draft['custom'],
  roll: fmt(+radToDeg(rollOf(i.direction as V3, i.xRef as V3)).toFixed(6)),
  tags: i.compatibility.join(', '),
  diameter: i.dimensions.diameter ? fmt(i.dimensions.diameter * 1000) : '',
  length: i.dimensions.length ? fmt(i.dimensions.length * 1000) : '',
  width: i.dimensions.width ? fmt(i.dimensions.width * 1000) : '',
});

/** Draft → validated interface (metres / unit vectors), or the problems found. */
function fromDraft(d: Draft): { ok: true; value: ModelInterface } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const pos = d.pos.map(num);
  if (pos.some((v) => v === null)) issues.push('Position: enter three numbers (mm).');
  let axis: V3 | null = AXES[d.axis] ?? null;
  if (d.axis === 'custom') {
    const c = d.custom.map(num);
    const len = c.every((v) => v !== null) ? Math.hypot(...(c as number[])) : 0;
    if (len < 1e-9) issues.push('Custom axis: enter a non-zero direction.');
    else axis = normalize(c as V3);
  }
  const roll = num(d.roll);
  if (roll === null) issues.push('Roll must be a number (degrees).');
  const dim = (s: string, label: string) => {
    if (s.trim() === '') return undefined;
    const v = num(s);
    if (v === null || v <= 0) {
      issues.push(`${label} must be a positive number (mm).`);
      return undefined;
    }
    return v / 1000;
  };
  const dimensions = {
    ...(dim(d.diameter, 'Diameter') !== undefined ? { diameter: dim(d.diameter, 'Diameter')! } : {}),
    ...(dim(d.length, 'Length') !== undefined ? { length: dim(d.length, 'Length')! } : {}),
    ...(dim(d.width, 'Width') !== undefined ? { width: dim(d.width, 'Width')! } : {}),
  };
  if (issues.length || !axis || roll === null) return { ok: false, issues };
  const candidate = {
    id: d.id.trim() || slug(d.name),
    name: d.name.trim(),
    type: d.type,
    gender: d.gender || null,
    position: (pos as number[]).map((v) => v / 1000),
    direction: axis,
    xRef: xRefFor(axis, degToRad(roll)),
    compatibility: d.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    dimensions,
  };
  const r = ModelInterfaceSchema.safeParse(candidate);
  if (!r.success)
    return {
      ok: false,
      issues: r.error.issues.map((i) =>
        i.path[0] === 'compatibility' && i.code === 'too_small'
          ? 'Add at least one compatibility tag (e.g. M4-clearance).'
          : `${i.path.join('.') || 'interface'}: ${i.message}`,
      ),
    };
  return { ok: true, value: r.data };
}

const inCls =
  'h-7 w-full min-w-0 rounded border border-border bg-background px-1 font-mono text-xs outline-none focus:border-ring';

export function ModelInterfacesEditor({ node, locked }: { node: ModelNode; locked: boolean }) {
  const run = useEditor((s) => s.run);
  const library = useEditor((s) => s.customModels.find((m) => m.assetHash === node.model.assetHash));
  const saveToLibrary = useEditor((s) => s.updateCustomModelInterfaces);
  const list = node.model.interfaces;
  const [editing, setEditing] = useState<{ index: number | null; draft: Draft } | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const commit = (next: ModelInterface[], label: string) => {
    const v = ModelInterfacesSchema.safeParse(next);
    if (!v.success) {
      setIssues(v.error.issues.map((i) => i.message));
      return false;
    }
    const r = run('model.instance.interfaces.set', { nodeId: node.id, interfaces: v.data }, { label });
    if (!r.ok) {
      setIssues([r.error.message]);
      return false;
    }
    setIssues([]);
    return true;
  };
  const apply = () => {
    if (!editing) return;
    const r = fromDraft(editing.draft);
    if (!r.ok) return setIssues(r.issues);
    const next =
      editing.index === null ? [...list, r.value] : list.map((x, k) => (k === editing.index ? r.value : x));
    if (
      commit(
        next,
        editing.index === null ? `Add interface “${r.value.name}”` : `Edit interface “${r.value.name}”`,
      )
    )
      setEditing(null);
  };
  const set = (p: Partial<Draft>) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...p } } : e));
  const [x0, y0, z0] = node.model.minM;
  const [w, h, d] = node.model.boundsM;
  const differs = library && JSON.stringify(library.interfaces) !== JSON.stringify(list);
  const dr = editing?.draft;
  return (
    <section className="space-y-1.5 rounded border border-border p-2 text-xs" data-testid="model-interfaces">
      <p className="font-semibold">Connection interfaces ({list.length})</p>
      <p className="text-[10px] text-muted-foreground">
        Declared by you — never inferred from the model’s appearance. Positions are in the model’s local frame
        (mm); its bounds are x {fmt(+(x0 * 1000).toFixed(2))}…{fmt(+((x0 + w) * 1000).toFixed(2))}, y{' '}
        {fmt(+(y0 * 1000).toFixed(2))}…{fmt(+((y0 + h) * 1000).toFixed(2))}, z {fmt(+(z0 * 1000).toFixed(2))}…
        {fmt(+((z0 + d) * 1000).toFixed(2))}.
      </p>
      <ul className="space-y-0.5" data-testid="model-interface-list">
        {list.map((i, k) => (
          <li key={i.id} className="flex items-center gap-1" data-interface={i.id}>
            <span className="min-w-0 flex-1 truncate">
              {i.name} · {i.type} · ({i.position.map((v) => fmt(+(v * 1000).toFixed(2))).join(', ')}) mm ·
              axis {axisKey(i.direction)} · {i.compatibility.join(', ')}
            </span>
            <button
              type="button"
              aria-label={`Edit interface ${i.name}`}
              disabled={locked}
              className="text-muted-foreground hover:text-sky-300"
              onClick={() => {
                setIssues([]);
                setEditing({ index: k, draft: toDraft(i) });
              }}
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={`Delete interface ${i.name}`}
              disabled={locked}
              className="text-muted-foreground hover:text-red-300"
              onClick={() =>
                commit(
                  list.filter((_, j) => j !== k),
                  `Delete interface “${i.name}”`,
                )
              }
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {!editing && (
        <Button
          size="sm"
          variant="secondary"
          disabled={locked || list.length >= 64}
          data-testid="model-interface-add"
          onClick={() => {
            setIssues([]);
            setEditing({ index: null, draft: blank() });
          }}
        >
          <Plus /> Add interface
        </Button>
      )}
      {dr && (
        <div
          className="space-y-1 rounded border border-sky-800/60 bg-sky-950/20 p-1.5"
          data-testid="model-interface-form"
        >
          <div className="grid grid-cols-2 gap-1">
            <input
              aria-label="Interface name"
              placeholder="Name"
              className={inCls}
              value={dr.name}
              onChange={(e) => set({ name: e.target.value })}
            />
            <input
              aria-label="Interface id"
              placeholder={dr.name ? slug(dr.name) : 'id (from name)'}
              className={inCls}
              value={dr.id}
              onChange={(e) => set({ id: e.target.value })}
            />
            <select
              aria-label="Interface type"
              className={inCls}
              value={dr.type}
              onChange={(e) => set({ type: e.target.value as Draft['type'] })}
            >
              {MODEL_INTERFACE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              aria-label="Interface gender"
              className={inCls}
              value={dr.gender}
              onChange={(e) => set({ gender: e.target.value as Draft['gender'] })}
            >
              <option value="">no gender</option>
              <option value="male">male</option>
              <option value="female">female</option>
              <option value="neutral">neutral</option>
            </select>
          </div>
          <p className="text-muted-foreground">Local position (mm)</p>
          <div className="grid grid-cols-3 gap-1">
            {(['X', 'Y', 'Z'] as const).map((a, i) => (
              <input
                key={a}
                aria-label={`Interface position ${a} (mm)`}
                className={`${inCls} text-right`}
                inputMode="decimal"
                value={dr.pos[i]}
                onChange={(e) =>
                  set({ pos: dr.pos.map((v, k) => (k === i ? e.target.value : v)) as Draft['pos'] })
                }
              />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1">
            <label className="space-y-0.5">
              <span className="text-muted-foreground">Mounting axis (outward)</span>
              <select
                aria-label="Interface mounting axis"
                className={inCls}
                value={dr.axis}
                onChange={(e) => set({ axis: e.target.value })}
              >
                {Object.keys(AXES).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
                <option value="custom">custom direction</option>
              </select>
            </label>
            <label className="space-y-0.5">
              <span className="text-muted-foreground">Roll about axis (°)</span>
              <input
                aria-label="Interface roll (degrees)"
                className={`${inCls} text-right`}
                inputMode="decimal"
                value={dr.roll}
                onChange={(e) => set({ roll: e.target.value })}
              />
            </label>
          </div>
          {dr.axis === 'custom' && (
            <div className="grid grid-cols-3 gap-1">
              {(['X', 'Y', 'Z'] as const).map((a, i) => (
                <input
                  key={a}
                  aria-label={`Interface axis ${a}`}
                  className={`${inCls} text-right`}
                  inputMode="decimal"
                  value={dr.custom[i]}
                  onChange={(e) =>
                    set({
                      custom: dr.custom.map((v, k) => (k === i ? e.target.value : v)) as Draft['custom'],
                    })
                  }
                />
              ))}
            </div>
          )}
          <input
            aria-label="Interface compatibility tags"
            placeholder="Compatibility tags, comma-separated (e.g. M4-clearance)"
            className={inCls}
            value={dr.tags}
            onChange={(e) => set({ tags: e.target.value })}
          />
          <p className="text-muted-foreground">Declared dimensions (mm, optional)</p>
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                ['diameter', 'Diameter'],
                ['length', 'Length'],
                ['width', 'Width'],
              ] as const
            ).map(([k, label]) => (
              <input
                key={k}
                aria-label={`Interface ${label.toLowerCase()} (mm)`}
                placeholder={label}
                className={`${inCls} text-right`}
                inputMode="decimal"
                value={dr[k]}
                onChange={(e) => set({ [k]: e.target.value })}
              />
            ))}
          </div>
          <div className="flex gap-1">
            <Button size="sm" data-testid="model-interface-apply" onClick={apply}>
              {editing.index === null ? 'Add' : 'Apply'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => (setEditing(null), setIssues([]))}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {issues.length > 0 && (
        <ul role="alert" className="list-disc pl-4 text-red-300" data-testid="model-interface-issues">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      {library ? (
        <div className="flex items-center justify-between gap-1">
          <span className="text-muted-foreground" data-testid="model-interface-library-state">
            Library component: {library.interfaces.length} interface
            {library.interfaces.length === 1 ? '' : 's'}
            {differs ? ' (differs from this instance)' : ' (same as this instance)'}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={!differs}
            data-testid="model-interface-save-library"
            onClick={() => saveToLibrary(node.model.assetHash, list)}
          >
            Save to library
          </Button>
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground">
          This model is not in your component library; its interfaces are kept with the project.
        </p>
      )}
    </section>
  );
}
