import { electricalModelFor, type CatalogPin } from '@forge/components';
import {
  devicePins,
  type DevicePin,
  type ElectricalDefinition,
  type ElectricalPart,
  type SceneGraph,
} from '@forge/engineering-core';
import type { OperatingPoint } from './analog/circuit';
import type { Netlist } from './netlist';

/**
 * Electrical design-rule checks (ERC/DRC). Each rule draws only the conclusion its data
 * supports: a missing rating yields an explicit "unknown", never a pass. Passing every rule
 * is NOT evidence that a circuit is safe or certified — the rules are listed in
 * docs/ELECTRICAL_ARCHITECTURE.md together with what they do not cover.
 */
export const DRC_DISCLAIMER =
  'Design-rule checks cover only the listed rules with the ratings that are known. Passing them does not show that a circuit is safe, and FORGE does not certify electrical designs.';

export type RuleSeverity = 'error' | 'warning' | 'info';
export interface RuleIssue {
  code:
    | 'missing-ground'
    | 'implicit-ground'
    | 'unconnected-power'
    | 'floating-input'
    | 'supply-short'
    | 'supply-conflict'
    | 'voltage-domain'
    | 'unknown-rating'
    | 'output-contention'
    | 'missing-current-limit'
    | 'incomplete-ground'
    | 'unpowered-controller'
    | 'controller-rail-load'
    | 'missing-parameter'
    | 'dangling-link'
    | 'overvoltage'
    | 'overcurrent'
    | 'dissipation'
    | 'reverse-polarity'
    | 'supply-mismatch';
  severity: RuleSeverity;
  message: string;
  parts: string[];
  nets: string[];
  /** structural: from topology and ratings; solved: from a DC operating point. */
  basis: 'structural' | 'solved';
}

export interface PinInfo extends DevicePin {
  nominalV: number | null;
  vmax: number | null;
  vmin: number | null;
  imax: number | null;
  limitSource: string | null;
}

/** Pin metadata: the catalogue's (with sources) when the part has a catalogue model, else the device's. */
export function pinInfos(part: ElectricalPart): PinInfo[] {
  const model = part.definitionId ? electricalModelFor(part.definitionId) : null;
  const fromCatalog = new Map<string, CatalogPin>(
    model && model.device.type === part.device.type ? model.pins.map((p) => [p.id, p]) : [],
  );
  const d = part.device;
  return devicePins(d).map((pin) => {
    const c = fromCatalog.get(pin.id);
    if (c)
      return {
        ...pin,
        nominalV: c.nominalV,
        vmax: c.voltage?.max ?? null,
        vmin: c.voltage?.min ?? null,
        imax: c.current?.max ?? null,
        limitSource: c.voltage?.source ?? c.current?.source ?? null,
      };
    let nominalV: number | null = null;
    if (d.type === 'vsource' && pin.id === 'pos' && d.waveform.kind === 'dc') nominalV = d.waveform.value;
    if (d.type === 'vsource' && pin.id === 'neg') nominalV = 0;
    if (
      (d.type === 'logic-gate' || d.type === 'dff' || d.type === 'counter' || d.type === 'clock') &&
      pin.direction === 'output'
    )
      nominalV = d.logicV;
    if (pin.role === 'ground') nominalV = 0;
    if (d.type === 'mcu') nominalV = pin.id === '3V3' ? 3.3 : pin.role === 'ground' ? 0 : 5;
    return { ...pin, nominalV, vmax: null, vmin: null, imax: null, limitSource: null };
  });
}

const ANALOG_IMPEDANCE = new Set(['resistor', 'potentiometer', 'inductor', 'switch', 'limit-switch']);
const PULL_CAPABLE = new Set([
  'resistor',
  'potentiometer',
  'capacitor',
  'inductor',
  'switch',
  'limit-switch',
  'diode',
  'led',
  'npn',
  'nmos',
  'vcvs',
  'vccs',
  'isource',
  'vsource',
]);

export function structuralChecks(def: ElectricalDefinition, nl: Netlist, scene?: SceneGraph): RuleIssue[] {
  const out: RuleIssue[] = [];
  const add = (i: Omit<RuleIssue, 'basis'>) => out.push({ ...i, basis: 'structural' });
  const infos = new Map(def.parts.map((p) => [p.id, new Map(pinInfos(p).map((i) => [i.id, i]))]));
  const info = (partId: string, pin: string) => infos.get(partId)?.get(pin);
  const label = (id: string) => nl.partById.get(id)?.label ?? id;
  const netName = (n: number | undefined) => (n === undefined ? '?' : nl.nets[n]!.name);
  const wiredParts = new Set(
    def.wires.flatMap((w) => [w.a.partId, w.b.partId]).concat(def.netLabels.map((l) => l.pin.partId)),
  );

  if (def.parts.length && nl.ground < 0 && def.parts.some((p) => PULL_CAPABLE.has(p.device.type)))
    add({ code: 'missing-ground', severity: 'error', message: nl.groundNote, parts: [], nets: [] });
  else if (nl.groundSource === 'implicit')
    add({
      code: 'implicit-ground',
      severity: 'info',
      message: nl.groundNote,
      parts: [],
      nets: [nl.nets[nl.ground]!.name],
    });

  const mcus = def.parts.filter((p) => p.device.type === 'mcu');
  for (const part of def.parts) {
    const d = part.device;
    const pins = [...infos.get(part.id)!.values()];
    // Power pins of an active device that is otherwise wired.
    if (wiredParts.has(part.id) && ['hc-sr04', 'servo', 'encoder', 'temp-sensor'].includes(d.type))
      for (const p of pins.filter((x) => x.role === 'supply' || x.role === 'ground')) {
        const n = nl.pinNet(part.id, p.id)!;
        if (nl.nets[n]!.partCount === 1 && !nl.nets[n]!.isGround)
          add({
            code: 'unconnected-power',
            severity: 'error',
            message: `${part.label} ${p.name} is not connected: the device is unpowered or has no reference.`,
            parts: [part.id],
            nets: [],
          });
      }
    // Floating digital inputs (nothing on the net can drive or pull it). The UNO's own pins are
    // excluded: their modes are set by firmware (floating READS are flagged at runtime) and RESET
    // has an on-board pull-up.
    for (const p of pins.filter(
      (x) => x.direction === 'input' && x.domain === 'digital' && d.type !== 'mcu',
    )) {
      const n = nl.pinNet(part.id, p.id)!;
      const net = nl.nets[n]!;
      const driven = net.pins.some((np) => {
        if (np.partId === part.id && np.pin === p.id) return false;
        const other = nl.partById.get(np.partId)!;
        const oi = info(np.partId, np.pin);
        return (
          PULL_CAPABLE.has(other.device.type) ||
          oi?.direction === 'output' ||
          oi?.direction === 'bidirectional' ||
          oi?.direction === 'power-out' ||
          net.isGround
        );
      });
      if (!driven && wiredParts.has(part.id))
        add({
          code: 'floating-input',
          severity: 'warning',
          message: `${part.label} ${p.name} is floating: nothing on net ${net.name} drives or pulls it, so its logic level is undefined.`,
          parts: [part.id],
          nets: [net.name],
        });
    }
    // Missing parameters / links that a simulation needs.
    if (d.type === 'hc-sr04' && !part.nodeId)
      add({
        code: 'missing-parameter',
        severity: 'warning',
        message: `${part.label} is not placed in 3D: without a mounting pose it cannot measure distance (it reports no echo).`,
        parts: [part.id],
        nets: [],
      });
    if (d.type === 'servo' && !d.mateId)
      add({
        code: 'missing-parameter',
        severity: 'info',
        message: `${part.label} is not linked to a joint: its control pulses are decoded but move nothing.`,
        parts: [part.id],
        nets: [],
      });
    if (d.type === 'mcu' && !d.firmwareId)
      add({
        code: 'missing-parameter',
        severity: 'info',
        message: `${part.label} has no firmware assigned.`,
        parts: [part.id],
        nets: [],
      });
    if (scene && part.nodeId && !scene.nodes[part.nodeId])
      add({
        code: 'dangling-link',
        severity: 'warning',
        message: `${part.label} is linked to a 3D component that no longer exists.`,
        parts: [part.id],
        nets: [],
      });
    if (scene && (d.type === 'servo' || d.type === 'encoder') && d.mateId && !mateExists(scene, d.mateId))
      add({
        code: 'dangling-link',
        severity: 'warning',
        message: `${part.label} is linked to joint "${d.mateId}", which does not exist.`,
        parts: [part.id],
        nets: [],
      });
    // Supply shorts across the device's own voltage-defining terminals.
    const pairs: [string, string][] =
      d.type === 'vsource'
        ? [['pos', 'neg']]
        : d.type === 'mcu' && d.power === 'usb'
          ? [
              ['5V', 'GND'],
              ['3V3', 'GND'],
            ]
          : [];
    for (const [a, b] of pairs)
      if (
        nl.terminalNet(part.id, a) === nl.terminalNet(part.id, b) &&
        (d.type !== 'vsource' || d.waveform.kind !== 'dc' || d.waveform.value !== 0)
      )
        add({
          code: 'supply-short',
          severity: 'error',
          message: `${part.label}: ${a} and ${b} are on the same net (${netName(nl.terminalNet(part.id, a))}) — a direct short across a supply.`,
          parts: [part.id],
          nets: [netName(nl.terminalNet(part.id, a))],
        });
    // LEDs without a series current-limiting element.
    if (d.type === 'led') {
      const hard = (n: number) =>
        nl.nets[n]!.isGround ||
        nl.nets[n]!.pins.some((np) => {
          const oi = info(np.partId, np.pin);
          return (
            (np.partId !== part.id &&
              (oi?.role === 'supply' ||
                oi?.direction === 'output' ||
                oi?.direction === 'power-out' ||
                oi?.role === 'gpio' ||
                oi?.role === 'pwm')) ??
            false
          );
        });
      const limited = (n: number) =>
        nl.nets[n]!.pins.some(
          (np) => np.partId !== part.id && ANALOG_IMPEDANCE.has(nl.partById.get(np.partId)!.device.type),
        );
      const a = nl.pinNet(part.id, 'a')!;
      const k = nl.pinNet(part.id, 'k')!;
      if (hard(a) && hard(k) && !limited(a) && !limited(k))
        add({
          code: 'missing-current-limit',
          severity: 'warning',
          message: `${part.label} sits directly between driven nets with no series resistor: its current is limited only by the sources.`,
          parts: [part.id],
          nets: [netName(a), netName(k)],
        });
    }
  }

  // Per-net source conflicts, voltage domains and output contention.
  for (const net of nl.nets) {
    const srcs = net.pins
      .map((np) => ({ np, i: info(np.partId, np.pin)! }))
      .filter(
        ({ i }) =>
          i &&
          i.nominalV !== null &&
          (i.direction === 'power-out' || (i.role === 'supply' && i.direction !== 'power-in')) &&
          i.role !== 'ground',
      );
    const levels = new Set(srcs.map((s) => s.i.nominalV));
    if (levels.size > 1)
      add({
        code: 'supply-conflict',
        severity: 'error',
        message: `Net ${net.name} ties supplies at different voltages together (${srcs.map((s) => `${label(s.np.partId)} ${s.i.name} ${s.i.nominalV} V`).join(', ')}).`,
        parts: [...new Set(srcs.map((s) => s.np.partId))],
        nets: [net.name],
      });
    const outputs = net.pins.filter((np) => {
      const i = info(np.partId, np.pin);
      return i?.direction === 'output' && i.domain === 'digital';
    });
    if (outputs.length > 1)
      add({
        code: 'output-contention',
        severity: 'warning',
        message: `Net ${net.name} has ${outputs.length} push-pull outputs (${outputs.map((o) => `${label(o.partId)} ${o.pin}`).join(', ')}): they contend whenever they drive different levels.`,
        parts: [...new Set(outputs.map((o) => o.partId))],
        nets: [net.name],
      });
    // Levels on the net vs ratings of its pins (structural, from nominal levels).
    const highest = Math.max(
      ...net.pins.map((np) => {
        const i = info(np.partId, np.pin);
        return i &&
          i.nominalV !== null &&
          (i.direction === 'output' ||
            i.direction === 'power-out' ||
            i.role === 'supply' ||
            i.direction === 'bidirectional') &&
          i.role !== 'ground'
          ? i.nominalV
          : -Infinity;
      }),
    );
    if (Number.isFinite(highest) && highest > 0)
      for (const np of net.pins) {
        const i = info(np.partId, np.pin);
        if (!i || i.role === 'ground' || i.role === 'passive') continue;
        if (i.vmax !== null && highest > i.vmax + 1e-9)
          add({
            code: 'voltage-domain',
            severity: 'error',
            message: `${label(np.partId)} ${i.name} (rated ≤ ${i.vmax} V${i.limitSource ? `, ${i.limitSource}` : ''}) is on net ${net.name}, which carries ${highest} V.`,
            parts: [np.partId],
            nets: [net.name],
          });
        else if (i.vmax === null && (i.direction === 'input' || i.direction === 'power-in'))
          add({
            code: 'unknown-rating',
            severity: 'info',
            message: `${label(np.partId)} ${i.name}: no known voltage rating, so the ${highest} V level on net ${net.name} cannot be checked.`,
            parts: [np.partId],
            nets: [net.name],
          });
      }
  }

  // Controllers: power and shared ground with the devices they talk to.
  for (const mcu of mcus) {
    const d = mcu.device;
    if (d.type !== 'mcu') continue;
    const gnd = nl.terminalNet(mcu.id, 'GND')!;
    const v5 = nl.terminalNet(mcu.id, '5V')!;
    if (d.power === 'external') {
      const powered = [v5, nl.terminalNet(mcu.id, 'VIN')!].some((n) =>
        nl.nets[n]!.pins.some(
          (np) =>
            np.partId !== mcu.id &&
            info(np.partId, np.pin)?.direction === 'power-out' &&
            info(np.partId, np.pin)?.role === 'supply',
        ),
      );
      if (!powered)
        add({
          code: 'unpowered-controller',
          severity: 'warning',
          message: `${mcu.label} is set to external power but nothing supplies its 5V or VIN pin: its firmware will not run.`,
          parts: [mcu.id],
          nets: [],
        });
    }
    const signalNets = new Set(
      ['D', 'A'].flatMap((x) =>
        Array.from({ length: x === 'D' ? 14 : 6 }, (_, i) => nl.pinNet(mcu.id, `${x}${i}`)!),
      ),
    );
    for (const part of def.parts) {
      if (part.id === mcu.id) continue;
      const pins = pinInfos(part);
      const talks = pins.some(
        (p) =>
          p.role !== 'ground' &&
          p.role !== 'supply' &&
          signalNets.has(nl.pinNet(part.id, p.id)!) &&
          nl.nets[nl.pinNet(part.id, p.id)!]!.partCount > 1,
      );
      const g = pins.find((p) => p.role === 'ground');
      if (talks && g && nl.pinNet(part.id, g.id) !== gnd)
        add({
          code: 'incomplete-ground',
          severity: 'error',
          message: `${part.label} exchanges signals with ${mcu.label} but its ${g.name} is not on ${mcu.label}'s ground: the signals have no common reference.`,
          parts: [part.id, mcu.id],
          nets: [netName(nl.pinNet(part.id, g.id)), netName(gnd)],
        });
    }
    const servosOnRail = def.parts.filter(
      (p) => p.device.type === 'servo' && nl.pinNet(p.id, 'vplus') === v5,
    );
    if (servosOnRail.length)
      add({
        code: 'controller-rail-load',
        severity: 'warning',
        message: `${servosOnRail.map((s) => s.label).join(', ')} ${servosOnRail.length > 1 ? 'are' : 'is'} powered from ${mcu.label}'s 5 V rail${d.power === 'usb' ? ' (USB: the board’s polyfuse is rated 500 mA)' : ''}. Servo current is unknown, so the supply cannot be checked; servos — especially several or high-torque ones — normally need a separate supply with a shared ground.`,
        parts: [...servosOnRail.map((s) => s.id), mcu.id],
        nets: [netName(v5)],
      });
  }
  return out;
}

function mateExists(scene: SceneGraph, mateId: string): boolean {
  for (const n of Object.values(scene.nodes))
    if (n.kind === 'assembly' && n.mechanical.mates.some((m) => m.id === mateId)) return true;
  return false;
}

/** Rules that need a DC operating point (voltages and currents). */
export function solvedChecks(def: ElectricalDefinition, nl: Netlist, op: OperatingPoint): RuleIssue[] {
  const out: RuleIssue[] = [];
  const add = (i: Omit<RuleIssue, 'basis'>) => out.push({ ...i, basis: 'solved' });
  const v = (n: number | undefined) => (n === undefined ? null : n === nl.ground ? 0 : op.v[n]);
  const fmt = (x: number, unit: string) =>
    `${Math.abs(x) >= 1 ? x.toFixed(3) : (x * 1000).toFixed(2) + ' m'}${Math.abs(x) >= 1 ? ' ' + unit : unit}`;
  const unknownLoads = def.parts.filter((p) => p.device.type === 'servo').map((p) => p.label);
  for (const part of def.parts) {
    const d = part.device;
    const pins = pinInfos(part);
    for (const p of pins) {
      const n = nl.pinNet(part.id, p.id);
      const vv = v(n);
      if (vv === null || vv === undefined) continue;
      if (p.vmax !== null && p.role !== 'ground' && vv > p.vmax + 0.05)
        add({
          code: 'overvoltage',
          severity: 'error',
          message: `${part.label} ${p.name} is at ${vv.toFixed(2)} V, above its ${p.vmax} V rating${p.limitSource ? ` (${p.limitSource})` : ''}.`,
          parts: [part.id],
          nets: [nl.nets[n!]!.name],
        });
    }
    if (d.type === 'resistor') {
      const i = op.i.get(part.label);
      if (i !== undefined) {
        const pw = i * i * d.resistanceOhm;
        if (d.powerRatingW !== null && pw > d.powerRatingW)
          add({
            code: 'dissipation',
            severity: 'warning',
            message: `${part.label} dissipates ${pw.toFixed(3)} W, above its ${d.powerRatingW} W rating.`,
            parts: [part.id],
            nets: [],
          });
      }
    }
    if (d.type === 'led' || d.type === 'diode') {
      const i = op.i.get(part.label) ?? 0;
      if (d.maxForwardCurrentA !== null && i > d.maxForwardCurrentA)
        add({
          code: 'overcurrent',
          severity: 'error',
          message: `${part.label} forward current ${fmt(i, 'A')} exceeds its ${fmt(d.maxForwardCurrentA, 'A')} rating.`,
          parts: [part.id],
          nets: [],
        });
      else if (d.maxForwardCurrentA === null && i > 0.03)
        add({
          code: 'unknown-rating',
          severity: 'warning',
          message: `${part.label} conducts ${fmt(i, 'A')}; its current rating is unknown, so this cannot be checked (typical indicator LEDs are rated in the tens of mA).`,
          parts: [part.id],
          nets: [],
        });
    }
    if (d.type === 'capacitor' && d.polarized) {
      const vp = v(nl.pinNet(part.id, 'pos'));
      const vn = v(nl.pinNet(part.id, 'neg'));
      if (vp !== null && vn !== null && vp !== undefined && vn !== undefined && vp - vn < -0.5)
        add({
          code: 'reverse-polarity',
          severity: 'error',
          message: `${part.label} (polarised) is reverse-biased by ${(vn - vp).toFixed(2)} V.`,
          parts: [part.id],
          nets: [],
        });
    }
    if (d.type === 'servo' || d.type === 'hc-sr04') {
      const [vpin, gpin] = d.type === 'servo' ? ['vplus', 'gnd'] : ['vcc', 'gnd'];
      const vs = v(nl.pinNet(part.id, vpin));
      const vg = v(nl.pinNet(part.id, gpin));
      if (vs === null || vg === null || vs === undefined || vg === undefined) continue;
      const supply = vs - vg;
      const [lo, hi] = d.type === 'servo' ? [d.minSupplyV, d.maxSupplyV] : [4.5, 5.5];
      if (supply < lo - 1e-6 || supply > hi + 1e-6)
        add({
          code: 'supply-mismatch',
          severity: supply > hi ? 'error' : 'warning',
          message: `${part.label} is supplied with ${supply.toFixed(2)} V; its model accepts ${lo}–${hi} V${d.type === 'hc-sr04' ? ' (assumption: ±10 % around the cited 5 V)' : ''}.`,
          parts: [part.id],
          nets: [],
        });
    }
    if (d.type === 'mcu') {
      // GPIO driver currents (drivers are named "<label>:<pin>:drv" by the co-simulation).
      for (const [id, i] of op.i)
        if (id.startsWith(`${part.label}:`) && id.endsWith(':drv') && Math.abs(i) > 0.02 + 1e-9)
          add({
            code: 'overcurrent',
            severity: 'warning',
            message: `${part.label} pin ${id.split(':')[1]} sources/sinks ${fmt(Math.abs(i), 'A')}, above the 20 mA per-pin DC rating (Arduino UNO R3 documentation).`,
            parts: [part.id],
            nets: [],
          });
      const i5 = op.i.get(`${part.label}:5V`);
      if (i5 !== undefined && -i5 > 0.5)
        add({
          code: 'overcurrent',
          severity: 'error',
          message: `${part.label} 5 V rail supplies ${fmt(-i5, 'A')}, above the 500 mA USB polyfuse rating.`,
          parts: [part.id],
          nets: [],
        });
      const i33 = op.i.get(`${part.label}:3V3`);
      if (i33 !== undefined && -i33 > 0.05)
        add({
          code: 'overcurrent',
          severity: 'warning',
          message: `${part.label} 3.3 V pin supplies ${fmt(-i33, 'A')}, above its 50 mA rating (Arduino UNO R3 documentation).`,
          parts: [part.id],
          nets: [],
        });
      if (i5 !== undefined && unknownLoads.length)
        add({
          code: 'unknown-rating',
          severity: 'info',
          message: `${part.label} 5 V load computed as ${fmt(Math.max(0, -i5), 'A')} excludes devices with unknown current (${unknownLoads.join(', ')}): the real load is higher.`,
          parts: [part.id],
          nets: [],
        });
    }
  }
  return out;
}
