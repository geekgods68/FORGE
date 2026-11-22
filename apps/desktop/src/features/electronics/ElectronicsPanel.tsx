import { electricalModelFor, getDefinition, parseSiValue } from '@forge/components';
import {
  devicePins,
  newId,
  type Device,
  type ElectricalDefinition,
  type ElectricalPart,
  type SceneGraph,
} from '@forge/engineering-core';
import {
  analogCircuitOf,
  DRC_DISCLAIMER,
  exportElectricalBundle,
  exportSpiceNetlist,
  parseElectricalBundle,
  pinInfos,
  solvedChecks,
  type RuleIssue,
} from '@forge/electronics';
import { CircuitBoard, Download, Plus, Trash2, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useEditor, useEditorStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { downloadText } from '@/lib/download';
import { CodeTab } from './CodeTab';
import { formatSi } from './format';
import { addCatalogPart, addPrimitive, CATALOG_PARTS, linkNode, PRIMITIVES } from './palette';
import { analyse, circuitOf, elecUiFor, type ElecTab } from './state';
import { WavePlot } from './WavePlot';

/**
 * Electronics mode: circuit construction and inspection. Every change is an undoable
 * `electrical.*` command; runtime results (DC operating point, transient traces) are view
 * state only and are recomputed on demand.
 */
export function ElectronicsPanel() {
  const editor = useEditorStore();
  const ui = useStore(elecUiFor(editor));
  const uiStore = elecUiFor(editor);
  const def = useEditor((s) => circuitOf(s.project.scene));
  const scene = useEditor((s) => s.project.scene);
  const run = useEditor((s) => s.run);
  const a = useMemo(() => (def ? analyse(def, scene) : null), [def, scene]);
  const tabs: [ElecTab, string][] = [
    ['parts', 'Parts'],
    ['wiring', 'Wiring'],
    ['checks', `Checks${a ? ` (${a.issues.filter((i) => i.severity !== 'info').length})` : ''}`],
    ['analysis', 'Analysis'],
    ['code', 'Code'],
  ];
  return (
    <section aria-label="Electronics" data-testid="electronics-panel" className="space-y-3 p-3 text-sm">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Electronics</h2>
        {def && (
          <span className="text-xs text-muted-foreground" data-testid="elec-summary">
            {def.parts.length} parts · {def.wires.length} wires ·{' '}
            {a!.netlist.nets.filter((n) => n.pins.length > 1).length} nets
          </span>
        )}
      </header>
      {!def && (
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            This project has no circuit. Create one, or place a component below (a circuit is created with
            it).
          </p>
          <Button
            size="sm"
            onClick={() => run('electrical.circuit.create', {}, { label: 'Create circuit' })}
            data-testid="elec-create"
          >
            <CircuitBoard /> Create circuit
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          variant={ui.schematicOpen ? 'secondary' : 'outline'}
          onClick={() => uiStore.setState({ schematicOpen: !ui.schematicOpen })}
          data-testid="elec-schematic-toggle"
        >
          {ui.schematicOpen ? 'Hide schematic' : 'Open schematic'}
        </Button>
        <div
          className="ml-auto flex items-center gap-0.5 rounded-md border border-border p-0.5"
          role="group"
          aria-label="Tool"
        >
          <Button
            size="sm"
            variant={ui.tool === 'select' ? 'secondary' : 'ghost'}
            onClick={() => uiStore.setState({ tool: 'select', pending: null })}
            data-testid="elec-tool-select"
          >
            Select
          </Button>
          <Button
            size="sm"
            variant={ui.tool === 'wire' ? 'secondary' : 'ghost'}
            onClick={() => uiStore.setState({ tool: 'wire', pending: null })}
            data-testid="elec-tool-wire"
          >
            Wire
          </Button>
        </div>
      </div>
      {ui.message && (
        <p
          data-testid="elec-message"
          role={ui.message.tone === 'error' ? 'alert' : 'status'}
          className={
            ui.message.tone === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
          }
        >
          {ui.message.text}
        </p>
      )}
      <nav className="flex flex-wrap gap-1 border-b border-border pb-1" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={ui.tab === id}
            data-testid={`elec-tab-${id}`}
            className={`rounded px-2 py-0.5 text-xs ${ui.tab === id ? 'bg-secondary font-medium' : 'text-muted-foreground hover:bg-secondary/60'}`}
            onClick={() => uiStore.setState({ tab: id })}
          >
            {label}
          </button>
        ))}
      </nav>
      {ui.tab === 'parts' && <PartsTab def={def} scene={scene} />}
      {ui.tab === 'wiring' && def && <WiringTab def={def} scene={scene} />}
      {ui.tab === 'checks' && def && <ChecksTab issues={a!.issues} />}
      {ui.tab === 'analysis' && def && <AnalysisTab def={def} />}
      {ui.tab === 'code' && <CodeTab def={def} />}
    </section>
  );
}

// -- Parts ----------------------------------------------------------------------------------
function PartsTab({ def, scene }: { def: ElectricalDefinition | null; scene: SceneGraph }) {
  const editor = useEditorStore();
  const ui = useStore(elecUiFor(editor));
  const [placeId, setPlaceId] = useState<string>(CATALOG_PARTS[0][0]);
  const [primKey, setPrimKey] = useState(PRIMITIVES[0]!.key);
  const linked = new Set(def?.parts.map((p) => p.nodeId).filter(Boolean));
  const unlinked = Object.values(scene.nodes).filter(
    (n) =>
      n.kind === 'component-instance' && !linked.has(n.id) && electricalModelFor(n.definitionId) !== null,
  );
  const selected = def?.parts.find((p) => p.id === ui.selectedPart) ?? null;
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-xs font-medium">Place component (3D + circuit)</h3>
        <div className="flex gap-1">
          <select
            aria-label="Component to place"
            data-testid="elec-place-select"
            className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
            value={placeId}
            onChange={(e) => setPlaceId(e.target.value)}
          >
            {CATALOG_PARTS.map(([id]) => (
              <option key={id} value={id}>
                {getDefinition(id)?.name ?? id}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            data-testid="elec-place"
            onClick={() => {
              const id = addCatalogPart(editor, placeId);
              if (id) elecUiFor(editor).setState({ selectedPart: id });
            }}
          >
            <Plus /> Place
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        <h3 className="text-xs font-medium">Add ideal element (schematic only)</h3>
        <div className="flex gap-1">
          <select
            aria-label="Element to add"
            data-testid="elec-prim-select"
            className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
            value={primKey}
            onChange={(e) => setPrimKey(e.target.value)}
          >
            {PRIMITIVES.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            data-testid="elec-prim-add"
            onClick={() => {
              const id = addPrimitive(editor, primKey);
              if (id) elecUiFor(editor).setState({ selectedPart: id });
            }}
          >
            <Plus /> Add
          </Button>
        </div>
      </div>
      {unlinked.length > 0 && (
        <div className="space-y-1" data-testid="elec-unlinked">
          <h3 className="text-xs font-medium">Placed components not in the circuit</h3>
          {unlinked.map((n) => (
            <div key={n.id} className="flex items-center justify-between gap-1 text-xs">
              <span className="truncate">{n.name}</span>
              <Button
                size="sm"
                variant="outline"
                data-testid={`elec-link-${n.id}`}
                onClick={() => linkNode(editor, n.id)}
              >
                Add to circuit
              </Button>
            </div>
          ))}
        </div>
      )}
      {def && (
        <ul className="divide-y divide-border rounded border border-border" data-testid="elec-parts">
          {def.parts.map((p) => (
            <li key={p.id}>
              <button
                className={`flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs ${ui.selectedPart === p.id ? 'bg-secondary' : 'hover:bg-secondary/50'}`}
                data-testid={`elec-part-${p.label}`}
                onClick={() => elecUiFor(editor).setState({ selectedPart: p.id, selectedWire: null })}
              >
                <span className="w-12 font-mono font-medium">{p.label}</span>
                <span className="flex-1 truncate">{p.name}</span>
                <span className="text-muted-foreground">{p.nodeId ? '3D' : 'sch'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {def && selected && <PartInspector def={def} part={selected} scene={scene} />}
    </div>
  );
}

/** Text field accepting SI notation ("4.7k", "100n", "2.2e-6"); commits on Enter/blur. */
function SiField({
  label,
  value,
  unit,
  onCommit,
  testId,
}: {
  label: string;
  value: number;
  unit: string;
  onCommit: (v: number) => void;
  testId?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const t = draft.trim().replace(/\s+/g, '');
    const v = /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t) ? Number(t) : parseSiValue(t.replace(/u/g, 'µ'));
    setDraft(null);
    if (v !== null && Number.isFinite(v) && v !== value) onCommit(v);
  };
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        aria-label={label}
        data-testid={testId}
        className="w-28 rounded border border-border bg-background px-1 py-0.5 text-right font-mono"
        value={draft ?? formatSi(value, unit)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        onBlur={commit}
      />
    </label>
  );
}

const FIELD_UNITS: Record<string, string> = {
  resistanceOhm: 'Ω',
  capacitanceF: 'F',
  inductanceH: 'H',
  seriesResistanceOhm: 'Ω',
  onResistanceOhm: 'Ω',
  powerRatingW: 'W',
  voltageRatingV: 'V',
  currentLimitA: 'A',
  thresholdV: 'V',
  transconductanceAPerV2: 'A/V²',
  frequencyHz: 'Hz',
  delayNs: 'ns',
  logicV: 'V',
  pulseMinUs: 'µs',
  pulseMaxUs: 'µs',
  deadbandUs: 'µs',
  validMinUs: 'µs',
  validMaxUs: 'µs',
  minSupplyV: 'V',
  maxSupplyV: 'V',
  minRangeM: 'm',
  maxRangeM: 'm',
  noiseStdM: 'm',
  noEchoPulseUs: 'µs',
  burstDelayUs: 'µs',
  minTriggerUs: 'µs',
  angleRangeDeg: '°',
  jointCentreRad: 'rad',
  gain: '',
  betaF: '',
  betaR: '',
  saturationCurrentA: 'A',
  duty: '',
  position: '',
  pulsesPerRev: '',
  inputs: '',
  bits: '',
};

function mates(scene: SceneGraph) {
  return Object.values(scene.nodes).flatMap((n) =>
    n.kind === 'assembly'
      ? n.mechanical.mates.filter((m) => m.type === 'revolute' || m.type === 'prismatic')
      : [],
  );
}

function PartInspector({
  def,
  part,
  scene,
}: {
  def: ElectricalDefinition;
  part: ElectricalPart;
  scene: SceneGraph;
}) {
  const editor = useEditorStore();
  const run = useEditor((s) => s.run);
  const nl = analyse(def, scene).netlist;
  const model = part.definitionId ? electricalModelFor(part.definitionId) : null;
  const infos = pinInfos(part);
  const catalogPins = new Map(model?.pins.map((p) => [p.id, p]) ?? []);
  const setDevice = (device: Device, label: string) => {
    const r = run('electrical.part.update', { partId: part.id, patch: { device } }, { label });
    if (!r.ok) elecUiFor(editor).setState({ message: { tone: 'error', text: r.error.message } });
  };
  const d = part.device as Record<string, unknown> & Device;
  const numeric = Object.entries(d).filter(([k, v]) => typeof v === 'number' && k in FIELD_UNITS);
  const nullable = Object.entries(d).filter(([k, v]) => v === null && k in FIELD_UNITS);
  return (
    <div className="space-y-2 rounded border border-border p-2" data-testid="elec-part-inspector">
      <div className="flex items-baseline justify-between">
        <h3 className="font-mono text-xs font-semibold">
          {part.label} <span className="font-sans font-normal text-muted-foreground">{part.device.type}</span>
        </h3>
        <Button
          size="sm"
          variant="ghost"
          data-testid="elec-part-remove"
          onClick={() => {
            run('electrical.part.remove', { partId: part.id }, { label: `Remove ${part.label}` });
            elecUiFor(editor).setState({ selectedPart: null });
          }}
        >
          <Trash2 /> Remove
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {part.name}
        {part.definitionId ? ` · catalogue: ${part.definitionId}` : ' · ideal element'}
        {part.nodeId ? (scene.nodes[part.nodeId] ? ' · placed in 3D' : ' · 3D component missing') : ''}
      </p>
      {model?.notes.map((n, i) => (
        <p key={i} className="rounded bg-amber-500/10 p-1 text-[11px] text-amber-200/90">
          {n}
        </p>
      ))}
      {d.type === 'vsource' && d.waveform.kind === 'dc' && (
        <SiField
          label="Voltage"
          unit="V"
          value={d.waveform.value}
          testId="elec-field-voltage"
          onCommit={(v) => setDevice({ ...d, waveform: { kind: 'dc', value: v } }, `${part.label} = ${v} V`)}
        />
      )}
      {d.type === 'isource' && d.waveform.kind === 'dc' && (
        <SiField
          label="Current"
          unit="A"
          value={d.waveform.value}
          onCommit={(v) => setDevice({ ...d, waveform: { kind: 'dc', value: v } }, `${part.label} = ${v} A`)}
        />
      )}
      {numeric.map(([k, v]) => (
        <SiField
          key={k}
          label={k}
          unit={FIELD_UNITS[k]!}
          value={v as number}
          testId={`elec-field-${k}`}
          onCommit={(nv) => setDevice({ ...d, [k]: nv } as Device, `${part.label} ${k}`)}
        />
      ))}
      {nullable.map(([k]) => (
        <div key={k} className="flex justify-between text-xs">
          <span className="text-muted-foreground">{k}</span>
          <span className="italic text-muted-foreground">unknown</span>
        </div>
      ))}
      {Object.entries(d)
        .filter(([, v]) => typeof v === 'boolean')
        .map(([k, v]) => (
          <label key={k} className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{k}</span>
            <input
              type="checkbox"
              checked={v as boolean}
              onChange={(e) => setDevice({ ...d, [k]: e.target.checked } as Device, `${part.label} ${k}`)}
            />
          </label>
        ))}
      {d.type === 'mcu' && (
        <>
          <label className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Power</span>
            <select
              data-testid="elec-mcu-power"
              className="rounded border border-border bg-background px-1"
              value={d.power}
              onChange={(e) =>
                setDevice({ ...d, power: e.target.value as 'usb' | 'external' }, `${part.label} power`)
              }
            >
              <option value="usb">USB host (5 V)</option>
              <option value="external">External (5V/VIN pins)</option>
            </select>
          </label>
          <label className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Firmware</span>
            <select
              data-testid="elec-mcu-firmware"
              className="rounded border border-border bg-background px-1"
              value={d.firmwareId ?? ''}
              onChange={(e) =>
                setDevice({ ...d, firmwareId: e.target.value || null }, `${part.label} firmware`)
              }
            >
              <option value="">(none)</option>
              {def.firmware.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} (rev {f.revision})
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {(d.type === 'servo' || d.type === 'encoder') && (
        <label className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Joint</span>
          <select
            data-testid="elec-joint-link"
            className="max-w-40 rounded border border-border bg-background px-1"
            value={d.mateId ?? ''}
            onChange={(e) =>
              setDevice({ ...d, mateId: e.target.value || null } as Device, `${part.label} joint`)
            }
          >
            <option value="">(not linked)</option>
            {mates(scene).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <details open>
        <summary className="cursor-pointer text-xs font-medium">Pins ({infos.length})</summary>
        <table className="mt-1 w-full text-[11px]" data-testid="elec-pins">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th>Pin</th>
              <th>Role</th>
              <th>Net</th>
              <th>Limits</th>
            </tr>
          </thead>
          <tbody>
            {infos.map((p) => {
              const n = nl.pinNet(part.id, p.id);
              const c = catalogPins.get(p.id);
              const lim = [
                c?.voltage ? `${c.voltage.min ?? ''}–${c.voltage.max ?? ''} V` : null,
                c?.current?.max != null ? `≤ ${formatSi(c.current.max, 'A')}` : null,
              ]
                .filter(Boolean)
                .join(', ');
              return (
                <tr
                  key={p.id}
                  title={`${p.fn}${c?.voltage ? ` — ${c.voltage.source} (${c.voltage.status})` : ''}${c?.current ? ` — ${c.current.source}` : ''}${c?.connector.compatibility.length ? ` — connector: ${c.connector.compatibility.join(', ')}` : ''}`}
                >
                  <td className="font-mono">{p.id}</td>
                  <td>{p.role}</td>
                  <td className="truncate font-mono">
                    {n === undefined ? '' : nl.nets[n]!.pins.length > 1 ? nl.nets[n]!.name : '—'}
                  </td>
                  <td>{lim || <span className="italic text-muted-foreground">unknown</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </div>
  );
}

// -- Wiring ---------------------------------------------------------------------------------
function WiringTab({ def, scene }: { def: ElectricalDefinition; scene: SceneGraph }) {
  const editor = useEditorStore();
  const ui = useStore(elecUiFor(editor));
  const run = useEditor((s) => s.run);
  const nl = analyse(def, scene).netlist;
  const label = (id: string) => nl.partById.get(id)?.label ?? id;
  const [lp, setLp] = useState({ part: def.parts[0]?.id ?? '', pin: '', name: '' });
  const pinsOf = def.parts.find((p) => p.id === lp.part);
  const fileInput = useRef<HTMLInputElement>(null);
  const project = useEditor((s) => s.project);
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-xs font-medium">Wires ({def.wires.length})</h3>
        <ul
          className="max-h-48 divide-y divide-border overflow-auto rounded border border-border"
          data-testid="elec-wires"
        >
          {def.wires.map((w) => {
            const n = nl.pinNet(w.a.partId, w.a.pin);
            return (
              <li
                key={w.id}
                className={`flex items-center gap-1 px-2 py-0.5 text-xs ${ui.selectedWire === w.id ? 'bg-secondary' : ''}`}
                data-testid="elec-wire-row"
              >
                <button
                  className="flex-1 truncate text-left font-mono"
                  onClick={() =>
                    elecUiFor(editor).setState({
                      selectedWire: w.id,
                      selectedNet: n === undefined ? null : nl.nets[n]!.name,
                    })
                  }
                >
                  {label(w.a.partId)}.{w.a.pin} — {label(w.b.partId)}.{w.b.pin}
                </button>
                <span className="text-muted-foreground">{n === undefined ? '' : nl.nets[n]!.name}</span>
                <button
                  aria-label="Remove wire"
                  onClick={() => run('electrical.wire.remove', { wireId: w.id }, { label: 'Remove wire' })}
                >
                  <Trash2 className="size-3" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="space-y-1">
        <h3 className="text-xs font-medium">Nets</h3>
        <ul className="max-h-48 overflow-auto rounded border border-border text-xs" data-testid="elec-nets">
          {nl.nets
            .filter((n) => n.pins.length > 1)
            .map((n) => (
              <li key={n.index}>
                <button
                  data-testid={`elec-net-${n.name}`}
                  className={`flex w-full gap-2 px-2 py-0.5 text-left ${ui.selectedNet === n.name ? 'bg-secondary' : 'hover:bg-secondary/50'}`}
                  onClick={() => elecUiFor(editor).setState({ selectedNet: n.name })}
                >
                  <span className="w-28 truncate font-mono">{n.name}</span>
                  <span className="truncate text-muted-foreground">
                    {n.pins.map((p) => `${label(p.partId)}.${p.pin}`).join(', ')}
                  </span>
                </button>
              </li>
            ))}
        </ul>
        <p className="text-[11px] text-muted-foreground">{nl.groundNote}</p>
      </div>
      <div className="space-y-1">
        <h3 className="text-xs font-medium">Label a net</h3>
        <div className="flex gap-1">
          <select
            aria-label="Part"
            className="w-16 rounded border border-border bg-background text-xs"
            value={lp.part}
            onChange={(e) => setLp({ ...lp, part: e.target.value, pin: '' })}
          >
            {def.parts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Pin"
            className="w-20 rounded border border-border bg-background text-xs"
            value={lp.pin}
            onChange={(e) => setLp({ ...lp, pin: e.target.value })}
          >
            <option value="">pin…</option>
            {pinsOf &&
              devicePins(pinsOf.device).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
          </select>
          <input
            aria-label="Net name"
            data-testid="elec-label-name"
            className="min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs"
            placeholder="name"
            value={lp.name}
            onChange={(e) => setLp({ ...lp, name: e.target.value })}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!lp.pin || !lp.name}
            onClick={() => {
              const r = run(
                'electrical.net.label',
                { label: { id: newId(), name: lp.name.trim(), pin: { partId: lp.part, pin: lp.pin } } },
                { label: `Label net ${lp.name}` },
              );
              elecUiFor(editor).setState({ message: r.ok ? null : { tone: 'error', text: r.error.message } });
            }}
          >
            Label
          </Button>
        </div>
        {def.netLabels.map((l) => (
          <div key={l.id} className="flex items-center justify-between text-xs">
            <span className="font-mono">
              {l.name} @ {label(l.pin.partId)}.{l.pin.pin}
            </span>
            <button
              aria-label="Remove label"
              onClick={() => run('electrical.net.unlabel', { labelId: l.id }, { label: 'Remove net label' })}
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="outline"
          data-testid="elec-export"
          onClick={() =>
            downloadText(
              `${def.name}.forge-circuit.json`,
              exportElectricalBundle(def, { project: project.name }),
            )
          }
        >
          <Download /> Export circuit
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
          <Upload /> Import circuit
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => downloadText(`${def.name}.cir`, exportSpiceNetlist(def))}
          title="SPICE-style netlist of the analog subset (not verified against a SPICE simulator)"
        >
          <Download /> SPICE-style netlist
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            if (f.size > 2 * 1024 * 1024)
              return elecUiFor(editor).setState({
                message: { tone: 'error', text: 'File too large (2 MB limit).' },
              });
            const r = parseElectricalBundle(await f.text());
            if (!r.ok)
              return elecUiFor(editor).setState({
                message: { tone: 'error', text: `${r.error} ${r.details.slice(0, 3).join('; ')}` },
              });
            const res = run(
              'electrical.circuit.import',
              { definition: r.definition },
              { label: 'Import circuit' },
            );
            elecUiFor(editor).setState({
              message: res.ok
                ? { tone: 'info', text: 'Circuit imported (replaces the previous one; undoable).' }
                : { tone: 'error', text: res.error.message },
            });
          }}
        />
      </div>
    </div>
  );
}

// -- Checks ---------------------------------------------------------------------------------
export function IssueList({ issues, testId }: { issues: RuleIssue[]; testId: string }) {
  if (!issues.length) return <p className="text-xs text-muted-foreground">No rule fired.</p>;
  return (
    <ul className="space-y-1" data-testid={testId}>
      {issues.map((i, k) => (
        <li
          key={k}
          data-code={i.code}
          className={`rounded border p-1.5 text-xs ${i.severity === 'error' ? 'border-destructive/60 bg-destructive/10' : i.severity === 'warning' ? 'border-amber-500/50 bg-amber-500/10' : 'border-border'}`}
        >
          <span className="mr-1 font-mono text-[10px] uppercase text-muted-foreground">{i.severity}</span>
          {i.message}
        </li>
      ))}
    </ul>
  );
}

function ChecksTab({ issues }: { issues: RuleIssue[] }) {
  return (
    <div className="space-y-2">
      <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">{DRC_DISCLAIMER}</p>
      <IssueList issues={issues} testId="elec-issues" />
    </div>
  );
}

// -- Analysis -------------------------------------------------------------------------------
function AnalysisTab({ def }: { def: ElectricalDefinition }) {
  const editor = useEditorStore();
  const ui = useStore(elecUiFor(editor));
  const revision = useEditor((s) => s.project.revision);
  const circuit = useMemo(() => analogCircuitOf(def), [def]);
  const [stop, setStop] = useState(def.settings.transient.stopS);
  const [step, setStep] = useState(def.settings.transient.stepS);
  const [shown, setShown] = useState<string[]>([]);
  const dc = ui.dc?.result;
  const tr = ui.transient?.result;
  const stale = (r: { revision: number } | null) => r !== null && r.revision !== revision;
  const nets = circuit.netlist.nets.filter((n) => n.pins.length > 1 || n.isGround);
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        Standalone analog analysis of the circuit (MNA). Digital parts and firmware run only in Simulation
        mode; here their outputs are open. Results are not stored in the project.
      </p>
      <div className="space-y-1">
        <Button
          size="sm"
          data-testid="elec-dc-run"
          onClick={() => elecUiFor(editor).setState({ dc: { revision, result: circuit.dc() } })}
        >
          DC operating point
        </Button>
        {dc && stale(ui.dc) && (
          <p className="text-[11px] text-amber-300">The circuit changed since this result.</p>
        )}
        {dc && !dc.ok && (
          <IssueList
            testId="elec-dc-diagnostics"
            issues={dc.diagnostics.map((d) => ({
              code: 'missing-ground',
              severity: 'error',
              message: `${d.code}: ${d.message}`,
              parts: d.elements,
              nets: d.nets,
              basis: 'solved',
            }))}
          />
        )}
        {dc?.ok && (
          <>
            <table className="w-full text-xs" data-testid="elec-dc-voltages">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th>Net (voltmeter)</th>
                  <th className="text-right">V</th>
                </tr>
              </thead>
              <tbody>
                {nets.map((n) => (
                  <tr key={n.index} data-net={n.name}>
                    <td className="font-mono">{n.name}</td>
                    <td className="text-right font-mono">
                      {dc.v[n.index] === null ? (
                        <span className="italic">undefined</span>
                      ) : (
                        formatSi(dc.v[n.index]!, 'V', 5)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="w-full text-xs" data-testid="elec-dc-currents">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th>Element (ammeter, a→b)</th>
                  <th className="text-right">A</th>
                </tr>
              </thead>
              <tbody>
                {[...dc.i.entries()].map(([k, v]) => (
                  <tr key={k}>
                    <td className="font-mono">{k}</td>
                    <td className="text-right font-mono">{formatSi(v, 'A', 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {dc.warnings.map((w, i) => (
              <p key={i} className="text-[11px] text-amber-300">
                {w.message}
              </p>
            ))}
            <IssueList testId="elec-dc-checks" issues={solvedChecks(def, circuit.netlist, dc)} />
          </>
        )}
      </div>
      <div className="space-y-1">
        <h3 className="text-xs font-medium">Transient</h3>
        <div className="flex gap-1">
          <SiField label="Stop" unit="s" value={stop} onCommit={setStop} testId="elec-tran-stop" />
          <SiField label="Step" unit="s" value={step} onCommit={setStep} testId="elec-tran-step" />
        </div>
        <Button
          size="sm"
          variant="outline"
          data-testid="elec-tran-run"
          onClick={() => {
            const result = circuit.transient(stop, step);
            elecUiFor(editor).setState({ transient: { revision, result } });
            if (result.ok && shown.length === 0)
              setShown(
                nets
                  .filter((n) => !n.isGround)
                  .slice(0, 3)
                  .map((n) => n.name),
              );
          }}
        >
          Run transient ({def.settings.transient.method})
        </Button>
        {tr && !tr.ok && (
          <p role="alert" className="text-xs text-destructive">
            {tr.diagnostics.map((d) => d.message).join(' ')}
          </p>
        )}
        {tr?.ok && (
          <>
            <div className="flex flex-wrap gap-1 text-[11px]">
              {nets
                .filter((n) => !n.isGround)
                .map((n) => (
                  <label key={n.index} className="flex items-center gap-0.5">
                    <input
                      type="checkbox"
                      checked={shown.includes(n.name)}
                      onChange={(e) =>
                        setShown(e.target.checked ? [...shown, n.name] : shown.filter((x) => x !== n.name))
                      }
                    />
                    {n.name}
                  </label>
                ))}
            </div>
            <WavePlot
              testId="elec-tran-plot"
              t={tr.t}
              series={shown.map((name) => ({ name, v: tr.v[circuit.netlist.netByName(name)!.index]! }))}
              unit="V"
            />
            <p className="text-[11px] text-muted-foreground">
              {tr.steps} steps · {tr.t.length} points · {tr.method}
              {tr.warnings.map((w) => ` · ${w.message}`).join('')}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const cols = shown.map((name) => tr.v[circuit.netlist.netByName(name)!.index]!);
                const rows = tr.t.map((t, k) => [t, ...cols.map((c) => c[k])].join(','));
                downloadText(
                  `${def.name}.transient.csv`,
                  [
                    `# FORGE transient (${tr.method}, step ${step} s); circuit "${def.name}"`,
                    ['t_s', ...shown.map((s) => `V(${s})`)].join(','),
                    ...rows,
                  ].join('\n'),
                );
              }}
            >
              <Download /> Export CSV
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
