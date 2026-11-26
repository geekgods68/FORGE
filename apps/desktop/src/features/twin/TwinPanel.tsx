import { ACTUATION_POLICY, DESIGNATIONS, toModel, type Designation } from '@forge/digital-twin';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useEditor, useEditorStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { LineChart } from '@/features/research/charts';
import { twinFor, type AdapterChoice } from './controller';
import { WebSerialAdapter } from './transports';

const inputCls = 'rounded border border-border bg-background px-1 py-0.5 text-xs';
const LINK_STYLE: Record<string, string> = {
  idle: 'bg-secondary text-muted-foreground',
  waiting: 'bg-secondary text-muted-foreground',
  live: 'bg-sky-500/20 text-sky-200',
  delayed: 'bg-amber-500/20 text-amber-200',
  stale: 'bg-amber-500/30 text-amber-100',
  disconnected: 'bg-red-500/20 text-red-200',
  replay: 'bg-indigo-500/20 text-indigo-200',
};

/** Digital twin side panel: twin, device connection (read-only), recordings, evidence. */
export function TwinPanel() {
  const editor = useEditorStore();
  const c = twinFor(editor);
  const ui = useStore(c.ui);
  const [designation, setDesignation] = useState<{
    level: Designation;
    evidence: string[];
    missing: string[];
  } | null>(null);
  const twin = c.twin;
  useEffect(() => {
    let live = true;
    void c.designation().then((d) => live && setDesignation(d));
    return () => {
      live = false;
    };
  }, [c, ui.recordings, ui.doc, ui.version]);
  const synthetic = ui.adapter === 'synthetic';
  const source =
    !ui.connected && ui.mode !== 'replay'
      ? 'VIRTUAL MODEL ONLY'
      : ui.mode === 'replay'
        ? 'REPLAY'
        : synthetic
          ? 'SYNTHETIC TELEMETRY'
          : 'PHYSICAL DEVICE (unverified)';
  return (
    <section aria-label="Digital twin" data-testid="twin-panel" className="space-y-3 p-3 text-sm">
      <header className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Digital twin</h2>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${synthetic && ui.connected ? 'bg-violet-500/25 text-violet-100' : 'bg-secondary'}`}
          data-testid="twin-source"
        >
          {source}
        </span>
      </header>
      {!twin ? (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">
            No twin for this project. The reference twin maps the HC-SR04 distance (measured) and the wrist
            servo command (commanded) of the VEYRIS arm.
          </p>
          <Button size="sm" onClick={() => c.createDefaultTwin()} data-testid="twin-create">
            Create the VEYRIS arm twin
          </Button>
        </div>
      ) : (
        <>
          <p className="text-[11px]">
            <strong>{twin.name}</strong> · device {twin.device.deviceId} ({twin.device.hardware}) · firmware{' '}
            {twin.device.firmware} {twin.device.firmwareVersion} · rev {twin.revision}
          </p>
          {ui.mappingIssues.length > 0 && (
            <ul className="text-[11px]" data-testid="twin-mapping-issues">
              {ui.mappingIssues.map((m, i) => (
                <li key={i} className={m.severity === 'error' ? 'text-destructive' : 'text-amber-300'}>
                  {m.channel}: {m.message}
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-1 rounded border border-border p-2">
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              <select
                className={inputCls}
                value={ui.adapter}
                disabled={ui.connected}
                onChange={(e) => c.ui.setState({ adapter: e.target.value as AdapterChoice })}
                data-testid="twin-adapter"
              >
                <option value="synthetic">Synthetic telemetry (generated)</option>
                <option value="web-serial">USB serial (Web Serial)</option>
                <option value="bridge">Local serial bridge</option>
              </select>
              {ui.adapter === 'synthetic' && (
                <select
                  className={inputCls}
                  value={ui.synthetic}
                  disabled={ui.connected}
                  onChange={(e) => c.ui.setState({ synthetic: e.target.value as 'nominal' })}
                  data-testid="twin-synthetic"
                >
                  <option value="nominal">nominal</option>
                  <option value="faults">with packet faults</option>
                  <option value="disconnects">with disconnect + stall</option>
                </select>
              )}
              {ui.adapter === 'bridge' && (
                <>
                  <input
                    className={`${inputCls} w-16`}
                    value={ui.bridge.port}
                    onChange={(e) =>
                      c.ui.setState({ bridge: { ...ui.bridge, port: Number(e.target.value) } })
                    }
                    aria-label="Bridge port"
                  />
                  <input
                    className={`${inputCls} w-40 font-mono`}
                    value={ui.bridge.token}
                    placeholder="token printed by the bridge"
                    onChange={(e) =>
                      c.ui.setState({ bridge: { ...ui.bridge, token: e.target.value.trim() } })
                    }
                    data-testid="twin-bridge-token"
                  />
                </>
              )}
            </div>
            {ui.adapter === 'web-serial' && !WebSerialAdapter.supported() && (
              <p className="text-[11px] text-amber-300" data-testid="twin-webserial-note">
                Web Serial is not available in this browser (Chrome/Edge desktop only). Use the local bridge:
                node tools/serial-bridge/bridge.mjs --device …
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1">
              {!ui.connected ? (
                <Button
                  size="sm"
                  onClick={() => void c.connect()}
                  data-testid="twin-connect"
                  disabled={ui.adapter === 'web-serial' && !WebSerialAdapter.supported()}
                >
                  Connect (observe)
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void c.disconnect()}
                  data-testid="twin-disconnect"
                >
                  Disconnect
                </Button>
              )}
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${LINK_STYLE[ui.link] ?? ''}`}
                data-testid="twin-link"
              >
                {ui.link}
              </span>
              <span className="text-[10px] text-muted-foreground" data-testid="twin-mode">
                mode: {ui.mode}
              </span>
            </div>
            <div className="flex gap-1">
              {!ui.recording ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!ui.connected}
                  onClick={() => c.startRecording()}
                  data-testid="twin-record"
                >
                  Record
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void c.stopRecording()}
                  data-testid="twin-stop-record"
                >
                  Stop recording
                </Button>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <h3 className="text-[11px] font-semibold">Recordings</h3>
            {!ui.recordings.length && <p className="text-[11px] text-muted-foreground">None yet.</p>}
            <ul className="space-y-1 text-[11px]" data-testid="twin-recordings">
              {ui.recordings.map((r, i) => (
                <li key={r.id} className="rounded border border-border p-1" data-testid={`twin-rec-${i}`}>
                  <span className={r.synthetic ? 'text-violet-200' : ''}>
                    {r.synthetic ? 'SYNTHETIC' : 'physical'}
                  </span>{' '}
                  · {r.adapter} · {r.lines} lines · {(r.durationMs / 1000).toFixed(1)} s
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void c.replay(r.id)}
                      data-testid={`twin-replay-${i}`}
                    >
                      Replay
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void c.compare(r.id, 'd')}
                      data-testid={`twin-compare-${i}`}
                    >
                      Compare with simulation
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void c.toResearch(r.id)}
                      data-testid={`twin-research-${i}`}
                    >
                      To Research
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          {designation && (
            <div className="rounded border border-border p-2 text-[11px]" data-testid="twin-designation">
              <p>
                Evidence level: <strong data-testid="twin-designation-level">{designation.level}</strong> (
                {DESIGNATIONS.indexOf(designation.level) + 1}/{DESIGNATIONS.length})
              </p>
              <ul className="list-disc pl-4 text-muted-foreground">
                {designation.evidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
              {designation.missing[0] && (
                <p className="text-amber-300">Next level needs: {designation.missing[0]}</p>
              )}
            </div>
          )}
        </>
      )}
      <p
        className="rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px]"
        data-testid="twin-actuation"
      >
        Physical actuation: <strong>not available</strong> — {ACTUATION_POLICY.reason} A software stop is
        never a substitute for a hardware emergency stop.
      </p>
      {ui.message && (
        <p
          className={`text-xs ${ui.message.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
          data-testid="twin-message"
        >
          {ui.message.text}
        </p>
      )}
    </section>
  );
}

/** Bottom strip in Digital twin mode: channels, diagnostics, timeline, comparison. */
export function TwinWorkspace() {
  const mode = useEditor((s) => s.workMode);
  const editor = useEditorStore();
  const c = twinFor(editor);
  const ui = useStore(c.ui);
  if (mode !== 'twin') return null;
  const p = c.pipeline;
  const twin = c.twin;
  const now = ui.tickMs;
  const d = p?.series.get('d');
  const a = p?.series.get('a');
  const cut = (s: typeof d) => {
    if (!s) return null;
    const t1 = s.t[s.t.length - 1] ?? 0;
    const i = s.t.findIndex((x) => x >= t1 - 10);
    return { t: s.t.slice(Math.max(0, i)), v: s.v.slice(Math.max(0, i)) };
  };
  const dd = cut(d);
  const aa = cut(a);
  return (
    <div
      className="absolute inset-x-0 bottom-0 z-20 max-h-[48%] overflow-auto border-t border-border bg-background/95 p-2 text-[11px]"
      data-testid="twin-workspace"
    >
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
        <div>
          <table className="w-full" data-testid="twin-channels">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th>Channel</th>
                <th>State</th>
                <th>Device</th>
                <th>Model</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {(twin?.channels ?? []).map((m) => {
                const l = p?.latest(m.channel, now);
                return (
                  <tr key={m.channel} data-testid={`twin-ch-${m.channel}`}>
                    <td>
                      {m.channel} →{' '}
                      {m.target.kind === 'joint'
                        ? m.target.mateId
                        : m.target.kind === 'sensor'
                          ? m.target.partId
                          : '—'}
                    </td>
                    <td className={m.kind === 'measured' ? 'text-sky-200' : 'text-amber-200'}>{m.kind}</td>
                    <td className="font-mono">{l ? `${l.value} ${m.deviceUnit}` : 'missing'}</td>
                    <td className="font-mono">
                      {l ? `${toModel(m, l.value).toFixed(4)} ${m.modelUnit}` : '—'}
                    </td>
                    <td>{l ? `${(l.ageMs / 1000).toFixed(1)} s` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {p && (
            <p className="mt-1 text-muted-foreground" data-testid="twin-diagnostics">
              {p.device
                ? `${p.device.deviceId} / ${p.device.firmware} ${p.device.firmwareVersion}`
                : 'no hello yet'}{' '}
              · {p.stats.valid}/{p.stats.lines} valid lines · invalid{' '}
              {Object.values(p.stats.invalid).reduce((x, y) => x + y, 0)} · duplicates {p.stats.duplicates} ·
              reordered {p.stats.reordered} · late {p.stats.late} · missing messages{' '}
              <span data-testid="twin-missing">{p.stats.missingMessages}</span> · missing values{' '}
              {p.stats.missingValues} · device errors{' '}
              {Object.entries(p.stats.deviceErrors)
                .map(([k, v]) => `${k}×${v}`)
                .join(', ') || '0'}{' '}
              · clock drift {p.clock.driftPpm.toFixed(0)} ppm · latency p95 {p.clock.latencyP95Ms.toFixed(1)}{' '}
              ms · restarts {p.stats.epochs}
            </p>
          )}
          {ui.previewWristRad !== null && (
            <p data-testid="twin-pose">
              Virtual wrist shown at the COMMANDED angle {((ui.previewWristRad * 180) / Math.PI).toFixed(1)}°
              (not measured).
            </p>
          )}
        </div>
        <div>
          {dd && dd.t.length > 1 && (
            <LineChart
              testId="twin-chart-d"
              series={[{ name: 'distance (measured) [mm]', t: dd.t, v: dd.v }]}
              xLabel="time (s)"
              yLabel="mm"
            />
          )}
        </div>
        <div>
          {aa && aa.t.length > 1 && (
            <LineChart
              testId="twin-chart-a"
              series={[{ name: 'servo angle (commanded) [deg]', t: aa.t, v: aa.v, hold: true }]}
              xLabel="time (s)"
              yLabel="deg"
            />
          )}
        </div>
      </div>
      {ui.comparison && (
        <div className="mt-2 rounded border border-border p-2" data-testid="twin-comparison">
          {'error' in ui.comparison ? (
            <p className="text-destructive">{ui.comparison.error}</p>
          ) : (
            <>
              <p>
                Observed distance vs simulated <span className="font-mono">{ui.comparison.signal}</span>: n ={' '}
                {ui.comparison.metrics.n}, MAE {ui.comparison.metrics.mae.toFixed(4)} m, RMSE{' '}
                <span data-testid="twin-rmse">{ui.comparison.metrics.rmse.toFixed(4)}</span> m, max{' '}
                {ui.comparison.metrics.maxAbs.toFixed(4)} m, bias {ui.comparison.metrics.bias.toFixed(4)} m ·{' '}
                {ui.comparison.missingObserved} missing observation(s) excluded · best timeline lag{' '}
                {ui.comparison.lag.bestS.toFixed(2)} s (RMSE {ui.comparison.lag.rmseAtBest.toFixed(4)} vs{' '}
                {ui.comparison.lag.rmseAtZero.toFixed(4)} at 0 s; not applied)
              </p>
              <LineChart
                testId="twin-chart-residual"
                series={[
                  {
                    name: 'simulated − observed [m]',
                    t: ui.comparison.residuals.t,
                    v: ui.comparison.residuals.residual,
                  },
                ]}
                xLabel="time (s)"
                yLabel="residual (m)"
              />
              <p className="text-muted-foreground">
                Synthetic telemetry verifies the software path only; agreement with it says nothing about the
                physical arm.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
