import { createProject, type ElectricalDefinition, type Mat4 } from '@forge/engineering-core';
import { PhysicsSession, simulationOf, type Rapier } from '@forge/physics';
import { CircuitBuilder } from '../builder';
import { CoSimulation } from '../cosim/coordinator';
import { speedOfSound, type HcSr04Model, type ServoModel } from '../cosim/devices';
import { physicsPortOf, type PhysicsPort } from '../cosim/physics';
import { createDigitalSim } from '../digital/sim';
import { UnoRuntime } from '../firmware/arduino';
import { createUltrasonicServoSample, GAUGE_JOINT, OBSTACLE_NODE } from '../samples/projects';
import { check, metric, result, type ElectricalValidationResult } from './record';

/** Embedded-runtime, sensor and actuator reference cases. */
const RUNTIME = 'UNO Level 2 runtime, op cost 250 ns, integer-ns event scheduler.';
const ms = (x: number) => Math.round(x * 1e6);

function uno(source: string, extra?: (b: CircuitBuilder, u: string) => void) {
  const b = new CircuitBuilder();
  const u = b.add(
    { type: 'mcu', board: 'arduino-uno-r3', power: 'usb', firmwareId: 'fw' },
    { definitionId: 'arduino-uno-r3' },
  );
  b.firmware('fw', 'case', source);
  extra?.(b, u);
  const def = b.build();
  const sim = createDigitalSim(def);
  const mcu = new UnoRuntime(
    def.parts.find((p) => p.id === u)!,
    def.firmware[0]!,
    sim.net,
    sim.sched,
    { opCostNs: 250 },
  );
  mcu.start();
  return { sim, mcu, u, text: () => mcu.serial.map((c) => c.text).join('') };
}

export function embeddedIo(): ElectricalValidationResult {
  // Known program: count to 5 on D12 pulses, print a computed table, toggle D13 with delays.
  const { sim, u, text } = uno(`
    void setup() {
      Serial.begin(115200);
      pinMode(12, OUTPUT);
      pinMode(13, OUTPUT);
      long acc = 0;
      for (int i = 1; i <= 10; i++) acc += (long)i * i;   // 385
      Serial.println(acc);
      int x = 30000;
      x += 10000;                                          // wraps to -25536
      Serial.println(x);
      Serial.println(7 / 2 + 7 % 2);                       // 4
      for (int k = 0; k < 5; k++) { digitalWrite(12, HIGH); delayMicroseconds(100); digitalWrite(12, LOW); delayMicroseconds(100); }
    }
    void loop() { digitalWrite(13, HIGH); delay(250); digitalWrite(13, LOW); delay(250); }`);
  sim.runTo(ms(2100));
  const out = text().split('\r\n');
  const d12 = sim.net.log.of(sim.net.pinNet(u, 'D12'));
  const pulses = d12.level.filter((l, i) => l === '1' && d12.level[i - 1] === '0').length;
  const d13 = sim.net.log.of(sim.net.pinNet(u, 'D13'));
  const rises = d13.t.filter((_, i) => d13.level[i] === '1' && d13.level[i - 1] !== '1');
  const period = (rises[rises.length - 1]! - rises[0]!) / (rises.length - 1);
  return result({
    id: 'embedded-io',
    title: 'Known input/output program: arithmetic, pin mapping, delays',
    category: 'embedded',
    conditions:
      'UNO (USB), sketch computes Σi² (i = 1…10), a 16-bit overflow and integer division; 5 pulses on D12; D13 toggled every 250 ms.',
    solver: RUNTIME,
    reference:
      'C/AVR semantics: Σ = 385, 30000 + 10000 = −25536 in int16, 7/2 + 7%2 = 4. delay(250) twice per cycle → 500 ms period plus the modelled call costs (≈ 4 µs per digitalWrite).',
    metrics: [
      check('printed 385, −25536, 4', out[0] === '385' && out[1] === '-25536' && out[2] === '4'),
      metric('D12 pulses (pin mapping D12 → its net)', 5, pulses, 0, ''),
      metric('D13 period', 500e6, period, 50e3, 'ns'),
    ],
  });
}

export function embeddedTiming(): ElectricalValidationResult {
  const { sim, mcu } = uno(`
    unsigned long t0;
    void setup() { Serial.begin(1000000); t0 = micros(); delay(10); Serial.println(micros() - t0); Serial.println(millis()); }
    void loop() { delay(1000); }`);
  sim.runTo(ms(50));
  const [dt, mil] = mcu.serial
    .map((c) => c.text)
    .join('')
    .split('\r\n')
    .map(Number);
  // Serial: 20 bytes at 9600 baud → 20 × 10 / 9600 s = 20.83 ms after the call.
  const s = uno(
    `void setup(){ Serial.begin(9600); Serial.print("ABCDEFGHIJKLMNOPQRST"); } void loop(){ delay(1000); }`,
  );
  s.sim.runTo(ms(100));
  return result({
    id: 'embedded-timing',
    title: 'Timer resolution and UART timing',
    category: 'embedded',
    conditions: 'micros() around delay(10); millis() after it; 20 bytes printed at 9600 baud.',
    solver: RUNTIME,
    reference:
      'micros() has 4 µs resolution on a 16 MHz UNO (Arduino reference), so the delta is a multiple of 4 near 10 000 µs; UART: 10 bits per byte.',
    metrics: [
      check('micros() delta is a multiple of 4 µs', dt! % 4 === 0),
      metric('micros() delta over delay(10)', 10_000, dt!, 40, 'µs'),
      metric('millis() after setup', 10, mil!, 1, 'ms'),
      metric('UART completion time, 20 bytes @ 9600', (20 * 10) / 9600, s.mcu.serial[0]!.t / 1e9, 1e-4, 's'),
    ],
  });
}

/** A stub world: the sensor sits at the origin facing +Z, a wall at `distance` metres. */
function stubWorld(distance: () => number | null): PhysicsPort {
  const I: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return {
    stepS: 1 / 120,
    step: () => true,
    setMotorTarget: () => ({ ok: true }),
    jointQ: () => 0,
    nodeMatrix: () => I,
    castRay: (_o, d) => {
      const g = distance();
      if (g === null) return null;
      const cos = d[2] / Math.hypot(...d);
      return cos > 0 ? { distance: g / cos, bodyId: 'wall' } : null;
    },
    moveNode: () => ({ ok: true }),
  };
}

function sonarRig(distance: () => number | null, patch: Record<string, unknown> = {}) {
  const p = createProject('Sensor case', new Date('2026-11-22T00:00:00Z'));
  // Place an HC-SR04 component so the model has its transducer geometry.
  const nodeId = 'sonar';
  const scene = JSON.parse(JSON.stringify(p.scene)) as typeof p.scene;
  scene.nodes[nodeId] = {
    id: nodeId,
    kind: 'component-instance',
    definitionId: 'hc-sr04',
    name: 'HC-SR04',
    parentId: scene.rootId,
    childIds: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    metadata: {},
    component: {
      definitionId: 'hc-sr04',
      variantId: null,
      parameters: {},
      materialId: null,
      connections: [],
    },
  } as unknown as (typeof scene.nodes)[string];
  const b = new CircuitBuilder();
  const u = b.add(
    { type: 'mcu', board: 'arduino-uno-r3', power: 'usb', firmwareId: 'fw' },
    { definitionId: 'arduino-uno-r3' },
  );
  const s = b.add(
    {
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
      ...patch,
    } as never,
    { definitionId: 'hc-sr04', nodeId },
  );
  b.wire(`${u}.5V`, `${s}.vcc`)
    .wire(`${u}.GND.1`, `${s}.gnd`)
    .wire(`${u}.D7`, `${s}.trig`)
    .wire(`${s}.echo`, `${u}.D8`);
  b.firmware(
    'fw',
    'echo',
    `void setup(){ Serial.begin(1000000); pinMode(7, OUTPUT); }
     void loop(){ digitalWrite(7, HIGH); delayMicroseconds(10); digitalWrite(7, LOW);
                  Serial.println(pulseIn(8, HIGH, 60000)); delay(20); }`,
  );
  const def: ElectricalDefinition = b.build();
  const cs = new CoSimulation(def, { physics: stubWorld(distance), scene });
  cs.start();
  return { cs, sonar: cs.devices[0] as HcSr04Model };
}

export function sensorEcho(): ElectricalValidationResult {
  let d: number | null = 0.5;
  const { cs, sonar } = sonarRig(() => d);
  cs.advanceTo(ms(200));
  const m1 = sonar.measurements.at(-1)!;
  const c = speedOfSound(20);
  const pulse1 = Number(
    cs.mcus[0]!.serial.map((x) => x.text)
      .join('')
      .split('\r\n')
      .filter(Boolean)
      .at(-1),
  );
  d = 1.234;
  cs.advanceTo(ms(400));
  const m2 = sonar.measurements.at(-1)!;
  d = 5; // beyond the 4 m maximum
  cs.advanceTo(ms(700));
  const far = sonar.measurements.at(-1)!;
  d = 0.01; // inside the 2 cm minimum
  cs.advanceTo(ms(900));
  const near = sonar.measurements.at(-1)!;
  d = null; // nothing at all
  cs.advanceTo(ms(1200));
  const none = sonar.measurements.at(-1)!;
  const printed = cs.mcus[0]!.serial.map((x) => x.text)
    .join('')
    .split('\r\n')
    .filter(Boolean);
  // Noise disabled: repeated measurements of one geometry are identical.
  const same = sonar.measurements.filter((m) => m.geometricM === 0.5).map((m) => m.echoUs);
  return result({
    id: 'sensor-echo',
    title: 'HC-SR04: known distance → echo duration; range limits; no-echo timeout',
    category: 'sensor',
    conditions:
      'Stub world: a plane at a set distance in front of the sensor (exact geometry). 20 °C, noise off. Firmware triggers with 10 µs and reads pulseIn(…, 60 ms).',
    solver: `${RUNTIME} HC-SR04 model: centre + 6 cone rays (nearest hit).`,
    reference:
      'Echo width = 2d / c with c = 331.3 + 0.606·T = 343.42 m/s; outside 2–400 cm the module returns its no-echo pulse (38 ms, configured).',
    metrics: [
      metric('echo width at 0.500 m', ((2 * 0.5) / c) * 1e6, m1.echoUs, 1e-6, 'µs'),
      metric('echo width at 1.234 m', ((2 * 1.234) / c) * 1e6, m2.echoUs, 1e-6, 'µs'),
      metric('pulseIn() reading at 0.500 m (integer µs)', Math.round(((2 * 0.5) / c) * 1e6), pulse1, 1, 'µs'),
      metric('beyond 4 m → no-echo pulse', 38_000, far.echoUs, 0, 'µs'),
      metric('inside 2 cm → no-echo pulse', 38_000, near.echoUs, 0, 'µs'),
      metric('no reflector → no-echo pulse', 38_000, none.echoUs, 0, 'µs'),
      check('the firmware reads 38 000 µs for the no-echo pulse', printed.includes('38000')),
      check('noise off: identical repeated readings', same.length > 3 && same.every((w) => w === same[0])),
    ],
  });
}

export function sensorNoise(): ElectricalValidationResult {
  const { cs, sonar } = sonarRig(() => 1, { noiseStdM: 0.005 });
  cs.advanceTo(ms(8000));
  const r = sonar.measurements.map((m) => m.reportedM!).filter((x) => x !== null);
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1));
  const { cs: cs2, sonar: s2 } = sonarRig(() => 1, { noiseStdM: 0.005 });
  cs2.advanceTo(ms(2000));
  return result({
    id: 'sensor-noise',
    title: 'HC-SR04 noise model: unbiased, configured σ, reproducible',
    category: 'sensor',
    conditions: `Plane at 1.000 m, σ = 5 mm, ${r.length} measurements (seed 1).`,
    solver: RUNTIME,
    reference:
      'Gaussian noise (Box–Muller on the seeded generator): sample mean ≈ 1 m, sample σ ≈ 5 mm; the same seed gives the same sequence.',
    metrics: [
      metric('sample mean', 1, mean, (3 * 0.005) / Math.sqrt(r.length) + 1e-4, 'm'),
      metric('sample σ', 0.005, sd, 0.2, '', true),
      check(
        'same seed → same readings',
        s2.measurements.every((m, i) => m.reportedM === sonar.measurements[i]!.reportedM),
      ),
    ],
  });
}

export function servoPulseMapping(): ElectricalValidationResult {
  // The Servo library maps write(angle) to 544…2400 µs; the servo model decodes the width.
  const b = new CircuitBuilder();
  const u = b.add(
    { type: 'mcu', board: 'arduino-uno-r3', power: 'usb', firmwareId: 'fw' },
    { definitionId: 'arduino-uno-r3' },
  );
  const sv = b.add({
    type: 'servo',
    model: 'generic',
    mateId: null,
    pulseMinUs: 544,
    pulseMaxUs: 2400,
    angleRangeDeg: 180,
    jointCentreRad: 0,
    direction: 1,
    deadbandUs: 0,
    validMinUs: 400,
    validMaxUs: 2600,
    minSupplyV: 4.8,
    maxSupplyV: 6,
  });
  b.wire(`${u}.D9`, `${sv}.signal`).wire(`${u}.5V`, `${sv}.vplus`).wire(`${u}.GND.1`, `${sv}.gnd`);
  b.firmware(
    'fw',
    'sweep',
    `#include <Servo.h>\nServo s;\nint a = 0;\nvoid setup(){ s.attach(9); s.write(0); }\nvoid loop(){ delay(100); a = a == 0 ? 90 : (a == 90 ? 180 : 0); s.write(a); }`,
  );
  const cs = new CoSimulation(b.build(), { physics: null, scene: null });
  cs.start();
  const model = cs.devices[0] as ServoModel;
  const at = (t: number) => {
    cs.advanceTo(ms(t));
    return { w: model.lastWidthUs, a: model.angleDeg };
  };
  const s0 = at(90);
  const s90 = at(190);
  const s180 = at(290);
  return result({
    id: 'servo-pwm',
    title: 'PWM command → servo target (Servo library mapping, pulse decoding)',
    category: 'actuator',
    conditions:
      'write(0), write(90), write(180) at 100 ms intervals; 50 Hz frames; servo model 544–2400 µs over 180°.',
    solver: RUNTIME,
    reference:
      'Servo library: µs = map(angle, 0, 180, 544, 2400) (integer) → 544, 1472, 2400 µs; decoded angle = (µs − 544)/(2400 − 544)·180.',
    metrics: [
      metric('pulse for write(0)', 544, s0.w!, 1e-6, 'µs'),
      metric('pulse for write(90)', 1472, s90.w!, 1e-6, 'µs'),
      metric('pulse for write(180)', 2400, s180.w!, 1e-6, 'µs'),
      metric('decoded angle for 1472 µs', 90, s90.a!, 1e-9, '°'),
    ],
  });
}

export function servoPhysics(R: Rapier): ElectricalValidationResult {
  const p = createUltrasonicServoSample(new Date('2026-11-22T00:00:00Z'));
  const root = p.scene.nodes[p.scene.rootId]!;
  if (root.kind !== 'root' || !root.electrical) throw new Error('sample has no circuit');
  const session = PhysicsSession.fromScene(R, p.scene, simulationOf(p.scene)!);
  const port = physicsPortOf(session, p.scene);
  const cs = new CoSimulation(root.electrical, { physics: port, scene: p.scene });
  cs.start();
  cs.advanceTo(ms(2000));
  const servo = cs.devices.find((d) => d.part.device.type === 'servo') as ServoModel;
  const t1 = servo.targetRad!;
  const err1 = Math.abs(port.jointQ(GAUGE_JOINT)! - t1);
  const n0 = (cs.devices.find((d) => d.part.device.type === 'hc-sr04') as HcSr04Model).measurements.length;
  port.moveNode(OBSTACLE_NODE, [0.14, 0.08, 0.4]);
  const before = cs.recorder.size;
  cs.advanceTo(ms(4000));
  const q = cs.recorder.series('SV1.q')!;
  let rate = 0;
  for (let i = before + 1; i < q.t.length; i++)
    rate = Math.max(rate, Math.abs(q.v[i]! - q.v[i - 1]!) / (q.t[i]! - q.t[i - 1]!));
  const limit = simulationOf(p.scene)!.joints.find((j) => j.mateId === GAUGE_JOINT)!.actuator!.speedLimit;
  const n1 = (cs.devices.find((d) => d.part.device.type === 'hc-sr04') as HcSr04Model).measurements.length;
  const err2 = Math.abs(port.jointQ(GAUGE_JOINT)! - servo.targetRad!);
  cs.dispose();
  return result({
    id: 'servo-physics',
    title: 'Servo command → Phase 5 joint motion within the actuator limits; repeated cycles',
    category: 'actuator',
    conditions:
      'Ultrasonic servo gauge sample (SG90-cited limits, generic dynamics); target moved from 0.25 m to 0.40 m at t = 2 s.',
    solver: `${RUNTIME} Rapier ${R.version()} at 120 Hz × 4 sub-steps.`,
    reference:
      'The servo only sets the joint target; the Phase 5 actuator (speed-limited setpoint + PID, effort-saturated) produces the motion: the joint settles near the target and never exceeds the cited no-load speed.',
    metrics: [
      metric('settled joint error before the move', 0, (err1 * 180) / Math.PI, 1.5, '°'),
      metric('settled joint error after the move', 0, (err2 * 180) / Math.PI, 1.5, '°'),
      metric('peak joint speed ≤ speed limit', 0, Math.max(0, rate - limit), 0.05 * limit, 'rad/s'),
      check('joint moved after the target moved (peak speed > 0.3 rad/s)', rate > 0.3),
      check('sensor → controller → actuator cycles continued (≥ 25 more measurements)', n1 - n0 >= 25),
    ],
  });
}

export const COSIM_VALIDATION_CASES = [
  embeddedIo,
  embeddedTiming,
  sensorEcho,
  sensorNoise,
  servoPulseMapping,
];
export const COSIM_PHYSICS_VALIDATION_CASES = [servoPhysics];
