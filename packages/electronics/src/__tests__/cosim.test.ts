import { loadRapier, PhysicsSession, simulationOf, type Rapier } from '@forge/physics';
import type { Project } from '@forge/engineering-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { CoSimulation } from '../cosim/coordinator';
import { speedOfSound, type HcSr04Model, type ServoModel } from '../cosim/devices';
import { physicsPortOf } from '../cosim/physics';
import { structuralChecks } from '../erc';
import { compileNetlist } from '../netlist';
import { createUltrasonicServoSample, GAUGE_JOINT, OBSTACLE_NODE } from '../samples/projects';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

const circuitOf = (p: Project) => {
  const r = p.scene.nodes[p.scene.rootId]!;
  if (r.kind !== 'root' || !r.electrical) throw new Error('no circuit');
  return r.electrical;
};

function run(p: Project) {
  const session = PhysicsSession.fromScene(R, p.scene, simulationOf(p.scene)!);
  expect(session.model.issues.filter((i) => i.severity === 'error')).toEqual([]);
  const port = physicsPortOf(session, p.scene);
  const cs = new CoSimulation(circuitOf(p), {
    physics: port,
    scene: p.scene,
    now: () => new Date('2026-11-22T00:00:00Z'),
  });
  cs.start();
  return { session, port, cs };
}
const lines = (cs: CoSimulation) =>
  cs.mcus[0]!.serial.map((c) => c.text)
    .join('')
    .split('\r\n')
    .filter(Boolean);
const lastReading = (cs: CoSimulation) => {
  const m = /distance_cm=([\d.]+) angle=(\d+)/.exec(
    lines(cs)
      .filter((l) => l.startsWith('distance'))
      .pop() ?? '',
  );
  return m ? { cm: Number(m[1]), angle: Number(m[2]) } : null;
};
const s = (x: number) => Math.round(x * 1e9);

describe('Arduino–HC-SR04–servo co-simulation (sample project)', () => {
  it('the sample is a valid project whose only rule findings are the documented advisories', () => {
    const p = createUltrasonicServoSample(new Date('2026-11-22T00:00:00Z'));
    const def = circuitOf(p);
    const codes = structuralChecks(def, compileNetlist(def), p.scene)
      .filter((i) => i.severity !== 'info')
      .map((i) => i.code);
    expect(codes).toEqual(['controller-rail-load']);
  });

  it('distance comes from the simulated geometry; the servo moves the physical joint; moving the target repeats the cycle', () => {
    const p = createUltrasonicServoSample(new Date('2026-11-22T00:00:00Z'));
    const { port, cs } = run(p);
    const sonar = cs.devices.find((d) => d.part.device.type === 'hc-sr04') as HcSr04Model;
    const servo = cs.devices.find((d) => d.part.device.type === 'servo') as ServoModel;
    expect(cs.mcus[0]!.state).toBe('running');

    cs.advanceTo(s(2));
    const g1 = sonar.measure()!;
    expect(g1).toBeGreaterThan(0.2);
    expect(g1).toBeLessThan(0.26);
    const r1 = lastReading(cs)!;
    // Firmware converts with 0.0343 cm/µs; the model's speed of sound at 20 °C is 343.42 m/s.
    const expectCm = (g: number) => (((2 * g) / speedOfSound(20)) * 1e6 * 0.0343) / 2;
    expect(Math.abs(r1.cm - expectCm(g1))).toBeLessThan(0.02);
    // Firmware angle → pulse (Servo library mapping) → joint target; physics settles near it.
    const deg = (r: number) => (r * 180) / Math.PI;
    expect(Math.abs(deg(servo.targetRad!) - (r1.angle - 90))).toBeLessThan(0.2);
    expect(Math.abs(deg(port.jointQ(GAUGE_JOINT)!) - deg(servo.targetRad!))).toBeLessThan(1.5);

    // Move the obstacle 12 cm further away: new geometry, new echo, new angle, new joint pose.
    expect(port.moveNode(OBSTACLE_NODE, [0.14, 0.08, 0.37]).ok).toBe(true);
    const before = cs.recorder.size;
    cs.advanceTo(s(4));
    const g2 = sonar.measure()!;
    expect(g2 - g1).toBeCloseTo(0.12, 3);
    const r2 = lastReading(cs)!;
    expect(Math.abs(r2.cm - expectCm(g2))).toBeLessThan(0.02);
    expect(r2.angle).toBeGreaterThan(r1.angle + 40);
    expect(Math.abs(deg(port.jointQ(GAUGE_JOINT)!) - (r2.angle - 90))).toBeLessThan(1.5);
    // The joint moved over time within the actuator's speed limit (from the shared-clock telemetry).
    const q = cs.recorder.series('SV1.q')!;
    let maxRate = 0;
    for (let i = before + 1; i < q.t.length; i++)
      maxRate = Math.max(maxRate, Math.abs(q.v[i]! - q.v[i - 1]!) / (q.t[i]! - q.t[i - 1]!));
    const speedLimit = simulationOf(p.scene)!.joints.find((j) => j.mateId === GAUGE_JOINT)!.actuator!
      .speedLimit;
    expect(maxRate).toBeGreaterThan(0.3);
    expect(maxRate).toBeLessThan(speedLimit * 1.1);
    // Repeated cycles: one measurement per loop (~60 ms + echo).
    expect(sonar.measurements.length).toBeGreaterThan(40);
    cs.dispose();
  });

  it('is deterministic: the same inputs give the same signals', () => {
    const run1 = run(createUltrasonicServoSample(new Date('2026-11-22T00:00:00Z')));
    const run2 = run(createUltrasonicServoSample(new Date('2026-11-22T00:00:00Z')));
    run1.cs.advanceTo(s(1));
    run2.cs.advanceTo(s(1));
    expect(lines(run1.cs)).toEqual(lines(run2.cs));
    expect(run1.cs.recorder.series('SV1.q')!.v).toEqual(run2.cs.recorder.series('SV1.q')!.v);
  });

  it('editing the firmware changes the outcome (nothing is scripted)', () => {
    const p = structuredClone(createUltrasonicServoSample(new Date('2026-11-22T00:00:00Z')));
    const def = circuitOf(p);
    // Reverse the mapping: near = 180°.
    def.firmware[0] = {
      ...def.firmware[0]!,
      source: def.firmware[0]!.source.replace(
        'int angle = (int)((clamped - NEAR_CM) * 180.0 / (FAR_CM - NEAR_CM));',
        'int angle = 180 - (int)((clamped - NEAR_CM) * 180.0 / (FAR_CM - NEAR_CM));',
      ),
    };
    const { cs } = run(p);
    cs.advanceTo(s(1.5));
    const r = lastReading(cs)!;
    expect(r.angle).toBeGreaterThan(90);
  });
});
