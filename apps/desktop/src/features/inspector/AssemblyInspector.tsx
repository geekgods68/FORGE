import { checkCompatibility } from '@forge/components';
import {
  degToRad,
  isMateDriven,
  MATE_COORDINATES,
  MATE_TYPES,
  radToDeg,
  type Mate,
  type SceneNode,
  worldMatrix,
} from '@forge/engineering-core';
import {
  aabbGap,
  assemblyMass,
  axisAngle,
  bodyInterfaces,
  checkFastener,
  pointDistance,
  transformDir,
  transformPoint,
  worldBounds,
  type InterferenceResult,
} from '@forge/mechanics';
import { Anchor, Home, Link2, Ruler, ScanSearch, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { NumberField } from '@/components/NumberField';
import { formatLength, formatMass } from '@/components3d/format';
import { useEditor } from '@/app/store';

type AssemblyNode = Extract<SceneNode, { kind: 'assembly' }>;

const STATUS_TEXT: Record<string, string> = {
  'fully-constrained': 'Fully constrained',
  'under-constrained': 'Under-constrained (free joints remain)',
  'over-constrained': 'Over-constrained (redundant but consistent)',
  conflicting: 'Conflicting relationships',
  empty: 'No mates or constraints yet',
};

/**
 * Mechanical assembly inspector: solver status and DOF, members (grounding), joint
 * coordinates (live preview while dragging; one undoable command per release), mates and
 * constraints, mate creation with a dry-run preview, and view-only analysis tools
 * (exploded view, interference, mass). Every model change is a validated engine command.
 */
export function AssemblyInspector({ node, locked }: { node: AssemblyNode; locked: boolean }) {
  const engine = useEditor((s) => s.engine);
  const revision = useEditor((s) => s.project.revision);
  const analysis = useMemo(
    () => engine.analyzeAssembly(node.id),
    // Re-analyse on every committed change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, node.id, revision],
  );
  const report = analysis?.report;
  return (
    <section aria-label="Assembly" className="space-y-3 text-xs" data-testid="assembly-inspector">
      <div className="rounded border border-border p-2" data-testid="assembly-status">
        {!analysis ? (
          <p>No mechanical solver is available.</p>
        ) : !analysis.ok ? (
          <p role="alert" className="text-red-300">
            {analysis.message}
          </p>
        ) : (
          <>
            <p className="font-semibold" data-status={report!.status}>
              {STATUS_TEXT[report!.status] ?? report!.status}
            </p>
            <p className="text-muted-foreground">
              Mobility <span data-testid="assembly-dof">{report!.mobility}</span> DOF · redundancy{' '}
              {report!.redundancy} · max residual {report!.maxResidual.toExponential(1)}
              {report!.implicitGround ? ' · nothing grounded: the first body is held as reference' : ''}
            </p>
            {report!.messages.map((m) => (
              <p key={m} className="text-amber-300">
                {m}
              </p>
            ))}
          </>
        )}
      </div>
      <Joints node={node} locked={locked} />
      <Members node={node} locked={locked} freeBodies={report?.freeBodies ?? []} />
      <Relationships node={node} locked={locked} residuals={report?.relationships ?? []} />
      {!locked && <NewMate node={node} />}
      <Measure node={node} />
      <ViewTools node={node} />
    </section>
  );
}

function Members({
  node,
  locked,
  freeBodies,
}: {
  node: AssemblyNode;
  locked: boolean;
  freeBodies: string[];
}) {
  const scene = useEditor((s) => s.project.scene);
  const run = useEditor((s) => s.run);
  const select = useEditor((s) => s.select);
  return (
    <details open={node.childIds.length <= 30}>
      <summary className="cursor-pointer font-semibold">Members ({node.childIds.length})</summary>
      <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto" data-testid="assembly-members">
        {node.childIds.map((id) => {
          const n = scene.nodes[id]!;
          const grounded = node.mechanical.grounded.includes(id);
          const state = grounded
            ? 'grounded'
            : isMateDriven(scene, id)
              ? 'mated'
              : freeBodies.includes(id)
                ? 'free'
                : '';
          return (
            <li key={id} className="flex items-center gap-1" data-member={id} data-state={state}>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left hover:underline"
                onClick={() => select(id)}
              >
                {n.name}
              </button>
              {state && (
                <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{state}</span>
              )}
              {n.kind !== 'group' && n.kind !== 'assembly' && (
                <button
                  type="button"
                  aria-label={grounded ? `Unground ${n.name}` : `Ground ${n.name}`}
                  title={grounded ? 'Unground' : 'Ground (fix in place)'}
                  disabled={locked}
                  className={grounded ? 'text-sky-300' : 'text-muted-foreground'}
                  onClick={() =>
                    run(
                      'assembly.ground',
                      { assemblyId: node.id, nodeId: id, grounded: !grounded },
                      { label: grounded ? 'Unground' : 'Ground' },
                    )
                  }
                >
                  <Anchor className="size-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Joint coordinate display/edit: angles in degrees, lengths in millimetres (UI only). */
const toUi = (kind: 'angle' | 'length', v: number) => (kind === 'angle' ? radToDeg(v) : v * 1000);
const fromUi = (kind: 'angle' | 'length', v: number) => (kind === 'angle' ? degToRad(v) : v / 1000);

function Joints({ node, locked }: { node: AssemblyNode; locked: boolean }) {
  const run = useEditor((s) => s.run);
  const joints = node.mechanical.mates.filter((m) => !m.suppressed && MATE_COORDINATES[m.type].length > 0);
  if (joints.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="assembly-joints">
      <div className="flex items-center justify-between">
        <p className="font-semibold">Joints</p>
        <Button
          size="sm"
          variant="secondary"
          disabled={locked}
          data-testid="joints-home"
          onClick={() => run('assembly.joint.home', { assemblyId: node.id }, { label: 'Home pose' })}
        >
          <Home /> Home
        </Button>
      </div>
      {joints.map((m) => (
        <JointRow key={m.id} assemblyId={node.id} mate={m} locked={locked} />
      ))}
    </div>
  );
}

function JointRow({ assemblyId, mate, locked }: { assemblyId: string; mate: Mate; locked: boolean }) {
  const run = useEditor((s) => s.run);
  const previewCommand = useEditor((s) => s.previewCommand);
  const clearPreview = useEditor((s) => s.clearPreview);
  const kinds = MATE_COORDINATES[mate.type];
  const [drag, setDrag] = useState<{ i: number; v: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commit = (coords: number[]) => {
    const r = run(
      'assembly.joint.setPosition',
      { assemblyId, mateId: mate.id, coordinates: coords },
      { label: `Move ${mate.name}` },
    );
    setError(r.ok ? null : r.error.message);
  };
  return (
    <div className="space-y-1 rounded border border-border/60 p-1.5" data-joint={mate.id}>
      <p className="flex justify-between">
        <span className="font-medium">{mate.name}</span>
        <span className="text-muted-foreground">{mate.type}</span>
      </p>
      {kinds.map((kind, i) => {
        const lim = mate.limits[i] ?? null;
        const unit = kind === 'angle' ? '°' : 'mm';
        const min = lim ? toUi(kind, lim.min) : kind === 'angle' ? -180 : -200;
        const max = lim ? toUi(kind, lim.max) : kind === 'angle' ? 180 : 200;
        const value = drag?.i === i ? drag.v : toUi(kind, mate.coordinates[i]!);
        const coordsWith = (ui: number) => mate.coordinates.map((c, j) => (j === i ? fromUi(kind, ui) : c));
        return (
          <div key={i} className="grid grid-cols-[1fr_6.5rem] items-center gap-1.5">
            <input
              type="range"
              aria-label={`${mate.name} ${kind} ${i + 1}`}
              data-testid={`joint-${mate.id}-${i}`}
              min={min}
              max={max}
              step={kind === 'angle' ? 0.5 : 0.5}
              value={value}
              disabled={locked}
              onChange={(e) => {
                const v = Number(e.target.value);
                setDrag({ i, v });
                // Live dry-run: the viewport shows the solved pose; nothing is committed yet.
                const r = previewCommand('assembly.joint.setPosition', {
                  assemblyId,
                  mateId: mate.id,
                  coordinates: coordsWith(v),
                });
                setError(r.ok ? null : r.error.message);
              }}
              onPointerUp={() => {
                if (!drag) return;
                clearPreview();
                commit(coordsWith(drag.v));
                setDrag(null);
              }}
              onKeyUp={() => {
                if (!drag) return;
                clearPreview();
                commit(coordsWith(drag.v));
                setDrag(null);
              }}
            />
            <NumberField
              label=""
              unit={unit}
              testId={`joint-${mate.id}-${i}-value`}
              value={toUi(kind, mate.coordinates[i]!)}
              decimals={kind === 'angle' ? 2 : 3}
              disabled={locked}
              onCommit={(v) => commit(coordsWith(v))}
            />
            <p className="col-span-2 -mt-1 text-[10px] text-muted-foreground">
              {lim ? `limits ${min.toFixed(1)} … ${max.toFixed(1)} ${unit}` : 'no limits'} · home{' '}
              {toUi(kind, mate.home[i]!).toFixed(1)} {unit}
            </p>
          </div>
        );
      })}
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

function Relationships({
  node,
  locked,
  residuals,
}: {
  node: AssemblyNode;
  locked: boolean;
  residuals: { id: string; residual: number; satisfied: boolean; role: string }[];
}) {
  const run = useEditor((s) => s.run);
  const scene = useEditor((s) => s.project.scene);
  const byId = new Map(residuals.map((r) => [r.id, r]));
  const rows = [
    ...node.mechanical.mates.map((m) => ({ ...m, rel: 'mate' as const })),
    ...node.mechanical.constraints.map((c) => ({ ...c, rel: 'constraint' as const })),
  ];
  if (rows.length === 0) return null;
  return (
    <details open={rows.length <= 12}>
      <summary className="cursor-pointer font-semibold">Mates &amp; constraints ({rows.length})</summary>
      <ul className="mt-1 max-h-56 space-y-0.5 overflow-auto" data-testid="assembly-relationships">
        {rows.map((r) => {
          const rep = byId.get(r.id);
          return (
            <li key={r.id} className="flex items-center gap-1" data-relationship={r.id}>
              <span className={rep && !rep.satisfied ? 'text-red-300' : 'text-emerald-300'}>●</span>
              <span className="min-w-0 flex-1 truncate" title={`${r.a.nodeId} ↔ ${r.b.nodeId}`}>
                {r.name} · {r.type} · {scene.nodes[r.a.nodeId]?.name} ↔ {scene.nodes[r.b.nodeId]?.name}
                {rep ? ` · ${rep.role}` : ''}
              </span>
              <button
                type="button"
                aria-label={`Delete ${r.name}`}
                disabled={locked}
                className="text-muted-foreground hover:text-red-300"
                onClick={() =>
                  r.rel === 'mate'
                    ? run(
                        'assembly.mate.delete',
                        { assemblyId: node.id, mateId: r.id },
                        { label: 'Delete mate' },
                      )
                    : run(
                        'assembly.constraint.delete',
                        { assemblyId: node.id, constraintId: r.id },
                        { label: 'Delete constraint' },
                      )
                }
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Mate creation: pick two members and their interfaces; preview (dry run) then confirm or cancel. */
function NewMate({ node }: { node: AssemblyNode }) {
  const scene = useEditor((s) => s.project.scene);
  const run = useEditor((s) => s.run);
  const previewCommand = useEditor((s) => s.previewCommand);
  const clearPreview = useEditor((s) => s.clearPreview);
  const previewing = useEditor((s) => s.previewScene !== null);
  const bodies = node.childIds.filter((id) => {
    const k = scene.nodes[id]?.kind;
    return k !== 'group' && k !== 'assembly';
  });
  const [a, setA] = useState('');
  const [ia, setIa] = useState('');
  const [b, setB] = useState('');
  const [ib, setIb] = useState('');
  const [type, setType] = useState<Mate['type']>('fixed');
  const [alignment, setAlignment] = useState<'opposed' | 'aligned'>('opposed');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ifA = useMemo(() => (a ? bodyInterfaces(scene, a) : []), [scene, a]);
  const ifB = useMemo(() => (b ? bodyInterfaces(scene, b) : []), [scene, b]);
  const selA = Array.isArray(ifA) ? ifA.find((i) => i.id === ia) : undefined;
  const selB = Array.isArray(ifB) ? ifB.find((i) => i.id === ib) : undefined;
  const fastener = selA && selB && selA.compatibility.some((t) => /^M[\d.]+-thread$/.test(t));
  const checks = fastener ? checkFastener(selA, selB, null, null) : [];
  const ready = a && b && a !== b && selA && selB;
  const payload = () => ({
    assemblyId: node.id,
    mate: {
      type,
      alignment,
      a: { nodeId: a, ref: { kind: 'interface' as const, interfaceId: ia } },
      b: { nodeId: b, ref: { kind: 'interface' as const, interfaceId: ib } },
    },
  });
  const reset = () => {
    clearPreview();
    setMsg(null);
  };
  const select = (cls: string) =>
    `h-7 w-full min-w-0 rounded border border-border bg-background px-1 text-xs ${cls}`;
  return (
    <details data-testid="new-mate">
      <summary className="cursor-pointer font-semibold">
        <Link2 className="mr-1 inline size-3.5" />
        New mate
      </summary>
      <div className="mt-1 space-y-1">
        {(
          [
            ['A', a, setA, ia, setIa, ifA],
            ['B', b, setB, ib, setIb, ifB],
          ] as const
        ).map(([label, body, setBody, ifc, setIfc, list]) => (
          <div key={label} className="grid grid-cols-2 gap-1">
            <select
              aria-label={`Mate body ${label}`}
              className={select('')}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setIfc('');
                reset();
              }}
            >
              <option value="">Body {label}…</option>
              {bodies.map((id) => (
                <option key={id} value={id}>
                  {scene.nodes[id]!.name}
                </option>
              ))}
            </select>
            <select
              aria-label={`Mate interface ${label}`}
              className={select('')}
              value={ifc}
              disabled={!body || !Array.isArray(list)}
              onChange={(e) => {
                setIfc(e.target.value);
                reset();
              }}
            >
              <option value="">{typeof list === 'string' ? 'no interfaces' : 'Interface…'}</option>
              {Array.isArray(list) &&
                list.map((i) => {
                  const compatible =
                    label === 'B' && selA ? (checkCompatibility(selA, i).compatible ? ' ✓' : '') : '';
                  return (
                    <option key={i.id} value={i.id}>
                      {i.name}
                      {compatible}
                    </option>
                  );
                })}
            </select>
          </div>
        ))}
        <div className="grid grid-cols-2 gap-1">
          <select
            aria-label="Mate type"
            className={select('')}
            value={type}
            onChange={(e) => {
              setType(e.target.value as Mate['type']);
              reset();
            }}
          >
            {MATE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t} ({MATE_COORDINATES[t].length} DOF)
              </option>
            ))}
          </select>
          <select
            aria-label="Mate alignment"
            className={select('')}
            value={alignment}
            onChange={(e) => {
              setAlignment(e.target.value as 'opposed' | 'aligned');
              reset();
            }}
          >
            <option value="opposed">opposed (face to face)</option>
            <option value="aligned">aligned (same direction)</option>
          </select>
        </div>
        {selA && selB && !checkCompatibility(selA, selB).compatible && (
          <p className="text-amber-300">
            Interfaces are not declared compatible ({checkCompatibility(selA, selB).reasons.join(' ')}). A
            mate is still allowed for geometric positioning.
          </p>
        )}
        {checks.length > 0 && (
          <ul data-testid="fastener-checks">
            {checks.map((c) => (
              <li key={c.name} className={c.ok ? 'text-emerald-300' : 'text-red-300'}>
                {c.ok ? '✓' : '✗'} {c.name}: {c.detail}
              </li>
            ))}
            <li className="text-muted-foreground">
              Dimensional checks only — no strength or preload rating.
            </li>
          </ul>
        )}
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="secondary"
            disabled={!ready}
            data-testid="mate-preview"
            onClick={() => {
              const r = previewCommand('assembly.mate.create', payload());
              setMsg(
                r.ok
                  ? { ok: true, text: 'Preview shown in the viewport. Confirm to apply or cancel.' }
                  : { ok: false, text: r.error.message },
              );
            }}
          >
            Preview
          </Button>
          <Button
            size="sm"
            disabled={!ready}
            data-testid="mate-confirm"
            onClick={() => {
              const r = run('assembly.mate.create', payload(), { label: `Mate (${type})` });
              setMsg(r.ok ? { ok: true, text: 'Mate created.' } : { ok: false, text: r.error.message });
            }}
          >
            Confirm
          </Button>
          <Button size="sm" variant="outline" disabled={!previewing && !msg} onClick={reset}>
            Cancel
          </Button>
        </div>
        {msg && (
          <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-emerald-300' : 'text-red-300'}>
            {msg.text}
          </p>
        )}
      </div>
    </details>
  );
}

function ViewTools({ node }: { node: AssemblyNode }) {
  const explode = useEditor((s) => (s.explode?.assemblyId === node.id ? s.explode.factor : 0));
  const setExplode = useEditor((s) => s.setExplode);
  const check = useEditor((s) => s.checkAssemblyInterference);
  const interference = useEditor((s) => (s.interference?.assemblyId === node.id ? s.interference : null));
  const revision = useEditor((s) => s.project.revision);
  const scene = useEditor((s) => s.project.scene);
  const mass = useMemo(() => assemblyMass(scene, node.id), [scene, node.id]);
  const name = (id: string) => scene.nodes[id]?.name ?? id;
  const shown = (interference?.results ?? []).filter((r) => r.kind !== 'contact');
  return (
    <div className="space-y-2 border-t border-border pt-2" data-testid="assembly-tools">
      <label className="block space-y-0.5">
        <span className="flex justify-between">
          <span className="font-semibold">Exploded view</span>
          <span className="text-muted-foreground">{explode === 0 ? 'off' : `× ${explode.toFixed(2)}`}</span>
        </span>
        <input
          type="range"
          aria-label="Explode"
          data-testid="explode"
          className="w-full"
          min={0}
          max={2}
          step={0.05}
          value={explode}
          onChange={(e) => setExplode(node.id, Number(e.target.value))}
        />
        <span className="text-[10px] text-muted-foreground">
          Display only — the model is not changed; 0 restores exactly. Editing is paused while exploded.
        </span>
      </label>
      <div className="space-y-1">
        <Button size="sm" variant="secondary" data-testid="interference-check" onClick={() => check(node.id)}>
          <ScanSearch /> Check interference
        </Button>
        {interference && (
          <div data-testid="interference-results">
            {interference.revision !== revision && (
              <p className="text-amber-300">Results are stale — re-run.</p>
            )}
            <p>
              {shown.length === 0
                ? 'No interference found between members.'
                : `${shown.length} pair${shown.length === 1 ? '' : 's'} flagged`}
              {' · '}
              {interference.results.filter((r) => r.kind === 'contact').length} contact
            </p>
            <ul className="max-h-32 overflow-auto">
              {shown.map((r: InterferenceResult) => (
                <li
                  key={`${r.a}|${r.b}`}
                  className={r.kind === 'interference' ? 'text-red-300' : 'text-amber-300'}
                  title={r.note}
                  data-kind={r.kind}
                >
                  {r.kind === 'interference' ? 'Overlap' : 'Possible'}: {name(r.a)} ↔ {name(r.b)}
                  {r.kind === 'interference' ? ` (${formatLength(r.penetrationM)})` : ''}
                  {r.mated ? ' · mated pair' : ''}
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-muted-foreground">
              Broad phase: bounding boxes. Narrow phase: oriented boxes per solid — verified only for exact
              box solids; curved, holed or envelope parts are reported as “possible”.
            </p>
          </div>
        )}
      </div>
      <div data-testid="assembly-mass">
        <p className="font-semibold">
          <Ruler className="mr-1 inline size-3.5" />
          Mass: {formatMass(mass.massKg)}{' '}
          <span className="font-normal text-muted-foreground">({mass.validity})</span>
        </p>
        {mass.centerOfMass && (
          <p className="text-muted-foreground">
            Centre of mass (world): {mass.centerOfMass.map((v) => (v * 1000).toFixed(1)).join(', ')} mm
          </p>
        )}
        <p className="text-[10px] text-muted-foreground">{mass.note}</p>
      </div>
    </div>
  );
}

/**
 * Measurement between two members: distance between interface origins and the angle
 * between interface axes (exact for declared interfaces — derived from the model, not
 * the mesh), and the bounding-box clearance between bodies (approximate).
 */
function Measure({ node }: { node: AssemblyNode }) {
  const scene = useEditor((s) => s.project.scene);
  const [a, setA] = useState('');
  const [ia, setIa] = useState('');
  const [b, setB] = useState('');
  const [ib, setIb] = useState('');
  const bodies = node.childIds.filter((id) => !['group', 'assembly'].includes(scene.nodes[id]!.kind));
  const list = (id: string) => {
    const l = id ? bodyInterfaces(scene, id) : [];
    return Array.isArray(l) ? l : [];
  };
  const frameOf = (id: string, ifc: string) => {
    if (!id) return null;
    const W = worldMatrix(scene, id);
    const i = list(id).find((x) => x.id === ifc);
    return i
      ? { p: transformPoint(W, i.position), d: transformDir(W, i.direction), tags: i.compatibility }
      : { p: transformPoint(W, [0, 0, 0]), d: null, tags: [] as string[] };
  };
  const fa = frameOf(a, ia);
  const fb = frameOf(b, ib);
  const ba = a ? worldBounds(scene, a) : null;
  const bb = b ? worldBounds(scene, b) : null;
  const holeDia = (tags: readonly string[]) =>
    tags.map((t) => /^hole-([\d.]+)mm$/.exec(t)?.[1]).find(Boolean) ?? null;
  const sel = 'h-7 w-full min-w-0 rounded border border-border bg-background px-1 text-xs';
  return (
    <details data-testid="measure">
      <summary className="cursor-pointer font-semibold">
        <Ruler className="mr-1 inline size-3.5" />
        Measure
      </summary>
      <div className="mt-1 space-y-1">
        {(
          [
            ['1', a, setA, ia, setIa],
            ['2', b, setB, ib, setIb],
          ] as const
        ).map(([label, body, setBody, ifc, setIfc]) => (
          <div key={label} className="grid grid-cols-2 gap-1">
            <select
              aria-label={`Measure body ${label}`}
              className={sel}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setIfc('');
              }}
            >
              <option value="">Body {label}…</option>
              {bodies.map((id) => (
                <option key={id} value={id}>
                  {scene.nodes[id]!.name}
                </option>
              ))}
            </select>
            <select
              aria-label={`Measure interface ${label}`}
              className={sel}
              value={ifc}
              disabled={!body}
              onChange={(e) => setIfc(e.target.value)}
            >
              <option value="">body origin</option>
              {list(body).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
        ))}
        {fa && fb && (
          <dl className="grid grid-cols-[7rem_1fr] gap-y-0.5" data-testid="measure-results">
            <dt className="text-muted-foreground">Distance</dt>
            <dd className="font-mono" data-testid="measure-distance">
              {(pointDistance(fa.p, fb.p) * 1000).toFixed(3)} mm{' '}
              <span className="text-muted-foreground">(exact, model frames)</span>
            </dd>
            {fa.d && fb.d && (
              <>
                <dt className="text-muted-foreground">Axis angle</dt>
                <dd className="font-mono" data-testid="measure-angle">
                  {radToDeg(axisAngle(fa.d, fb.d)).toFixed(3)}°
                </dd>
              </>
            )}
            {ba && bb && a !== b && (
              <>
                <dt className="text-muted-foreground">Clearance</dt>
                <dd className="font-mono">
                  {Math.max(0, aabbGap(ba, bb) * 1000).toFixed(2)} mm{' '}
                  <span className="text-muted-foreground">(approximate: bounding boxes)</span>
                </dd>
              </>
            )}
            {[fa, fb].map((f, i) => {
              const d = holeDia(f.tags);
              return d ? (
                <div key={i} className="contents">
                  <dt className="text-muted-foreground">Hole Ø ({i + 1})</dt>
                  <dd className="font-mono">{d} mm (declared)</dd>
                </div>
              ) : null;
            })}
          </dl>
        )}
      </div>
    </details>
  );
}
