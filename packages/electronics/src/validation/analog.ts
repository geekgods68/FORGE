import { analogCircuitOf } from '../analog/build';
import { VT_NOMINAL, type OpResult } from '../analog/circuit';
import { CircuitBuilder } from '../builder';
import { check, lambertW, metric, result, type ElectricalValidationResult } from './record';

/** Analog reference cases: resistive (DC), RC, RL, RLC transients, nonlinear devices, diagnostics. */
const op = (r: OpResult) => {
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return r;
};
const DC_SOLVER = 'MNA, sparse LU (Markowitz + threshold pivoting); linear: one factorisation';

export function seriesParallelDivider(): ElectricalValidationResult {
  // 10 V — R1 1 kΩ — n1 — (R2 2 kΩ ∥ R3 6 kΩ) — GND, plus a divider R4 3 kΩ / R5 7 kΩ.
  const b = new CircuitBuilder('Resistive network');
  const v = b.dcSource(10);
  const g = b.ground();
  const r1 = b.resistor(1000);
  const r2 = b.resistor(2000);
  const r3 = b.resistor(6000);
  const r4 = b.resistor(3000);
  const r5 = b.resistor(7000);
  b.wire(`${v}.neg`, `${g}.gnd`)
    .wire(`${v}.pos`, `${r1}.p1`)
    .wire(`${r1}.p2`, `${r2}.p1`)
    .wire(`${r1}.p2`, `${r3}.p1`)
    .wire(`${r2}.p2`, `${g}.gnd`)
    .wire(`${r3}.p2`, `${g}.gnd`)
    .wire(`${v}.pos`, `${r4}.p1`)
    .wire(`${r4}.p2`, `${r5}.p1`)
    .label('MID', `${r1}.p2`)
    .label('DIV', `${r4}.p2`)
    .wire(`${r5}.p2`, `${g}.gnd`);
  const def = b.build();
  const c = analogCircuitOf(def);
  const r = op(c.dc());
  const net = (n: string) => r.v[c.netlist.netByName(n)!.index]!;
  const rp = (2000 * 6000) / 8000; // 1.5 kΩ
  const vMid = (10 * rp) / (1000 + rp);
  const iTotal = 10 / (1000 + rp) + 10 / 10_000;
  // KCL at MID: I(R1) = I(R2) + I(R3); KVL around V–R1–R2: 10 − V(R1) − V(R2) = 0.
  const i1 = r.i.get('R1')!;
  const i2 = r.i.get('R2')!;
  const i3 = r.i.get('R3')!;
  const kvl = 10 - i1 * 1000 - i2 * 2000;
  return result({
    id: 'dc-resistive',
    title: 'Series/parallel resistors and a voltage divider (DC)',
    category: 'resistive',
    conditions:
      '10 V ideal source; R1 = 1 kΩ in series with R2 = 2 kΩ ∥ R3 = 6 kΩ; divider R4 = 3 kΩ / R5 = 7 kΩ.',
    solver: DC_SOLVER,
    reference:
      'Ohm’s law: R2∥R3 = 1.5 kΩ, V(MID) = 10·1.5/2.5 = 6 V, V(DIV) = 10·7/10 = 7 V; Kirchhoff’s current and voltage laws.',
    metrics: [
      metric('V(MID)', vMid, net('MID'), 1e-9, 'V'),
      metric('V(DIV)', 7, net('DIV'), 1e-9, 'V'),
      metric('source current', iTotal, -r.i.get('V1')!, 1e-12, 'A'),
      metric('KCL residual at MID', 0, i1 - i2 - i3, 1e-12, 'A'),
      metric('KVL residual (V1–R1–R2)', 0, kvl, 1e-9, 'V'),
    ],
  });
}

export function currentSourceAndControlled(): ElectricalValidationResult {
  // 2 mA into 1 kΩ; a VCVS (gain 3) copies it to 10 kΩ; a VCCS (1 mS) drives 2 kΩ.
  const b = new CircuitBuilder('Sources');
  const g = b.ground();
  const i = b.add({ type: 'isource', waveform: { kind: 'dc', value: 0.002 } });
  const r1 = b.resistor(1000);
  const e = b.add({ type: 'vcvs', gain: 3 });
  const r2 = b.resistor(10_000);
  const gm = b.add({ type: 'vccs', transconductanceS: 0.001 });
  const r3 = b.resistor(2000);
  b.wire(`${i}.neg`, `${g}.gnd`)
    .wire(`${i}.pos`, `${r1}.p1`)
    .wire(`${r1}.p2`, `${g}.gnd`)
    .label('IN', `${r1}.p1`)
    .wire(`${e}.ctl+`, `${r1}.p1`)
    .wire(`${e}.ctl-`, `${g}.gnd`)
    .wire(`${e}.out-`, `${g}.gnd`)
    .wire(`${e}.out+`, `${r2}.p1`)
    .label('OUT', `${r2}.p1`)
    .wire(`${r2}.p2`, `${g}.gnd`)
    .wire(`${gm}.ctl+`, `${r1}.p1`)
    .wire(`${gm}.ctl-`, `${g}.gnd`)
    .wire(`${gm}.out+`, `${g}.gnd`)
    .wire(`${gm}.out-`, `${r3}.p1`)
    .label('GOUT', `${r3}.p1`)
    .wire(`${r3}.p2`, `${g}.gnd`);
  const c = analogCircuitOf(b.build());
  const r = op(c.dc());
  const net = (n: string) => r.v[c.netlist.netByName(n)!.index]!;
  return result({
    id: 'dc-sources',
    title: 'Current source and controlled sources (DC)',
    category: 'resistive',
    conditions: 'I = 2 mA into 1 kΩ; VCVS gain 3 into 10 kΩ; VCCS 1 mS (out+ → out−) into 2 kΩ.',
    solver: DC_SOLVER,
    reference:
      'V(IN) = 2 mA·1 kΩ = 2 V; V(OUT) = 3·2 V = 6 V; VCCS current 1 mS·2 V = 2 mA flows GND→GOUT through the source, so V(GOUT) = 2 mA·2 kΩ = 4 V.',
    metrics: [
      metric('V(IN)', 2, net('IN'), 1e-9, 'V'),
      metric('V(OUT)', 6, net('OUT'), 1e-9, 'V'),
      metric('V(GOUT)', 4, net('GOUT'), 1e-9, 'V'),
    ],
  });
}

function rcCircuit(ic: number, vs: number) {
  const b = new CircuitBuilder('RC');
  const v = b.add({
    type: 'vsource',
    waveform: { kind: 'dc', value: vs },
    seriesResistanceOhm: 0,
    currentLimitA: null,
    purpose: 'signal',
  });
  const g = b.ground();
  const r = b.resistor(1000);
  const c = b.capacitor(1e-6, ic);
  b.wire(`${v}.neg`, `${g}.gnd`)
    .wire(`${v}.pos`, `${r}.p1`)
    .wire(`${r}.p2`, `${c}.p1`)
    .label('VC', `${c}.p1`)
    .wire(`${c}.p2`, `${g}.gnd`);
  return b.build();
}

/** Max |error| of a transient trace against f(t) (NaN-safe). */
function maxErr(t: number[], v: number[], f: (t: number) => number) {
  let e = 0;
  for (let k = 0; k < t.length; k++) e = Math.max(e, Math.abs(v[k]! - f(t[k]!)));
  return e;
}

export function rcCharging(): ElectricalValidationResult {
  const tau = 1e-3;
  const def = rcCircuit(0, 5);
  const c = analogCircuitOf(def);
  const vc = c.netlist.netByName('VC')!.index;
  const run = (h: number, method: 'trapezoidal' | 'backward-euler') => {
    const r = c.transient(5 * tau, h, { method, maxPoints: 1e6 });
    if (!r.ok) throw new Error(r.diagnostics[0]!.message);
    return r;
  };
  const exact = (t: number) => 5 * (1 - Math.exp(-t / tau));
  const tr = run(1e-5, 'trapezoidal');
  const tr2 = run(5e-6, 'trapezoidal');
  const e1 = maxErr(tr.t, tr.v[vc]!, exact);
  const e2 = maxErr(tr2.t, tr2.v[vc]!, exact);
  const k = tr.t.findIndex((t) => Math.abs(t - tau) < 1e-12);
  const be = run(1e-5, 'backward-euler');
  const eBe = maxErr(be.t, be.v[vc]!, exact);
  return result({
    id: 'rc-charging',
    title: 'RC charging (time constant)',
    category: 'capacitive',
    conditions: '5 V step into R = 1 kΩ, C = 1 µF (τ = 1 ms), v_C(0) = 0; 0 … 5τ.',
    solver:
      'Trapezoidal, fixed step h = 10 µs (and 5 µs), first step backward Euler; BE comparison at 10 µs.',
    reference: 'v_C(t) = 5·(1 − e^(−t/τ)); v_C(τ) = 5·(1 − 1/e) = 3.1606 V.',
    metrics: [
      metric('v_C(τ)', 5 * (1 - Math.exp(-1)), tr.v[vc]![k]!, 1e-3, 'V'),
      metric('max |error|, h = 10 µs', 0, e1, 2e-3, 'V'),
      metric('max |error|, h = 5 µs', 0, e2, 1e-3, 'V'),
      metric('error ratio (second-order ⇒ ≈ 4; first BE step limits it)', 4, e1 / e2, 2.5, ''),
      metric('backward Euler max |error|, h = 10 µs', 0, eBe, 2e-2, 'V'),
    ],
  });
}

export function rcDischarging(): ElectricalValidationResult {
  const tau = 1e-3;
  const c = analogCircuitOf(rcCircuit(5, 0));
  const vc = c.netlist.netByName('VC')!.index;
  const r = c.transient(5 * tau, 1e-5, { maxPoints: 1e6 });
  if (!r.ok) throw new Error(r.diagnostics[0]!.message);
  const exact = (t: number) => 5 * Math.exp(-t / tau);
  // Measured time constant: first time v_C falls below 5/e.
  const k = r.v[vc]!.findIndex((v) => v <= 5 / Math.E);
  const t0 = r.t[k - 1]!;
  const t1 = r.t[k]!;
  const v0 = r.v[vc]![k - 1]!;
  const v1 = r.v[vc]![k]!;
  const tauMeasured = t0 + ((5 / Math.E - v0) * (t1 - t0)) / (v1 - v0);
  return result({
    id: 'rc-discharging',
    title: 'RC discharging (time-constant measurement)',
    category: 'capacitive',
    conditions:
      'C = 1 µF charged to 5 V (initial condition), discharging through R = 1 kΩ to a 0 V source; 0 … 5τ.',
    solver: 'Trapezoidal, h = 10 µs, first step backward Euler.',
    reference: 'v_C(t) = 5·e^(−t/τ), τ = RC = 1 ms.',
    metrics: [
      metric('max |error|', 0, maxErr(r.t, r.v[vc]!, exact), 2e-3, 'V'),
      metric('measured τ', tau, tauMeasured, 2e-3, '', true),
    ],
  });
}

export function rlStep(): ElectricalValidationResult {
  // 10 V — R 100 Ω — L 10 mH — GND; τ = L/R = 100 µs; I∞ = 0.1 A.
  const b = new CircuitBuilder('RL');
  const v = b.dcSource(10);
  const g = b.ground();
  const r = b.resistor(100);
  const l = b.inductor(10e-3, 0);
  b.wire(`${v}.neg`, `${g}.gnd`)
    .wire(`${v}.pos`, `${r}.p1`)
    .wire(`${r}.p2`, `${l}.p1`)
    .wire(`${l}.p2`, `${g}.gnd`);
  const c = analogCircuitOf(b.build());
  const tau = 1e-4;
  const res = c.transient(5 * tau, 1e-6, { maxPoints: 1e6 });
  if (!res.ok) throw new Error(res.diagnostics[0]!.message);
  const iL = res.i.get('L1')!;
  const exact = (t: number) => 0.1 * (1 - Math.exp(-t / tau));
  return result({
    id: 'rl-step',
    title: 'RL step response',
    category: 'inductive',
    conditions: '10 V step into R = 100 Ω, L = 10 mH (τ = 100 µs), i_L(0) = 0; 0 … 5τ.',
    solver: 'Trapezoidal, h = 1 µs, first step backward Euler.',
    reference: 'i_L(t) = (V/R)·(1 − e^(−t/τ)).',
    metrics: [
      metric('max |error| of i_L', 0, maxErr(res.t, iL, exact), 2e-5, 'A'),
      metric('i_L(5τ)', exact(5 * tau), iL[iL.length - 1]!, 2e-5, 'A'),
    ],
  });
}

export function rlcUnderdamped(): ElectricalValidationResult {
  // Series RLC step: R = 20 Ω, L = 1 mH, C = 1 µF → α = 1e4 /s, ω0 = 31623 rad/s.
  const R = 20;
  const L = 1e-3;
  const C = 1e-6;
  const b = new CircuitBuilder('RLC');
  const v = b.dcSource(1);
  const g = b.ground();
  const r = b.resistor(R);
  const l = b.inductor(L, 0);
  const cap = b.capacitor(C, 0);
  b.wire(`${v}.neg`, `${g}.gnd`)
    .wire(`${v}.pos`, `${r}.p1`)
    .wire(`${r}.p2`, `${l}.p1`)
    .wire(`${l}.p2`, `${cap}.p1`)
    .label('VC', `${cap}.p1`)
    .wire(`${cap}.p2`, `${g}.gnd`);
  const c = analogCircuitOf(b.build());
  const alpha = R / (2 * L);
  const w0 = 1 / Math.sqrt(L * C);
  const wd = Math.sqrt(w0 * w0 - alpha * alpha);
  const exact = (t: number) =>
    1 - Math.exp(-alpha * t) * (Math.cos(wd * t) + (alpha / wd) * Math.sin(wd * t));
  const res = c.transient(1e-3, 5e-7, { maxPoints: 1e6 });
  if (!res.ok) throw new Error(res.diagnostics[0]!.message);
  const vc = res.v[c.netlist.netByName('VC')!.index]!;
  let peak = 0;
  let tPeak = 0;
  vc.forEach((x, k) => {
    if (x > peak) {
      peak = x;
      tPeak = res.t[k]!;
    }
  });
  return result({
    id: 'rlc-underdamped',
    title: 'Series RLC step response (underdamped)',
    category: 'rlc',
    conditions: '1 V step, R = 20 Ω, L = 1 mH, C = 1 µF; zero initial state; 0 … 1 ms.',
    solver: 'Trapezoidal, h = 0.5 µs (≈ 400 steps per period), first step backward Euler.',
    reference:
      'v_C = 1 − e^(−αt)(cos ω_d t + (α/ω_d) sin ω_d t), α = R/2L, ω_d = √(1/LC − α²); first peak at π/ω_d with overshoot e^(−απ/ω_d).',
    metrics: [
      metric('max |error| of v_C', 0, maxErr(res.t, vc, exact), 2e-3, 'V'),
      metric('first peak time', Math.PI / wd, tPeak, 1e-2, '', true),
      metric('overshoot', Math.exp((-alpha * Math.PI) / wd), peak - 1, 1e-2, '', true),
    ],
  });
}

export function switchedRc(): ElectricalValidationResult {
  // A pulse source (0 → 5 V at 1 ms, back to 0 at 3 ms) drives the RC: piecewise exponentials.
  const b = new CircuitBuilder('Switched RC');
  const v = b.add({
    type: 'vsource',
    waveform: { kind: 'pulse', v1: 0, v2: 5, delayS: 1e-3, riseS: 0, fallS: 0, widthS: 2e-3, periodS: 1 },
    seriesResistanceOhm: 0,
    currentLimitA: null,
    purpose: 'signal',
  });
  const g = b.ground();
  const r = b.resistor(1000);
  const cap = b.capacitor(1e-6, 0);
  b.wire(`${v}.neg`, `${g}.gnd`)
    .wire(`${v}.pos`, `${r}.p1`)
    .wire(`${r}.p2`, `${cap}.p1`)
    .label('VC', `${cap}.p1`)
    .wire(`${cap}.p2`, `${g}.gnd`);
  const c = analogCircuitOf(b.build());
  const res = c.transient(6e-3, 1e-5, { maxPoints: 1e6 });
  if (!res.ok) throw new Error(res.diagnostics[0]!.message);
  const tau = 1e-3;
  const v3 = 5 * (1 - Math.exp(-2));
  const exact = (t: number) =>
    t < 1e-3 ? 0 : t <= 3e-3 ? 5 * (1 - Math.exp(-(t - 1e-3) / tau)) : v3 * Math.exp(-(t - 3e-3) / tau);
  const vc = res.v[c.netlist.netByName('VC')!.index]!;
  return result({
    id: 'switched-rc',
    title: 'Switched RC (pulse source with breakpoints)',
    category: 'capacitive',
    conditions: 'Ideal pulse 0 → 5 V at 1 ms, back to 0 V at 3 ms (zero rise/fall), R = 1 kΩ, C = 1 µF.',
    solver:
      'Trapezoidal, h = 10 µs; steps land exactly on the source breakpoints, backward Euler right after each.',
    reference: 'Piecewise exponentials with τ = 1 ms; v_C(3 ms) = 5(1 − e^(−2)).',
    metrics: [metric('max |error| of v_C', 0, maxErr(res.t, vc, exact), 3e-3, 'V')],
  });
}

export function diodeResistor(): ElectricalValidationResult {
  // 5 V — 1 kΩ — diode (Is = 1e-14 A, n = 1) — GND: exact solution via Lambert W.
  const Is = 1e-14;
  const n = 1;
  const R = 1000;
  const V = 5;
  const b = new CircuitBuilder('Diode');
  const v = b.dcSource(V);
  const g = b.ground();
  const r = b.resistor(R);
  const d = b.add({
    type: 'diode',
    model: { saturationCurrentA: Is, emissionCoefficient: n, seriesResistanceOhm: 0 },
    maxForwardCurrentA: null,
    maxReverseVoltageV: null,
    preset: 'test',
  });
  b.wire(`${v}.neg`, `${g}.gnd`)
    .wire(`${v}.pos`, `${r}.p1`)
    .wire(`${r}.p2`, `${d}.a`)
    .label('VD', `${d}.a`)
    .wire(`${d}.k`, `${g}.gnd`);
  const def = b.build();
  def.settings.solver.gmin = 0; // compare with the ideal Shockley equation
  const c = analogCircuitOf(def);
  const r0 = op(c.dc());
  const nvt = n * VT_NOMINAL;
  const I = (nvt / R) * lambertW(((Is * R) / nvt) * Math.exp((V + Is * R) / nvt)) - Is;
  return result({
    id: 'diode-resistor',
    title: 'Diode–resistor operating point (nonlinear DC)',
    category: 'nonlinear',
    conditions:
      '5 V source, 1 kΩ, Shockley diode Is = 1e-14 A, n = 1, T = 27 °C (V_T = 25.865 mV), gmin = 0.',
    solver: 'Newton–Raphson with SPICE junction limiting (pnjlim); relTol 1e-6.',
    reference: 'Closed form: I = (nV_T/R)·W((Is·R/nV_T)·e^((V + Is·R)/nV_T)) − Is (Lambert W).',
    metrics: [
      metric('diode current', I, r0.i.get('D1')!, 1e-6, '', true),
      metric('diode voltage', V - I * R, r0.v[c.netlist.netByName('VD')!.index]!, 1e-6, 'V'),
      metric('Newton iterations (≤ 50)', 0, Math.max(0, r0.iterations - 50), 0, ''),
    ],
  });
}

export function mosfetSaturation(): ElectricalValidationResult {
  // VDD 10 V — RD 1 kΩ — drain; gate 3 V; Vth 2 V, K = 2 mA/V² → saturation: Id = K/2·1² = 1 mA.
  const b = new CircuitBuilder('NMOS');
  const g = b.ground();
  const vdd = b.dcSource(10);
  const vg = b.dcSource(3);
  const rd = b.resistor(1000);
  const m = b.add({
    type: 'nmos',
    thresholdV: 2,
    transconductanceAPerV2: 2e-3,
    lambdaPerV: 0,
    maxDrainCurrentA: null,
  });
  b.wire(`${vdd}.neg`, `${g}.gnd`)
    .wire(`${vg}.neg`, `${g}.gnd`)
    .wire(`${vdd}.pos`, `${rd}.p1`)
    .wire(`${rd}.p2`, `${m}.d`)
    .label('D', `${m}.d`)
    .wire(`${vg}.pos`, `${m}.g`)
    .wire(`${m}.s`, `${g}.gnd`);
  const def = b.build();
  def.settings.solver.gmin = 0;
  const c = analogCircuitOf(def);
  const r = op(c.dc());
  // Triode case: gate 10 V → solve K[(Vov)Vds − Vds²/2] = (10 − Vds)/RD for Vds (quadratic).
  const b2 = new CircuitBuilder('NMOS triode');
  Object.assign(b2.def, JSON.parse(JSON.stringify(def)));
  (
    b2.def.parts.find((p) => p.label === 'V2')!.device as { waveform: { kind: 'dc'; value: number } }
  ).waveform = {
    kind: 'dc',
    value: 10,
  };
  const c2 = analogCircuitOf(b2.build());
  const r2 = op(c2.dc());
  const K = 2e-3;
  const vov = 8;
  // K(vov·x − x²/2)·RD = 10 − x  ⇒ (K·RD/2)x² − (K·RD·vov + 1)x + 10 = 0, smaller root.
  const A = (K * 1000) / 2;
  const B = -(K * 1000 * vov + 1);
  const x = (-B - Math.sqrt(B * B - 4 * A * 10)) / (2 * A);
  return result({
    id: 'nmos-switch',
    title: 'NMOS square-law operating points (saturation and triode)',
    category: 'nonlinear',
    conditions:
      'VDD = 10 V, RD = 1 kΩ, Vth = 2 V, K = 2 mA/V², λ = 0; gate at 3 V (saturation) and 10 V (triode).',
    solver: 'Newton–Raphson, level-1 square-law model.',
    reference:
      'Saturation: Id = K/2·(Vgs − Vth)² = 1 mA ⇒ Vd = 9 V. Triode: quadratic in Vds solved in closed form.',
    metrics: [
      metric('Id (saturation)', 1e-3, r.i.get('M1')!, 1e-9, 'A'),
      metric('Vd (triode)', x, r2.v[c2.netlist.netByName('D')!.index]!, 1e-6, 'V'),
    ],
  });
}

export function bjtActive(): ElectricalValidationResult {
  // Base driven through 100 kΩ from 5 V; collector through 1 kΩ from 10 V. Forward active.
  const b = new CircuitBuilder('NPN');
  const g = b.ground();
  const vb = b.dcSource(5);
  const vc = b.dcSource(10);
  const rb = b.resistor(100_000);
  const rc = b.resistor(1000);
  const q = b.add({
    type: 'npn',
    saturationCurrentA: 1e-14,
    betaF: 100,
    betaR: 1,
    maxCollectorCurrentA: null,
  });
  b.wire(`${vb}.neg`, `${g}.gnd`)
    .wire(`${vc}.neg`, `${g}.gnd`)
    .wire(`${vb}.pos`, `${rb}.p1`)
    .wire(`${rb}.p2`, `${q}.b`)
    .label('B', `${q}.b`)
    .wire(`${vc}.pos`, `${rc}.p1`)
    .wire(`${rc}.p2`, `${q}.c`)
    .label('C', `${q}.c`)
    .wire(`${q}.e`, `${g}.gnd`);
  const def = b.build();
  def.settings.solver.gmin = 0;
  const c = analogCircuitOf(def);
  const r = op(c.dc());
  const vB = r.v[c.netlist.netByName('B')!.index]!;
  const vC = r.v[c.netlist.netByName('C')!.index]!;
  const ib = (5 - vB) / 100_000;
  const ic = (10 - vC) / 1000;
  // Independent check: in forward active (Vbc ≪ 0) Ib = Is/βF·(e^(Vbe/VT) − 1) and Ic = βF·Ib.
  const ibModel = (1e-14 / 100) * (Math.exp(vB / VT_NOMINAL) - 1);
  return result({
    id: 'npn-active',
    title: 'NPN forward-active operating point (Ebers–Moll)',
    category: 'nonlinear',
    conditions: 'Is = 1e-14 A, βF = 100, βR = 1; RB = 100 kΩ from 5 V, RC = 1 kΩ from 10 V.',
    solver: 'Newton–Raphson with junction limiting.',
    reference:
      'KCL with the transport model: Ib from the base resistor equals Is/βF·(e^(Vbe/VT) − 1); Ic ≈ βF·Ib in forward active.',
    metrics: [
      metric('Ib (resistor) vs Ib (model)', ibModel, ib, 1e-6, '', true),
      metric('Ic / Ib', 100, ic / ib, 1e-3, '', true),
      check('forward active (Vce > 0.3 V)', vC > 0.3),
    ],
  });
}

export function diagnosticsCases(): ElectricalValidationResult {
  const outcomes: boolean[] = [];
  const codes: string[] = [];
  const expectFail = (def: ReturnType<CircuitBuilder['build']>, code: string) => {
    const r = analogCircuitOf(def).dc();
    codes.push(r.ok ? 'ok' : r.diagnostics.map((d) => d.code).join('+'));
    outcomes.push(!r.ok && r.diagnostics.some((d) => d.code === code));
  };
  // 1. Two ideal sources in parallel with different values.
  {
    const b = new CircuitBuilder();
    const g = b.ground();
    const a = b.dcSource(5);
    const c = b.dcSource(3);
    b.wire(`${a}.neg`, `${g}.gnd`).wire(`${c}.neg`, `${g}.gnd`).wire(`${a}.pos`, `${c}.pos`);
    expectFail(b.build(), 'voltage-source-loop');
  }
  // 2. Shorted source.
  {
    const b = new CircuitBuilder();
    const g = b.ground();
    const a = b.dcSource(5);
    b.wire(`${a}.neg`, `${g}.gnd`).wire(`${a}.pos`, `${g}.gnd`);
    expectFail(b.build(), 'shorted-source');
  }
  // 3. Current source into a capacitor only (no DC path).
  {
    const b = new CircuitBuilder();
    const g = b.ground();
    const i = b.add({ type: 'isource', waveform: { kind: 'dc', value: 1e-3 } });
    const c = b.capacitor(1e-6);
    b.wire(`${i}.neg`, `${g}.gnd`).wire(`${i}.pos`, `${c}.p1`).wire(`${c}.p2`, `${g}.gnd`);
    expectFail(b.build(), 'current-source-no-path');
  }
  // 4. No reference at all (passive network only).
  {
    const b = new CircuitBuilder();
    const r1 = b.resistor(10);
    const r2 = b.resistor(10);
    b.wire(`${r1}.p2`, `${r2}.p1`);
    expectFail(b.build(), 'missing-reference');
  }
  // 5. Floating MOSFET gate.
  {
    const b = new CircuitBuilder();
    const g = b.ground();
    const v = b.dcSource(5);
    const r = b.resistor(1000);
    const m = b.add({
      type: 'nmos',
      thresholdV: 2,
      transconductanceAPerV2: 1e-3,
      lambdaPerV: 0,
      maxDrainCurrentA: null,
    });
    b.wire(`${v}.neg`, `${g}.gnd`)
      .wire(`${v}.pos`, `${r}.p1`)
      .wire(`${r}.p2`, `${m}.d`)
      .wire(`${m}.s`, `${g}.gnd`);
    expectFail(b.build(), 'floating-control');
  }
  return result({
    id: 'solver-diagnostics',
    title: 'Numerical failures are reported, not fabricated',
    category: 'diagnostics',
    conditions:
      'Contradictory parallel sources; a shorted source; a current source into a capacitor; no reference; a floating MOSFET gate.',
    solver: 'Topology checks before factorisation; singular-pivot detection in the LU.',
    reference:
      'Each circuit has no unique DC solution: the solver must refuse with a diagnostic naming the cause.',
    metrics: outcomes.map((ok, i) => check(`case ${i + 1} → ${codes[i]}`, ok)),
  });
}

export const ANALOG_VALIDATION_CASES = [
  seriesParallelDivider,
  currentSourceAndControlled,
  rcCharging,
  rcDischarging,
  rlStep,
  rlcUnderdamped,
  switchedRc,
  diodeResistor,
  mosfetSaturation,
  bjtActive,
  diagnosticsCases,
];
