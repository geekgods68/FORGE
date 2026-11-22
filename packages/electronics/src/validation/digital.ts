import type { Device } from '@forge/engineering-core';
import { CircuitBuilder } from '../builder';
import { cmosThresholds } from '../digital/devices';
import { evalGate, type GateOp, type Logic } from '../digital/logic';
import { createDigitalSim } from '../digital/sim';
import { check, metric, result, type ElectricalValidationResult } from './record';

/** Digital reference cases: truth tables, propagation, sequential logic, PWM, contention, A↔D boundary. */
const SCHED = 'Discrete-event scheduler, integer-ns time, (time, sequence) ordering; inertial gate delays.';
const TEST_DRIVE = { vHigh: 5, rOut: 10, refNet: -1 };

const gate = (op: GateOp, inputs: number, delayNs = 10): Device => ({
  type: 'logic-gate',
  op,
  inputs,
  delayNs,
  logicV: 5,
});

export function truthTables(): ElectricalValidationResult {
  const ops: GateOp[] = ['and', 'or', 'nand', 'nor', 'xor', 'xnor'];
  const metrics = [];
  const EXPECT: Record<GateOp, (a: number, b: number) => number> = {
    and: (a, b) => a & b,
    or: (a, b) => a | b,
    nand: (a, b) => 1 - (a & b),
    nor: (a, b) => 1 - (a | b),
    xor: (a, b) => a ^ b,
    xnor: (a, b) => 1 - (a ^ b),
    not: (a) => 1 - a,
    buffer: (a) => a,
  };
  for (const op of ops) {
    const b = new CircuitBuilder();
    const g = b.add(gate(op, 2));
    const sim = createDigitalSim(b.build());
    let ok = true;
    let t = 0;
    for (const [a, c] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ] as const) {
      sim.net.drive(g, 'in1', a ? '1' : '0', TEST_DRIVE);
      sim.net.drive(g, 'in2', c ? '1' : '0', TEST_DRIVE);
      t += 100;
      sim.runTo(t);
      const out = sim.net.netLevel(sim.net.pinNet(g, 'out'));
      if (out !== (EXPECT[op](a, c) ? '1' : '0')) ok = false;
    }
    metrics.push(check(`${op.toUpperCase()} truth table`, ok));
  }
  // Unknown-value propagation (dominance): 0 dominates AND, 1 dominates OR, else X.
  const unk = [
    evalGate('and', ['Z', '0']) === '0',
    evalGate('and', ['Z', '1']) === 'X',
    evalGate('or', ['X', '1']) === '1',
    evalGate('or', ['X', '0']) === 'X',
    evalGate('xor', ['Z', '1']) === 'X',
    evalGate('not', ['Z']) === 'X',
  ];
  metrics.push(check('Z/X dominance rules (6 cases)', unk.every(Boolean)));
  return result({
    id: 'truth-tables',
    title: 'Gate truth tables and unknown-value propagation',
    category: 'digital',
    conditions:
      'Two-input gates driven through all four input combinations; 100 ns per combination; 10 ns gate delay.',
    solver: SCHED,
    reference:
      'Boolean definitions of AND/OR/NAND/NOR/XOR/XNOR; IEEE 1164-style dominance for unknown inputs.',
    metrics,
  });
}

export function propagation(): ElectricalValidationResult {
  // Three inverters (10 ns, 20 ns, 30 ns) in a chain; an input edge at 1 µs.
  const b = new CircuitBuilder();
  const n1 = b.add(gate('not', 1, 10));
  const n2 = b.add(gate('not', 1, 20));
  const n3 = b.add(gate('not', 1, 30));
  const nb = b.add(gate('buffer', 1, 10));
  b.wire(`${n1}.out`, `${n2}.in1`).wire(`${n2}.out`, `${n3}.in1`);
  const sim = createDigitalSim(b.build());
  sim.net.drive(n1, 'in1', '0', TEST_DRIVE);
  sim.net.drive(nb, 'in1', '0', TEST_DRIVE);
  sim.runTo(500);
  sim.net.drive(n1, 'in1', '1', TEST_DRIVE);
  sim.runTo(1000);
  sim.sched.at(1000, () => sim.net.drive(n1, 'in1', '0', TEST_DRIVE));
  // A 5 ns glitch into the 10 ns buffer must be filtered (inertial delay).
  sim.sched.at(1500, () => sim.net.drive(nb, 'in1', '1', TEST_DRIVE));
  sim.sched.at(1505, () => sim.net.drive(nb, 'in1', '0', TEST_DRIVE));
  sim.runTo(3000);
  const out = sim.net.log.of(sim.net.pinNet(n3, 'out'));
  const k = out.t.findIndex((t) => t >= 1000);
  const glitch = sim.net.log.of(sim.net.pinNet(nb, 'out')).t.filter((t) => t >= 1500);
  return result({
    id: 'propagation',
    title: 'Propagation delay and inertial filtering',
    category: 'digital',
    conditions:
      'Inverter chain with 10 + 20 + 30 ns delays; input falls at t = 1 µs. A 5 ns pulse into a 10 ns buffer.',
    solver: SCHED,
    reference:
      'Output of the third inverter changes exactly 60 ns after the input; a pulse shorter than an inertial delay produces no output transition.',
    metrics: [
      metric('chain output edge time', 1060, out.t[k] ?? NaN, 0, 'ns'),
      check('5 ns glitch filtered by the 10 ns buffer', glitch.length === 0),
    ],
  });
}

export function sequential(): ElectricalValidationResult {
  // 1 MHz clock → 4-bit counter; same clock → D flip-flop wired as a toggle (Q̅ → D).
  const b = new CircuitBuilder();
  const clk = b.add({ type: 'clock', frequencyHz: 1e6, duty: 0.5, logicV: 5 });
  const cnt = b.add({ type: 'counter', bits: 4, delayNs: 5, logicV: 5 });
  const ff = b.add({ type: 'dff', delayNs: 5, logicV: 5 });
  const g = b.ground();
  void g;
  b.wire(`${clk}.out`, `${cnt}.clk`).wire(`${clk}.out`, `${ff}.clk`).wire(`${ff}.qn`, `${ff}.d`);
  const sim = createDigitalSim(b.build());
  sim.net.drive(cnt, 'rst', '0', TEST_DRIVE);
  // 20 rising edges happen at t = 0 … 19 µs; sample at 19.5 µs.
  sim.runTo(19_500);
  const bits = [0, 1, 2, 3].map((i) => sim.net.netLevel(sim.net.pinNet(cnt, `q${i}`)));
  const value = bits.reduce((v, l, i) => v + (l === '1' ? 1 << i : 0), 0);
  // The first edge (t = 0) is not a 0→1 transition of an already-known clock: the counter sees
  // 19 rising edges after start, so 19 mod 16 = 3.
  const q = sim.net.log.of(sim.net.pinNet(ff, 'q'));
  const rises = q.t.filter((_, i) => q.level[i] === '1');
  const period = rises.length > 2 ? (rises[rises.length - 1]! - rises[1]!) / (rises.length - 2) : NaN;
  return result({
    id: 'sequential',
    title: 'Counter and D flip-flop (toggle) on a 1 MHz clock',
    category: 'digital',
    conditions: '1 MHz, 50 % clock; 4-bit counter (5 ns delay, reset low); D flip-flop with Q̅ fed back to D.',
    solver: SCHED,
    reference:
      'The counter increments on each rising edge after start-up (19 edges by 19.5 µs → 19 mod 16 = 3); the toggle flip-flop divides the clock by two (2 µs period).',
    metrics: [
      metric('counter value', 3, value, 0, ''),
      metric('toggle output period', 2000, period, 0, 'ns'),
    ],
  });
}

export function pwmDuty(): ElectricalValidationResult {
  const metrics = [];
  for (const [f, duty] of [
    [490.2, 0.3],
    [1000, 0.75],
    [50, 0.0745],
  ] as const) {
    const b = new CircuitBuilder();
    const clk = b.add({ type: 'clock', frequencyHz: f, duty, logicV: 5 });
    const x = b.add(gate('buffer', 1, 0));
    b.wire(`${clk}.out`, `${x}.in1`);
    const sim = createDigitalSim(b.build());
    const periods = 10;
    sim.runTo(Math.round((periods / f) * 1e9));
    const tr = sim.net.log.of(sim.net.pinNet(clk, 'out'));
    let high = 0;
    for (let i = 0; i < tr.t.length; i++)
      if (tr.level[i] === '1') high += (tr.t[i + 1] ?? Math.round((periods / f) * 1e9)) - tr.t[i]!;
    metrics.push(metric(`duty at ${f} Hz`, duty, high / ((periods / f) * 1e9), 1e-6, ''));
  }
  return result({
    id: 'pwm-duty',
    title: 'PWM duty cycle',
    category: 'digital',
    conditions:
      'Ideal PWM sources at 490.2 Hz/30 %, 1 kHz/75 % and 50 Hz/7.45 % (≈ 1.49 ms servo pulse); 10 periods.',
    solver: SCHED,
    reference: 'High time / total time equals the configured duty (edge times rounded to 1 ns).',
    metrics,
  });
}

export function contention(): ElectricalValidationResult {
  // Two clocks in antiphase drive one net: whenever they disagree the net is X.
  const b = new CircuitBuilder();
  const c1 = b.add({ type: 'clock', frequencyHz: 1e6, duty: 0.5, logicV: 5 });
  const c2 = b.add({ type: 'clock', frequencyHz: 1e6, duty: 0.25, logicV: 5 });
  b.wire(`${c1}.out`, `${c2}.out`);
  const sim = createDigitalSim(b.build());
  sim.runTo(5000);
  const net = sim.net.pinNet(c1, 'out');
  const levels = sim.net.log.of(net).level;
  // Floating read: an undriven gate input reads Z, so a NOT gate on it outputs X.
  const f = new CircuitBuilder();
  const inv = f.add(gate('not', 1, 1));
  const fs = createDigitalSim(f.build());
  fs.runTo(100);
  return result({
    id: 'contention',
    title: 'Output contention and floating inputs are explicit',
    category: 'digital',
    conditions:
      'Two push-pull clocks (50 % and 25 % duty) tied together for 5 µs; an inverter with an unconnected input.',
    solver: SCHED,
    reference:
      'Conflicting strong drivers resolve to X and raise contention events; an undriven input is Z (not assumed LOW or HIGH), so the inverter output is X.',
    metrics: [
      check('net resolves to X while drivers disagree', levels.includes('X')),
      check(
        'contention events raised',
        sim.net.events.some((e) => e.kind === 'contention'),
      ),
      check('floating input reads Z', fs.net.read(inv, 'in1', cmosThresholds(5), -1) === 'Z'),
      check('inverter of a floating input outputs X', fs.net.netLevel(fs.net.pinNet(inv, 'out')) === 'X'),
    ],
  });
}

export function adBoundary(): ElectricalValidationResult {
  // A 5 V logic output (10 Ω) drives a divider; a CMOS input (V_IL 1.5 V, V_IH 3.5 V) reads the tap.
  const run = (r2: number) => {
    const b = new CircuitBuilder();
    const drv = b.add(gate('buffer', 1, 0));
    const rd = b.add(gate('buffer', 1, 0));
    const g = b.ground();
    const r1 = b.resistor(10_000);
    const r2p = b.resistor(r2);
    b.wire(`${drv}.out`, `${r1}.p1`)
      .wire(`${r1}.p2`, `${r2p}.p1`)
      .wire(`${r2p}.p2`, `${g}.gnd`)
      .wire(`${r1}.p2`, `${rd}.in1`);
    const sim = createDigitalSim(b.build());
    sim.net.drive(drv, 'in1', '1', TEST_DRIVE);
    sim.runTo(100);
    const tap = sim.net.pinNet(rd, 'in1');
    return {
      v: sim.net.voltage(tap)!,
      level: sim.net.read(rd, 'in1', cmosThresholds(5), sim.netlist.ground) as Logic,
    };
  };
  const mid = run(10_000);
  const high = run(30_000);
  const low = run(1_000);
  const exact = (r2: number) => (5 * r2) / (10 + 10_000 + r2);
  return result({
    id: 'ad-boundary',
    title: 'Digital output → analog divider → digital input thresholds',
    category: 'digital',
    conditions:
      'Logic output V_OH = 5 V behind 10 Ω; divider R1 = 10 kΩ, R2 = 1 k / 10 k / 30 kΩ; reader thresholds 0.3·5 V and 0.7·5 V.',
    solver: `${SCHED} Mixed nets solved by MNA (quasi-static).`,
    reference:
      'Tap voltage 5·R2/(10 Ω + R1 + R2); level 0 below 1.5 V, 1 above 3.5 V, X between — a wire never implies a level.',
    metrics: [
      metric('tap voltage (R2 = 10 kΩ)', exact(10_000), mid.v, 1e-9, 'V'),
      check('2.50 V reads X (between thresholds)', mid.level === 'X'),
      check('3.75 V reads 1', high.level === '1'),
      check('0.45 V reads 0', low.level === '0'),
    ],
  });
}

export const DIGITAL_VALIDATION_CASES = [
  truthTables,
  propagation,
  sequential,
  pwmDuty,
  contention,
  adBoundary,
];
