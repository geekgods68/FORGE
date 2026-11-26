import type { Device, ElectricalDefinition } from '@forge/engineering-core';
import { buildDefinition, parseSiValue, verifyConnectivity, type PartSpec } from '../electrical';
import { err, info, MAX_INPUT_BYTES, warn, type Diagnostic, type FormatId } from '../schemas';
import { all, first, head, parseSExpr, SExprError, val, type SExpr } from './sexpr';

/**
 * KiCad interoperability (KiCad 6/7/8 S-expression files).
 *
 *  - Netlist (.net, "(export (version E))"): components and nets with explicit pin
 *    membership → FORGE parts and net labels. This is the reliable path.
 *  - PCB (.kicad_pcb): footprints with pad → net assignments → the same conversion, plus
 *    placement (position, rotation, side) recorded per part. A PCB import is NOT an
 *    electromagnetic, thermal or manufacturing analysis.
 *  - Schematic (.kicad_sch): inspected only (symbols listed). Connectivity in a schematic is
 *    geometric (wire endpoints, junctions, labels, symbol pin graphics); FORGE does not
 *    derive it — export a netlist from KiCad instead.
 *
 * Mapping is EXPLICIT: only the library symbols listed in `mapSymbol` map automatically,
 * and only when the value parses. Anything else is reported unmapped with its reference,
 * value, footprint and library id, and can be mapped manually or omitted — never silently
 * replaced by an electrically different FORGE part.
 */
declare const TextDecoder: { new (label?: string): { decode(input: Uint8Array): string } };

export interface KicadComponent {
  ref: string;
  value: string;
  footprint: string;
  lib: string;
  part: string;
  description: string;
  /** PCB only: placement in mm, degrees, side. */
  placement: { x: number; y: number; rotation: number; side: 'front' | 'back' } | null;
}
export interface KicadNode {
  ref: string;
  pin: string;
  pinfunction: string;
}
export interface KicadDoc {
  kind: 'kicad-netlist' | 'kicad-pcb' | 'kicad-schematic';
  version: string | null;
  tool: string | null;
  source: string | null;
  components: KicadComponent[];
  nets: { name: string; nodes: KicadNode[] }[];
  unsupported: string[];
}

export type ManualMapping =
  | { as: 'omit' }
  | { as: 'resistor' | 'capacitor' | 'inductor'; value: number }
  | { as: 'device'; device: Device; pins: Record<string, string> };

export interface ComponentMapping {
  ref: string;
  status: 'mapped' | 'manual' | 'omitted' | 'unmapped';
  forgeType: string | null;
  reason: string;
  /** FORGE pin → KiCad pin number. */
  pins: Record<string, string>;
}

export interface KicadImport {
  ok: boolean;
  doc: KicadDoc | null;
  definition: ElectricalDefinition | null;
  mappings: ComponentMapping[];
  connectivity: ReturnType<typeof verifyConnectivity> | null;
  diagnostics: Diagnostic[];
}

function readDoc(bytes: Uint8Array, kind: FormatId): { doc: KicadDoc | null; diagnostics: Diagnostic[] } {
  const d: Diagnostic[] = [];
  if (bytes.byteLength > MAX_INPUT_BYTES[kind])
    return { doc: null, diagnostics: [err('too-large', 'File too large.')] };
  let root: SExpr;
  try {
    root = parseSExpr(new TextDecoder('utf-8').decode(bytes));
  } catch (e) {
    return {
      doc: null,
      diagnostics: [
        err('kicad-syntax', `Not a readable KiCad file: ${e instanceof SExprError ? e.message : String(e)}`),
      ],
    };
  }
  const h = head(root);
  const unsupported: string[] = [];
  if (kind === 'kicad-netlist') {
    if (h !== 'export')
      return { doc: null, diagnostics: [err('kicad-netlist', 'Root element is not (export …).')] };
    const version = val(root, 'version');
    if (version !== 'E' && version !== 'D')
      d.push(
        warn('kicad-version', `Netlist version "${version}" (FORGE was written for version E, KiCad 6–8).`),
      );
    const design = first(root, 'design');
    const comps = first(root, 'components');
    const nets = first(root, 'nets');
    if (!comps || !nets)
      return {
        doc: null,
        diagnostics: [err('kicad-netlist', 'The netlist has no (components …) or (nets …) section.')],
      };
    const components: KicadComponent[] = all(comps, 'comp').map((c) => {
      const ls = first(c, 'libsource');
      return {
        ref: val(c, 'ref') ?? '?',
        value: val(c, 'value') ?? '',
        footprint: val(c, 'footprint') ?? '',
        lib: (ls && val(ls, 'lib')) ?? '',
        part: (ls && val(ls, 'part')) ?? '',
        description: (ls && val(ls, 'description')) ?? val(c, 'description') ?? '',
        placement: null,
      };
    });
    const netList = all(nets, 'net').map((n) => ({
      name: val(n, 'name') ?? `net-${val(n, 'code') ?? '?'}`,
      nodes: all(n, 'node').map((x) => ({
        ref: val(x, 'ref') ?? '?',
        pin: val(x, 'pin') ?? '?',
        pinfunction: val(x, 'pinfunction') ?? '',
      })),
    }));
    if (first(root, 'libparts'))
      unsupported.push('library part definitions (pin lists are taken from the nets)');
    return {
      doc: {
        kind,
        version,
        tool: (design && val(design, 'tool')) ?? null,
        source: (design && val(design, 'source')) ?? null,
        components,
        nets: netList,
        unsupported,
      },
      diagnostics: d,
    };
  }
  if (kind === 'kicad-pcb') {
    if (h !== 'kicad_pcb')
      return { doc: null, diagnostics: [err('kicad-pcb', 'Root element is not (kicad_pcb …).')] };
    const version = val(root, 'version');
    const netNames = new Map<string, string>();
    for (const n of all(root, 'net'))
      if (typeof n[1] === 'string') netNames.set(n[1], typeof n[2] === 'string' ? n[2] : '');
    const byNet = new Map<string, KicadNode[]>();
    const components: KicadComponent[] = [];
    for (const f of [...all(root, 'footprint'), ...all(root, 'module')]) {
      const lib = typeof f[1] === 'string' ? f[1] : '';
      const prop = (name: string) => {
        for (const p of all(f, 'property')) if (p[1] === name && typeof p[2] === 'string') return p[2];
        for (const t of all(f, 'fp_text'))
          if (t[1] === name.toLowerCase() && typeof t[2] === 'string') return t[2];
        return '';
      };
      const ref = prop('Reference');
      const at = first(f, 'at');
      const layer = val(f, 'layer') ?? 'F.Cu';
      components.push({
        ref,
        value: prop('Value'),
        footprint: lib,
        lib: lib.split(':')[0] ?? '',
        part: lib.split(':')[1] ?? lib,
        description: prop('Description'),
        placement: at
          ? {
              x: Number(at[1]),
              y: Number(at[2]),
              rotation: Number(at[3] ?? 0),
              side: layer.startsWith('B') ? 'back' : 'front',
            }
          : null,
      });
      for (const pad of all(f, 'pad')) {
        const num = typeof pad[1] === 'string' ? pad[1] : '';
        const net = first(pad, 'net');
        if (!net || !num) continue;
        const name = typeof net[2] === 'string' ? net[2] : (netNames.get(String(net[1])) ?? '');
        if (!name) continue;
        const list = byNet.get(name) ?? [];
        if (!list.some((x) => x.ref === ref && x.pin === num))
          list.push({ ref, pin: num, pinfunction: val(pad, 'pinfunction') ?? '' });
        byNet.set(name, list);
      }
      if (first(f, 'model')) unsupported.push(`${ref}: 3D model reference (external file, not loaded)`);
    }
    const counts = (k: string) => all(root, k).length;
    if (counts('segment') || counts('via'))
      unsupported.push(
        `copper geometry (${counts('segment')} track segments, ${counts('via')} vias): no electromagnetic or thermal analysis`,
      );
    if (counts('zone')) unsupported.push(`${counts('zone')} copper zone(s)`);
    d.push(
      info(
        'kicad-pcb-scope',
        'A PCB import provides connectivity and placement only; it is not an electromagnetic, thermal or manufacturing validation.',
      ),
    );
    return {
      doc: {
        kind,
        version,
        tool: val(root, 'generator'),
        source: null,
        components,
        nets: [...byNet].map(([name, nodes]) => ({ name, nodes })),
        unsupported,
      },
      diagnostics: d,
    };
  }
  // Schematic: inspection only.
  if (h !== 'kicad_sch')
    return { doc: null, diagnostics: [err('kicad-sch', 'Root element is not (kicad_sch …).')] };
  const components: KicadComponent[] = all(root, 'symbol').map((s) => {
    const prop = (name: string) => {
      for (const p of all(s, 'property')) if (p[1] === name && typeof p[2] === 'string') return p[2];
      return '';
    };
    const id = val(s, 'lib_id') ?? '';
    return {
      ref: prop('Reference'),
      value: prop('Value'),
      footprint: prop('Footprint'),
      lib: id.split(':')[0] ?? '',
      part: id.split(':')[1] ?? id,
      description: '',
      placement: null,
    };
  });
  d.push(
    err(
      'kicad-sch-connectivity',
      `Schematic read for inspection (${components.length} symbols). FORGE does not derive connectivity from schematic geometry: in KiCad use File → Export → Netlist and import the .net file.`,
    ),
  );
  return {
    doc: {
      kind: 'kicad-schematic',
      version: val(root, 'version'),
      tool: val(root, 'generator'),
      source: null,
      components,
      nets: [],
      unsupported: ['schematic connectivity (wires, junctions, labels)'],
    },
    diagnostics: d,
  };
}

/** Automatic mapping for exact library symbols only. Returns null when not mapped. */
export function mapSymbol(
  c: KicadComponent,
  pins: KicadNode[],
): { device: Device; pins: Record<string, string>; reason: string } | { device: null; reason: string } {
  const key = `${c.lib}:${c.part}`;
  const num = (want: string[]) => {
    const r: Record<string, string> = {};
    want.forEach((f, i) => (r[f] = String(i + 1)));
    return r;
  };
  const byFunction = (fn: Record<string, RegExp>, fallback: Record<string, string>) => {
    const r: Record<string, string> = {};
    for (const [forge, re] of Object.entries(fn)) {
      const p = pins.find((x) => re.test(x.pinfunction));
      if (p) r[forge] = p.pin;
    }
    return Object.keys(r).length === Object.keys(fn).length ? r : fallback;
  };
  const pcbPrefix = (lib: string, prefix: string) => c.placement !== null && lib.startsWith(prefix);
  const value = (_what: string) => {
    const v = parseSiValue(c.value.replace(/\s*(ohm|ohms|F|H|V)$/i, ''));
    return v !== null && v > 0 ? v : null;
  };
  const isR = /^Device:R(_Small|_US)?$/.test(key) || pcbPrefix(c.lib, 'Resistor_');
  const isC = /^Device:C(_Small)?$/.test(key) || (pcbPrefix(c.lib, 'Capacitor_') && !/CP_|Elec/.test(c.part));
  const isCP =
    /^Device:(CP|C_Polarized)(_Small)?$/.test(key) ||
    (pcbPrefix(c.lib, 'Capacitor_') && /CP_|Elec/.test(c.part));
  const isL = /^Device:L(_Small)?$/.test(key) || pcbPrefix(c.lib, 'Inductor_');
  if (isR) {
    const v = value('resistance');
    return v
      ? {
          device: { type: 'resistor', resistanceOhm: v, powerRatingW: null },
          pins: num(['p1', 'p2']),
          reason: `${key} → resistor ${c.value}`,
        }
      : { device: null, reason: `resistor value "${c.value}" does not parse` };
  }
  if (isC || isCP) {
    const v = value('capacitance');
    if (!v) return { device: null, reason: `capacitor value "${c.value}" does not parse` };
    return isCP
      ? {
          device: {
            type: 'capacitor',
            capacitanceF: v,
            voltageRatingV: null,
            initialVoltageV: null,
            polarized: true,
          },
          pins: num(['pos', 'neg']),
          reason: `${key} → polarised capacitor ${c.value} (pin 1 = +)`,
        }
      : {
          device: {
            type: 'capacitor',
            capacitanceF: v,
            voltageRatingV: null,
            initialVoltageV: null,
            polarized: false,
          },
          pins: num(['p1', 'p2']),
          reason: `${key} → capacitor ${c.value}`,
        };
  }
  if (isL) {
    const v = value('inductance');
    return v
      ? {
          device: { type: 'inductor', inductanceH: v, currentRatingA: null, initialCurrentA: null },
          pins: num(['p1', 'p2']),
          reason: `${key} → inductor ${c.value}`,
        }
      : { device: null, reason: `inductor value "${c.value}" does not parse` };
  }
  const diodeModel = { saturationCurrentA: 1e-14, emissionCoefficient: 1.8, seriesResistanceOhm: 0.5 };
  if (/^Device:D(_Small)?$/.test(key))
    return {
      device: {
        type: 'diode',
        model: diodeModel,
        maxForwardCurrentA: null,
        maxReverseVoltageV: null,
        preset: 'generic',
      },
      pins: byFunction({ k: /^K$/i, a: /^A$/i }, { k: '1', a: '2' }),
      reason: `${key} → generic diode (KiCad pin 1 = K, 2 = A); model parameters are FORGE generic values`,
    };
  if (/^Device:LED(_Small)?$/.test(key))
    return {
      device: {
        type: 'led',
        model: { saturationCurrentA: 1e-18, emissionCoefficient: 2, seriesResistanceOhm: 5 },
        color: 'red',
        maxForwardCurrentA: 0.02,
        maxReverseVoltageV: 5,
        preset: 'generic-red',
      },
      pins: byFunction({ k: /^K$/i, a: /^A$/i }, { k: '1', a: '2' }),
      reason: `${key} → generic red LED (pin 1 = K, 2 = A); colour and model are FORGE generic values`,
    };
  const bjt = /^Device:Q_NPN_([BCE]{3})$/.exec(key);
  if (bjt) {
    const order = bjt[1]!.toLowerCase().split('');
    return {
      device: { type: 'npn', saturationCurrentA: 1e-14, betaF: 100, betaR: 1, maxCollectorCurrentA: null },
      pins: num(order),
      reason: `${key} → generic NPN (pins ${bjt[1]}); Ebers–Moll parameters are generic`,
    };
  }
  const fet = /^Device:Q_NMOS_([GDS]{3})$/.exec(key);
  if (fet) {
    const order = fet[1]!.toLowerCase().split('');
    return {
      device: {
        type: 'nmos',
        thresholdV: 2,
        transconductanceAPerV2: 0.1,
        lambdaPerV: 0,
        maxDrainCurrentA: null,
      },
      pins: num(order),
      reason: `${key} → generic level-1 NMOS (pins ${fet[1]}); parameters are generic`,
    };
  }
  if (/^Device:Battery(_Cell)?$/.test(key) || /^Simulation_SPICE:VDC$/.test(key)) {
    const v = parseSiValue(c.value.replace(/^dc\s*/i, '').replace(/V$/i, ''));
    return v !== null
      ? {
          device: {
            type: 'vsource',
            waveform: { kind: 'dc', value: v },
            seriesResistanceOhm: 0,
            currentLimitA: null,
            purpose: 'supply',
          },
          pins: num(['pos', 'neg']),
          reason: `${key} → ideal DC source ${v} V (pin 1 = +)`,
        }
      : { device: null, reason: `source value "${c.value}" does not parse as a DC voltage` };
  }
  if (/^MCU_Module:Arduino_UNO_R3$/.test(key)) {
    const r: Record<string, string> = {};
    let g = 0;
    const missing: string[] = [];
    for (const p of pins) {
      const f = p.pinfunction.replace(/^~\{?|\}$/g, '').toUpperCase();
      const dm = /^D(\d{1,2})\b/.exec(f);
      const am = /^A(\d)\b/.exec(f);
      let forge: string | null = null;
      if (dm && Number(dm[1]) <= 13) forge = `D${Number(dm[1])}`;
      else if (am && Number(am[1]) <= 5) forge = `A${am[1]}`;
      else if (/^\+?5V$/.test(f)) forge = '5V';
      else if (/^\+?3V3$|^\+?3\.3V$/.test(f)) forge = '3V3';
      else if (/^VIN$/.test(f)) forge = 'VIN';
      else if (/^IOREF$/.test(f)) forge = 'IOREF';
      else if (/^AREF$/.test(f)) forge = 'AREF';
      else if (/RESET/.test(f)) forge = 'RESET';
      else if (/^GND$/.test(f) && g < 3) forge = `GND.${++g}`;
      if (forge) r[forge] = p.pin;
      else missing.push(`${p.pin}:${p.pinfunction || '?'}`);
    }
    if (missing.length)
      return {
        device: null,
        reason: `Arduino UNO pins not recognised by function name: ${missing.join(', ')}`,
      };
    return {
      device: { type: 'mcu', board: 'arduino-uno-r3', power: 'usb', firmwareId: null },
      pins: r,
      reason: `${key} → Arduino UNO R3 (pins matched by function name)`,
    };
  }
  return { device: null, reason: `no FORGE mapping for symbol ${key || c.footprint || '(unknown)'}` };
}

export function importKicad(
  bytes: Uint8Array,
  kind: 'kicad-netlist' | 'kicad-pcb' | 'kicad-schematic',
  manual: Record<string, ManualMapping> = {},
): KicadImport {
  const r = readDoc(bytes, kind);
  const d = [...r.diagnostics];
  if (!r.doc || d.some((x) => x.severity === 'error'))
    return { ok: false, doc: r.doc, definition: null, mappings: [], connectivity: null, diagnostics: d };
  const doc = r.doc;
  const pinsOf = new Map<string, KicadNode[]>();
  const netOf = new Map<string, string>(); // "ref:pin" → net
  for (const n of doc.nets)
    for (const x of n.nodes) {
      pinsOf.set(x.ref, [...(pinsOf.get(x.ref) ?? []), x]);
      netOf.set(`${x.ref}:${x.pin}`, n.name);
    }
  const groundNet = doc.nets.find((n) => /^\/?GND$|^\/?0$|^\/?GNDD$/i.test(n.name))?.name ?? null;
  const parts: PartSpec[] = [];
  const mappings: ComponentMapping[] = [];
  const seen = new Set<string>();
  for (const c of doc.components) {
    if (!c.ref || c.ref.startsWith('#')) continue; // power flags / virtual symbols
    if (seen.has(c.ref)) {
      d.push(warn('kicad-duplicate-ref', `Duplicate reference ${c.ref}; only the first is used.`));
      continue;
    }
    seen.add(c.ref);
    const pins = pinsOf.get(c.ref) ?? [];
    const m = manual[c.ref];
    let device: Device | null = null;
    let pinMap: Record<string, string> = {};
    let status: ComponentMapping['status'] = 'unmapped';
    let reason: string;
    if (m?.as === 'omit') {
      status = 'omitted';
      reason = 'omitted by the user';
    } else if (m && (m.as === 'resistor' || m.as === 'capacitor' || m.as === 'inductor')) {
      if (pins.length !== 2)
        reason = `manual ${m.as} mapping needs exactly 2 connected pins (has ${pins.length})`;
      else {
        device =
          m.as === 'resistor'
            ? { type: 'resistor', resistanceOhm: m.value, powerRatingW: null }
            : m.as === 'capacitor'
              ? {
                  type: 'capacitor',
                  capacitanceF: m.value,
                  voltageRatingV: null,
                  initialVoltageV: null,
                  polarized: false,
                }
              : { type: 'inductor', inductanceH: m.value, currentRatingA: null, initialCurrentA: null };
        pinMap = { p1: pins[0]!.pin, p2: pins[1]!.pin };
        status = 'manual';
        reason = `manually mapped to ${m.as} ${m.value}`;
      }
    } else if (m?.as === 'device') {
      device = m.device;
      pinMap = m.pins;
      status = 'manual';
      reason = `manually mapped to ${m.device.type}`;
    } else {
      const auto = mapSymbol(c, pins);
      reason = auto.reason;
      if (auto.device) {
        device = auto.device;
        pinMap = auto.pins;
        status = 'mapped';
      }
    }
    mappings.push({ ref: c.ref, status, forgeType: device?.type ?? null, reason, pins: pinMap });
    if (!device) {
      if (status === 'unmapped')
        d.push(
          warn(
            'kicad-unmapped',
            `${c.ref} (${c.lib}:${c.part}, value "${c.value}", footprint "${c.footprint}") was not imported: ${reason}. Map it manually or omit it.`,
          ),
        );
      continue;
    }
    const pinNets: Record<string, string | null> = {};
    for (const [forgePin, kpin] of Object.entries(pinMap))
      pinNets[forgePin] = netOf.get(`${c.ref}:${kpin}`) ?? null;
    const note = [
      `KiCad ${c.lib}:${c.part}`,
      c.footprint ? `footprint ${c.footprint}` : '',
      c.placement
        ? `PCB ${c.placement.side} at (${c.placement.x}, ${c.placement.y}) mm, ${c.placement.rotation}°`
        : '',
    ]
      .filter(Boolean)
      .join('; ');
    parts.push({ label: c.ref, name: `${c.ref} ${c.value}`.trim(), device, pins: pinNets, note });
  }
  const unmapped = mappings.filter((m) => m.status === 'unmapped');
  if (!parts.length) d.push(err('kicad-empty', 'No component could be mapped to a FORGE part.'));
  if (!groundNet)
    d.push(
      warn(
        'kicad-ground',
        'No GND net found: the circuit has no reference node (analog analysis needs one).',
      ),
    );
  if (d.some((x) => x.severity === 'error'))
    return { ok: false, doc, definition: null, mappings, connectivity: null, diagnostics: d };
  const built = buildDefinition(
    doc.source
      ?.split(/[\\/]/)
      .pop()
      ?.replace(/\.\w+$/, '') ?? 'KiCad import',
    parts,
    groundNet,
  );
  d.push(...built.diagnostics);
  if (!built.def) return { ok: false, doc, definition: null, mappings, connectivity: null, diagnostics: d };
  // Expected connectivity: each net's terminals on IMPORTED parts.
  const expected = new Map<string, { label: string; pin: string }[]>();
  for (const p of parts)
    for (const [forgePin, net] of Object.entries(p.pins))
      if (net) expected.set(net, [...(expected.get(net) ?? []), { label: p.label, pin: forgePin }]);
  if (groundNet) expected.set(groundNet, [...(expected.get(groundNet) ?? []), { label: 'GND', pin: 'gnd' }]);
  const connectivity = verifyConnectivity(built.def, expected);
  if (!connectivity.ok) d.push(...connectivity.problems.map((m) => err('connectivity', m)));
  else
    d.push(
      info(
        'connectivity',
        `Connectivity verified: ${connectivity.nets} nets, ${connectivity.terminals} terminals of imported parts identical to the KiCad source${unmapped.length ? ` (${unmapped.length} unmapped component(s) excluded)` : ''}.`,
      ),
    );
  return {
    ok: !d.some((x) => x.severity === 'error'),
    doc,
    definition: built.def,
    mappings,
    connectivity,
    diagnostics: d,
  };
}
