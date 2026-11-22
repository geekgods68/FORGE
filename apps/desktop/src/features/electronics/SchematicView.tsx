import type { ElectricalPart, Wire } from '@forge/engineering-core';
import { X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import { useEditor, useEditorStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { cosimFor } from './cosim';
import { formatSi } from './format';
import { analyse, circuitOf, clickPin, elecUiFor } from './state';
import { pinPoint, snap, symbolLayout, wirePath, type Pt } from './symbols';

/**
 * 2D schematic of the project's circuit. It renders the SAME electrical definition as the 3D
 * view and edits it only through `electrical.*` commands (move/rotate parts, add/route/remove
 * wires, labels), so there is one connectivity state. Positions never create connections.
 */
const U = 10; // px per grid unit at scale 1

export function SchematicOverlay() {
  const editor = useEditorStore();
  const open = useStore(elecUiFor(editor), (s) => s.schematicOpen);
  const mode = useEditor((s) => s.workMode);
  if (!open || mode === 'cad') return null;
  return <SchematicView />;
}

function valueText(p: ElectricalPart): string {
  const d = p.device;
  switch (d.type) {
    case 'resistor':
      return formatSi(d.resistanceOhm, 'Ω');
    case 'capacitor':
      return formatSi(d.capacitanceF, 'F');
    case 'inductor':
      return formatSi(d.inductanceH, 'H');
    case 'vsource':
      return d.waveform.kind === 'dc' ? formatSi(d.waveform.value, 'V') : d.waveform.kind;
    case 'isource':
      return d.waveform.kind === 'dc' ? formatSi(d.waveform.value, 'A') : d.waveform.kind;
    case 'potentiometer':
      return formatSi(d.resistanceOhm, 'Ω');
    case 'logic-gate':
      return d.op.toUpperCase();
    case 'clock':
      return formatSi(d.frequencyHz, 'Hz');
    case 'mcu':
      return 'Arduino UNO R3';
    case 'servo':
      return d.model.toUpperCase();
    case 'hc-sr04':
      return 'HC-SR04';
    default:
      return '';
  }
}

function SchematicView() {
  const editor = useEditorStore();
  const ui = useStore(elecUiFor(editor));
  const uiStore = elecUiFor(editor);
  const def = useEditor((s) => circuitOf(s.project.scene));
  const hasCircuit = def !== null;
  const scene = useEditor((s) => s.project.scene);
  const run = useEditor((s) => s.run);
  const live = useStore(cosimFor(editor).ui, (s) => s.netLevels);
  const [view, setView] = useState({ x: -10, y: -14, k: 1.4 });
  const [drag, setDrag] = useState<
    | null
    | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
    | { kind: 'part'; id: string; sx: number; sy: number; dx: number; dy: number }
    | { kind: 'vertex'; wireId: string; index: number; at: Pt }
  >(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 700 });
  const fitRef = useRef<(w: number, h: number) => void>(() => undefined);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth || 1000;
      const h = el.clientHeight || 700;
      setSize({ w, h });
      if (!fitted.current) {
        fitted.current = true;
        fitRef.current(w, h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasCircuit]);
  const analysis = useMemo(() => (def ? analyse(def, scene) : null), [def, scene]);
  const parts = useMemo(() => new Map(def?.parts.map((p) => [p.id, p]) ?? []), [def]);

  /** Fit every symbol into the visible area. */
  const fit = useCallback(
    (w: number, h: number) => {
      if (!def?.parts.length) return;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of def.parts) {
        const lay = symbolLayout(p);
        const pts = [...lay.pins.keys()]
          .map((k) => pinPoint(p, k)!)
          .concat([
            [p.schematic.x - lay.w, p.schematic.y - lay.h - 2],
            [p.schematic.x + lay.w, p.schematic.y + lay.h],
          ]);
        for (const [x, y] of pts) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
      const margin = 4;
      const k = Math.min(
        3,
        Math.max(0.3, Math.min(w / ((x1 - x0 + 2 * margin) * U), (h - 40) / ((y1 - y0 + 2 * margin) * U))),
      );
      setView({ k, x: (x0 + x1) / 2 - w / (2 * U * k), y: (y0 + y1) / 2 - (h + 30) / (2 * U * k) });
    },
    [def],
  );
  const fitted = useRef(false);

  const toGrid = useCallback(
    (cx: number, cy: number): Pt => {
      const r = svg.current!.getBoundingClientRect();
      return [(cx - r.left) / (U * view.k) + view.x, (cy - r.top) / (U * view.k) + view.y];
    },
    [view],
  );

  const netOfPin = (partId: string, pin: string) => {
    const n = analysis?.netlist.pinNet(partId, pin);
    return n === undefined ? null : analysis!.netlist.nets[n]!.name;
  };
  const wireNet = (w: Wire) => netOfPin(w.a.partId, w.a.pin);

  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);

  // Keyboard: Esc cancels wiring; Delete removes the selection; R rotates the selected part.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return;
      const u = uiStore.getState();
      if (e.key === 'Escape') uiStore.setState({ pending: null, message: null });
      if ((e.key === 'Delete' || e.key === 'Backspace') && u.selectedWire) {
        run('electrical.wire.remove', { wireId: u.selectedWire }, { label: 'Remove wire' });
        uiStore.setState({ selectedWire: null });
      }
      if ((e.key === 'r' || e.key === 'R') && u.selectedPart && !e.metaKey && !e.ctrlKey) {
        const p = circuitOf(editor.getState().project.scene)?.parts.find((x) => x.id === u.selectedPart);
        if (p)
          run(
            'electrical.part.update',
            {
              partId: p.id,
              patch: {
                schematic: {
                  ...p.schematic,
                  rotation: ((p.schematic.rotation + 90) % 360) as 0 | 90 | 180 | 270,
                },
              },
            },
            { label: `Rotate ${p.label}` },
          );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, run, uiStore]);

  if (!def || !analysis)
    return (
      <div className="absolute inset-0 z-20 grid place-items-center bg-background/95 text-sm text-muted-foreground">
        No circuit yet — add a part from the Electronics panel.
        <CloseButton />
      </div>
    );

  const partPos = (p: ElectricalPart): ElectricalPart =>
    drag?.kind === 'part' && drag.id === p.id
      ? {
          ...p,
          schematic: { ...p.schematic, x: snap(p.schematic.x + drag.dx), y: snap(p.schematic.y + drag.dy) },
        }
      : p;
  const pinAt = (partId: string, pin: string): Pt | null => {
    const p = parts.get(partId);
    return p ? pinPoint(partPos(p), pin) : null;
  };

  const onPointerMove = (e: RPointerEvent) => {
    if (!drag) return;
    if (drag.kind === 'pan')
      setView((v) => ({
        ...v,
        x: drag.vx - (e.clientX - drag.sx) / (U * v.k),
        y: drag.vy - (e.clientY - drag.sy) / (U * v.k),
      }));
    else if (drag.kind === 'part')
      setDrag({
        ...drag,
        dx: (e.clientX - drag.sx) / (U * view.k),
        dy: (e.clientY - drag.sy) / (U * view.k),
      });
    else if (drag.kind === 'vertex') {
      const [gx, gy] = toGrid(e.clientX, e.clientY);
      setDrag({ ...drag, at: [snap(gx), snap(gy)] });
    }
  };
  const onPointerUp = () => {
    if (drag?.kind === 'part' && (Math.abs(drag.dx) >= 0.5 || Math.abs(drag.dy) >= 0.5)) {
      const p = parts.get(drag.id)!;
      run(
        'electrical.part.update',
        { partId: p.id, patch: { schematic: partPos(p).schematic } },
        { label: `Move ${p.label} (schematic)` },
      );
    }
    if (drag?.kind === 'vertex') {
      const w = def.wires.find((x) => x.id === drag.wireId)!;
      const route = [...w.route];
      route[drag.index] = drag.at;
      run('electrical.wire.update', { wireId: w.id, patch: { route } }, { label: 'Route wire' });
    }
    setDrag(null);
  };

  const highlight = ui.selectedNet;
  const routeOf = (w: Wire): Pt[] | null => {
    const a = pinAt(w.a.partId, w.a.pin);
    const b = pinAt(w.b.partId, w.b.pin);
    if (!a || !b) return null;
    const ww =
      drag?.kind === 'vertex' && drag.wireId === w.id
        ? { ...w, route: w.route.map((r, i) => (i === drag.index ? drag.at : r)) }
        : w;
    return wirePath(ww, a, b);
  };
  // Junction dots: pins where three or more wire ends meet.
  const ends = new Map<string, { n: number; at: Pt }>();
  for (const w of def.wires)
    for (const r of [w.a, w.b]) {
      const at = pinAt(r.partId, r.pin);
      if (!at) continue;
      const k = `${r.partId}\u0000${r.pin}`;
      ends.set(k, { n: (ends.get(k)?.n ?? 0) + 1, at });
    }

  const levelColor = (net: string | null) => {
    if (!net || !live) return null;
    const l = live[net];
    return l === '1'
      ? '#4ade80'
      : l === '0'
        ? '#60a5fa'
        : l === 'X'
          ? '#f87171'
          : l === 'Z'
            ? '#a3a3a3'
            : null;
  };

  return (
    <div
      className="absolute inset-0 z-20 bg-[#f7f7f2] text-black dark:bg-[#f7f7f2]"
      data-testid="schematic"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <div className="absolute left-2 top-2 z-10 flex items-center gap-2 rounded bg-white/90 px-2 py-1 text-xs shadow">
        <strong>Schematic</strong>
        <span className="text-neutral-600">
          {def.parts.length} parts · {def.wires.length} wires ·{' '}
          {analysis.netlist.nets.filter((n) => n.pins.length > 1).length} nets
        </span>
        <span className="text-neutral-500">
          Drag to pan · wheel to zoom · R rotates · Del removes a wire · double-click a wire to add a bend
        </span>
        <button
          className="rounded border px-1"
          onClick={() => fit(size.w, size.h)}
          data-testid="schematic-fit"
        >
          Fit
        </button>
        {ui.pending && (
          <span className="text-amber-700">
            Wiring from {parts.get(ui.pending.partId)?.label}.{ui.pending.pin}…
          </span>
        )}
      </div>
      <CloseButton />
      <svg
        ref={svg}
        className="h-full w-full touch-none select-none"
        viewBox={`${view.x * U} ${view.y * U} ${size.w / view.k} ${size.h / view.k}`}
        onPointerDown={(e) => {
          if (e.target === svg.current || (e.target as Element).getAttribute('data-bg')) {
            setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
            uiStore.setState({ selectedWire: null, selectedNet: null });
          }
        }}
        onWheel={(e) => {
          const [gx, gy] = toGrid(e.clientX, e.clientY);
          const k = Math.min(8, Math.max(0.25, view.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
          const r = svg.current!.getBoundingClientRect();
          setView({ k, x: gx - (e.clientX - r.left) / (U * k), y: gy - (e.clientY - r.top) / (U * k) });
        }}
      >
        <defs>
          <pattern id="sch-grid" width={U} height={U} patternUnits="userSpaceOnUse">
            <circle cx={0} cy={0} r={0.6} fill="#c8c8c0" />
          </pattern>
        </defs>
        <rect data-bg="1" x={-1e5} y={-1e5} width={2e5} height={2e5} fill="url(#sch-grid)" />
        {def.wires.map((w) => {
          const path = routeOf(w);
          if (!path) return null;
          const net = wireNet(w);
          const sel = ui.selectedWire === w.id;
          const hl = highlight !== null && net === highlight;
          const pts = path.map(([x, y]) => `${x * U},${y * U}`).join(' ');
          return (
            <g key={w.id} data-testid={`sch-wire-${w.id}`}>
              <polyline
                points={pts}
                fill="none"
                stroke="transparent"
                strokeWidth={8}
                style={{ cursor: 'pointer' }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  uiStore.setState({ selectedWire: w.id, selectedNet: net, selectedPart: null });
                }}
                onDoubleClick={(e) => {
                  const [gx, gy] = toGrid(e.clientX, e.clientY);
                  // Insert a bend at the clicked point (keeps the wire's existing route).
                  const route = w.route.length
                    ? [...w.route, [snap(gx), snap(gy)] as Pt]
                    : [[snap(gx), snap(gy)] as Pt];
                  run(
                    'electrical.wire.update',
                    { wireId: w.id, patch: { route } },
                    { label: 'Add wire bend' },
                  );
                }}
              />
              <polyline
                points={pts}
                fill="none"
                stroke={sel ? '#d97706' : hl ? '#0ea5e9' : (levelColor(net) ?? w.color ?? '#1d6b2f')}
                strokeWidth={sel || hl ? 2.4 : 1.6}
                pointerEvents="none"
              />
              {sel &&
                w.route.map(([x, y], i) => (
                  <circle
                    key={i}
                    cx={x * U}
                    cy={y * U}
                    r={3}
                    fill="#d97706"
                    style={{ cursor: 'move' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setDrag({ kind: 'vertex', wireId: w.id, index: i, at: [x, y] });
                    }}
                  />
                ))}
            </g>
          );
        })}
        {[...ends.values()]
          .filter((e) => e.n >= 2)
          .map((e, i) => (
            <circle key={i} cx={e.at[0] * U} cy={e.at[1] * U} r={2.4} fill="#1d6b2f" pointerEvents="none" />
          ))}
        {def.parts.map((p0) => {
          const p = partPos(p0);
          const lay = symbolLayout(p);
          const sel = ui.selectedPart === p.id;
          return (
            <g
              key={p.id}
              data-testid={`sch-part-${p.label}`}
              transform={`translate(${p.schematic.x * U} ${p.schematic.y * U}) rotate(${p.schematic.rotation})`}
            >
              <g
                style={{ cursor: 'grab' }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  uiStore.setState({ selectedPart: p.id, selectedWire: null });
                  setDrag({ kind: 'part', id: p.id, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0 });
                }}
              >
                <Symbol part={p} lay={lay} selected={sel} />
              </g>
              <text
                x={0}
                y={(lay.kind === 'box' ? -lay.h - 0.6 : -2.2) * U}
                fontSize={9}
                textAnchor="middle"
                transform={`rotate(${-p.schematic.rotation} 0 ${(lay.kind === 'box' ? -lay.h - 0.6 : -2.2) * U})`}
                fontFamily="ui-monospace, monospace"
                fill="#111"
              >
                {p.label} {lay.kind !== 'box' ? valueText(p) : ''}
              </text>
              {[...lay.pins.entries()].map(([pin, [x, y]]) => {
                const pending = ui.pending?.partId === p.id && ui.pending.pin === pin;
                const net = netOfPin(p.id, pin);
                const hl = highlight !== null && net === highlight;
                return (
                  <g key={pin}>
                    {lay.kind === 'box' && (
                      <text
                        x={(x < 0 ? x + 2.4 : x - 2.4) * U}
                        y={y * U + 3}
                        fontSize={7}
                        textAnchor={x < 0 ? 'start' : 'end'}
                        fill="#333"
                        fontFamily="ui-monospace, monospace"
                        pointerEvents="none"
                      >
                        {pin}
                      </text>
                    )}
                    <circle
                      data-testid={`sch-pin-${p.label}-${pin}`}
                      cx={x * U}
                      cy={y * U}
                      r={pending ? 4 : 2.6}
                      fill={pending ? '#d97706' : hl ? '#0ea5e9' : ui.tool === 'wire' ? '#b45309' : '#555'}
                      style={{ cursor: 'crosshair' }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (ui.tool === 'wire') clickPin(editor, { partId: p.id, pin });
                        else uiStore.setState({ selectedPart: p.id, selectedNet: net, selectedWire: null });
                      }}
                    >
                      <title>{`${p.label}.${pin} — net ${net ?? '?'}`}</title>
                    </circle>
                  </g>
                );
              })}
            </g>
          );
        })}
        {def.netLabels.map((l) => {
          const at = pinAt(l.pin.partId, l.pin.pin);
          if (!at) return null;
          return (
            <g key={l.id} pointerEvents="none">
              <rect
                x={at[0] * U + 3}
                y={at[1] * U - 13}
                width={l.name.length * 6 + 6}
                height={11}
                fill="#fff7d6"
                stroke="#b45309"
                strokeWidth={0.6}
              />
              <text
                x={at[0] * U + 6}
                y={at[1] * U - 4.5}
                fontSize={8}
                fontFamily="ui-monospace, monospace"
                fill="#7c2d12"
              >
                {l.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function CloseButton() {
  const editor = useEditorStore();
  return (
    <Button
      size="sm"
      variant="secondary"
      className="absolute right-2 top-2 z-10"
      onClick={() => elecUiFor(editor).setState({ schematicOpen: false })}
      data-testid="schematic-close"
    >
      <X /> Close schematic
    </Button>
  );
}

/** Standard symbols (IEC/ANSI-style line art); boxes for modules and logic. */
function Symbol({
  part,
  lay,
  selected,
}: {
  part: ElectricalPart;
  lay: ReturnType<typeof symbolLayout>;
  selected: boolean;
}) {
  const s = selected ? '#d97706' : '#111';
  const sw = 1.4;
  const d = part.device;
  const lead = (x1: number, x2: number) => (
    <line x1={x1 * U} y1={0} x2={x2 * U} y2={0} stroke={s} strokeWidth={sw} />
  );
  const hit = (
    <rect
      x={-lay.w * U - 4}
      y={-lay.h * U - 4}
      width={lay.w * 2 * U + 8}
      height={lay.h * 2 * U + 8}
      fill="transparent"
    />
  );
  switch (lay.kind) {
    case 'two': {
      let body: ReactNode = null;
      if (d.type === 'resistor')
        body = (
          <polyline points="-15,0 -12,-5 -6,5 0,-5 6,5 12,-5 15,0" fill="none" stroke={s} strokeWidth={sw} />
        );
      else if (d.type === 'capacitor')
        body = (
          <>
            <line x1={-3} y1={-8} x2={-3} y2={8} stroke={s} strokeWidth={2} />
            <line x1={3} y1={-8} x2={3} y2={8} stroke={s} strokeWidth={2} />
            {d.polarized && (
              <text x={-12} y={-6} fontSize={8} fill={s}>
                +
              </text>
            )}
          </>
        );
      else if (d.type === 'inductor')
        body = (
          <path
            d="M-15,0 a5,5 0 0 1 10,0 a5,5 0 0 1 10,0 a5,5 0 0 1 10,0"
            fill="none"
            stroke={s}
            strokeWidth={sw}
          />
        );
      else if (d.type === 'vsource' || d.type === 'isource')
        body = (
          <>
            <circle r={10} fill="#fff" stroke={s} strokeWidth={sw} />
            {d.type === 'vsource' ? (
              <>
                <text x={-8} y={3} fontSize={9} fill={s}>
                  +
                </text>
                <text x={3} y={3} fontSize={9} fill={s}>
                  −
                </text>
              </>
            ) : (
              <path d="M6,0 L-6,0 M-2,-4 L-6,0 L-2,4" fill="none" stroke={s} strokeWidth={sw} />
            )}
          </>
        );
      else if (d.type === 'diode' || d.type === 'led')
        body = (
          <>
            <polygon
              points="-7,-7 -7,7 6,0"
              fill={d.type === 'led' ? '#fde68a' : '#fff'}
              stroke={s}
              strokeWidth={sw}
            />
            <line x1={6} y1={-7} x2={6} y2={7} stroke={s} strokeWidth={2} />
            {d.type === 'led' && <path d="M0,-9 l5,-6 M5,-9 l5,-6" stroke={s} strokeWidth={1} />}
          </>
        );
      else if (d.type === 'switch')
        body = (
          <>
            <circle cx={-10} cy={0} r={1.8} fill={s} />
            <circle cx={10} cy={0} r={1.8} fill={s} />
            <line x1={-10} y1={0} x2={9} y2={d.closed ? 0 : -8} stroke={s} strokeWidth={sw} />
          </>
        );
      const inner =
        d.type === 'capacitor'
          ? 0.3
          : d.type === 'vsource' || d.type === 'isource'
            ? 1
            : d.type === 'switch'
              ? 1
              : 1.5;
      return (
        <>
          {hit}
          {lead(-3, -inner)}
          {lead(inner, 3)}
          {body}
        </>
      );
    }
    case 'ground':
      return (
        <>
          {hit}
          <line x1={0} y1={-U} x2={0} y2={0} stroke={s} strokeWidth={sw} />
          <line x1={-9} y1={0} x2={9} y2={0} stroke={s} strokeWidth={sw} />
          <line x1={-6} y1={3.5} x2={6} y2={3.5} stroke={s} strokeWidth={sw} />
          <line x1={-3} y1={7} x2={3} y2={7} stroke={s} strokeWidth={sw} />
        </>
      );
    case 'junction':
      return <circle r={3.5} fill={s} />;
    case 'three':
      return (
        <>
          {hit}
          {d.type === 'potentiometer' ? (
            <>
              <line x1={-30} y1={0} x2={-15} y2={0} stroke={s} strokeWidth={sw} />
              <line x1={15} y1={0} x2={30} y2={0} stroke={s} strokeWidth={sw} />
              <rect x={-15} y={-5} width={30} height={10} fill="#fff" stroke={s} strokeWidth={sw} />
              <path d="M0,-30 L0,-7 M-3,-11 L0,-6 L3,-11" fill="none" stroke={s} strokeWidth={sw} />
            </>
          ) : (
            <>
              <circle cx={4} cy={0} r={13} fill="#fff" stroke={s} strokeWidth={sw} />
              <line x1={-30} y1={0} x2={d.type === 'nmos' ? -4 : -2} y2={0} stroke={s} strokeWidth={sw} />
              {d.type === 'nmos' && <line x1={-4} y1={-8} x2={-4} y2={8} stroke={s} strokeWidth={sw} />}
              <line x1={0} y1={-9} x2={0} y2={9} stroke={s} strokeWidth={2.4} />
              <path d="M0,-5 L20,-30 M0,5 L20,30" fill="none" stroke={s} strokeWidth={sw} />
              {d.type === 'npn' && <path d="M12,20 L17,26 L10,26" fill={s} stroke={s} />}
            </>
          )}
        </>
      );
    case 'box':
      return (
        <>
          <rect
            x={-lay.w * U}
            y={-lay.h * U}
            width={lay.w * 2 * U}
            height={lay.h * 2 * U}
            fill={d.type === 'mcu' ? '#e6f0fb' : '#fff'}
            stroke={s}
            strokeWidth={sw}
          />
          {[...lay.pins.values()].map(([x, y], i) => (
            <line
              key={i}
              x1={x * U}
              y1={y * U}
              x2={(x < 0 ? -lay.w : lay.w) * U}
              y2={y * U}
              stroke={s}
              strokeWidth={1}
            />
          ))}
          <text y={4} fontSize={9} textAnchor="middle" fill="#334" fontFamily="ui-sans-serif">
            {valueText(part)}
          </text>
        </>
      );
  }
}
