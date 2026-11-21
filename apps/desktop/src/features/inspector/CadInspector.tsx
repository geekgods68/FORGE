import {
  degToRad,
  radToDeg,
  SKETCH_CONSTRAINT_TYPES,
  type CommandResult,
  type Feature,
  type SceneNode,
  type SketchConstraint,
} from '@forge/engineering-core';
import { evaluatePart, massProperties, solveSketch } from '@forge/mechanics';
import { Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatLength, formatMass, formatVolume } from '@/components3d/format';
import { useEditor } from '@/app/store';

type PartNode = Extract<SceneNode, { kind: 'part' }>;
type SketchNode = Extract<SceneNode, { kind: 'sketch' }>;

/** Small numeric input holding a UI value (mm / deg / count) until the form is submitted. */
function Num({
  label,
  value,
  onChange,
  testId,
  step = 0.1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  testId?: string;
  step?: number;
}) {
  return (
    <label className="flex min-w-0 flex-col text-[10px] text-muted-foreground">
      {label}
      <input
        type="number"
        aria-label={label}
        data-testid={testId}
        className="h-7 w-full min-w-0 rounded border border-border bg-background/60 px-1 text-xs text-foreground"
        value={Number.isFinite(value) ? value : ''}
        step={step}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
    </label>
  );
}

function useResult() {
  const [error, setError] = useState<string | null>(null);
  const take = (r: CommandResult) => {
    setError(r.ok ? null : r.error.message);
    return r.ok;
  };
  const node = error ? (
    <p role="alert" data-testid="cad-error" className="text-red-300">
      {error} Nothing was changed.
    </p>
  ) : null;
  return { take, node };
}

const mm = (v: number) => v / 1000;
const rect = (u: number, v: number, w: number, h: number): [number, number][] => [
  [mm(u - w / 2), mm(v - h / 2)],
  [mm(u + w / 2), mm(v - h / 2)],
  [mm(u + w / 2), mm(v + h / 2)],
  [mm(u - w / 2), mm(v + h / 2)],
];

function describe(f: Feature): string {
  const d = (m: number) => formatLength(m);
  switch (f.type) {
    case 'extrude':
      return `Base extrude · ${d(f.depth)} deep · ${f.profile.outer.length}-point profile${f.sourceSketchId ? ' (from sketch)' : ''}`;
    case 'hole':
      return `Hole Ø${d(f.diameter)} at (${d(f.center[0])}, ${d(f.center[1])}) · ${f.depth === null ? 'through' : `${d(f.depth)} deep`}`;
    case 'cut':
      return `Cut · ${f.profile.length}-point profile · ${f.depth === null ? 'through' : `${d(f.depth)} deep`}`;
    case 'boolean':
      return `Boolean ${f.op} · ${f.profile.length}-point profile`;
    case 'pattern-rect':
      return `Rectangular pattern of ${f.target} · ${f.countU} × ${f.countV} @ ${d(f.spacingU)} × ${d(f.spacingV)}`;
    case 'pattern-circ':
      return `Circular pattern of ${f.target} · ${f.count} over ${radToDeg(f.totalAngle).toFixed(1)}°`;
    case 'mirror':
      return `Mirror of ${f.target} about ${f.axis} = ${d(f.offset)}`;
  }
}

/**
 * Feature-based part editor (prismatic kernel). Each operation is one validated, undoable
 * command; the engine regenerates the part and REFUSES the edit (keeping the previous
 * valid state) when the result would be invalid — the reason is shown here.
 */
export function PartInspector({ node, locked }: { node: PartNode; locked: boolean }) {
  const run = useEditor((s) => s.run);
  const scene = useEditor((s) => s.project.scene);
  const result = useMemo(() => evaluatePart(node.features), [node.features]);
  const mass = useMemo(() => massProperties(scene, node.id), [scene, node.id]);
  const { take, node: errorNode } = useResult();
  const [hole, setHole] = useState({ u: 0, v: 0, d: 5, depth: 0, through: true });
  const [cut, setCut] = useState({ u: 0, v: 0, w: 10, h: 10, depth: 0, through: true });
  const [pat, setPat] = useState({
    kind: 'rect' as 'rect' | 'circ',
    target: '',
    nu: 2,
    nv: 1,
    su: 20,
    sv: 20,
    n: 4,
    deg: 360,
    cu: 0,
    cv: 0,
  });
  const [mir, setMir] = useState({ target: '', axis: 'u' as 'u' | 'v', offset: 0 });
  const [bool, setBool] = useState({
    op: 'union' as 'union' | 'difference' | 'intersection',
    u: 0,
    v: 0,
    w: 20,
    h: 20,
  });
  const targets = node.features.filter((f) => f.type === 'hole' || f.type === 'cut');
  const base = { partId: node.id };
  const label = (l: string) => ({ label: l });

  return (
    <section aria-label="Part" className="space-y-3 text-xs" data-testid="part-inspector">
      <div className="rounded border border-border p-2">
        <p className="font-semibold">Feature part (prismatic kernel)</p>
        {result.ok ? (
          <p className="text-muted-foreground" data-testid="part-volume">
            Volume {formatVolume(result.geometry.volumeM3)} (exact for this geometry) · mass{' '}
            {formatMass(mass.massKg)} ({mass.validity}) · {result.geometry.interfaces.length} interfaces
          </p>
        ) : (
          <p className="text-red-300">{result.message}</p>
        )}
      </div>
      <ol className="space-y-0.5" data-testid="part-features">
        {node.features.map((f) => (
          <li key={f.id} className="flex items-center gap-1" data-feature={f.type}>
            <span className="min-w-0 flex-1">{describe(f)}</span>
            {f.type === 'hole' && !locked && (
              <input
                type="number"
                aria-label={`Diameter of ${f.id} (mm)`}
                data-testid={`hole-diameter-${f.id}`}
                className="h-6 w-16 rounded border border-border bg-background/60 px-1"
                defaultValue={f.diameter * 1000}
                step={0.1}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const v = (e.target as HTMLInputElement).valueAsNumber;
                  if (
                    !take(
                      run(
                        'geometry.feature.update',
                        { ...base, feature: { ...f, diameter: mm(v) } },
                        label('Edit hole'),
                      ),
                    )
                  )
                    (e.target as HTMLInputElement).value = String(f.diameter * 1000);
                }}
              />
            )}
            {f.type !== 'extrude' && !locked && (
              <button
                type="button"
                aria-label={`Delete feature ${f.id}`}
                className="text-muted-foreground hover:text-red-300"
                onClick={() =>
                  take(run('geometry.feature.delete', { ...base, featureId: f.id }, label('Delete feature')))
                }
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ol>
      {errorNode}
      {!locked && (
        <div className="space-y-2">
          <details data-testid="add-hole">
            <summary className="cursor-pointer font-semibold">Add hole</summary>
            <div className="mt-1 grid grid-cols-4 gap-1">
              <Num label="u (mm)" value={hole.u} onChange={(u) => setHole({ ...hole, u })} testId="hole-u" />
              <Num label="v (mm)" value={hole.v} onChange={(v) => setHole({ ...hole, v })} testId="hole-v" />
              <Num label="Ø (mm)" value={hole.d} onChange={(d) => setHole({ ...hole, d })} testId="hole-d" />
              <Num
                label="depth (mm)"
                value={hole.depth}
                onChange={(depth) => setHole({ ...hole, depth, through: false })}
                testId="hole-depth"
              />
            </div>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={hole.through}
                onChange={(e) => setHole({ ...hole, through: e.target.checked })}
              />
              through all
            </label>
            <Button
              size="sm"
              data-testid="hole-create"
              onClick={() =>
                take(
                  run(
                    'geometry.hole.create',
                    {
                      ...base,
                      center: [mm(hole.u), mm(hole.v)],
                      diameter: mm(hole.d),
                      depth: hole.through ? null : mm(hole.depth),
                    },
                    label('Hole'),
                  ),
                )
              }
            >
              Create hole
            </Button>
          </details>
          <details>
            <summary className="cursor-pointer font-semibold">Add rectangular cut / pocket</summary>
            <div className="mt-1 grid grid-cols-4 gap-1">
              <Num label="u (mm)" value={cut.u} onChange={(u) => setCut({ ...cut, u })} />
              <Num label="v (mm)" value={cut.v} onChange={(v) => setCut({ ...cut, v })} />
              <Num label="w (mm)" value={cut.w} onChange={(w) => setCut({ ...cut, w })} />
              <Num label="h (mm)" value={cut.h} onChange={(h) => setCut({ ...cut, h })} />
              <Num
                label="depth (mm)"
                value={cut.depth}
                onChange={(depth) => setCut({ ...cut, depth, through: false })}
              />
            </div>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={cut.through}
                onChange={(e) => setCut({ ...cut, through: e.target.checked })}
              />
              through all
            </label>
            <Button
              size="sm"
              onClick={() =>
                take(
                  run(
                    'geometry.cut.create',
                    {
                      ...base,
                      profile: rect(cut.u, cut.v, cut.w, cut.h),
                      depth: cut.through ? null : mm(cut.depth),
                    },
                    label('Cut'),
                  ),
                )
              }
            >
              Create cut
            </Button>
          </details>
          <details data-testid="add-pattern">
            <summary className="cursor-pointer font-semibold">Pattern a hole / cut</summary>
            <div className="mt-1 grid grid-cols-2 gap-1">
              <select
                aria-label="Pattern target"
                className="h-7 rounded border border-border bg-background px-1"
                value={pat.target}
                onChange={(e) => setPat({ ...pat, target: e.target.value })}
              >
                <option value="">Target…</option>
                {targets.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.type} {f.id.slice(0, 8)}
                  </option>
                ))}
              </select>
              <select
                aria-label="Pattern kind"
                className="h-7 rounded border border-border bg-background px-1"
                value={pat.kind}
                onChange={(e) => setPat({ ...pat, kind: e.target.value as 'rect' | 'circ' })}
              >
                <option value="rect">rectangular</option>
                <option value="circ">circular</option>
              </select>
            </div>
            {pat.kind === 'rect' ? (
              <div className="grid grid-cols-4 gap-1">
                <Num
                  label="count u"
                  step={1}
                  value={pat.nu}
                  onChange={(nu) => setPat({ ...pat, nu })}
                  testId="pattern-nu"
                />
                <Num
                  label="count v"
                  step={1}
                  value={pat.nv}
                  onChange={(nv) => setPat({ ...pat, nv })}
                  testId="pattern-nv"
                />
                <Num
                  label="pitch u (mm)"
                  value={pat.su}
                  onChange={(su) => setPat({ ...pat, su })}
                  testId="pattern-su"
                />
                <Num
                  label="pitch v (mm)"
                  value={pat.sv}
                  onChange={(sv) => setPat({ ...pat, sv })}
                  testId="pattern-sv"
                />
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-1">
                <Num label="count" step={1} value={pat.n} onChange={(n) => setPat({ ...pat, n })} />
                <Num label="angle (°)" value={pat.deg} onChange={(deg) => setPat({ ...pat, deg })} />
                <Num label="centre u (mm)" value={pat.cu} onChange={(cu) => setPat({ ...pat, cu })} />
                <Num label="centre v (mm)" value={pat.cv} onChange={(cv) => setPat({ ...pat, cv })} />
              </div>
            )}
            <Button
              size="sm"
              data-testid="pattern-create"
              disabled={!pat.target}
              onClick={() =>
                take(
                  run(
                    'geometry.pattern.create',
                    pat.kind === 'rect'
                      ? {
                          ...base,
                          kind: 'rect',
                          target: pat.target,
                          countU: pat.nu,
                          countV: pat.nv,
                          spacingU: mm(pat.su),
                          spacingV: mm(pat.sv),
                        }
                      : {
                          ...base,
                          kind: 'circ',
                          target: pat.target,
                          count: pat.n,
                          center: [mm(pat.cu), mm(pat.cv)],
                          totalAngle: degToRad(pat.deg),
                        },
                    label('Pattern'),
                  ),
                )
              }
            >
              Create pattern
            </Button>
          </details>
          <details>
            <summary className="cursor-pointer font-semibold">Mirror a hole / cut</summary>
            <div className="mt-1 grid grid-cols-3 gap-1">
              <select
                aria-label="Mirror target"
                className="h-7 rounded border border-border bg-background px-1"
                value={mir.target}
                onChange={(e) => setMir({ ...mir, target: e.target.value })}
              >
                <option value="">Target…</option>
                {targets.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.type} {f.id.slice(0, 8)}
                  </option>
                ))}
              </select>
              <select
                aria-label="Mirror axis"
                className="h-7 rounded border border-border bg-background px-1"
                value={mir.axis}
                onChange={(e) => setMir({ ...mir, axis: e.target.value as 'u' | 'v' })}
              >
                <option value="u">about u = offset</option>
                <option value="v">about v = offset</option>
              </select>
              <Num label="offset (mm)" value={mir.offset} onChange={(offset) => setMir({ ...mir, offset })} />
            </div>
            <Button
              size="sm"
              disabled={!mir.target}
              onClick={() =>
                take(
                  run(
                    'geometry.mirror.create',
                    { ...base, target: mir.target, axis: mir.axis, offset: mm(mir.offset) },
                    label('Mirror'),
                  ),
                )
              }
            >
              Create mirror
            </Button>
          </details>
          <details>
            <summary className="cursor-pointer font-semibold">Boolean with a rectangle</summary>
            <div className="mt-1 grid grid-cols-5 gap-1">
              <select
                aria-label="Boolean operation"
                className="h-7 rounded border border-border bg-background px-1"
                value={bool.op}
                onChange={(e) => setBool({ ...bool, op: e.target.value as typeof bool.op })}
              >
                <option value="union">union</option>
                <option value="difference">difference</option>
                <option value="intersection">intersection</option>
              </select>
              <Num label="u" value={bool.u} onChange={(u) => setBool({ ...bool, u })} />
              <Num label="v" value={bool.v} onChange={(v) => setBool({ ...bool, v })} />
              <Num label="w" value={bool.w} onChange={(w) => setBool({ ...bool, w })} />
              <Num label="h" value={bool.h} onChange={(h) => setBool({ ...bool, h })} />
            </div>
            <Button
              size="sm"
              onClick={() =>
                take(
                  run(
                    'geometry.boolean.create',
                    { ...base, op: bool.op, profile: rect(bool.u, bool.v, bool.w, bool.h) },
                    label(`Boolean ${bool.op}`),
                  ),
                )
              }
            >
              Apply
            </Button>
          </details>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground">
        Prismatic (2.5D) kernel: one extruded body with through/blind holes, pockets, patterns, mirrors and
        planar booleans. No fillets, chamfers, drafts, lofts or STEP export.
      </p>
    </section>
  );
}

const DIMENSIONAL: SketchConstraint['type'][] = ['distance', 'radius', 'diameter', 'angle'];

/** 2D sketch editor: constraint status/DOF from the sketch solver, constraint add/delete, extrude. */
export function SketchInspector({ node, locked }: { node: SketchNode; locked: boolean }) {
  const run = useEditor((s) => s.run);
  const select = useEditor((s) => s.select);
  const solved = useMemo(
    () => solveSketch(node.entities, node.constraints),
    [node.entities, node.constraints],
  );
  const { take, node: errorNode } = useResult();
  const [type, setType] = useState<SketchConstraint['type']>('distance');
  const [r1, setR1] = useState('');
  const [r2, setR2] = useState('');
  const [value, setValue] = useState(100);
  const [depth, setDepth] = useState(5);
  const [circle, setCircle] = useState({ u: 0, v: 0, r: 5 });
  const options = node.entities.filter(
    (e) => e.kind !== 'point' || type === 'coincident' || type === 'fixed' || type === 'distance',
  );
  const twoRefs =
    ['coincident', 'parallel', 'perpendicular', 'equal', 'angle'].includes(type) ||
    (type === 'distance' && node.entities.find((e) => e.id === r1)?.kind === 'point');
  return (
    <section aria-label="Sketch" className="space-y-3 text-xs" data-testid="sketch-inspector">
      <div
        className="rounded border border-border p-2"
        data-testid="sketch-status"
        data-status={solved.status}
      >
        <p className="font-semibold">
          {solved.status === 'fully-constrained'
            ? 'Fully constrained'
            : solved.status === 'under-constrained'
              ? 'Under-constrained'
              : solved.status === 'over-constrained'
                ? 'Over-constrained (redundant, consistent)'
                : 'Conflicting'}
        </p>
        <p className="text-muted-foreground">
          <span data-testid="sketch-dof">{solved.dof}</span> remaining DOF · {node.entities.length} entities ·{' '}
          {node.constraints.length} constraints
        </p>
      </div>
      <ul className="max-h-40 space-y-0.5 overflow-auto" data-testid="sketch-constraints">
        {node.constraints.map((c) => (
          <li key={c.id} className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate">
              {c.type} · {c.refs.join(', ')}
              {c.value !== null
                ? ` = ${c.type === 'angle' ? `${radToDeg(c.value).toFixed(2)}°` : formatLength(c.value)}`
                : ''}
            </span>
            {!locked && (
              <button
                type="button"
                aria-label={`Delete constraint ${c.id}`}
                className="text-muted-foreground hover:text-red-300"
                onClick={() =>
                  take(
                    run(
                      'sketch.constraint.delete',
                      { sketchId: node.id, constraintId: c.id },
                      { label: 'Delete sketch constraint' },
                    ),
                  )
                }
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {errorNode}
      {!locked && (
        <>
          <details data-testid="sketch-add-constraint">
            <summary className="cursor-pointer font-semibold">Add constraint</summary>
            <div className="mt-1 grid grid-cols-2 gap-1">
              <select
                aria-label="Constraint type"
                className="h-7 rounded border border-border bg-background px-1"
                value={type}
                onChange={(e) => setType(e.target.value as SketchConstraint['type'])}
              >
                {SKETCH_CONSTRAINT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                aria-label="Constraint entity 1"
                className="h-7 rounded border border-border bg-background px-1"
                value={r1}
                onChange={(e) => setR1(e.target.value)}
              >
                <option value="">Entity…</option>
                {options.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.kind} {e.id}
                  </option>
                ))}
              </select>
              {twoRefs && (
                <select
                  aria-label="Constraint entity 2"
                  className="h-7 rounded border border-border bg-background px-1"
                  value={r2}
                  onChange={(e) => setR2(e.target.value)}
                >
                  <option value="">Entity…</option>
                  {options.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.kind} {e.id}
                    </option>
                  ))}
                </select>
              )}
              {DIMENSIONAL.includes(type) && (
                <Num
                  label={type === 'angle' ? 'value (°)' : 'value (mm)'}
                  value={value}
                  onChange={setValue}
                  testId="sketch-constraint-value"
                />
              )}
            </div>
            <Button
              size="sm"
              data-testid="sketch-constraint-add"
              disabled={!r1 || (twoRefs && !r2)}
              onClick={() =>
                take(
                  run(
                    'sketch.constraint.add',
                    {
                      sketchId: node.id,
                      constraint: {
                        type,
                        refs: twoRefs ? [r1, r2] : [r1],
                        value: DIMENSIONAL.includes(type)
                          ? type === 'angle'
                            ? degToRad(value)
                            : mm(value)
                          : null,
                        value2: null,
                      },
                    },
                    { label: `Sketch ${type}` },
                  ),
                )
              }
            >
              Add constraint
            </Button>
          </details>
          <details>
            <summary className="cursor-pointer font-semibold">Add circle</summary>
            <div className="mt-1 grid grid-cols-3 gap-1">
              <Num label="u (mm)" value={circle.u} onChange={(u) => setCircle({ ...circle, u })} />
              <Num label="v (mm)" value={circle.v} onChange={(v) => setCircle({ ...circle, v })} />
              <Num label="r (mm)" value={circle.r} onChange={(r) => setCircle({ ...circle, r })} />
            </div>
            <Button
              size="sm"
              onClick={() => {
                const id = `c${node.entities.length}`;
                take(
                  run(
                    'sketch.entity.add',
                    {
                      sketchId: node.id,
                      entities: [
                        { id: `${id}-c`, kind: 'point', x: mm(circle.u), y: mm(circle.v) },
                        { id, kind: 'circle', center: `${id}-c`, r: mm(circle.r) },
                      ],
                    },
                    { label: 'Sketch circle' },
                  ),
                );
              }}
            >
              Add circle
            </Button>
          </details>
          <div className="flex items-end gap-1 border-t border-border pt-2">
            <Num label="Extrude depth (mm)" value={depth} onChange={setDepth} testId="sketch-extrude-depth" />
            <Button
              size="sm"
              data-testid="sketch-extrude"
              onClick={() => {
                const r = run(
                  'part.create',
                  {
                    fromSketchId: node.id,
                    depth: mm(depth),
                    ...(node.parentId ? { parentId: node.parentId } : {}),
                    transform: node.transform,
                  },
                  { label: 'Extrude sketch' },
                );
                if (take(r)) select(r.ok ? r.affectedIds[0]! : null);
              }}
            >
              Extrude to part
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
