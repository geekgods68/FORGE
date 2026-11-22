import { describe, expect, it } from 'vitest';
import { CircuitBuilder } from '../builder';
import { createDigitalSim } from '../digital/sim';
import { UnoRuntime } from '../firmware/arduino';
import { convert } from '../firmware/types';

/** UNO (USB powered) + extra parts; returns a running runtime on a digital/analog sim. */
function rig(
  source: string,
  extra?: (b: CircuitBuilder, u: string) => void,
  power: 'usb' | 'external' = 'usb',
) {
  const b = new CircuitBuilder();
  const u = b.add(
    { type: 'mcu', board: 'arduino-uno-r3', power, firmwareId: 'fw' },
    { definitionId: 'arduino-uno-r3' },
  );
  b.firmware('fw', 'test', source);
  extra?.(b, u);
  const def = b.build();
  const sim = createDigitalSim(def);
  const part = def.parts.find((p) => p.id === u)!;
  const mcu = new UnoRuntime(part, def.firmware[0]!, sim.net, sim.sched, { opCostNs: 250 });
  mcu.start();
  const out = () => mcu.serial.map((c) => c.text).join('');
  return { sim, mcu, u, out, def };
}
const ms = (x: number) => x * 1e6;

describe('AVR numeric semantics', () => {
  it('wraps like 16/32-bit two’s complement and float32', () => {
    expect(convert(40000, 'int')).toBe(-25536);
    expect(convert(-1, 'uint')).toBe(65535);
    expect(convert(2 ** 31, 'long')).toBe(-(2 ** 31));
    expect(convert(300, 'uchar')).toBe(44);
    expect(convert(0.1, 'float')).toBe(Math.fround(0.1));
  });

  it('runs integer and float arithmetic as an UNO would', () => {
    const { sim, out } = rig(`
      void setup() {
        Serial.begin(115200);
        int a = 40000;            // overflows a 16-bit int
        unsigned long big = 4000000000UL;
        int d = -7 / 2;           // truncates toward zero
        long m = 1000 * 1000L;
        Serial.println(a);
        Serial.println(big);
        Serial.println(d);
        Serial.println(-7 % 3);
        Serial.println(m);
        Serial.println(3.14159);   // default: 2 decimals
        Serial.println(2.0 / 3.0, 4);
        Serial.println(255, HEX);
        Serial.println(map(512, 0, 1023, 0, 180));
        Serial.println(constrain(250, 0, 180));
        char c = 'A';
        Serial.println(c);
        Serial.println(1 << 15);  // int overflow: -32768
      }
      void loop() { delay(1000); }`);
    sim.runTo(ms(50));
    expect(out().split('\r\n').slice(0, 12)).toEqual([
      '-25536',
      '4000000000',
      '-3',
      '-1',
      '1000000',
      '3.14',
      '0.6667',
      'FF',
      '90',
      '180',
      'A',
      '-32768',
    ]);
  });
});

describe('compile diagnostics', () => {
  it('reports errors with line numbers and refuses unsupported features', () => {
    const r = (src: string) => rig(src).mcu.compile;
    const e1 = r('void setup() {\n  int x = y;\n}\nvoid loop() {}');
    expect(e1.ok).toBe(false);
    expect(e1.errors[0]).toMatchObject({ line: 2, message: expect.stringContaining('"y" is not declared') });
    expect(r('#include <Wire.h>\nvoid setup(){}\nvoid loop(){}').errors[0]!.message).toMatch(
      /Wire\.h> is not supported/,
    );
    expect(r('void setup(){ tone(8, 440); }\nvoid loop(){}').errors[0]!.message).toMatch(
      /tone.*not available/,
    );
    expect(r('void loop(){}').errors[0]!.message).toMatch(/void setup\(\)/);
    expect(r('String s = "x";\nvoid setup(){}\nvoid loop(){}').errors[0]!.message).toMatch(
      /String class is not supported/,
    );
    expect(r('long big[2000];\nvoid setup(){}\nvoid loop(){}').errors[0]!.message).toMatch(
      /2048 bytes of SRAM/,
    );
    expect(r('void setup(){ break; }\nvoid loop(){}').errors[0]!.message).toMatch(/break/);
  });

  it('stops with a runtime error (and the line) on an out-of-bounds array access', () => {
    const { sim, mcu } = rig('int a[3];\nvoid setup() {\n  int i = 3;\n  a[i] = 1;\n}\nvoid loop() {}');
    sim.runTo(ms(5));
    expect(mcu.state).toBe('error');
    expect(mcu.events.find((e) => e.kind === 'error')).toMatchObject({
      line: 4,
      message: expect.stringContaining('out of bounds'),
    });
  });
});

describe('UNO runtime on simulation time', () => {
  it('blinks a pin through a resistor and LED with delay()-accurate timing', () => {
    const { sim, u } = rig(
      `void setup(){ pinMode(13, OUTPUT); }
       void loop(){ digitalWrite(13, HIGH); delay(100); digitalWrite(13, LOW); delay(100); }`,
      (b, uno) => {
        const r = b.resistor(220);
        const led = b.add({
          type: 'led',
          model: { saturationCurrentA: 1e-19, emissionCoefficient: 1.8, seriesResistanceOhm: 2 },
          color: 'red',
          maxForwardCurrentA: null,
          maxReverseVoltageV: null,
          preset: 't',
        });
        b.wire(`${uno}.D13`, `${r}.p1`).wire(`${r}.p2`, `${led}.a`).wire(`${led}.k`, `${uno}.GND.1`);
      },
    );
    sim.runTo(ms(1000));
    const d13 = sim.net.pinNet(u, 'D13');
    const tr = sim.net.log.of(d13);
    const rises = tr.t.filter((_, i) => tr.level[i] === '1' && (i === 0 || tr.level[i - 1] !== '1'));
    // Period = 200 ms + a few µs of modelled call overhead per cycle.
    const period = (rises[rises.length - 1]! - rises[1]!) / (rises.length - 2);
    expect(period / 1e6).toBeGreaterThan(200);
    expect(period / 1e6).toBeLessThan(200.1);
    // While HIGH the pin sits below 5 V: the LED current flows through the 25 Ω output model.
    const v = tr.v.filter((_x, i) => tr.level[i] === '1');
    expect(Math.max(...v)).toBeLessThan(5);
    expect(Math.max(...v)).toBeGreaterThan(4.6);
  });

  it('pulseIn measures a pulse from exact edge times; times out to 0', () => {
    const { sim, out } = rig(
      `void setup(){ Serial.begin(115200); }
       void loop(){
         unsigned long w = pulseIn(7, HIGH);
         Serial.println(w);
         unsigned long z = pulseIn(8, HIGH, 5000);
         Serial.println(z);
         delay(1000);
       }`,
      (b, uno) => {
        const clk = b.add({ type: 'clock', frequencyHz: 400, duty: 0.3, logicV: 5 }); // 750 µs high
        b.wire(`${clk}.out`, `${uno}.D7`);
        const g = b.ground();
        b.wire(`${g}.gnd`, `${uno}.GND.1`);
        const r = b.resistor(10_000);
        b.wire(`${r}.p1`, `${uno}.D8`).wire(`${r}.p2`, `${g}.gnd`); // pulled down: never HIGH
      },
    );
    sim.runTo(ms(30));
    expect(out().split('\r\n').slice(0, 2)).toEqual(['750', '0']);
  });

  it('interrupts count edges while the main program sleeps', () => {
    const { sim, out } = rig(
      `volatile unsigned int n = 0;
       void tick() { n++; }
       void setup(){ Serial.begin(115200); attachInterrupt(digitalPinToInterrupt(2), tick, RISING); }
       void loop(){ delay(100); noInterrupts(); unsigned int c = n; n = 0; interrupts(); Serial.println(c); }`,
      (b, uno) => {
        const clk = b.add({ type: 'clock', frequencyHz: 1000, duty: 0.5, logicV: 5 });
        b.wire(`${clk}.out`, `${uno}.D2`);
      },
    );
    sim.runTo(ms(350));
    const counts = out().split('\r\n').filter(Boolean).map(Number);
    expect(counts.length).toBeGreaterThanOrEqual(3);
    for (const c of counts.slice(1)) expect(Math.abs(c - 100)).toBeLessThanOrEqual(1);
  });

  it('analogRead returns the 10-bit code of the solved divider voltage', () => {
    const { sim, out } = rig(
      `void setup(){ Serial.begin(115200); Serial.println(analogRead(A0)); }
       void loop(){ delay(1000); }`,
      (b, uno) => {
        const r1 = b.resistor(10_000);
        const r2 = b.resistor(4_700);
        b.wire(`${uno}.5V`, `${r1}.p1`)
          .wire(`${r1}.p2`, `${uno}.A0`)
          .wire(`${r1}.p2`, `${r2}.p1`)
          .wire(`${r2}.p2`, `${uno}.GND.1`);
      },
    );
    sim.runTo(ms(20));
    expect(Number(out().trim())).toBe(Math.floor((4700 / 14700) * 1024)); // 327
  });

  it('serial output is timestamped by its transmission time at the configured baud', () => {
    const { sim, mcu } = rig(
      `void setup(){ Serial.begin(9600); Serial.print("0123456789"); } void loop(){ delay(1000); }`,
    );
    sim.runTo(ms(50));
    // 10 bytes × 10 bits / 9600 baud ≈ 10.42 ms after the call.
    expect(mcu.serial[0]!.t / 1e6).toBeGreaterThan(10.4);
    expect(mcu.serial[0]!.t / 1e6).toBeLessThan(10.6);
  });

  it('flags floating reads instead of inventing a level', () => {
    const { sim, mcu } = rig(
      `void setup(){ pinMode(4, INPUT); Serial.begin(9600); Serial.println(digitalRead(4)); } void loop(){ delay(1000); }`,
    );
    sim.runTo(ms(20));
    expect(mcu.events.some((e) => /floating/.test(e.message))).toBe(true);
    // With INPUT_PULLUP the same pin reads HIGH.
    const r = rig(
      `void setup(){ pinMode(4, INPUT_PULLUP); Serial.begin(9600); Serial.println(digitalRead(4)); } void loop(){ delay(1000); }`,
    );
    r.sim.runTo(ms(20));
    expect(r.out().trim()).toBe('1');
  });

  it('does not run when the board is not powered', () => {
    const { mcu } = rig('void setup(){} void loop(){}', undefined, 'external');
    expect(mcu.state).toBe('unpowered');
  });
});

describe('example sketches', () => {
  it('every bundled sketch passes the UNO compile check', async () => {
    const m = await import('../samples/firmware');
    for (const [name, src] of Object.entries(m)) {
      const r = UnoRuntime.check(src);
      expect({ name, errors: r.errors }).toEqual({ name, errors: [] });
    }
  });

  it('serial commands reach the firmware through the modelled UART', () => {
    const b = new CircuitBuilder();
    const u = b.add(
      { type: 'mcu', board: 'arduino-uno-r3', power: 'usb', firmwareId: 'fw' },
      { definitionId: 'arduino-uno-r3' },
    );
    void u;
    return import('../samples/firmware').then(({ SERIAL_COMMAND_SKETCH }) => {
      b.firmware('fw', 'cmd', SERIAL_COMMAND_SKETCH);
      const def = b.build();
      const sim = createDigitalSim(def);
      const mcu = new UnoRuntime(def.parts[0]!, def.firmware[0]!, sim.net, sim.sched, { opCostNs: 250 });
      mcu.start();
      sim.runTo(ms(10));
      mcu.sendSerial('7 1\n');
      sim.runTo(ms(100));
      const text = mcu.serial.map((c) => c.text).join('');
      expect(text).toContain('D7 = HIGH');
      expect(sim.net.netLevel(sim.net.pinNet(def.parts[0]!.id, 'D7'))).toBe('1');
    });
  });
});
