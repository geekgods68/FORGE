import { transformPoint } from '@forge/engineering-core';
import { Download, Pause, Play, RotateCcw, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { useEditor, useEditorStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { downloadText } from '@/lib/download';
import { simulationFor } from '@/features/simulation/controller';
import { cosimFor } from './cosim';
import { formatSi } from './format';
import { LogicAnalyzer } from './LogicAnalyzer';
import { circuitOf } from './state';
import { WavePlot } from './WavePlot';

/**
 * Electronics runtime (Simulation mode). Every value is what the co-simulation computed:
 * serial text is what the firmware printed, traces are recorded transitions/samples (no
 * smoothing), device statuses come from the device models.
 */
export function RuntimePanel() {
  const editor = useEditorStore();
  const c = cosimFor(editor);
  const ui = useStore(c.ui);
  const def = useEditor((s) => circuitOf(s.project.scene));
  if (!def) return null;
  return (
    <section className="space-y-2 rounded border border-border p-2" data-testid="cosim-panel">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Electronics (co-simulation)
        </h3>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-xs" data-testid="cosim-state">
          {ui.state}
        </span>
      </header>
      <p className="text-[11px] text-muted-foreground">
        One clock: firmware, digital signals and{' '}
        {ui.physics ? 'the physics steps' : 'circuit (no physics setup)'} at t ={' '}
        <span className="font-mono" data-testid="cosim-time">
          {ui.time.toFixed(3)}
        </span>{' '}
        s. Level 2 microcontroller runtime (Arduino API modelled, ATmega328P not emulated).
      </p>
      {!ui.physics && ui.active && (
        <div className="flex gap-1">
          {ui.state === 'running' ? (
            <Button size="sm" variant="secondary" onClick={() => c.pause()} data-testid="cosim-pause">
              <Pause /> Pause
            </Button>
          ) : (
            <Button size="sm" onClick={() => c.start()} data-testid="cosim-start">
              <Play /> {ui.time > 0 ? 'Resume' : 'Start'}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => c.reset()} data-testid="cosim-reset">
            <RotateCcw /> Reset
          </Button>
        </div>
      )}
      {ui.fault && (
        <p role="alert" className="text-xs text-destructive">
          {ui.fault}
        </p>
      )}
      {ui.mcus.map((m) => (
        <Mcu key={m.label} m={m} />
      ))}
      {ui.devices.length > 0 && (
        <ul className="space-y-0.5 text-[11px]" data-testid="cosim-devices">
          {ui.devices.map((d) => (
            <li key={d.id} data-testid={`cosim-device-${d.label}`} className="flex gap-2">
              <span className="w-10 font-mono font-medium">{d.label}</span>
              <span className="flex-1">{d.status}</span>
            </li>
          ))}
        </ul>
      )}
      <Inputs />
      <Instruments />
      {ui.events.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-medium">Events ({ui.events.length})</summary>
          <ul className="max-h-40 space-y-0.5 overflow-auto text-[11px]" data-testid="cosim-events">
            {ui.events
              .slice()
              .reverse()
              .map((e, i) => (
                <li
                  key={i}
                  className={
                    e.kind === 'error' || e.kind === 'contention'
                      ? 'text-destructive'
                      : e.kind === 'warning' || e.kind === 'invalid-input'
                        ? 'text-amber-300'
                        : ''
                  }
                >
                  <span className="font-mono text-muted-foreground">{(e.t / 1e9).toFixed(4)} s</span> [
                  {e.source}] {e.message}
                </li>
              ))}
          </ul>
        </details>
      )}
      {ui.stats && (
        <p className="text-[10px] text-muted-foreground" data-testid="cosim-stats">
          last advance {ui.stats.lastAdvanceMs.toFixed(1)} ms (max {ui.stats.maxAdvanceMs.toFixed(1)}) ·{' '}
          {ui.stats.events} events · {ui.stats.analogSolves} analog solves · {ui.stats.samples} samples ·{' '}
          {ui.stats.transitions} transitions · buffers {(ui.stats.telemetryBytes / 1024 / 1024).toFixed(1)} MB
          (fixed) · lagged frames {ui.stats.lagged}
        </p>
      )}
    </section>
  );
}

function Mcu({ m }: { m: ReturnType<ReturnType<typeof cosimFor>['ui']['getState']>['mcus'][number] }) {
  const editor = useEditorStore();
  const [text, setText] = useState('');
  const [stamps, setStamps] = useState(false);
  return (
    <div className="space-y-1 rounded border border-border/60 p-1.5" data-testid={`cosim-mcu-${m.label}`}>
      <p className="text-xs">
        <span className="font-mono font-semibold">{m.label}</span> {m.firmware} —{' '}
        <span
          data-testid={`cosim-mcu-state-${m.label}`}
          className={
            m.state === 'error'
              ? 'text-destructive'
              : m.state === 'running'
                ? 'text-emerald-300'
                : 'text-amber-300'
          }
        >
          {m.state}
        </span>
      </p>
      {m.errors.map((e, i) => (
        <p key={i} className="text-[11px] text-destructive" data-testid="cosim-mcu-error">
          {e.line ? `line ${e.line}: ` : ''}
          {e.message}
        </p>
      ))}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Serial monitor</span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={stamps} onChange={(e) => setStamps(e.target.checked)} /> timestamps
        </label>
      </div>
      <pre
        className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/50 p-1 font-mono text-[11px] text-emerald-200"
        data-testid={`serial-out-${m.label}`}
      >
        {stamps
          ? m.serial.map((c) => `[${(c.t / 1e9).toFixed(4)} s] ${c.text}`).join('')
          : m.serial
              .map((c) => c.text)
              .join('')
              .split('\r\n')
              .slice(-60)
              .join('\n')}
      </pre>
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (cosimFor(editor).sendSerial(m.label, `${text}\n`)) setText('');
        }}
      >
        <input
          aria-label="Serial input"
          data-testid={`serial-in-${m.label}`}
          className="min-w-0 flex-1 rounded border border-border bg-background px-1 font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="send text (newline appended)"
        />
        <Button size="sm" variant="outline" type="submit" data-testid={`serial-send-${m.label}`}>
          <Send />
        </Button>
      </form>
    </div>
  );
}

/** Runtime experiment inputs: move a target body, turn a potentiometer, press a switch. */
function Inputs() {
  const editor = useEditorStore();
  const c = cosimFor(editor);
  const ui = useStore(c.ui);
  const scene = useEditor((s) => s.project.scene);
  const def = useEditor((s) => circuitOf(s.project.scene));
  const session = simulationFor(editor).session;
  const targets = useMemo(() => {
    if (!session) return [];
    return session.model.bodies
      .filter(
        (b) =>
          b.mode === 'fixed' && b.unitIds.length === 1 && scene.nodes[b.unitIds[0]!]?.kind === 'primitive',
      )
      .map((b) => b.unitIds[0]!)
      .filter((id) => !/stand/i.test(scene.nodes[id]!.name));
  }, [session, scene]);
  const [target, setTarget] = useState<string | null>(null);
  const tid = target ?? targets[0] ?? null;
  const pos = (() => {
    if (!tid || !session) return null;
    const m = session.unitWorldMatrix(tid);
    return m ? transformPoint(m, [0, 0, 0]) : null;
  })();
  void ui.frame;
  const manualPots =
    def?.parts.filter((p) => p.device.type === 'potentiometer' && p.device.link.kind === 'manual') ?? [];
  const switches =
    def?.parts.filter(
      (p) =>
        p.device.type === 'switch' || (p.device.type === 'limit-switch' && p.device.link.kind === 'manual'),
    ) ?? [];
  if (!targets.length && !manualPots.length && !switches.length) return null;
  return (
    <div className="space-y-1" data-testid="cosim-inputs">
      <h4 className="text-xs font-medium">Experiment inputs (runtime only)</h4>
      {tid && pos && (
        <div className="space-y-0.5 text-xs">
          <select
            className="w-full rounded border border-border bg-background px-1"
            value={tid}
            onChange={(e) => setTarget(e.target.value)}
            aria-label="Target"
          >
            {targets.map((t) => (
              <option key={t} value={t}>
                {scene.nodes[t]!.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1">
            z
            <input
              type="range"
              min={0.03}
              max={1.2}
              step={0.005}
              value={pos[2]}
              data-testid="cosim-target-z-slider"
              className="flex-1"
              onChange={(e) => c.moveNode(tid, [pos[0], pos[1], Number(e.target.value)])}
            />
            <input
              aria-label="Target z (m)"
              data-testid="cosim-target-z"
              className="w-16 rounded border border-border bg-background px-1 text-right font-mono"
              defaultValue={pos[2].toFixed(3)}
              key={pos[2].toFixed(3)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const v = Number((e.target as HTMLInputElement).value);
                if (Number.isFinite(v)) c.moveNode(tid, [pos[0], pos[1], v]);
              }}
            />
            m
          </label>
        </div>
      )}
      {manualPots.map((p) => (
        <label key={p.id} className="flex items-center gap-1 text-xs">
          {p.label}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            defaultValue={p.device.type === 'potentiometer' ? p.device.position : 0.5}
            data-testid={`cosim-pot-${p.label}`}
            className="flex-1"
            onChange={(e) => c.setPot(p.id, Number(e.target.value))}
          />
        </label>
      ))}
      {switches.map((p) => (
        <label key={p.id} className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            data-testid={`cosim-switch-${p.label}`}
            onChange={(e) => c.setPressed(p.id, e.target.checked)}
          />
          {p.label} pressed
        </label>
      ))}
    </div>
  );
}

const WINDOWS: [string, number][] = [
  ['100 µs', 1e5],
  ['1 ms', 1e6],
  ['5 ms', 5e6],
  ['25 ms', 2.5e7],
  ['100 ms', 1e8],
  ['1 s', 1e9],
];

function Instruments() {
  const editor = useEditorStore();
  const c = cosimFor(editor);
  const ui = useStore(c.ui);
  const [tab, setTab] = useState<'scope' | 'logic' | 'meters' | 'telemetry'>('scope');
  const [nets, setNets] = useState<string[] | null>(null);
  const [win, setWin] = useState(2.5e7);
  const [trigger, setTrigger] = useState(true);
  const [frozen, setFrozen] = useState<{ t1: number } | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const cs = c.cosim;
  if (!cs) return null;
  const allNets = cs.netlist.nets.filter((n) => cs.net.kind[n.index] !== 'analog' && n.pins.length > 1);
  const chosen = nets ?? allNets.slice(0, 3).map((n) => n.name);
  const now = frozen?.t1 ?? cs.now;
  // Trigger: align the window's right part to the last rising edge on channel 1.
  let t1 = now;
  if (trigger && chosen[0]) {
    const n = cs.netlist.netByName(chosen[0]);
    if (n) {
      const tr = cs.net.log.of(n.index);
      for (let i = tr.t.length - 1; i > 0; i--)
        if (tr.level[i] === '1' && tr.level[i - 1] === '0' && tr.t[i]! + win * 0.75 <= now) {
          t1 = tr.t[i]! + win * 0.75;
          break;
        }
    }
  }
  const t0 = Math.max(0, t1 - win);
  void ui.frame;
  const traces = chosen.flatMap((name) => {
    const n = cs.netlist.netByName(name);
    if (!n) return [];
    const tr = cs.net.log.of(n.index);
    // Extend the last level to the window end (it holds until the next transition).
    const t = [...tr.t, t1];
    const v = [...tr.v, tr.v[tr.v.length - 1] ?? NaN];
    return [{ name, t, v, level: [...tr.level, tr.level[tr.level.length - 1] ?? 'Z'] }];
  });
  return (
    <div className="space-y-1" data-testid="cosim-instruments">
      <nav className="flex gap-1 border-b border-border pb-0.5">
        {(['scope', 'logic', 'meters', 'telemetry'] as const).map((k) => (
          <button
            key={k}
            data-testid={`inst-tab-${k}`}
            className={`rounded px-1.5 text-xs ${tab === k ? 'bg-secondary' : 'text-muted-foreground'}`}
            onClick={() => setTab(k)}
          >
            {k === 'scope'
              ? 'Oscilloscope'
              : k === 'logic'
                ? 'Logic analyser'
                : k === 'meters'
                  ? 'Meters'
                  : 'Telemetry'}
          </button>
        ))}
      </nav>
      {(tab === 'scope' || tab === 'logic') && (
        <>
          <div className="flex flex-wrap gap-x-2 text-[11px]">
            {allNets.map((n) => (
              <label key={n.index} className="flex items-center gap-0.5">
                <input
                  type="checkbox"
                  checked={chosen.includes(n.name)}
                  onChange={(e) =>
                    setNets(
                      e.target.checked ? [...chosen, n.name].slice(-6) : chosen.filter((x) => x !== n.name),
                    )
                  }
                />
                {n.name}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1 text-[11px]">
            <select
              aria-label="Time window"
              data-testid="inst-window"
              className="rounded border border-border bg-background"
              value={win}
              onChange={(e) => setWin(Number(e.target.value))}
            >
              {WINDOWS.map(([l, v]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-0.5">
              <input type="checkbox" checked={trigger} onChange={(e) => setTrigger(e.target.checked)} />{' '}
              trigger ↑ ch1
            </label>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-1.5"
              data-testid="inst-freeze"
              onClick={() => setFrozen(frozen ? null : { t1: cs.now })}
            >
              {frozen ? 'Live' : 'Pause'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-1.5"
              data-testid="inst-export"
              onClick={() => {
                const rows = traces.flatMap((tr) =>
                  tr.t.map((t, i) =>
                    [
                      tr.name,
                      (t / 1e9).toFixed(9),
                      tr.level[i],
                      Number.isFinite(tr.v[i]!) ? tr.v[i] : '',
                    ].join(','),
                  ),
                );
                downloadText(
                  `${cs.meta.runId}.${tab}.csv`,
                  [
                    '# FORGE recorded transitions (exact event times; voltages at each transition)',
                    'net,t_s,level,voltage_V',
                    ...rows,
                  ].join('\n'),
                );
              }}
            >
              <Download /> CSV
            </Button>
          </div>
          {tab === 'scope' && (
            <p className="text-[10px] text-muted-foreground" data-testid="inst-scope">
              {traces.length} channel(s) · window {formatSi(win / 1e9, 's')} ending{' '}
              {formatSi(t1 / 1e9, 's', 6)}
              {frozen ? ' (paused)' : ''}
            </p>
          )}
          {tab === 'scope' &&
            traces.map((tr) => (
              <WavePlot
                key={tr.name}
                testId={`inst-scope-${tr.name}`}
                t={tr.t.map((x) => x / 1e9)}
                series={[{ name: tr.name, v: tr.v }]}
                unit="V"
                window={[t0 / 1e9, t1 / 1e9]}
                step
                height={60}
              />
            ))}
          {tab === 'logic' && (
            <LogicAnalyzer
              testId="inst-logic"
              lanes={traces.map((tr) => ({ name: tr.name, t: tr.t, level: tr.level }))}
              window={[t0, t1]}
            />
          )}
        </>
      )}
      {tab === 'meters' && <Meters />}
      {tab === 'telemetry' && (
        <div className="space-y-1">
          <select
            aria-label="Channel"
            data-testid="inst-channel"
            className="w-full rounded border border-border bg-background text-xs"
            value={channel ?? ui.channels[0]?.key ?? ''}
            onChange={(e) => setChannel(e.target.value)}
          >
            {ui.channels.map((ch) => (
              <option key={ch.key} value={ch.key}>
                {ch.label} [{ch.unit || '-'}] ({ch.kind})
              </option>
            ))}
          </select>
          {(() => {
            const key = channel ?? ui.channels[0]?.key;
            const s = key ? cs.recorder.series(key) : null;
            const ch = ui.channels.find((x) => x.key === key);
            return s ? (
              <WavePlot
                testId="inst-telemetry-plot"
                t={s.t}
                series={[{ name: ch?.label ?? key!, v: s.v }]}
                unit={ch?.unit ?? ''}
              />
            ) : null;
          })()}
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              data-testid="cosim-export-csv"
              onClick={() => {
                const f = c.exportCsv();
                if (f) downloadText(f.fileName, f.text);
              }}
            >
              <Download /> CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="cosim-export-json"
              onClick={() => {
                const f = c.exportJson();
                if (f) downloadText(f.fileName, f.text);
              }}
            >
              <Download /> JSON
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Meters() {
  const editor = useEditorStore();
  const c = cosimFor(editor);
  const ui = useStore(c.ui);
  const cs = c.cosim!;
  const [net, setNet] = useState<string>('');
  void ui.frame;
  const nets = cs.netlist.nets.filter((n) => n.pins.length > 1);
  const chosen = net || nets.find((n) => !n.isGround)?.name || '';
  const n = cs.netlist.netByName(chosen);
  const v = n ? cs.net.voltage(n.index) : null;
  const currents = [...(cs.net.op?.i.entries() ?? [])].filter(([, x]) => Math.abs(x) > 1e-9);
  return (
    <div className="space-y-1 text-xs" data-testid="inst-meters">
      <label className="flex items-center gap-1">
        Voltmeter
        <select
          className="flex-1 rounded border border-border bg-background"
          value={chosen}
          onChange={(e) => setNet(e.target.value)}
          aria-label="Net"
        >
          {nets.map((x) => (
            <option key={x.index}>{x.name}</option>
          ))}
        </select>
        <span className="font-mono" data-testid="inst-voltmeter">
          {v === null ? 'undefined' : formatSi(v, 'V', 4)}
        </span>
      </label>
      <p className="text-[11px] text-muted-foreground">
        Ammeter (latest mixed-signal solve; a→b through each element):
      </p>
      <table className="w-full text-[11px]" data-testid="inst-ammeter">
        <tbody>
          {currents.slice(0, 30).map(([k, x]) => (
            <tr key={k}>
              <td className="font-mono">{k}</td>
              <td className="text-right font-mono">{formatSi(x, 'A', 4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
