import { newId, UNO_ANALOG_PINS, UNO_DIGITAL_PINS, type ElectricalDefinition } from '@forge/engineering-core';
import { UnoRuntime, type CompileResult } from '@forge/electronics';
import { Plus, Save, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { useEditor, useEditorStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { FIRMWARE_TEMPLATES } from './templates';
import { analyse, elecUiFor } from './state';

/**
 * Firmware editor for the FORGE Arduino subset (Level 2 runtime — docs/EMBEDDED_RUNTIME.md).
 * Edits are local until saved; saving is one undoable `electrical.firmware.set` (revision +1).
 * "Check" compiles with the same front end the runtime uses, so errors match what will run.
 */
const KEYWORDS = new Set(
  'if else for while do switch case default break continue return const volatile static unsigned signed void bool boolean char byte int short long float double word size_t uint8_t int8_t uint16_t int16_t uint32_t int32_t true false Servo'.split(
    ' ',
  ),
);
const API = new Set(
  'pinMode digitalWrite digitalRead analogRead analogWrite delay delayMicroseconds millis micros pulseIn map constrain min max abs sq sqrt pow sin cos tan atan atan2 exp log fabs floor ceil round fmod bitRead bit lowByte highByte random randomSeed attachInterrupt detachInterrupt digitalPinToInterrupt noInterrupts interrupts Serial setup loop HIGH LOW INPUT OUTPUT INPUT_PULLUP LED_BUILTIN A0 A1 A2 A3 A4 A5 RISING FALLING CHANGE PI DEC HEX BIN OCT'.split(
    ' ',
  ),
);

function highlight(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])+')|(^[ \t]*#[^\n]*)|(\b0[xX][0-9a-fA-F]+[uUlL]*\b|\b\d+\.?\d*(?:[eE][+-]?\d+)?[fFuUlL]*\b)|([A-Za-z_]\w*)/gm;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const cls = m[1]
      ? 'text-neutral-500 italic'
      : m[2]
        ? 'text-amber-300'
        : m[3]
          ? 'text-fuchsia-300'
          : m[4]
            ? 'text-sky-300'
            : KEYWORDS.has(m[5]!)
              ? 'text-violet-300'
              : API.has(m[5]!)
                ? 'text-emerald-300'
                : null;
    out.push(
      cls ? (
        <span key={k++} className={cls}>
          {m[0]}
        </span>
      ) : (
        m[0]
      ),
    );
    last = m.index + m[0].length;
  }
  out.push(src.slice(last));
  return out;
}

export function CodeTab({ def }: { def: ElectricalDefinition | null }) {
  const editor = useEditorStore();
  const run = useEditor((s) => s.run);
  const scene = useEditor((s) => s.project.scene);
  const ui = useStore(elecUiFor(editor));
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<{ id: string; src: string; result: CompileResult } | null>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const fw = def?.firmware.find((f) => f.id === selected) ?? def?.firmware[0] ?? null;
  const source = fw ? (drafts[fw.id] ?? fw.source) : '';
  const dirty = !!fw && drafts[fw.id] !== undefined && drafts[fw.id] !== fw.source;
  const mcus = useMemo(() => def?.parts.filter((p) => p.device.type === 'mcu') ?? [], [def]);
  const result = checked && fw && checked.id === fw.id && checked.src === source ? checked.result : null;
  const lines = source.split('\n').length;

  // Pin map from the WIRING (not from the source text): which net and device each pin reaches.
  const pinMap = useMemo(() => {
    if (!def) return [];
    const { netlist } = analyse(def, scene);
    return mcus.flatMap((m) =>
      [...UNO_DIGITAL_PINS, ...UNO_ANALOG_PINS].flatMap((pin) => {
        const n = netlist.pinNet(m.id, pin);
        if (n === undefined) return [];
        const others = netlist.nets[n]!.pins.filter((p) => p.partId !== m.id);
        return others.length
          ? [
              {
                mcu: m.label,
                pin,
                net: netlist.nets[n]!.name,
                to: others.map((o) => `${netlist.partById.get(o.partId)!.label}.${o.pin}`).join(', '),
              },
            ]
          : [];
      }),
    );
  }, [def, scene, mcus]);

  if (!def) return <p className="text-xs text-muted-foreground">Create a circuit first.</p>;
  const create = (key: keyof typeof FIRMWARE_TEMPLATES) => {
    const id = newId();
    const t = FIRMWARE_TEMPLATES[key];
    const r = run(
      'electrical.firmware.set',
      { firmware: { id, name: t.name, language: 'arduino-subset', source: t.source } },
      { label: `New firmware ${t.name}` },
    );
    if (r.ok) setSelected(id);
  };
  const save = () => {
    if (!fw) return;
    const r = run(
      'electrical.firmware.set',
      { firmware: { id: fw.id, name: fw.name, language: fw.language, source } },
      { label: `Edit firmware ${fw.name}` },
    );
    if (r.ok) setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== fw.id)));
    else elecUiFor(editor).setState({ message: { tone: 'error', text: r.error.message } });
  };
  const check = () => fw && setChecked({ id: fw.id, src: source, result: UnoRuntime.check(source) });
  return (
    <div className="space-y-2" data-testid="elec-code">
      <p className="rounded border border-sky-500/30 bg-sky-500/10 p-1.5 text-[11px]">
        Board: <strong>Arduino UNO R3 — Level 2 runtime</strong>. Sketches in the documented FORGE Arduino
        subset run against a modelled Arduino API (GPIO, PWM, analogRead, timing, Serial, Servo, interrupts).
        The ATmega328P is not emulated; compiled .hex/.elf firmware cannot be loaded.
      </p>
      <div className="flex flex-wrap items-center gap-1">
        <select
          aria-label="Firmware"
          data-testid="elec-fw-select"
          className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
          value={fw?.id ?? ''}
          onChange={(e) => setSelected(e.target.value)}
        >
          {def.firmware.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} (rev {f.revision})
            </option>
          ))}
        </select>
        <select
          aria-label="New firmware from template"
          data-testid="elec-fw-new"
          className="rounded border border-border bg-background px-1 py-0.5 text-xs"
          value=""
          onChange={(e) => e.target.value && create(e.target.value as keyof typeof FIRMWARE_TEMPLATES)}
        >
          <option value="">New from template…</option>
          {Object.entries(FIRMWARE_TEMPLATES).map(([k, t]) => (
            <option key={k} value={k}>
              {t.name}
            </option>
          ))}
        </select>
        {!def.firmware.length && (
          <Button size="sm" variant="outline" onClick={() => create('blink')}>
            <Plus /> New
          </Button>
        )}
      </div>
      {fw && (
        <>
          <div className="relative h-72 overflow-hidden rounded border border-border bg-[#0d1117] font-mono text-[11px] leading-[16px]">
            <div
              ref={gutter}
              className="absolute inset-y-0 left-0 w-8 overflow-hidden border-r border-white/10 bg-black/30 py-1 pr-1 text-right text-neutral-500"
            >
              {Array.from({ length: lines }, (_, i) => (
                <div
                  key={i}
                  className={result?.errors.some((e) => e.line === i + 1) ? 'bg-red-500/30 text-red-200' : ''}
                >
                  {i + 1}
                </div>
              ))}
            </div>
            <pre
              ref={pre}
              aria-hidden
              className="pointer-events-none absolute inset-0 left-8 m-0 overflow-hidden whitespace-pre px-2 py-1 text-neutral-200"
            >
              {highlight(source)}
              {'\n'}
            </pre>
            <textarea
              aria-label="Firmware source"
              data-testid="elec-fw-source"
              spellCheck={false}
              className="absolute inset-0 left-8 resize-none overflow-auto whitespace-pre bg-transparent px-2 py-1 text-transparent caret-white outline-none selection:bg-sky-500/40"
              value={source}
              onChange={(e) => setDrafts((d) => ({ ...d, [fw.id]: e.target.value }))}
              onScroll={(e) => {
                const t = e.currentTarget;
                if (pre.current) {
                  pre.current.scrollTop = t.scrollTop;
                  pre.current.scrollLeft = t.scrollLeft;
                }
                if (gutter.current) gutter.current.scrollTop = t.scrollTop;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const t = e.currentTarget;
                  const s = t.selectionStart;
                  const next = `${source.slice(0, s)}  ${source.slice(t.selectionEnd)}`;
                  setDrafts((d) => ({ ...d, [fw.id]: next }));
                  requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
                }
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault();
                  save();
                }
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="outline" onClick={check} data-testid="elec-fw-check">
              Check
            </Button>
            <Button size="sm" disabled={!dirty} onClick={save} data-testid="elec-fw-save">
              <Save /> Save (rev {fw.revision + (dirty ? 1 : 0)})
            </Button>
            {dirty && <span className="text-[11px] text-amber-300">unsaved changes</span>}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() =>
                run(
                  'electrical.firmware.delete',
                  { firmwareId: fw.id },
                  { label: `Delete firmware ${fw.name}` },
                )
              }
            >
              <Trash2 />
            </Button>
          </div>
          {result && (
            <div className="space-y-1 text-[11px]" data-testid="elec-fw-result">
              {result.ok ? (
                <p className="text-emerald-300">
                  Check passed: {result.stats.functions} functions, {result.stats.globals} globals, ≈{' '}
                  {result.stats.sramBytes} B of 2048 B SRAM (estimate).
                </p>
              ) : (
                result.errors.map((e, i) => (
                  <p key={i} className="text-destructive" data-testid="elec-fw-error">
                    line {e.line}:{e.col} — {e.message}
                  </p>
                ))
              )}
              {result.warnings.map((w, i) => (
                <p key={i} className="text-amber-300">
                  line {w.line} — {w.message}
                </p>
              ))}
            </div>
          )}
          {mcus.map((m) => (
            <label key={m.id} className="flex items-center justify-between text-xs">
              <span>{m.label} runs</span>
              <select
                data-testid={`elec-fw-assign-${m.label}`}
                className="rounded border border-border bg-background px-1"
                value={m.device.type === 'mcu' ? (m.device.firmwareId ?? '') : ''}
                onChange={(e) =>
                  m.device.type === 'mcu' &&
                  run(
                    'electrical.part.update',
                    { partId: m.id, patch: { device: { ...m.device, firmwareId: e.target.value || null } } },
                    { label: `${m.label} firmware` },
                  )
                }
              >
                <option value="">(none)</option>
                {def.firmware.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </>
      )}
      {pinMap.length > 0 && (
        <details open>
          <summary className="cursor-pointer text-xs font-medium">Pin map (from the wiring)</summary>
          <table className="mt-1 w-full text-[11px]" data-testid="elec-pin-map">
            <tbody>
              {pinMap.map((r) => (
                <tr key={`${r.mcu}.${r.pin}`}>
                  <td className="font-mono">
                    {r.mcu}.{r.pin}
                  </td>
                  <td className="font-mono text-muted-foreground">{r.net}</td>
                  <td>{r.to}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {ui.message?.tone === 'error' && <p className="text-xs text-destructive">{ui.message.text}</p>}
    </div>
  );
}
