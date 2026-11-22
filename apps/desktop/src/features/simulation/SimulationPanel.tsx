import {
  bodySettingsFor,
  radToDeg,
  degToRad,
  type BodySettings,
  type SimulationDefinition,
} from '@forge/engineering-core';
import { MATERIALS } from '@forge/components';
import { bodyCollidersSummary, simulationOf, type JointState } from '@forge/physics';
import { Download, Pause, Play, RotateCcw, SkipForward, OctagonX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import { NumberField } from '@/components/NumberField';
import { useEditor, useEditorStore } from '@/app/store';
import { downloadText } from '@/lib/download';
import { simulationFor, type SimUi } from './controller';
import { TelemetryPlot } from './TelemetryPlot';

/**
 * Simulation mode panel. Every value is labelled by what it is:
 *   measured   — read from the running simulation;
 *   target / command — what the user or controller asked for;
 *   applied    — effort actually applied after saturation (model output);
 *   configured — a persisted setup input (undoable).
 */
const QUALITY = {
  draft: { substeps: 2, solverIterations: 8 },
  standard: { substeps: 4, solverIterations: 8 },
  precise: { substeps: 8, solverIterations: 12 },
} as const;
const qualityOf = (d: SimulationDefinition) =>
  (Object.entries(QUALITY).find(
    ([, v]) => v.substeps === d.solver.substeps && v.solverIterations === d.solver.solverIterations,
  )?.[0] ?? 'custom') as keyof typeof QUALITY | 'custom';

const deg = (r: number, d = 2) => radToDeg(r).toFixed(d);
const fmt3 = (v: readonly number[], k = 1, d = 3) => v.map((x) => (x * k).toFixed(d)).join(', ');

export function SimulationPanel() {
  const c = simulationFor(useEditorStore());
  const ui = useStore(c.ui);
  const def = useEditor((s) => simulationOf(s.project.scene));
  const phase = ui.phase;
  return (
    <section aria-label="Simulation" data-testid="simulation-panel" className="space-y-3 p-3 text-sm">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Simulation</h2>
        <span data-testid="sim-state" className="rounded bg-secondary px-1.5 py-0.5 text-xs">
          {phase}
        </span>
      </header>
      <p
        className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
        data-testid="sim-validity"
      >
        Status: <strong>approximate</strong> rigid-body model (Rapier). Results are not validated predictions
        of the physical robot; see the assumptions below.
      </p>
      {phase === 'loading' && <p className="text-muted-foreground">Loading the physics engine…</p>}
      {phase === 'error' && (
        <p role="alert" className="text-destructive">
          {ui.error}
        </p>
      )}
      {phase === 'no-setup' && <NoSetup onCreate={() => c.createSetup()} />}
      {def && ui.phase !== 'no-setup' && ui.phase !== 'loading' && (
        <>
          <RunControls ui={ui} />
          <Issues ui={ui} />
          <World def={def} />
          <Visual ui={ui} />
          <Joints ui={ui} />
          <Payloads def={def} />
          <BodyInspector ui={ui} />
          <Telemetry ui={ui} />
          <Events ui={ui} />
          <Assumptions ui={ui} />
        </>
      )}
    </section>
  );
}

function NoSetup({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>
        This project has no simulation setup. Creating one adds solver settings, gravity and default body
        settings (undoable). Bodies with unknown mass will need a mass before they can be simulated.
      </p>
      <Button size="sm" onClick={onCreate} data-testid="sim-create">
        Create simulation setup
      </Button>
    </div>
  );
}

function RunControls({ ui }: { ui: SimUi }) {
  const c = simulationFor(useEditorStore());
  const running = ui.phase === 'running';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {running ? (
          <Button size="sm" variant="secondary" onClick={() => c.pause()} data-testid="sim-pause">
            <Pause /> Pause
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => c.start()}
            disabled={ui.phase === 'faulted'}
            data-testid="sim-start"
          >
            <Play /> {ui.time > 0 ? 'Resume' : 'Start'}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => c.step(1)}
          disabled={ui.phase === 'faulted'}
          data-testid="sim-step"
          title="Advance one fixed step"
        >
          <SkipForward /> Step
        </Button>
        <Button size="sm" variant="outline" onClick={() => c.reset()} data-testid="sim-reset">
          <RotateCcw /> Reset
        </Button>
        <label className="ml-auto flex items-center gap-1 text-xs">
          Speed
          <select
            aria-label="Simulation speed"
            data-testid="sim-speed"
            className="rounded border border-border bg-background px-1 py-0.5"
            value={String(ui.speed)}
            onChange={(e) => c.setSpeed(Number(e.target.value))}
          >
            {[0.1, 0.25, 0.5, 1, 2].map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span>
          Simulated time <strong data-testid="sim-time">{ui.time.toFixed(3)}</strong> s · {ui.steps} steps
        </span>
        {ui.stopped ? (
          <Button size="sm" variant="outline" onClick={() => c.releaseStop()} data-testid="sim-release">
            Release stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="border-destructive text-destructive"
            onClick={() => c.emergencyStop()}
            data-testid="sim-estop"
          >
            <OctagonX /> E-stop
          </Button>
        )}
      </div>
      {ui.stats && (
        <p className="text-xs text-muted-foreground" data-testid="sim-stats">
          Physics step (measured): {ui.stats.lastStepMs.toFixed(2)} ms last · {ui.stats.meanStepMs.toFixed(2)}{' '}
          ms mean
          {ui.stats.lagFrames > 0 && ` · slower than real time on ${ui.stats.lagFrames} frame(s)`}
        </p>
      )}
      {ui.fault && (
        <p role="alert" className="text-xs text-destructive" data-testid="sim-fault">
          {ui.fault}
        </p>
      )}
      {(ui.needsReset || ui.cadChanged) && (
        <p
          className="flex items-center justify-between gap-2 rounded border border-border p-2 text-xs"
          data-testid="sim-needs-reset"
        >
          {ui.cadChanged ? 'The CAD model changed.' : 'The setup changed structurally.'} Reset to rebuild the
          simulation.
          <Button size="sm" variant="outline" onClick={() => c.rebuild()} data-testid="sim-rebuild">
            Rebuild
          </Button>
        </p>
      )}
    </div>
  );
}

function Issues({ ui }: { ui: SimUi }) {
  const list = ui.issues.filter((i) => i.severity !== 'info');
  if (!list.length) return null;
  return (
    <ul className="space-y-1 text-xs" data-testid="sim-issues">
      {list.map((i, k) => (
        <li key={k} className={i.severity === 'error' ? 'text-destructive' : 'text-amber-400'}>
          {i.severity === 'error' ? 'Error' : 'Warning'}: {i.message}
        </li>
      ))}
    </ul>
  );
}

function World({ def }: { def: SimulationDefinition }) {
  const c = simulationFor(useEditorStore());
  const q = qualityOf(def);
  return (
    <details open className="rounded border border-border p-2" data-testid="sim-world">
      <summary className="cursor-pointer text-xs font-semibold">World (configured, undoable)</summary>
      <div className="mt-2 space-y-2 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="sim-gravity-enabled"
            checked={def.gravityEnabled}
            onChange={(e) =>
              c.configure(
                { gravityEnabled: e.target.checked },
                e.target.checked ? 'Gravity on' : 'Gravity off',
              )
            }
          />
          Gravity
        </label>
        <NumberField
          wideLabel
          label="Gravity Y"
          unit="m/s²"
          value={def.gravity[1]}
          decimals={4}
          testId="sim-gravity-y"
          onCommit={(v) => c.configure({ gravity: [def.gravity[0], v, def.gravity[2]] }, `Gravity ${v} m/s²`)}
        />
        <label className="flex items-center justify-between gap-2">
          Solver quality
          <select
            aria-label="Solver quality"
            data-testid="sim-quality"
            className="rounded border border-border bg-background px-1 py-0.5"
            value={q}
            onChange={(e) => {
              const v = e.target.value as keyof typeof QUALITY;
              if (QUALITY[v]) c.configure({ solver: QUALITY[v] }, `Solver quality: ${v}`);
            }}
          >
            <option value="draft">Draft (2 × 8)</option>
            <option value="standard">Standard (4 × 8)</option>
            <option value="precise">Precise (8 × 12)</option>
            {q === 'custom' && <option value="custom">Custom</option>}
          </select>
        </label>
        <p className="text-muted-foreground">
          Fixed step {(def.solver.timestepS * 1000).toFixed(3)} ms × {def.solver.substeps} sub-steps,{' '}
          {def.solver.solverIterations} iterations (independent of the display frame rate).
        </p>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="sim-ground"
            checked={def.ground.enabled}
            onChange={(e) => c.configure({ ground: { enabled: e.target.checked } }, 'Work surface')}
          />
          Static work surface at y = {def.ground.heightM} m
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="sim-self-collision"
            checked={def.selfCollision}
            onChange={(e) => c.configure({ selfCollision: e.target.checked }, 'Self-collision')}
          />
          Self-collision between non-adjacent links
        </label>
      </div>
    </details>
  );
}

function Visual({ ui }: { ui: SimUi }) {
  const c = simulationFor(useEditorStore());
  return (
    <div className="flex gap-3 text-xs">
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          data-testid="sim-show-colliders"
          checked={ui.showColliders}
          onChange={(e) => c.setVisual({ showColliders: e.target.checked })}
        />
        Collision shapes
      </label>
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          data-testid="sim-show-contacts"
          checked={ui.showContacts}
          onChange={(e) => c.setVisual({ showContacts: e.target.checked })}
        />
        Contacts
      </label>
    </div>
  );
}

function Joints({ ui }: { ui: SimUi }) {
  if (!ui.joints.length) return null;
  return (
    <details open className="rounded border border-border p-2" data-testid="sim-joints">
      <summary className="cursor-pointer text-xs font-semibold">Joints ({ui.joints.length})</summary>
      <div className="mt-2 space-y-3">
        {ui.joints.map((j) => (
          <JointRow key={j.mateId} j={j} />
        ))}
      </div>
    </details>
  );
}

function JointRow({ j }: { j: JointState }) {
  const c = simulationFor(useEditorStore());
  const [err, setErr] = useState<string | null>(null);
  const lin = j.unit === 'm';
  const show = (v: number) => (lin ? (v * 1000).toFixed(2) : deg(v));
  const unit = lin ? 'mm' : '°';
  const rate = lin ? 'mm/s' : '°/s';
  const eff = lin ? 'N' : 'N·m';
  const toInternal = (v: number) => (lin ? v / 1000 : degToRad(v));
  const a = j.actuator;
  const lim = j.limits[0];
  const send = (cmd: Parameters<typeof c.motor>[0]) => {
    const r = c.motor(cmd);
    setErr(r.ok ? null : (r.error ?? 'Rejected'));
  };
  return (
    <div className="space-y-1 text-xs" data-testid={`sim-joint-${j.mateId}`}>
      <div className="flex items-baseline justify-between">
        <span className="font-medium">{j.name}</span>
        <span className="text-muted-foreground">{j.mapping}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-2">
        <span>
          Position (measured): <strong data-testid={`sim-joint-q-${j.mateId}`}>{show(j.q)}</strong> {unit}
        </span>
        <span>
          Velocity (measured): {lin ? (j.qd * 1000).toFixed(1) : deg(j.qd, 1)} {rate}
        </span>
        <span>Limits: {lim ? `${show(lim.min)} … ${show(lim.max)} ${unit}` : 'none'}</span>
        <span title="Constraint drift measured from the simulated bodies">
          Drift: {(j.driftPos * 1000).toFixed(3)} mm / {deg(j.driftAng, 3)}°
        </span>
      </div>
      {j.atLimit && (
        <p className="text-amber-400" data-testid={`sim-joint-limit-${j.mateId}`}>
          At its {j.atLimit === 'max' ? 'upper' : 'lower'} limit
        </p>
      )}
      {a ? (
        <div className="space-y-1 rounded bg-secondary/40 p-1.5">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={a.enabled}
                aria-label={`${j.name} actuator enabled`}
                data-testid={`sim-joint-enabled-${j.mateId}`}
                onChange={(e) => send({ mateId: j.mateId, enabled: e.target.checked })}
              />
              Actuator
            </label>
            <select
              aria-label={`${j.name} control mode`}
              data-testid={`sim-joint-mode-${j.mateId}`}
              className="rounded border border-border bg-background px-1"
              value={a.mode}
              onChange={(e) =>
                send({ mateId: j.mateId, mode: e.target.value as 'position' | 'velocity' | 'effort' })
              }
            >
              <option value="position">Position</option>
              <option value="velocity">Velocity</option>
              <option value="effort">Effort</option>
            </select>
            <span className="ml-auto text-muted-foreground" title={a.source}>
              {a.source}
            </span>
          </div>
          {a.mode === 'position' && (
            <NumberField
              wideLabel
              label="Target (input)"
              unit={unit}
              value={lin ? a.target * 1000 : radToDeg(a.target)}
              decimals={2}
              testId={`sim-joint-target-${j.mateId}`}
              onCommit={(v) => send({ mateId: j.mateId, target: toInternal(v) })}
            />
          )}
          {a.mode === 'velocity' && (
            <NumberField
              wideLabel
              label="Target velocity (input)"
              unit={rate}
              value={lin ? a.targetVelocity * 1000 : radToDeg(a.targetVelocity)}
              decimals={1}
              testId={`sim-joint-velocity-${j.mateId}`}
              onCommit={(v) => send({ mateId: j.mateId, targetVelocity: toInternal(v) })}
            />
          )}
          {a.mode === 'effort' && (
            <NumberField
              wideLabel
              label="Target effort (input)"
              unit={eff}
              value={a.targetEffort}
              decimals={3}
              testId={`sim-joint-effort-${j.mateId}`}
              onCommit={(v) => send({ mateId: j.mateId, targetEffort: v })}
            />
          )}
          <div className="grid grid-cols-2 gap-x-2">
            <span>
              Setpoint (controller): {show(a.setpoint)} {unit}
            </span>
            <span>
              Commanded effort: {a.command.toFixed(3)} {eff}
            </span>
            <span>
              Applied effort (model):{' '}
              <strong data-testid={`sim-joint-effort-applied-${j.mateId}`}>{a.applied.toFixed(3)}</strong>{' '}
              {eff}
            </span>
            <span>
              Effort limit: {a.effortLimit.toFixed(3)} {eff}
            </span>
            <span>
              Speed limit: {lin ? (a.speedLimit * 1000).toFixed(0) : deg(a.speedLimit, 0)} {rate}
            </span>
            <span title="Effective inertia estimated at the initial pose (used for automatic gains)">
              Gains kp {a.gains.kp.toPrecision(3)} · kd {a.gains.kd.toPrecision(3)}
            </span>
          </div>
          {a.saturated && (
            <p className="font-medium text-amber-400" data-testid={`sim-joint-sat-${j.mateId}`}>
              Effort saturated — the actuator cannot deliver the commanded effort.
            </p>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground">Passive joint (no actuator).</p>
      )}
      {err && (
        <p role="alert" className="text-destructive">
          {err}
        </p>
      )}
    </div>
  );
}

function Payloads({ def }: { def: SimulationDefinition }) {
  const c = simulationFor(useEditorStore());
  const nodes = useEditor((s) => s.project.scene.nodes);
  if (!def.payloads.length) return null;
  return (
    <details open className="rounded border border-border p-2" data-testid="sim-payloads">
      <summary className="cursor-pointer text-xs font-semibold">Payload (configured, undoable)</summary>
      <div className="mt-2 space-y-2 text-xs">
        {def.payloads.map((p) => (
          <div key={p.id}>
            <NumberField
              wideLabel
              label={`${p.name} on ${nodes[p.nodeId]?.name ?? p.nodeId}`}
              unit="kg"
              value={p.massKg}
              decimals={3}
              min={0}
              testId={`sim-payload-mass-${p.id}`}
              onCommit={(v) => c.setPayloadMass(p.id, v)}
            />
            <p className="text-muted-foreground">
              Point mass at the body's local ({fmt3(p.offsetM, 1000, 1)}) mm; applied live without a reset.
            </p>
          </div>
        ))}
      </div>
    </details>
  );
}

function BodyInspector({ ui }: { ui: SimUi }) {
  const c = simulationFor(useEditorStore());
  const selected = useEditor((s) => s.selection[0]);
  const [force, setForce] = useState<[number, number, number]>([0, 0, 0]);
  const [duration, setDuration] = useState(0.1);
  const [msg, setMsg] = useState<string | null>(null);
  const b = ui.body;
  const model = b ? c.session?.model.bodies.find((x) => x.id === b.id) : undefined;
  if (!selected)
    return <p className="text-xs text-muted-foreground">Select a body to inspect its physical properties.</p>;
  if (!b || !model)
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground" data-testid="sim-body-none">
          The selection is not a simulated body
          {ui.issues.some((i) => i.severity === 'error') ? ' (or the setup has errors)' : ''}.
        </p>
        <BodySettingsForm nodeId={selected} />
      </div>
    );
  return (
    <>
      <BodySettingsForm nodeId={selected} />
      <details open className="rounded border border-border p-2" data-testid="sim-body">
        <summary className="cursor-pointer text-xs font-semibold">Body: {b.name}</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
          <dt>Type</dt>
          <dd>
            {b.mode}
            {b.sleeping ? ' (sleeping)' : ''}
          </dd>
          <dt>Mass (configured)</dt>
          <dd data-testid="sim-body-mass">
            {b.massKg !== null ? `${b.massKg.toFixed(4)} kg — approximate` : 'n/a (not dynamic)'}
          </dd>
          <dt>Centre of mass</dt>
          <dd>{b.com ? `${fmt3(b.com, 1000, 1)} mm` : '—'}</dd>
          <dt>Principal inertia</dt>
          <dd>{b.inertia ? `${b.inertia.map((x) => x.toExponential(2)).join(', ')} kg·m²` : '—'}</dd>
          <dt>Velocity (measured)</dt>
          <dd>{fmt3(b.linvel)} m/s</dd>
          <dt>Angular velocity</dt>
          <dd>{fmt3(b.angvel)} rad/s</dd>
          <dt>Applied force</dt>
          <dd>{fmt3(b.force)} N</dd>
          <dt>Applied torque</dt>
          <dd>{fmt3(b.torque, 1, 4)} N·m</dd>
          <dt>Collision shape</dt>
          <dd>
            {bodyCollidersSummary(model)}
            {model.colliders.some((x) => x.approximation) ? ' (approximate)' : ''}
          </dd>
          <dt>Contacts</dt>
          <dd data-testid="sim-body-contacts">
            {b.contacts.length ? b.contacts.map((x) => `${x.points} pt`).join(', ') : 'none'}
          </dd>
        </dl>
        {model.massSources.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
            {model.massSources.map((m) => (
              <li key={m.nodeId}>
                {m.name}: {m.massKg.toFixed(4)} kg ({m.source}, {m.status}) — {m.note}
              </li>
            ))}
          </ul>
        )}
        {b.mode === 'dynamic' && (
          <div className="mt-2 space-y-1 text-xs">
            <p className="font-medium">Apply a force at the centre of mass (world frame)</p>
            <div className="grid grid-cols-3 gap-1">
              {(['X', 'Y', 'Z'] as const).map((ax, i) => (
                <label key={ax} className="flex items-center gap-1">
                  F{ax}
                  <input
                    aria-label={`Force ${ax} (N)`}
                    data-testid={`sim-force-${ax.toLowerCase()}`}
                    type="number"
                    className="w-full rounded border border-border bg-background px-1"
                    value={force[i]}
                    onChange={(e) => {
                      const next = [...force] as [number, number, number];
                      next[i] = Number(e.target.value);
                      setForce(next);
                    }}
                  />
                </label>
              ))}
            </div>
            <label className="flex items-center gap-1">
              Duration (s)
              <input
                aria-label="Force duration (s)"
                data-testid="sim-force-duration"
                type="number"
                step="0.01"
                min="0.001"
                className="w-20 rounded border border-border bg-background px-1"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
              <Button
                size="sm"
                variant="outline"
                data-testid="sim-force-apply"
                onClick={() => {
                  const r = c.applyForce(selected, force, duration);
                  setMsg(r.ok ? `Applied (${force.join(', ')}) N for ${duration} s.` : r.error);
                }}
              >
                Apply force
              </Button>
            </label>
            {msg && <p role="status">{msg}</p>}
          </div>
        )}
      </details>
    </>
  );
}

const SIM_BODY_KINDS = new Set([
  'component-instance',
  'part',
  'primitive',
  'model-instance',
  'assembly',
  'group',
]);
const DENSE_MATERIALS = MATERIALS.filter((m) => m.densityKgM3 != null);

/** Persisted physical settings of the selected body (each change is one undoable command). */
function BodySettingsForm({ nodeId }: { nodeId: string }) {
  const node = useEditor((s) => s.project.scene.nodes[nodeId]);
  const def = useEditor((s) => simulationOf(s.project.scene));
  const run = useEditor((s) => s.run);
  if (!node || !def || !SIM_BODY_KINDS.has(node.kind)) return null;
  const b = bodySettingsFor(def, nodeId);
  const set = (settings: Partial<BodySettings>, label: string) =>
    run('physics.body.set', { nodeId, settings }, { label });
  const sel = 'rounded border border-border bg-background px-1 py-0.5';
  return (
    <details open className="rounded border border-border p-2" data-testid="sim-body-settings">
      <summary className="cursor-pointer text-xs font-semibold">
        Physical settings: {node.name} (configured, undoable)
      </summary>
      <div className="mt-2 space-y-1.5 text-xs">
        <label className="flex items-center justify-between gap-2">
          Body type
          <select
            aria-label="Body type"
            data-testid="sim-body-mode"
            className={sel}
            value={b.mode}
            onChange={(e) =>
              set({ mode: e.target.value as BodySettings['mode'] }, `Body type: ${e.target.value}`)
            }
          >
            <option value="auto">Auto (assembly: dynamic, grounded: fixed; loose: fixed)</option>
            <option value="dynamic">Dynamic</option>
            <option value="fixed">Fixed</option>
            <option value="kinematic">Kinematic (prescribed velocity)</option>
            <option value="excluded">Excluded</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          Mass source
          <select
            aria-label="Mass source"
            data-testid="sim-body-mass-source"
            className={sel}
            value={b.mass.source}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'model') set({ mass: { source: 'model' } }, 'Mass from the model');
              if (v === 'user')
                set({ mass: { source: 'user', massKg: 1, note: 'user-supplied' } }, 'User mass');
              if (v === 'material')
                set(
                  { mass: { source: 'material', materialId: DENSE_MATERIALS[0]!.id } },
                  'Material mass model',
                );
            }}
          >
            <option value="model">Engineering model</option>
            <option value="user">User-supplied mass</option>
            <option value="material">Volume × material density (approximate)</option>
          </select>
        </label>
        {b.mass.source === 'user' && (
          <NumberField
            wideLabel
            label="Mass (user-supplied)"
            unit="kg"
            value={b.mass.massKg}
            decimals={4}
            min={0}
            testId="sim-body-mass-kg"
            onCommit={(v) =>
              v > 0 && set({ mass: { source: 'user', massKg: v, note: 'user-supplied' } }, `Mass ${v} kg`)
            }
          />
        )}
        {b.mass.source === 'material' && (
          <label className="flex items-center justify-between gap-2">
            Material
            <select
              aria-label="Material"
              data-testid="sim-body-material"
              className={sel}
              value={b.mass.materialId}
              onChange={(e) =>
                set({ mass: { source: 'material', materialId: e.target.value } }, 'Material mass model')
              }
            >
              {DENSE_MATERIALS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.densityKgM3} kg/m³)
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center justify-between gap-2">
          Collision shape
          <select
            aria-label="Collision shape"
            data-testid="sim-body-collider"
            className={sel}
            value={b.collider}
            onChange={(e) =>
              set({ collider: e.target.value as BodySettings['collider'] }, `Collider: ${e.target.value}`)
            }
          >
            <option value="auto">Per modelled solid</option>
            <option value="bounds-box">Bounding box (approximate)</option>
            <option value="none">None</option>
          </select>
        </label>
        <NumberField
          wideLabel
          label="Friction coefficient"
          value={b.friction}
          decimals={3}
          min={0}
          testId="sim-body-friction"
          onCommit={(v) => set({ friction: v }, `Friction ${v}`)}
        />
        <NumberField
          wideLabel
          label="Restitution"
          value={b.restitution}
          decimals={3}
          min={0}
          testId="sim-body-restitution"
          onCommit={(v) => set({ restitution: v }, `Restitution ${v}`)}
        />
        <NumberField
          wideLabel
          label="Contact load rating (0 = off)"
          unit="N"
          value={b.contactLoadRatingN ?? 0}
          decimals={1}
          min={0}
          testId="sim-body-rating"
          onCommit={(v) => set({ contactLoadRatingN: v > 0 ? v : null }, 'Load rating')}
        />
        <p className="text-muted-foreground">
          Type, mass and shape changes apply after Rebuild; no property is inferred from appearance.
        </p>
      </div>
    </details>
  );
}

function Telemetry({ ui }: { ui: SimUi }) {
  const c = simulationFor(useEditorStore());
  const channels = ui.telemetry.channels;
  const [key, setKey] = useState<string | null>(null);
  const chosen = key && channels.some((x) => x.key === key) ? key : (channels[0]?.key ?? null);
  const ch = channels.find((x) => x.key === chosen);
  const angle = ch?.unit === 'rad' || ch?.unit === 'rad/s';
  const series = useMemo(() => {
    void ui.time; // refresh with the simulation clock
    const s = chosen ? c.session?.telemetry.series(chosen) : undefined;
    if (!s) return [];
    return [{ t: s.t, v: angle ? Array.from(s.v, (x) => (x * 180) / Math.PI) : s.v }];
  }, [c, chosen, angle, ui.time]);
  const download = (r: { fileName: string; text: string } | null) => r && downloadText(r.fileName, r.text);
  return (
    <details open className="rounded border border-border p-2" data-testid="sim-telemetry">
      <summary className="cursor-pointer text-xs font-semibold">Telemetry</summary>
      <div className="mt-2 space-y-2 text-xs">
        <select
          aria-label="Telemetry channel"
          data-testid="sim-channel"
          className="w-full rounded border border-border bg-background px-1 py-0.5"
          value={chosen ?? ''}
          onChange={(e) => setKey(e.target.value)}
        >
          {channels.map((x) => (
            <option key={x.key} value={x.key}>
              {x.label} [{x.unit === 'rad' ? '°' : x.unit === 'rad/s' ? '°/s' : x.unit}] ({x.kind})
            </option>
          ))}
        </select>
        <TelemetryPlot
          series={series}
          label={ch ? `${ch.label} over time` : 'Telemetry'}
          unit={angle ? (ch?.unit === 'rad' ? '°' : '°/s') : (ch?.unit ?? '')}
          testId="sim-plot"
        />
        <p className="text-muted-foreground" data-testid="sim-telemetry-summary">
          {ui.telemetry.samples} samples
          {ui.telemetry.dropped ? ` (${ui.telemetry.dropped} oldest overwritten)` : ''} ·{' '}
          {(ui.telemetry.bytes / 1024).toFixed(0)} KiB bounded buffer · run {ui.runId}
        </p>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => download(c.exportCsv())}
            data-testid="sim-export-csv"
          >
            <Download /> CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => download(c.exportJson())}
            data-testid="sim-export-json"
          >
            <Download /> JSON
          </Button>
        </div>
      </div>
    </details>
  );
}

function Events({ ui }: { ui: SimUi }) {
  return (
    <details open className="rounded border border-border p-2" data-testid="sim-events">
      <summary className="cursor-pointer text-xs font-semibold">
        Warnings and events ({ui.eventCount})
      </summary>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Threshold-based engineering warnings — not material failure, fracture or fatigue predictions.
      </p>
      <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto text-[11px]">
        {[...ui.events].reverse().map((e, i) => (
          <li
            key={i}
            className={
              e.severity === 'fault'
                ? 'text-destructive'
                : e.severity === 'warning'
                  ? 'text-amber-400'
                  : 'text-muted-foreground'
            }
            data-kind={e.kind}
          >
            t={e.t.toFixed(3)} s — {e.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Assumptions({ ui }: { ui: SimUi }) {
  return (
    <details className="rounded border border-border p-2" data-testid="sim-assumptions">
      <summary className="cursor-pointer text-xs font-semibold">
        Model assumptions ({ui.assumptions.length})
      </summary>
      <ul className="mt-1 space-y-1 text-[11px]">
        {ui.assumptions.map((a) => (
          <li key={a.topic}>
            <strong>{a.topic}</strong> ({a.status}): {a.text}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Physics engine: Rapier {ui.engineVersion ?? '—'}.
      </p>
    </details>
  );
}
