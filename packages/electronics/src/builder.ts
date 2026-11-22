import {
  defaultElectricalDefinition,
  ElectricalDefinitionSchema,
  type Device,
  type DeviceOf,
  type DeviceType,
  type ElectricalDefinition,
  type ElectricalPart,
} from '@forge/engineering-core';

/** Typed helper for building electrical definitions in code (tests, validation, samples). */
export class CircuitBuilder {
  readonly def: ElectricalDefinition;
  private n = 0;
  private counters = new Map<string, number>();
  constructor(name = 'Circuit') {
    this.def = defaultElectricalDefinition(name);
  }

  private prefix(type: DeviceType): string {
    const map: Partial<Record<DeviceType, string>> = {
      resistor: 'R',
      capacitor: 'C',
      inductor: 'L',
      vsource: 'V',
      isource: 'I',
      ground: 'GND',
      junction: 'J',
      switch: 'SW',
      vcvs: 'E',
      vccs: 'G',
      diode: 'D',
      led: 'LED',
      npn: 'Q',
      nmos: 'M',
      potentiometer: 'RV',
      mcu: 'U',
      'hc-sr04': 'US',
      servo: 'SV',
      'limit-switch': 'S',
      encoder: 'ENC',
      'temp-sensor': 'TS',
      'logic-gate': 'X',
      dff: 'FF',
      counter: 'CNT',
      clock: 'CLK',
    };
    return map[type] ?? 'P';
  }

  /** Add a part; returns its id. */
  add<T extends DeviceType>(
    device: DeviceOf<T> | Device,
    opts: Partial<
      Pick<ElectricalPart, 'id' | 'label' | 'name' | 'definitionId' | 'nodeId' | 'schematic'>
    > = {},
  ): string {
    const pre = this.prefix(device.type);
    const k = (this.counters.get(pre) ?? 0) + 1;
    this.counters.set(pre, k);
    const id = opts.id ?? `p${++this.n}`;
    this.def.parts.push({
      id,
      label: opts.label ?? `${pre}${k}`,
      name: opts.name ?? `${pre}${k}`,
      device,
      definitionId: opts.definitionId ?? null,
      nodeId: opts.nodeId ?? null,
      schematic: opts.schematic ?? {
        x: (this.def.parts.length % 8) * 12,
        y: Math.floor(this.def.parts.length / 8) * 10,
        rotation: 0,
      },
      note: '',
    });
    return id;
  }

  resistor(ohm: number, opts: Parameters<CircuitBuilder['add']>[1] = {}) {
    return this.add({ type: 'resistor', resistanceOhm: ohm, powerRatingW: null }, opts);
  }
  capacitor(f: number, ic: number | null = null, opts: Parameters<CircuitBuilder['add']>[1] = {}) {
    return this.add(
      { type: 'capacitor', capacitanceF: f, voltageRatingV: null, initialVoltageV: ic, polarized: false },
      opts,
    );
  }
  inductor(h: number, ic: number | null = null, opts: Parameters<CircuitBuilder['add']>[1] = {}) {
    return this.add({ type: 'inductor', inductanceH: h, currentRatingA: null, initialCurrentA: ic }, opts);
  }
  dcSource(v: number, opts: Parameters<CircuitBuilder['add']>[1] = {}, rs = 0) {
    return this.add(
      {
        type: 'vsource',
        waveform: { kind: 'dc', value: v },
        seriesResistanceOhm: rs,
        currentLimitA: null,
        purpose: 'supply',
      },
      opts,
    );
  }
  ground() {
    return this.add({ type: 'ground' });
  }

  /** Wire two pins ("partId.pin"). */
  wire(a: string, b: string, route: [number, number][] = []) {
    const pa = a.split('.');
    const pb = b.split('.');
    const [ap, apin] = [pa[0]!, pa.slice(1).join('.')];
    const [bp, bpin] = [pb[0]!, pb.slice(1).join('.')];
    this.def.wires.push({
      id: `w${this.def.wires.length + 1}`,
      a: { partId: ap, pin: apin },
      b: { partId: bp, pin: bpin },
      route,
      color: null,
    });
    return this;
  }

  label(name: string, pin: string) {
    const [p, ...rest] = pin.split('.');
    this.def.netLabels.push({
      id: `l${this.def.netLabels.length + 1}`,
      name,
      pin: { partId: p!, pin: rest.join('.') },
    });
    return this;
  }

  firmware(id: string, name: string, source: string) {
    this.def.firmware.push({ id, name, language: 'arduino-subset', source, revision: 1 });
    return this;
  }

  /** Validated definition (throws with the schema issues if invalid). */
  build(): ElectricalDefinition {
    return ElectricalDefinitionSchema.parse(this.def);
  }
}
