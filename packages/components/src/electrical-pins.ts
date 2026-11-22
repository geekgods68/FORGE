import { devicePins, type Device, type DevicePin } from '@forge/engineering-core';
import { getDefinition } from './catalog';
import { evaluate, resolveParameters } from './evaluate';
import type { ComponentInterface, DataStatus, ParamValues } from './schemas';

/**
 * Electrical pin metadata for catalogue components (Phase 6 extension of the Phase 3
 * catalogue — no second component library). For each supported definition it provides the
 * default DEVICE MODEL (the parameters the circuit simulator uses) and first-class PIN
 * metadata: role, direction, domain, voltage/current limits WITH THEIR SOURCE, the connector
 * the pin is on (the catalogue interface id and its mechanical mating descriptors) and the
 * pin's local 3D position (from the generated interface).
 *
 * Unknown ratings stay `null` — never a guessed number. Mechanical mating compatibility
 * (connections.ts) and electrical compatibility (below) are separate questions: a Dupont
 * jumper fits any 2.54 mm header pin, which says nothing about voltage or current.
 */
export interface PinLimit {
  min: number | null;
  max: number | null;
  unit: 'V' | 'A';
  status: DataStatus;
  source: string;
}

export interface CatalogPin extends DevicePin {
  componentId: string;
  /** Nominal level the pin outputs or is supplied at (V); null = not applicable/unknown. */
  nominalV: number | null;
  voltage: PinLimit | null;
  current: PinLimit | null;
  connector: { interfaceId: string | null; compatibility: string[]; gender: ComponentInterface['gender'] };
  /** Local 3D position (component frame, m); null when the geometry has no pin there. */
  position: [number, number, number] | null;
  manufacturerSource: string | null;
}

export interface CatalogElectricalModel {
  definitionId: string;
  device: Device;
  pins: CatalogPin[];
  /** Model notes shown with the part (assumptions, unknowns). */
  notes: string[];
}

// -- value parsing ("4.7 kΩ", "100 µF", "10 µH") ------------------------------------------
const PREFIX: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
};
export function parseSiValue(text: string): number | null {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*([pnuµmkMG]?)\s*[A-Za-zΩ]*\s*$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? PREFIX[m[2]]! : 1);
}

const DC = 'datasheet-cited' as const;
const lim = (
  min: number | null,
  max: number | null,
  unit: 'V' | 'A',
  status: DataStatus,
  source: string,
): PinLimit => ({ min, max, unit, status, source });

const UNO_DOC = 'Arduino UNO R3 documentation (docs.arduino.cc)';
const HC_DOC = 'HC-SR04 user manual (generic, widely redistributed)';

type PinExtra = Partial<Pick<CatalogPin, 'nominalV' | 'voltage' | 'current' | 'manufacturerSource'>>;
interface Entry {
  device: (v: ParamValues) => Device;
  /** Pin id → catalogue interface (by id, or by name and occurrence). */
  iface: (pinId: string, ifaces: ComponentInterface[]) => ComponentInterface | undefined;
  extra: (pin: DevicePin) => PinExtra;
  notes: string[];
}

const byId = (id: string) => (ifs: ComponentInterface[]) => ifs.find((i) => i.id === id);
const nth = (pred: (i: ComponentInterface) => boolean, k: number) => (ifs: ComponentInterface[]) =>
  ifs.filter(pred)[k];
const terminals = (ifs: ComponentInterface[]) => ifs.filter((i) => i.type === 'electrical-terminal');
const ordered =
  (order: string[]) =>
  (pin: string, ifs: ComponentInterface[]): ComponentInterface | undefined => {
    const k = order.indexOf(pin);
    return k < 0 ? undefined : terminals(ifs)[k];
  };

const servoEntry = (
  model: 'sg90' | 'mg996r' | 'generic',
  supply: [number, number],
  deadbandUs: number,
  note: string,
): Entry => ({
  device: () => ({
    type: 'servo',
    model,
    mateId: null,
    pulseMinUs: 544,
    pulseMaxUs: 2400,
    angleRangeDeg: 180,
    jointCentreRad: 0,
    direction: 1,
    deadbandUs,
    validMinUs: 400,
    validMaxUs: 2600,
    minSupplyV: supply[0],
    maxSupplyV: supply[1],
  }),
  iface: (pin, ifs) => {
    const map: Record<string, (x: ComponentInterface[]) => ComponentInterface | undefined> = {
      signal: byId('signal'),
      vplus: byId('v-plus'),
      gnd: byId('ground'),
    };
    return map[pin]?.(ifs);
  },
  extra: (p) =>
    p.id === 'vplus'
      ? {
          voltage: lim(supply[0], supply[1], 'V', model === 'generic' ? 'generic' : DC, note),
          current: null, // stall/running current not given in the cited datasheets → unknown
        }
      : p.id === 'signal'
        ? { voltage: null, current: null }
        : {},
  notes: [
    'Pulse-to-angle mapping assumed equal to the Arduino Servo library default (544–2400 µs → 0–180°); real servos vary.',
    'Supply current is unknown (not given in the cited datasheet): supply adequacy cannot be checked.',
  ],
});

const ENTRIES: Record<string, Entry> = {
  'arduino-uno-r3': {
    device: () => ({ type: 'mcu', board: 'arduino-uno-r3', power: 'usb', firmwareId: null }),
    iface: (pin, ifs) => {
      const named = (n: string, k = 0) => nth((i) => i.name === n, k)(ifs);
      if (pin === 'GND.3') return named('GND', 0); // digital header
      if (pin === 'GND.1') return named('GND', 1); // power header
      if (pin === 'GND.2') return named('GND', 2);
      return named(pin);
    },
    extra: (p) => {
      if (p.role === 'ground') return { nominalV: 0 };
      if (p.id === '5V')
        return { nominalV: 5, voltage: lim(null, 5, 'V', DC, `${UNO_DOC}: operating voltage 5 V`) };
      if (p.id === 'IOREF') return { nominalV: 5 };
      if (p.id === '3V3')
        return {
          nominalV: 3.3,
          current: lim(null, 0.05, 'A', DC, `${UNO_DOC}: DC current for 3.3 V pin 50 mA`),
        };
      if (p.id === 'VIN')
        return { voltage: lim(7, 12, 'V', DC, `${UNO_DOC}: input voltage (recommended) 7–12 V`) };
      if (p.id === 'AREF' || p.id === 'RESET') return {};
      return {
        nominalV: 5,
        voltage: lim(0, 5, 'V', DC, `${UNO_DOC}: operating voltage 5 V`),
        current: lim(null, 0.02, 'A', DC, `${UNO_DOC}: DC current per I/O pin 20 mA`),
        manufacturerSource: UNO_DOC,
      };
    },
    notes: [
      'Level 2 runtime: sketches in the FORGE Arduino subset run against a modelled Arduino API; the ATmega328P is not emulated.',
      'Power: "usb" models the USB host as an ideal 5 V source (the board’s 500 mA polyfuse is a rating check only).',
    ],
  },
  'hc-sr04': {
    device: () => ({
      type: 'hc-sr04',
      temperatureC: null,
      minRangeM: 0.02,
      maxRangeM: 4,
      beamHalfAngleRad: (7.5 * Math.PI) / 180,
      rays: 7,
      noiseStdM: 0,
      noEchoPulseUs: 38_000,
      burstDelayUs: 200,
      minTriggerUs: 10,
    }),
    iface: (pin, ifs) => byId(`pin-${pin}`)(ifs),
    extra: (p) =>
      p.id === 'vcc'
        ? {
            nominalV: 5,
            voltage: lim(5, 5, 'V', DC, `${HC_DOC}: working voltage DC 5 V`),
            current: lim(null, 0.015, 'A', DC, `${HC_DOC}: working current 15 mA`),
          }
        : p.id === 'echo'
          ? { nominalV: 5 }
          : p.id === 'trig'
            ? { voltage: lim(0, 5, 'V', 'generic', `${HC_DOC}: 10 µs TTL trigger pulse`) }
            : { nominalV: 0 },
    notes: [
      'Generic HC-SR04-compatible model, not verified manufacturer behaviour. Ranges 2–400 cm and 15° measuring angle are datasheet-cited.',
      'No-echo pulse width 38 ms is commonly published but varies between modules (unverified); burst delay 200 µs = 8 cycles at the cited 40 kHz.',
    ],
  },
  'towerpro-sg90': servoEntry('sg90', [4.8, 6], 10, 'TowerPro SG90 datasheet: 4.8 V (commonly 4.8–6 V)'),
  'towerpro-mg996r': servoEntry('mg996r', [4.8, 7.2], 0, 'TowerPro MG996R datasheet: 4.8–7.2 V'),
  'micro-servo-generic': servoEntry('generic', [4.8, 6], 0, 'Generic size class: no cited supply range'),
  'standard-servo-generic': servoEntry('generic', [4.8, 6], 0, 'Generic size class: no cited supply range'),
  'high-torque-servo-generic': servoEntry(
    'generic',
    [4.8, 6],
    0,
    'Generic size class: no cited supply range',
  ),
  'resistor-axial': {
    device: (v) => ({
      type: 'resistor',
      resistanceOhm: parseSiValue(String(v.resistance ?? '1 kΩ')) ?? 1000,
      powerRatingW: null,
    }),
    iface: ordered(['p1', 'p2']),
    extra: () => ({}),
    notes: ['Power rating unknown for this generic entry: dissipation is computed, but not checked.'],
  },
  potentiometer: {
    device: (v) => ({
      type: 'potentiometer',
      resistanceOhm: parseSiValue(String(v.resistance ?? '10 kΩ')) ?? 10_000,
      position: 0.5,
      link: { kind: 'manual' },
    }),
    iface: ordered(['a', 'w', 'b']),
    extra: () => ({}),
    notes: ['Linear taper assumed; pin order (A, wiper, B) assumed for the generic TO-92 body.'],
  },
  'electrolytic-capacitor': {
    device: (v) => ({
      type: 'capacitor',
      capacitanceF: parseSiValue(String(v.capacitance ?? '100 µF')) ?? 100e-6,
      voltageRatingV: null,
      initialVoltageV: null,
      polarized: true,
    }),
    iface: ordered(['pos', 'neg']),
    extra: () => ({}),
    notes: ['Ideal capacitor (no ESR or leakage). Voltage rating unknown for this generic entry.'],
  },
  'ceramic-capacitor': {
    device: (v) => ({
      type: 'capacitor',
      capacitanceF: parseSiValue(String(v.capacitance ?? '100 nF')) ?? 100e-9,
      voltageRatingV: null,
      initialVoltageV: null,
      polarized: false,
    }),
    iface: ordered(['p1', 'p2']),
    extra: () => ({}),
    notes: ['Ideal capacitor (no ESR, no voltage coefficient).'],
  },
  'radial-inductor': {
    device: (v) => ({
      type: 'inductor',
      inductanceH: parseSiValue(String(v.inductance ?? '100 µH')) ?? 100e-6,
      currentRatingA: null,
      initialCurrentA: null,
    }),
    iface: ordered(['p1', 'p2']),
    extra: () => ({}),
    notes: ['Ideal inductor (no winding resistance, no saturation).'],
  },
  'diode-axial': {
    device: () => ({
      type: 'diode',
      model: { saturationCurrentA: 1e-14, emissionCoefficient: 1, seriesResistanceOhm: 0 },
      maxForwardCurrentA: null,
      maxReverseVoltageV: null,
      preset: 'generic-silicon',
    }),
    iface: ordered(['a', 'k']),
    extra: () => ({}),
    notes: ['Generic Shockley model (Is = 1e-14 A, n = 1); no breakdown, no junction capacitance.'],
  },
  'led-5mm': {
    device: (v) => ({
      type: 'led',
      // Generic indicator-LED Shockley fit: ≈ 2.0 V at 20 mA (red). Illustrative, not a part.
      model: { saturationCurrentA: 1e-19, emissionCoefficient: 1.8, seriesResistanceOhm: 2 },
      color: (['red', 'green', 'yellow', 'blue', 'white'].includes(String(v.colour))
        ? String(v.colour)
        : 'red') as 'red',
      maxForwardCurrentA: null,
      maxReverseVoltageV: null,
      preset: 'generic-indicator',
    }),
    iface: ordered(['a', 'k']),
    extra: () => ({}),
    notes: [
      'Generic Shockley fit (≈ 2.0 V at 20 mA); colour does not change the model. Current rating unknown for this generic entry.',
    ],
  },
  'bjt-to92': {
    device: () => ({
      type: 'npn',
      saturationCurrentA: 1e-14,
      betaF: 100,
      betaR: 1,
      maxCollectorCurrentA: null,
    }),
    iface: ordered(['e', 'b', 'c']),
    extra: () => ({}),
    notes: [
      'Ebers–Moll transport model with generic parameters (Is = 1e-14 A, βF = 100, βR = 1). Pin order E-B-C assumed; it varies by part.',
    ],
  },
  'mosfet-to220': {
    device: () => ({
      type: 'nmos',
      thresholdV: 2,
      transconductanceAPerV2: 1,
      lambdaPerV: 0,
      maxDrainCurrentA: null,
    }),
    iface: ordered(['g', 'd', 's']),
    extra: () => ({}),
    notes: [
      'Square-law (level-1) switching approximation with generic parameters (Vth = 2 V, K = 1 A/V²). Pin order G-D-S assumed.',
    ],
  },
  microswitch: {
    device: () => ({ type: 'limit-switch', link: { kind: 'manual', pressed: false }, onResistanceOhm: 0.05 }),
    iface: ordered(['com', 'no', 'nc']),
    extra: () => ({}),
    notes: ['Ideal contacts (no bounce); contact resistance 50 mΩ assumed.'],
  },
  'rotary-encoder-module': {
    device: () => ({ type: 'encoder', mateId: null, pulsesPerRev: 20 }),
    iface: () => undefined,
    extra: (p) => (p.id === 'a' || p.id === 'b' ? { nominalV: 5 } : {}),
    notes: ['Ideal quadrature outputs (no bounce) at the supply level; 20 pulses/rev is a generic default.'],
  },
  'temp-sensor-to92': {
    device: () => ({ type: 'temp-sensor', offsetV: 0.5, slopeVPerC: 0.01 }),
    iface: ordered(['vcc', 'out', 'gnd']),
    extra: () => ({}),
    notes: [
      'Generic linear analog sensor (500 mV + 10 mV/°C). It reads the configured ambient temperature: there is no thermal simulation.',
    ],
  },
  'battery-pack': {
    device: (v) => {
      const cell = v.format === '18650' || v.format === '21700' ? 3.7 : 1.5;
      return {
        type: 'vsource',
        waveform: { kind: 'dc', value: cell * Number(v.series ?? 4) },
        seriesResistanceOhm: 0,
        currentLimitA: null,
        purpose: 'supply',
      };
    },
    iface: () => undefined,
    extra: () => ({}),
    notes: [
      'Ideal source at the nominal pack voltage (1.5 V alkaline / 3.7 V Li-ion per cell): internal resistance, capacity and discharge are not modelled.',
    ],
  },
  'breadboard-power-module': {
    device: () => ({
      type: 'vsource',
      waveform: { kind: 'dc', value: 5 },
      seriesResistanceOhm: 0,
      currentLimitA: null,
      purpose: 'supply',
    }),
    iface: () => undefined,
    extra: () => ({}),
    notes: ['Ideal 5 V rail; output current rating unknown for this generic entry.'],
  },
};

/** Definitions that have an electrical model. */
export const ELECTRICAL_DEFINITION_IDS = Object.keys(ENTRIES);

/** Device model + pin metadata for a catalogue definition (null = no electrical model yet). */
export function electricalModelFor(
  definitionId: string,
  values: ParamValues = {},
  variantId: string | null = null,
): CatalogElectricalModel | null {
  const e = ENTRIES[definitionId];
  const def = getDefinition(definitionId);
  if (!e || !def) return null;
  const resolved = resolveParameters(def, variantId, values);
  const params = resolved.ok ? resolved.values : {};
  const device = e.device(params);
  let ifaces: ComponentInterface[] = [];
  try {
    ifaces = evaluate(def, params, def.materialId).interfaces;
  } catch {
    ifaces = [...def.interfaces];
  }
  const pins = devicePins(device).map((pin): CatalogPin => {
    const itf = e.iface(pin.id, ifaces);
    const x = e.extra(pin);
    return {
      ...pin,
      componentId: definitionId,
      nominalV: x.nominalV ?? null,
      voltage: x.voltage ?? null,
      current: x.current ?? null,
      connector: {
        interfaceId: itf?.id ?? null,
        compatibility: itf?.compatibility ?? [],
        gender: itf?.gender ?? null,
      },
      position: itf ? [...itf.position] : null,
      manufacturerSource:
        x.manufacturerSource ?? (def.manufacturer ? (def.references[0]?.title ?? null) : null),
    };
  });
  return { definitionId, device, pins, notes: e.notes };
}

export type ElectricalCompatibility = {
  status: 'compatible' | 'warning' | 'incompatible' | 'unknown';
  reasons: string[];
};

/**
 * ELECTRICAL compatibility of connecting two pins directly (not whether their connectors
 * mate — see checkCompatibility). Only conclusions the metadata supports are drawn; missing
 * ratings yield "unknown", never "compatible".
 */
export function checkElectricalCompatibility(
  a: Pick<CatalogPin, 'name' | 'role' | 'direction' | 'nominalV' | 'voltage'>,
  b: Pick<CatalogPin, 'name' | 'role' | 'direction' | 'nominalV' | 'voltage'>,
): ElectricalCompatibility {
  const reasons: string[] = [];
  let status: ElectricalCompatibility['status'] = 'compatible';
  const worse = (s: ElectricalCompatibility['status']) => {
    const rank = { compatible: 0, unknown: 1, warning: 2, incompatible: 3 };
    if (rank[s] > rank[status]) status = s;
  };
  const isOut = (p: typeof a) => p.direction === 'output' || p.direction === 'power-out';
  if (
    (a.role === 'ground' && b.direction === 'power-out' && b.role === 'supply') ||
    (b.role === 'ground' && a.direction === 'power-out' && a.role === 'supply')
  ) {
    reasons.push('A supply output wired directly to ground is a short circuit.');
    worse('incompatible');
  }
  if (isOut(a) && isOut(b) && a.nominalV !== null && b.nominalV !== null && a.nominalV !== b.nominalV) {
    reasons.push(`Two sources at different levels (${a.nominalV} V vs ${b.nominalV} V) would fight.`);
    worse('incompatible');
  } else if (a.direction === 'output' && b.direction === 'output') {
    reasons.push('Two outputs on one net may contend if they drive different levels.');
    worse('warning');
  }
  for (const [src, dst] of [
    [a, b],
    [b, a],
  ] as const) {
    const drives =
      src.direction === 'output' ||
      src.direction === 'power-out' ||
      src.direction === 'bidirectional' || // GPIO: may be configured as an output
      src.role === 'supply';
    if (src.nominalV === null || !drives) continue;
    if (dst.voltage?.max != null && src.nominalV > dst.voltage.max + 1e-9) {
      reasons.push(
        `${src.name} (${src.nominalV} V) exceeds ${dst.name}'s ${dst.voltage.max} V limit (${dst.voltage.source}).`,
      );
      worse('incompatible');
    } else if (dst.voltage?.min != null && src.nominalV < dst.voltage.min - 1e-9 && dst.role === 'supply') {
      reasons.push(`${src.name} (${src.nominalV} V) is below ${dst.name}'s ${dst.voltage.min} V minimum.`);
      worse('warning');
    } else if (!dst.voltage && dst.role !== 'ground' && dst.role !== 'passive') {
      reasons.push(`${dst.name} has no known voltage rating: the ${src.nominalV} V level cannot be checked.`);
      worse('unknown');
    }
  }
  return { status, reasons };
}
