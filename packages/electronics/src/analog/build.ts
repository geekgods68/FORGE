import type { ElectricalDefinition, ElectricalPart } from '@forge/engineering-core';
import { compileNetlist, type Netlist } from '../netlist';
import { AnalogCircuit, type Element } from './circuit';

/**
 * Device models → MNA elements. Digital pins contribute nothing here unless the
 * co-simulation passes a DRIVER (a Thevenin source standing for a digital output) or a
 * pull-up; that is the documented digital→analog boundary (docs/ELECTRICAL_ARCHITECTURE.md).
 */
export interface AnalogOverrides {
  /** Digital outputs driving the analog network: level v (V) behind r (Ω) w.r.t. refNet. */
  drivers?: { id: string; part: string; net: number; refNet: number; v: number; r: number }[];
  /** Extra resistors (e.g. microcontroller input pull-ups). */
  resistors?: { id: string; part: string; a: number; b: number; r: number }[];
  /** Runtime wiper positions (0…1) by part id. */
  potPosition?: Map<string, number>;
  /** Runtime switch / limit-switch state by part id. */
  pressed?: Map<string, boolean>;
  /** Sensor output voltages (relative to the sensor's GND) by part id. */
  sensorOutputV?: Map<string, number>;
  /** Microcontrollers (part id) whose external supply is regulated (VIN ≥ threshold). */
  regulated?: Set<string>;
}

/** Arduino UNO: USB host 5 V and the 3.3 V regulator, as ideal sources (ratings checked separately). */
export const UNO = {
  usbV: 5,
  reg3v3: 3.3,
  /** Recommended minimum VIN (datasheet-cited) for the on-board regulator to be modelled as on. */
  vinMin: 7,
  /** Internal pull-up (ATmega328P datasheet range 20–50 kΩ; mid value used). */
  pullUpOhm: 35_000,
  /**
   * Output resistance of a driven pin: the ATmega328P datasheet guarantees VOH ≥ 4.2 V at
   * 20 mA (5 V), i.e. ≤ 40 Ω; 25 Ω is used as a typical value (approximate).
   */
  outputOhm: 25,
  /** Input thresholds (datasheet): VIL ≤ 0.3·VCC, VIH ≥ 0.6·VCC. */
  vilFrac: 0.3,
  vihFrac: 0.6,
} as const;

/** HC-SR04 supply current (cited 15 mA at 5 V) as an equivalent resistive load. */
export const HCSR04_LOAD_OHM = 5 / 0.015;

export function buildElements(def: ElectricalDefinition, nl: Netlist, o: AnalogOverrides = {}): Element[] {
  const out: Element[] = [];
  const net = (p: ElectricalPart, t: string) => nl.terminalNet(p.id, t) ?? -1;
  for (const p of def.parts) {
    const d = p.device;
    const id = p.label;
    switch (d.type) {
      case 'resistor':
        out.push({ k: 'R', id, part: p.id, a: net(p, 'p1'), b: net(p, 'p2'), r: d.resistanceOhm });
        break;
      case 'capacitor': {
        const [a, b] = d.polarized ? ['pos', 'neg'] : ['p1', 'p2'];
        out.push({
          k: 'C',
          id,
          part: p.id,
          a: net(p, a),
          b: net(p, b),
          c: d.capacitanceF,
          ic: d.initialVoltageV,
        });
        break;
      }
      case 'inductor':
        out.push({
          k: 'L',
          id,
          part: p.id,
          a: net(p, 'p1'),
          b: net(p, 'p2'),
          l: d.inductanceH,
          ic: d.initialCurrentA,
        });
        break;
      case 'vsource':
        out.push({
          k: 'V',
          id,
          part: p.id,
          a: net(p, 'pos'),
          b: net(p, 'neg'),
          wave: d.waveform,
          rs: d.seriesResistanceOhm,
        });
        break;
      case 'isource':
        out.push({ k: 'I', id, part: p.id, a: net(p, 'pos'), b: net(p, 'neg'), wave: d.waveform });
        break;
      case 'switch':
        if (o.pressed?.get(p.id) ?? d.closed)
          out.push({ k: 'R', id, part: p.id, a: net(p, 'p1'), b: net(p, 'p2'), r: d.onResistanceOhm });
        break;
      case 'vcvs':
        out.push({
          k: 'E',
          id,
          part: p.id,
          a: net(p, 'out+'),
          b: net(p, 'out-'),
          c: net(p, 'ctl+'),
          d: net(p, 'ctl-'),
          gain: d.gain,
        });
        break;
      case 'vccs':
        out.push({
          k: 'G',
          id,
          part: p.id,
          a: net(p, 'out+'),
          b: net(p, 'out-'),
          c: net(p, 'ctl+'),
          d: net(p, 'ctl-'),
          gm: d.transconductanceS,
        });
        break;
      case 'diode':
      case 'led':
        out.push({
          k: 'D',
          id,
          part: p.id,
          a: net(p, 'a'),
          b: net(p, 'k'),
          is: d.model.saturationCurrentA,
          n: d.model.emissionCoefficient,
          rs: d.model.seriesResistanceOhm,
        });
        break;
      case 'npn':
        out.push({
          k: 'Q',
          id,
          part: p.id,
          c: net(p, 'c'),
          b: net(p, 'b'),
          e: net(p, 'e'),
          is: d.saturationCurrentA,
          bf: d.betaF,
          br: d.betaR,
        });
        break;
      case 'nmos':
        out.push({
          k: 'M',
          id,
          part: p.id,
          d: net(p, 'd'),
          g: net(p, 'g'),
          s: net(p, 's'),
          vt: d.thresholdV,
          kp: d.transconductanceAPerV2,
          lambda: d.lambdaPerV,
        });
        break;
      case 'potentiometer': {
        const pos = Math.min(1, Math.max(0, o.potPosition?.get(p.id) ?? d.position));
        // Track ends clamped to 0.01 % of the track (a real wiper never reaches 0 Ω).
        const end = 1e-4;
        out.push({
          k: 'R',
          id: `${id}:aw`,
          part: p.id,
          a: net(p, 'a'),
          b: net(p, 'w'),
          r: d.resistanceOhm * Math.max(end, pos),
        });
        out.push({
          k: 'R',
          id: `${id}:wb`,
          part: p.id,
          a: net(p, 'w'),
          b: net(p, 'b'),
          r: d.resistanceOhm * Math.max(end, 1 - pos),
        });
        break;
      }
      case 'limit-switch': {
        const pressed = o.pressed?.get(p.id) ?? (d.link.kind === 'manual' ? d.link.pressed : false);
        out.push({
          k: 'R',
          id: `${id}:${pressed ? 'no' : 'nc'}`,
          part: p.id,
          a: net(p, 'com'),
          b: net(p, pressed ? 'no' : 'nc'),
          r: d.onResistanceOhm,
        });
        break;
      }
      case 'mcu': {
        // Powered by USB, or by VIN through the regulator: the 5 V rail and the 3.3 V
        // regulator (fed from it) are ideal sources; their ratings are checked separately.
        if (d.power === 'usb' || o.regulated?.has(p.id)) {
          out.push({
            k: 'V',
            id: `${id}:5V`,
            part: p.id,
            a: net(p, '5V'),
            b: net(p, 'GND'),
            wave: { kind: 'dc', value: UNO.usbV },
            rs: 0,
          });
          out.push({
            k: 'V',
            id: `${id}:3V3`,
            part: p.id,
            a: net(p, '3V3'),
            b: net(p, 'GND'),
            wave: { kind: 'dc', value: UNO.reg3v3 },
            rs: 0,
          });
        }
        break;
      }
      case 'hc-sr04':
        out.push({
          k: 'R',
          id: `${id}:supply`,
          part: p.id,
          a: net(p, 'vcc'),
          b: net(p, 'gnd'),
          r: HCSR04_LOAD_OHM,
        });
        break;
      case 'temp-sensor': {
        const v = o.sensorOutputV?.get(p.id);
        if (v !== undefined)
          out.push({
            k: 'V',
            id: `${id}:out`,
            part: p.id,
            a: net(p, 'out'),
            b: net(p, 'gnd'),
            wave: { kind: 'dc', value: v },
            rs: 0,
          });
        break;
      }
      default:
        break; // ground, junction, servo (load unknown), encoder, logic primitives: no analog element
    }
  }
  for (const r of o.resistors ?? []) out.push({ k: 'R', id: r.id, part: r.part, a: r.a, b: r.b, r: r.r });
  for (const dr of o.drivers ?? [])
    out.push({
      k: 'V',
      id: dr.id,
      part: dr.part,
      a: dr.net,
      b: dr.refNet,
      wave: { kind: 'dc', value: dr.v },
      rs: dr.r,
    });
  return out;
}

/** Convenience: compile a definition and build its analog circuit (standalone analyses). */
export function analogCircuitOf(def: ElectricalDefinition, o: AnalogOverrides = {}) {
  const nl = compileNetlist(def);
  return new AnalogCircuit(nl, buildElements(def, nl, o), def.settings);
}
