import {
  checkCompatibility,
  checkElectricalCompatibility,
  electricalModelFor,
  getDefinition,
} from '@forge/components';
import { describe, expect, it } from 'vitest';
import { analogCircuitOf } from '../analog/build';
import { CircuitBuilder } from '../builder';
import { solvedChecks, structuralChecks } from '../erc';
import { exportElectricalBundle, exportSpiceNetlist, parseElectricalBundle } from '../interop';
import { compileNetlist } from '../netlist';

const uno = (b: CircuitBuilder, power: 'usb' | 'external' = 'usb') =>
  b.add(
    { type: 'mcu', board: 'arduino-uno-r3', power, firmwareId: null },
    { definitionId: 'arduino-uno-r3' },
  );

describe('netlist (explicit connectivity only)', () => {
  it('nets come from wires, labels and internal terminals — never from positions', () => {
    const b = new CircuitBuilder();
    const r1 = b.resistor(100, { schematic: { x: 0, y: 0, rotation: 0 } });
    const r2 = b.resistor(100, { schematic: { x: 0, y: 0, rotation: 0 } }); // same position as R1
    const r3 = b.resistor(100);
    const u = uno(b);
    b.wire(`${r1}.p2`, `${r2}.p1`)
      .label('SIG', `${r2}.p2`)
      .label('SIG', `${r3}.p1`)
      .wire(`${u}.GND.1`, `${r3}.p2`);
    const nl = compileNetlist(b.build());
    const same = (a: [string, string], c: [string, string]) => nl.pinNet(...a) === nl.pinNet(...c);
    expect(same([r1, 'p2'], [r2, 'p1'])).toBe(true);
    expect(same([r1, 'p1'], [r2, 'p1'])).toBe(false); // overlapping parts are NOT connected
    expect(same([r2, 'p2'], [r3, 'p1'])).toBe(true); // shared label
    expect(nl.netByName('SIG')).toBeDefined();
    // The UNO's GND pins are one internal net; R3 wired to GND.1 is on GND.3's net too.
    expect(same([u, 'GND.3'], [r3, 'p2'])).toBe(true);
    expect(nl.groundSource).toBe('implicit');
    expect(nl.nets[nl.ground]!.name).toBe('GND');
  });

  it('a ground symbol defines the reference; moving parts changes nothing electrically', () => {
    const b = new CircuitBuilder();
    const v = b.dcSource(5);
    const g = b.ground();
    const r = b.resistor(1000);
    b.wire(`${v}.pos`, `${r}.p1`).wire(`${r}.p2`, `${g}.gnd`).wire(`${v}.neg`, `${g}.gnd`);
    const def = b.build();
    const a = compileNetlist(def);
    const moved = structuredClone(def);
    moved.parts.forEach((p, i) => (p.schematic = { x: 100 * i, y: -50, rotation: 90 }));
    const c = compileNetlist(moved);
    expect(a.groundSource).toBe('symbol');
    expect(c.nets.map((n) => n.pins.map((p) => `${p.partId}.${p.pin}`))).toEqual(
      a.nets.map((n) => n.pins.map((p) => `${p.partId}.${p.pin}`)),
    );
  });
});

describe('catalogue pin metadata (Phase 3 catalogue extension)', () => {
  it('UNO pins carry cited limits, connector descriptors and 3D positions from the generated headers', () => {
    const m = electricalModelFor('arduino-uno-r3')!;
    const d9 = m.pins.find((p) => p.id === 'D9')!;
    expect(d9.role).toBe('pwm');
    expect(d9.current?.max).toBe(0.02);
    expect(d9.current?.status).toBe('datasheet-cited');
    expect(d9.connector.compatibility.length).toBeGreaterThan(0);
    expect(d9.position).not.toBeNull();
    const gnds = m.pins.filter((p) => p.terminal === 'GND');
    expect(new Set(gnds.map((p) => p.connector.interfaceId)).size).toBe(3);
    expect(m.pins.find((p) => p.id === 'VIN')!.voltage).toMatchObject({ min: 7, max: 12 });
  });

  it('HC-SR04 and servos: cited values where published, unknown (null) where not', () => {
    const hc = electricalModelFor('hc-sr04')!;
    expect(hc.pins.map((p) => p.id)).toEqual(['vcc', 'trig', 'echo', 'gnd']);
    expect(hc.pins.every((p) => p.position !== null)).toBe(true);
    expect(hc.pins.find((p) => p.id === 'vcc')!.current?.max).toBe(0.015);
    const mg = electricalModelFor('towerpro-mg996r')!;
    expect(mg.pins.find((p) => p.id === 'vplus')!.current).toBeNull(); // stall current unknown
    expect(mg.device).toMatchObject({ type: 'servo', model: 'mg996r', minSupplyV: 4.8, maxSupplyV: 7.2 });
    expect(electricalModelFor('resistor-axial', { resistance: '4.7 kΩ' })!.device).toMatchObject({
      resistanceOhm: 4700,
    });
  });

  it('mechanical mating and electrical compatibility are separate questions', () => {
    const hc = electricalModelFor('hc-sr04')!;
    const sv = electricalModelFor('towerpro-sg90')!;
    const hcItf = getDefinition('hc-sr04')!;
    void hcItf;
    // Two 2.54 mm header pins may physically mate…
    const pinA = {
      id: 'a',
      name: 'A',
      type: 'gpio-pin' as const,
      position: [0, 0, 0] as [number, number, number],
      direction: [0, 1, 0] as [number, number, number],
      gender: 'male' as const,
      compatibility: ['2.54mm-header'],
      limits: [],
    };
    const pinB = { ...pinA, id: 'b', gender: 'female' as const };
    expect(checkCompatibility(pinA, pinB).compatible).toBe(true);
    // …but a 7.4 V supply output may not be connected to the HC-SR04's 5 V VCC.
    const supply = {
      name: 'Pack +',
      role: 'supply' as const,
      direction: 'power-out' as const,
      nominalV: 7.4,
      voltage: null,
    };
    const vcc = hc.pins.find((p) => p.id === 'vcc')!;
    expect(checkElectricalCompatibility(supply, vcc).status).toBe('incompatible');
    // A servo signal input has no cited voltage rating: the result is "unknown", never "compatible".
    const d9 = electricalModelFor('arduino-uno-r3')!.pins.find((p) => p.id === 'D9')!;
    expect(
      checkElectricalCompatibility(
        d9,
        sv.pins.find((p) => p.id === 'signal')!,
      ).status,
    ).toBe('unknown');
  });
});

describe('design-rule checks', () => {
  it('flags shorts, floating inputs, missing current limiting, shared-ground and servo-rail problems', () => {
    const b = new CircuitBuilder();
    const u = uno(b);
    const s = b.add(electricalModelFor('towerpro-mg996r')!.device, { definitionId: 'towerpro-mg996r' });
    const hc = b.add(electricalModelFor('hc-sr04')!.device, { definitionId: 'hc-sr04' });
    const led = b.add(electricalModelFor('led-5mm')!.device, { definitionId: 'led-5mm' });
    // Servo on the UNO 5 V rail with its ground missing; HC-SR04 trig floating; LED straight from D13 to GND.
    b.wire(`${u}.D9`, `${s}.signal`).wire(`${u}.5V`, `${s}.vplus`);
    b.wire(`${u}.5V`, `${hc}.vcc`).wire(`${u}.GND.1`, `${hc}.gnd`).wire(`${hc}.echo`, `${u}.D10`);
    b.wire(`${u}.D13`, `${led}.a`).wire(`${led}.k`, `${u}.GND.2`);
    const def = b.build();
    const codes = structuralChecks(def, compileNetlist(def)).map((i) => i.code);
    expect(codes).toContain('incomplete-ground'); // servo GND not on the UNO's ground
    expect(codes).toContain('unconnected-power'); // servo GND pin unconnected
    expect(codes).toContain('floating-input'); // HC-SR04 trig
    expect(codes).toContain('missing-current-limit');
    expect(codes).toContain('controller-rail-load');
    expect(codes).toContain('missing-parameter'); // HC-SR04 not placed in 3D
  });

  it('flags supply conflicts and a 7.4 V rail on a 5 V-rated pin', () => {
    const b = new CircuitBuilder();
    const u = uno(b);
    const pack = b.dcSource(7.4);
    const hc = b.add(electricalModelFor('hc-sr04')!.device, { definitionId: 'hc-sr04' });
    b.wire(`${pack}.pos`, `${hc}.vcc`)
      .wire(`${pack}.neg`, `${u}.GND.1`)
      .wire(`${hc}.gnd`, `${u}.GND.2`)
      .wire(`${pack}.pos`, `${u}.5V`);
    const def = b.build();
    const codes = structuralChecks(def, compileNetlist(def)).map((i) => i.code);
    expect(codes).toContain('supply-conflict'); // 7.4 V pack tied to the 5 V USB rail
    expect(codes).toContain('voltage-domain'); // 7.4 V on HC-SR04 VCC (cited 5 V)
  });

  it('solved checks: GPIO overcurrent through an LED with too small a resistor, and the cited-rating basis', () => {
    const b = new CircuitBuilder();
    const g = b.ground();
    const v = b.dcSource(5);
    const r = b.resistor(10);
    const led = b.add(electricalModelFor('led-5mm')!.device, { definitionId: 'led-5mm' });
    b.wire(`${v}.neg`, `${g}.gnd`)
      .wire(`${v}.pos`, `${r}.p1`)
      .wire(`${r}.p2`, `${led}.a`)
      .wire(`${led}.k`, `${g}.gnd`);
    const def = b.build();
    const c = analogCircuitOf(def);
    const op = c.dc();
    if (!op.ok) throw new Error('dc failed');
    expect(op.i.get('LED1')!).toBeGreaterThan(0.03);
    const issues = solvedChecks(def, c.netlist, op);
    expect(issues.some((i) => i.code === 'unknown-rating' && /rating is unknown/.test(i.message))).toBe(true);
  });
});

describe('interchange', () => {
  it('bundle round-trips; malformed or oversized imports are rejected with details', () => {
    const b = new CircuitBuilder('Divider');
    const v = b.dcSource(5);
    const g = b.ground();
    const r1 = b.resistor(1000);
    b.wire(`${v}.pos`, `${r1}.p1`).wire(`${r1}.p2`, `${g}.gnd`).wire(`${v}.neg`, `${g}.gnd`);
    const def = b.build();
    const text = exportElectricalBundle(def);
    const back = parseElectricalBundle(text);
    expect(back.ok && back.definition).toEqual(def);
    expect(parseElectricalBundle('{').ok).toBe(false);
    expect(parseElectricalBundle(JSON.stringify({ format: 'x' })).ok).toBe(false);
    const bad = JSON.parse(text);
    bad.definition.wires[0].a.pin = 'nope';
    const r = parseElectricalBundle(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.details.join()).toMatch(/no pin "nope"/);
    expect(parseElectricalBundle('x'.repeat(3 * 1024 * 1024)).ok).toBe(false);
  });

  it('SPICE-style export lists supported elements and marks the rest as comments', () => {
    const b = new CircuitBuilder();
    const v = b.dcSource(5);
    const g = b.ground();
    const r = b.resistor(220);
    const u = uno(b);
    b.wire(`${v}.pos`, `${r}.p1`).wire(`${r}.p2`, `${g}.gnd`).wire(`${v}.neg`, `${g}.gnd`);
    void u;
    const text = exportSpiceNetlist(b.build());
    expect(text).toMatch(/^R1 \S+ 0 220$/m); // label R1 already starts with R (Phase 8: no RR1)
    expect(text).toMatch(/^V1 \S+ 0 DC 5$/m);
    expect(text).toMatch(/\* U1 \(mcu\): no SPICE equivalent/);
    expect(text).toMatch(/not verified against a SPICE simulator/);
  });
});
