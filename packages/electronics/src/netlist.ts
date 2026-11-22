import {
  devicePins,
  type DevicePin,
  type ElectricalDefinition,
  type ElectricalPart,
  type PinRef,
} from '@forge/engineering-core';

/**
 * Netlist compiler: turns the persisted electrical definition into NETS — sets of device
 * terminals that are electrically one node. Connectivity comes ONLY from explicit
 * relationships: wires, shared net labels, junction parts, ground symbols and a device's own
 * internal terminals (e.g. the UNO's three GND pins). Schematic or 3D positions are never
 * consulted, so moving a part can never connect or disconnect it.
 */
export interface NetPin {
  partId: string;
  pin: string;
  terminal: string;
}

export interface Net {
  index: number;
  /** Label name, "GND" for the reference, or an automatic "Net-(R1-p1)" name. */
  name: string;
  /** True when the name comes from a net label (or the ground symbol). */
  named: boolean;
  isGround: boolean;
  pins: NetPin[];
  /** Number of distinct parts on the net. */
  partCount: number;
}

export interface Netlist {
  nets: Net[];
  /** Index of the reference (0 V) net, or -1 when there is none. */
  ground: number;
  /** How the reference was chosen. */
  groundSource: 'symbol' | 'implicit' | 'none';
  groundNote: string;
  parts: ElectricalPart[];
  partById: Map<string, ElectricalPart>;
  /** Net of a part's terminal (by terminal id). */
  terminalNet(partId: string, terminal: string): number | undefined;
  /** Net of a part's pin (by pin id). */
  pinNet(partId: string, pin: string): number | undefined;
  pinsOf(partId: string): DevicePin[];
  netByName(name: string): Net | undefined;
}

const key = (partId: string, terminal: string) => `${partId}\u0000${terminal}`;

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let r = this.parent.get(x) ?? x;
    if (r !== x) {
      r = this.find(r);
      this.parent.set(x, r);
    }
    return r;
  }
  add(x: string) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

export function compileNetlist(def: ElectricalDefinition): Netlist {
  const uf = new UnionFind();
  const pinTables = new Map<string, DevicePin[]>();
  const terminalOf = new Map<string, string>(); // key(part, pin) → key(part, terminal)
  const GROUND = '\u0000GND';
  let hasSymbol = false;
  for (const part of def.parts) {
    const pins = devicePins(part.device);
    pinTables.set(part.id, pins);
    for (const p of pins) {
      const t = key(part.id, p.terminal);
      uf.add(t);
      terminalOf.set(key(part.id, p.id), t);
    }
    if (part.device.type === 'ground') {
      hasSymbol = true;
      uf.add(GROUND);
      uf.union(GROUND, key(part.id, 'gnd'));
    }
  }
  const term = (r: PinRef) => terminalOf.get(key(r.partId, r.pin));
  for (const w of def.wires) {
    const a = term(w.a);
    const b = term(w.b);
    if (a && b) uf.union(a, b);
  }
  const byLabel = new Map<string, string>();
  const labelOfTerm = new Map<string, string[]>();
  for (const l of def.netLabels) {
    const t = term(l.pin);
    if (!t) continue;
    const prev = byLabel.get(l.name);
    if (prev) uf.union(prev, t);
    else byLabel.set(l.name, t);
    labelOfTerm.set(t, [...(labelOfTerm.get(t) ?? []), l.name]);
  }

  // Group terminals into nets.
  const groups = new Map<string, NetPin[]>();
  for (const part of def.parts)
    for (const p of pinTables.get(part.id)!) {
      const root = uf.find(key(part.id, p.terminal));
      const list = groups.get(root) ?? [];
      list.push({ partId: part.id, pin: p.id, terminal: p.terminal });
      groups.set(root, list);
    }
  const labelsOfRoot = new Map<string, Set<string>>();
  for (const [t, names] of labelOfTerm) {
    const root = uf.find(t);
    const s = labelsOfRoot.get(root) ?? new Set<string>();
    names.forEach((n) => s.add(n));
    labelsOfRoot.set(root, s);
  }
  const groundRoot = hasSymbol ? uf.find(GROUND) : null;
  const partById = new Map(def.parts.map((p) => [p.id, p]));
  const pinName = (np: NetPin) => {
    const part = partById.get(np.partId)!;
    return `${part.label}-${np.pin}`;
  };
  const nets: Net[] = [];
  const netOfRoot = new Map<string, number>();
  // Deterministic order: by the smallest "label-pin" name on the net.
  const entries = [...groups.entries()].map(([root, pins]) => ({
    root,
    pins: pins.sort((x, y) => pinName(x).localeCompare(pinName(y))),
  }));
  entries.sort((x, y) => pinName(x.pins[0]!).localeCompare(pinName(y.pins[0]!)));
  for (const { root, pins } of entries) {
    const labels = [...(labelsOfRoot.get(root) ?? [])].sort();
    const isGround = root === groundRoot;
    const index = nets.length;
    nets.push({
      index,
      name: isGround ? 'GND' : (labels[0] ?? `Net-(${pinName(pins[0]!)})`),
      named: isGround || labels.length > 0,
      isGround,
      pins,
      partCount: new Set(pins.map((p) => p.partId)).size,
    });
    netOfRoot.set(root, index);
  }

  // Reference: the ground symbol's net; otherwise (documented) the first supply's negative
  // terminal or the controller's GND — reported so the user knows what 0 V means.
  let ground = -1;
  let groundSource: Netlist['groundSource'] = 'none';
  let groundNote = 'No ground reference: place a ground symbol (or a supply/controller GND).';
  if (groundRoot) {
    ground = netOfRoot.get(groundRoot)!;
    groundSource = 'symbol';
    groundNote = 'Reference (0 V): the ground symbol’s net.';
  } else {
    const candidate =
      def.parts.find((p) => p.device.type === 'mcu') ??
      def.parts.find((p) => p.device.type === 'vsource' && p.device.purpose === 'supply') ??
      def.parts.find((p) => p.device.type === 'vsource');
    if (candidate) {
      const t = candidate.device.type === 'mcu' ? 'GND' : 'neg';
      ground = netOfRoot.get(uf.find(key(candidate.id, t)))!;
      groundSource = 'implicit';
      groundNote = `No ground symbol: ${candidate.label} ${t === 'GND' ? 'GND' : '−'} is used as the 0 V reference.`;
    }
  }
  if (ground >= 0) {
    nets[ground]!.isGround = true;
    if (!nets[ground]!.named) nets[ground]!.name = 'GND';
  }

  const terminalNet = (partId: string, terminal: string) => {
    const t = key(partId, terminal);
    return netOfRoot.get(uf.find(t));
  };
  const pinNet = (partId: string, pin: string) => {
    const t = terminalOf.get(key(partId, pin));
    return t ? netOfRoot.get(uf.find(t)) : undefined;
  };
  const byName = new Map(nets.map((n) => [n.name, n]));
  return {
    nets,
    ground,
    groundSource,
    groundNote,
    parts: def.parts,
    partById,
    terminalNet,
    pinNet,
    pinsOf: (partId) => pinTables.get(partId) ?? [],
    netByName: (name) => byName.get(name),
  };
}

/** Stable short hash of a value (FNV-1a over its JSON) — identifies circuit/firmware revisions. */
export function hashOf(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
