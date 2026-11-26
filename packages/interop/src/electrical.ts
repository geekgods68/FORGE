import { compileNetlist } from '@forge/electronics';
import {
  defaultElectricalDefinition,
  ElectricalDefinitionSchema,
  type Device,
  type ElectricalDefinition,
  type ElectricalPart,
} from '@forge/engineering-core';
import { err, type Diagnostic } from './schemas';

/**
 * Shared helpers for electrical imports (SPICE, KiCad): SI value parsing, construction of a
 * FORGE electrical definition from explicit node connectivity, and an independent check
 * that the compiled FORGE netlist has EXACTLY the source's connectivity.
 */

/** SPICE/KiCad value with SI suffix: 4k7 → 4700, 10u → 1e-5, 1meg → 1e6, 2.2µF → 2.2e-6. */
export function parseSiValue(raw: string): number | null {
  const s = raw.trim().replace(/[Ωω]/g, '').replace(/µ/g, 'u');
  // "4k7" style (R notation): digit, multiplier letter, digits.
  const rn = /^(\d+)([RKMUNPG]|MEG)(\d+)$/i.exec(s);
  if (rn) {
    const k = SUFFIX[rn[2]!.toUpperCase() === 'R' ? '' : rn[2]!.toUpperCase()];
    if (k !== undefined) return scale(Number(`${rn[1]}.${rn[3]}`), k);
  }
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(MEG|MIL|[TGKMUNPF]?)([A-Za-z]*)$/i.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  const k = SUFFIX[m[2]!.toUpperCase()];
  if (!Number.isFinite(v) || k === undefined) return null;
  return scale(v, k);
}
/** v·k, computed as v / (1/k) for sub-unit prefixes so 100n is exactly the double nearest 1e-7. */
function scale(v: number, k: number): number {
  if (k >= 1) return v * k;
  const inv = Math.round(1 / k);
  return Math.abs(inv * k - 1) < 1e-12 ? v / inv : v * k;
}
const SUFFIX: Record<string, number> = {
  '': 1,
  T: 1e12,
  G: 1e9,
  MEG: 1e6,
  K: 1e3,
  M: 1e-3, // SPICE: M is milli
  MIL: 25.4e-6,
  U: 1e-6,
  N: 1e-9,
  P: 1e-12,
  F: 1e-15,
};

export interface PartSpec {
  label: string;
  name?: string;
  device: Device;
  /** Device pin → source node name (null = not connected). */
  pins: Record<string, string | null>;
  note?: string;
}

/**
 * Build a definition: one ground part for the reference node, every other node expressed
 * with net labels on the pins (FORGE connects pins carrying the same label).
 */
export function buildDefinition(
  name: string,
  parts: PartSpec[],
  groundNode: string | null,
): { def: ElectricalDefinition | null; diagnostics: Diagnostic[] } {
  const def = defaultElectricalDefinition(name.slice(0, 200) || 'Imported circuit');
  const used = new Set<string>();
  const uniqueLabel = (l: string) => {
    let base = l.replace(/[^\w.+-]/g, '_').slice(0, 60) || 'P';
    while (used.has(base)) base = `${base}_`;
    used.add(base);
    return base;
  };
  let n = 0;
  // Part ids equal the (unique) source designators, so research parameter targets such as
  // electrical.part.R1.resistanceOhm read naturally.
  const part = (spec: Omit<PartSpec, 'pins'>): ElectricalPart => {
    const i = n++;
    const label = uniqueLabel(spec.label);
    return {
      id: label,
      label,
      name: (spec.name ?? spec.label).slice(0, 200),
      device: spec.device,
      definitionId: null,
      nodeId: null,
      schematic: { x: (i % 8) * 12, y: Math.floor(i / 8) * 10, rotation: 0 },
      note: (spec.note ?? '').slice(0, 2000),
    };
  };
  const labels: ElectricalDefinition['netLabels'] = [];
  // FORGE net names allow letters, digits and _ + - . / $ #; each source node keeps a
  // UNIQUE sanitised name so two different nets can never be merged by renaming.
  const names = new Map<string, string>();
  const taken = new Set<string>(['GND']);
  const netName = (node: string) => {
    if (node === groundNode) return 'GND';
    const hit = names.get(node);
    if (hit) return hit;
    let base =
      node
        .replace(/[^A-Za-z0-9_+\-./$#]/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 56) || 'N';
    if (base === 'GND') base = 'GND_';
    let name = base;
    for (let k = 2; taken.has(name); k++) name = `${base}_${k}`;
    taken.add(name);
    names.set(node, name);
    return name;
  };
  if (groundNode !== null) {
    const g = part({ label: 'GND', device: { type: 'ground' } });
    def.parts.push(g);
    labels.push({ id: `l${labels.length + 1}`, name: 'GND', pin: { partId: g.id, pin: 'gnd' } });
  }
  for (const s of parts) {
    const p = part(s);
    def.parts.push(p);
    for (const [pin, node] of Object.entries(s.pins))
      if (node !== null)
        labels.push({ id: `l${labels.length + 1}`, name: netName(node), pin: { partId: p.id, pin } });
  }
  def.netLabels = labels;
  const v = ElectricalDefinitionSchema.safeParse(def);
  if (!v.success)
    return {
      def: null,
      diagnostics: v.error.issues
        .slice(0, 20)
        .map((i) => err('invalid-circuit', `${i.path.join('.')}: ${i.message}`)),
    };
  return { def: v.data, diagnostics: [] };
}

/**
 * Independent connectivity check: compile the FORGE definition and compare its net
 * partition of (part label, pin) terminals with the source's node → terminals map.
 */
export function verifyConnectivity(
  def: ElectricalDefinition,
  source: Map<string, { label: string; pin: string }[]>,
): { ok: boolean; nets: number; terminals: number; problems: string[] } {
  const nl = compileNetlist(def);
  const byLabel = new Map(def.parts.map((p) => [p.label, p.id]));
  const problems: string[] = [];
  let terminals = 0;
  const netOf = new Map<number, string>();
  for (const [node, pins] of source) {
    const nets = new Set<number>();
    for (const t of pins) {
      terminals++;
      const id = byLabel.get(t.label);
      const net = id ? nl.terminalNet(id, t.pin) : undefined;
      if (net === undefined) problems.push(`${t.label}.${t.pin} (node ${node}) is not connected in FORGE.`);
      else nets.add(net);
    }
    if (nets.size > 1) problems.push(`Source node ${node} is split across ${nets.size} FORGE nets.`);
    for (const x of nets) {
      const prev = netOf.get(x);
      if (prev !== undefined && prev !== node)
        problems.push(`Source nodes ${prev} and ${node} are merged in FORGE.`);
      netOf.set(x, node);
    }
  }
  return { ok: problems.length === 0, nets: source.size, terminals, problems };
}
