import type { ElectricalSettings, Waveform } from '@forge/engineering-core';
import type { Netlist } from '../netlist';
import { factor, solveLU, SparseMatrix, type LUFactors } from './sparse';
import { waveBreakpoints, waveValue } from './waveform';

/**
 * Modified nodal analysis (MNA) of the analog part of a circuit.
 *
 * Unknowns: the voltage of every net with a DC path to the reference (ground = 0 V) and the
 * branch current of every voltage-defining element (voltage sources, VCVS, inductors).
 * Linear elements are stamped once; nonlinear ones (diodes, LEDs, NPN, NMOS) are linearised
 * by Newton–Raphson with SPICE-style junction-voltage limiting. Transient analysis uses
 * companion models: trapezoidal (default) or backward Euler, a fixed step that lands on
 * source breakpoints, and one backward-Euler step after every discontinuity.
 *
 * A failure (singular matrix, contradictory sources, non-convergence) returns diagnostics
 * and NO voltages — never fabricated values.
 */
export const BOLTZMANN = 1.380649e-23;
export const ELEMENTARY_CHARGE = 1.602176634e-19;
/** Thermal voltage at the SPICE nominal temperature 27 °C. */
export const VT_NOMINAL = (BOLTZMANN * 300.15) / ELEMENTARY_CHARGE;

type N = number; // net index (−1 = reference)

export type Element =
  | { k: 'R'; id: string; part: string; a: N; b: N; r: number }
  | { k: 'V'; id: string; part: string; a: N; b: N; wave: Waveform; rs: number }
  | { k: 'I'; id: string; part: string; a: N; b: N; wave: Waveform }
  | { k: 'C'; id: string; part: string; a: N; b: N; c: number; ic: number | null }
  | { k: 'L'; id: string; part: string; a: N; b: N; l: number; ic: number | null }
  | { k: 'E'; id: string; part: string; a: N; b: N; c: N; d: N; gain: number }
  | { k: 'G'; id: string; part: string; a: N; b: N; c: N; d: N; gm: number }
  | { k: 'D'; id: string; part: string; a: N; b: N; is: number; n: number; rs: number }
  | { k: 'Q'; id: string; part: string; c: N; b: N; e: N; is: number; bf: number; br: number }
  | { k: 'M'; id: string; part: string; d: N; g: N; s: N; vt: number; kp: number; lambda: number };

export interface Diagnostic {
  code:
    | 'missing-reference'
    | 'voltage-source-loop'
    | 'shorted-source'
    | 'current-source-no-path'
    | 'floating-control'
    | 'singular-matrix'
    | 'non-convergence'
    | 'invalid-value'
    | 'step-failure'
    | 'unsupported';
  message: string;
  elements: string[];
  nets: string[];
}

export interface AnalogWarning {
  code: 'undefined-nets' | 'stiffness' | 'decimated' | 'source-stepping';
  message: string;
}

export interface OperatingPoint {
  ok: true;
  /** Net voltages (V) by net index; null = no DC path to the reference (undefined). */
  v: (number | null)[];
  /** Current a→b THROUGH each element (A), by element id. Sources: a = +, so delivering < 0. */
  i: Map<string, number>;
  iterations: number;
  warnings: AnalogWarning[];
}
export type OpResult = OperatingPoint | { ok: false; diagnostics: Diagnostic[] };

interface Layout {
  /** net index → unknown index (−1 = reference or excluded). */
  node: Int32Array;
  nNodes: number;
  branch: Map<string, number>;
  /** Internal node for a diode's series resistance. */
  internal: Map<string, number>;
  size: number;
  excluded: Set<number>;
  active: Element[];
}

const conducts = (e: Element, transient: boolean): [N, N][] => {
  switch (e.k) {
    case 'R':
    case 'V':
    case 'L':
    case 'D':
      return [[e.a, e.b]];
    case 'C':
      return transient ? [[e.a, e.b]] : [];
    case 'E':
      return [[e.a, e.b]];
    case 'Q':
      return [
        [e.b, e.e],
        [e.b, e.c],
      ];
    case 'M':
      return [[e.d, e.s]];
    default:
      return [];
  }
};

/** Elements whose terminals must have defined voltages but carry no DC current. */
const controls = (e: Element): N[] => (e.k === 'E' || e.k === 'G' ? [e.c, e.d] : e.k === 'M' ? [e.g] : []);

function nets(e: Element): N[] {
  switch (e.k) {
    case 'Q':
      return [e.c, e.b, e.e];
    case 'M':
      return [e.d, e.g, e.s];
    case 'E':
    case 'G':
      return [e.a, e.b, e.c, e.d];
    default:
      return [e.a, e.b];
  }
}

export class AnalogCircuit {
  constructor(
    readonly netlist: Netlist,
    readonly elements: Element[],
    readonly settings: ElectricalSettings,
  ) {}

  private netName = (i: N) => (i < 0 ? 'GND' : (this.netlist.nets[i]?.name ?? `net${i}`));

  /** Topology checks and unknown numbering (DC: capacitors are open, inductors short). */
  layout(transient: boolean): { ok: true; layout: Layout } | { ok: false; diagnostics: Diagnostic[] } {
    const nl = this.netlist;
    const diags: Diagnostic[] = [];
    const g = nl.ground;
    const nNets = nl.nets.length;
    const idx = (n: N) => (n === g ? -1 : n);
    if (g < 0 && this.elements.length)
      return {
        ok: false,
        diagnostics: [{ code: 'missing-reference', message: nl.groundNote, elements: [], nets: [] }],
      };
    // DC connectivity to the reference.
    const parent = Array.from({ length: nNets + 1 }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
    const R = nNets; // reference
    const u = (n: N) => (idx(n) < 0 ? R : n);
    for (const e of this.elements)
      for (const [a, b] of conducts(e, transient)) parent[find(u(a))] = find(u(b));
    const excluded = new Set<number>();
    for (let n = 0; n < nNets; n++) if (n !== g && find(n) !== find(R)) excluded.add(n);
    const active: Element[] = [];
    for (const e of this.elements) {
      const ns = nets(e).filter((n) => idx(n) >= 0);
      const exc = ns.filter((n) => excluded.has(n));
      if (exc.length === 0) {
        active.push(e);
        continue;
      }
      if (e.k === 'I' || e.k === 'G') {
        const out = [e.a, e.b];
        if (out.some((n) => excluded.has(n)))
          diags.push({
            code: 'current-source-no-path',
            message: `${e.id}: its current has no DC return path (net ${out
              .filter((n) => excluded.has(n))
              .map(this.netName)
              .join(', ')} is isolated).`,
            elements: [e.part],
            nets: out.filter((n) => excluded.has(n)).map(this.netName),
          });
        if (out.some((n) => excluded.has(n))) continue;
      }
      // A controlling terminal (gate, control input) on an isolated net while the element's
      // other terminals are in the solved circuit: its state is undefined — report, never guess.
      const ctl = controls(e).filter((n) => excluded.has(n));
      const live = nets(e)
        .filter((n) => !controls(e).includes(n))
        .some((n) => n === g || !excluded.has(n));
      if (ctl.length && live)
        diags.push({
          code: 'floating-control',
          message: `${e.id}: control terminal on net ${ctl.map(this.netName).join(', ')} has no DC path to the reference; its state is undefined.`,
          elements: [e.part],
          nets: ctl.map(this.netName),
        });
      // Otherwise: entirely inside an isolated island (or a capacitor straddling one in DC).
    }
    // Ideal voltage-defining branches must not form loops (or short their own terminals).
    const vp = Array.from({ length: nNets + 1 }, (_, i) => i);
    const vfind = (x: number): number => (vp[x] === x ? x : (vp[x] = vfind(vp[x]!)));
    const loopMembers = new Map<number, string[]>();
    for (const e of active) {
      const ideal =
        (e.k === 'V' && e.rs === 0) || e.k === 'E' || (e.k === 'L' && !transient) ? [e.a, e.b] : null;
      if (!ideal) continue;
      const [a, b] = ideal.map(u) as [number, number];
      if (a === b) {
        diags.push({
          code: 'shorted-source',
          message: `${e.id} has both terminals on the same net (${this.netName(ideal[0]!)}): a short across an ideal source.`,
          elements: [e.part],
          nets: [this.netName(ideal[0]!)],
        });
        continue;
      }
      const ra = vfind(a);
      const rb = vfind(b);
      if (ra === rb) {
        const members = [...(loopMembers.get(ra) ?? []), e.id];
        diags.push({
          code: 'voltage-source-loop',
          message: `Ideal voltage sources/inductors form a loop (${members.join(', ')}): their voltages are contradictory or redundant. Add series resistance or remove one.`,
          elements: [...new Set([...members.map((m) => this.partOf(m)), e.part])],
          nets: [this.netName(ideal[0]!), this.netName(ideal[1]!)],
        });
        continue;
      }
      vp[ra] = rb;
      loopMembers.set(rb, [...(loopMembers.get(ra) ?? []), ...(loopMembers.get(rb) ?? []), e.id]);
    }
    if (diags.length) return { ok: false, diagnostics: diags };
    const node = new Int32Array(nNets).fill(-1);
    let k = 0;
    for (let n = 0; n < nNets; n++) if (n !== g && !excluded.has(n)) node[n] = k++;
    const nNodes = k;
    const internal = new Map<string, number>();
    for (const e of active) if (e.k === 'D' && e.rs > 0) internal.set(e.id, k++);
    const branch = new Map<string, number>();
    for (const e of active) if (e.k === 'V' || e.k === 'E' || e.k === 'L') branch.set(e.id, k++);
    return { ok: true, layout: { node, nNodes, branch, internal, size: k, excluded, active } };
  }

  private partOf(elementId: string) {
    return this.elements.find((e) => e.id === elementId)?.part ?? elementId;
  }

  /** DC operating point at time t (sources evaluated at t). */
  dc(t = 0, opts: { ic?: boolean } = {}): OpResult {
    // Initial conditions (opts.ic): capacitors with an IC become ideal sources, inductors with
    // an IC become current sources — the standard way to start a transient from a given state.
    if (opts.ic && this.elements.some((e) => (e.k === 'C' || e.k === 'L') && e.ic !== null)) {
      const els = this.elements.map((e): Element =>
        e.k === 'C' && e.ic !== null
          ? { k: 'V', id: e.id, part: e.part, a: e.a, b: e.b, wave: { kind: 'dc', value: e.ic }, rs: 0 }
          : e.k === 'L' && e.ic !== null
            ? { k: 'I', id: e.id, part: e.part, a: e.a, b: e.b, wave: { kind: 'dc', value: -e.ic } }
            : e,
      );
      return new AnalogCircuit(this.netlist, els, this.settings).dc(t);
    }
    const lay = this.layout(false);
    if (!lay.ok) return lay;
    const L = lay.layout;
    const sys = new System(this, L, this.settings);
    let r = sys.newton(t, null, 1);
    const warnings: AnalogWarning[] = [];
    if (!r.ok && r.diagnostics[0]?.code === 'non-convergence' && sys.nonlinear) {
      // Source stepping: ramp every independent source from 0 to 100 %.
      let x: Float64Array | null = null;
      let ok = true;
      for (const s of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const rs = sys.newton(t, x, s);
        if (!rs.ok) {
          ok = false;
          r = rs;
          break;
        }
        x = rs.x;
        r = rs;
      }
      if (ok) warnings.push({ code: 'source-stepping', message: 'Converged with source stepping.' });
    }
    if (!r.ok) return r;
    if (L.excluded.size)
      warnings.push({
        code: 'undefined-nets',
        message: `No DC path to the reference: ${[...L.excluded].map(this.netName).join(', ')} (voltages undefined).`,
      });
    return { ok: true, ...sys.extract(r.x, null, t), iterations: r.iterations, warnings };
  }

  /** Transient analysis from t = 0 to stopS. */
  transient(
    stopS = this.settings.transient.stopS,
    stepS = this.settings.transient.stepS,
    opts: { maxPoints?: number; method?: 'trapezoidal' | 'backward-euler' } = {},
  ): TransientResult {
    const method = opts.method ?? this.settings.transient.method;
    if (!(stepS > 0) || !(stopS > 0) || stopS / stepS > 5e7)
      return {
        ok: false,
        diagnostics: [
          {
            code: 'invalid-value',
            message: `Invalid transient window: step ${stepS} s, stop ${stopS} s (at most 5·10⁷ steps).`,
            elements: [],
            nets: [],
          },
        ],
      };
    const op0 = this.dc(0, { ic: true });
    if (!op0.ok) return op0;
    const lay = this.layout(true);
    if (!lay.ok) return lay;
    const L = lay.layout;
    const sys = new System(this, L, this.settings);
    // State from the initial operating point.
    const caps = L.active.filter((e): e is Extract<Element, { k: 'C' }> => e.k === 'C');
    const inds = L.active.filter((e): e is Extract<Element, { k: 'L' }> => e.k === 'L');
    const v0 = (n: N) => (n === this.netlist.ground ? 0 : (op0.v[n] ?? 0));
    const state: History = {
      vC: new Map(caps.map((c) => [c.id, c.ic ?? v0(c.a) - v0(c.b)])),
      iC: new Map(caps.map((c) => [c.id, op0.i.get(c.id) ?? 0])),
      iL: new Map(inds.map((l) => [l.id, l.ic ?? op0.i.get(l.id) ?? 0])),
      vL: new Map(inds.map((l) => [l.id, v0(l.a) - v0(l.b)])),
    };
    // Caps without an IC carry no current at the DC point.
    for (const c of caps) if (c.ic === null) state.iC.set(c.id, 0);
    const bps = new Set<number>();
    for (const e of L.active)
      if (e.k === 'V' || e.k === 'I') for (const b of waveBreakpoints(e.wave, stopS)) bps.add(b);
    const breakpoints = [...bps].sort((a, b) => a - b);
    const warnings: AnalogWarning[] = [];
    const tau = sys.fastestTimeConstant();
    if (tau !== null && stepS > tau)
      warnings.push({
        code: 'stiffness',
        message: `Step ${stepS.toExponential(2)} s exceeds the fastest time constant (≈ ${tau.toExponential(2)} s): that dynamic is under-resolved. Reduce the step.`,
      });
    const maxPoints = opts.maxPoints ?? 20_000;
    const estSteps = Math.ceil(stopS / stepS) + breakpoints.length;
    const every = Math.max(1, Math.ceil(estSteps / maxPoints));
    if (every > 1)
      warnings.push({
        code: 'decimated',
        message: `Recorded every ${every}th step (${estSteps} steps, at most ${maxPoints} points kept).`,
      });
    const times: number[] = [0];
    const volt: number[][] = this.netlist.nets.map((_, n) => [
      n === this.netlist.ground ? 0 : (op0.v[n] ?? NaN),
    ]);
    const cur = new Map<string, number[]>([...op0.i.entries()].map(([k, v]) => [k, [v]]));
    for (const c of caps) cur.set(c.id, [state.iC.get(c.id)!]);
    let t = 0;
    let bi = 0;
    let useBE = true; // first step after t = 0 (a discontinuity)
    let x: Float64Array | null = null;
    let steps = 0;
    let factored: { key: string; lu: LUFactors } | null = null;
    while (t < stopS * (1 - 1e-12)) {
      while (bi < breakpoints.length && breakpoints[bi]! <= t * (1 + 1e-12) + 1e-18) bi++;
      let h = Math.min(stepS, stopS - t);
      let hitBp = false;
      if (bi < breakpoints.length && t + h >= breakpoints[bi]! * (1 - 1e-12)) {
        h = breakpoints[bi]! - t;
        hitBp = true;
      }
      const be = method === 'backward-euler' || useBE;
      let res: NewtonResult | null = null;
      for (let tries = 0; tries < 10; tries++) {
        // A step that ENDS on a breakpoint sees the source's left limit there (an ideal jump
        // belongs to the following step, which starts with backward Euler).
        const tEval = hitBp ? t + h - Math.max(1e-18, (t + h) * 1e-12) : t + h;
        res = sys.newton(tEval, x, 1, { h, be, hist: state }, factored);
        if (res.ok) break;
        h /= 2;
        hitBp = false;
      }
      if (!res || !res.ok)
        return {
          ok: false,
          diagnostics: [
            {
              code: 'step-failure',
              message: `Transient step failed at t = ${t.toExponential(4)} s even after halving the step 10 times (${res && !res.ok ? res.diagnostics[0]?.message : ''}).`,
              elements: res && !res.ok ? res.diagnostics.flatMap((d) => d.elements) : [],
              nets: [],
            },
          ],
        };
      if (res.lu && !sys.nonlinear) factored = { key: `${h}|${be}`, lu: res.lu };
      x = res.x;
      t += h;
      steps++;
      sys.updateHistory(x, { h, be, hist: state });
      useBE = hitBp;
      if (steps % every === 0 || t >= stopS * (1 - 1e-12)) {
        const out = sys.extract(x, { h, be, hist: state }, t);
        times.push(t);
        out.v.forEach((v, n) => volt[n]!.push(n === this.netlist.ground ? 0 : (v ?? NaN)));
        for (const [k, v] of out.i) {
          const arr = cur.get(k) ?? [];
          arr.push(v);
          cur.set(k, arr);
        }
      }
    }
    if (L.excluded.size)
      warnings.push({
        code: 'undefined-nets',
        message: `No path to the reference: ${[...L.excluded].map(this.netName).join(', ')} (voltages undefined).`,
      });
    return { ok: true, t: times, v: volt, i: cur, steps, warnings, method };
  }
}

export type TransientResult =
  | {
      ok: true;
      t: number[];
      /** v[net][k] (NaN for undefined nets). */
      v: number[][];
      i: Map<string, number[]>;
      steps: number;
      warnings: AnalogWarning[];
      method: 'trapezoidal' | 'backward-euler';
    }
  | { ok: false; diagnostics: Diagnostic[] };

interface History {
  vC: Map<string, number>;
  iC: Map<string, number>;
  iL: Map<string, number>;
  vL: Map<string, number>;
}
interface TranCtx {
  h: number;
  be: boolean;
  hist: History;
}
type NewtonResult =
  | { ok: true; x: Float64Array; iterations: number; lu: LUFactors | null }
  | { ok: false; diagnostics: Diagnostic[] };

/** Junction-voltage limiting (SPICE pnjlim). */
function pnjlim(vnew: number, vold: number, vte: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vte) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vte;
      return arg > 0 ? vold + vte * Math.log(arg) : vcrit;
    }
    return vte * Math.log(vnew / vte);
  }
  return vnew;
}

/** One MNA system (fixed layout) — stamping, Newton iteration and result extraction. */
class System {
  readonly nonlinear: boolean;
  private junction = new Map<string, number[]>();
  constructor(
    private readonly c: AnalogCircuit,
    private readonly L: Layout,
    private readonly s: ElectricalSettings,
  ) {
    this.nonlinear = L.active.some((e) => e.k === 'D' || e.k === 'Q' || e.k === 'M');
  }

  private n(net: N): number {
    return net < 0 || net === this.c.netlist.ground ? -1 : this.L.node[net]!;
  }
  private vOf(x: Float64Array | null, net: N): number {
    const i = this.n(net);
    return i < 0 || !x ? 0 : x[i]!;
  }

  private stampG(A: SparseMatrix, a: number, b: number, g: number) {
    A.add(a, a, g);
    A.add(b, b, g);
    A.add(a, b, -g);
    A.add(b, a, -g);
  }
  /** Current `i` flowing a→b through an element: injected into b, drawn from a. */
  private stampI(rhs: Float64Array, a: number, b: number, i: number) {
    if (a >= 0) rhs[a] = rhs[a]! - i;
    if (b >= 0) rhs[b] = rhs[b]! + i;
  }

  /** Linear part (+ transient companions). Scale multiplies independent sources. */
  private stampLinear(A: SparseMatrix, rhs: Float64Array, t: number, scale: number, tr: TranCtx | null) {
    for (const e of this.L.active) {
      switch (e.k) {
        case 'R':
          this.stampG(A, this.n(e.a), this.n(e.b), 1 / e.r);
          break;
        case 'V': {
          const br = this.L.branch.get(e.id)!;
          const a = this.n(e.a);
          const b = this.n(e.b);
          A.add(a, br, 1);
          A.add(b, br, -1);
          A.add(br, a, 1);
          A.add(br, b, -1);
          if (e.rs > 0) A.add(br, br, -e.rs);
          rhs[br] = waveValue(e.wave, t) * scale;
          break;
        }
        case 'I':
          this.stampI(rhs, this.n(e.a), this.n(e.b), -waveValue(e.wave, t) * scale);
          break;
        case 'C':
          if (tr) {
            const g = (tr.be ? 1 : 2) * (e.c / tr.h);
            const ieq = tr.be ? g * tr.hist.vC.get(e.id)! : g * tr.hist.vC.get(e.id)! + tr.hist.iC.get(e.id)!;
            const a = this.n(e.a);
            const b = this.n(e.b);
            this.stampG(A, a, b, g);
            // i(a→b) = g·v − ieq  ⇒ an equivalent source of ieq flowing b→a.
            this.stampI(rhs, b, a, ieq);
          }
          break;
        case 'L': {
          const br = this.L.branch.get(e.id)!;
          const a = this.n(e.a);
          const b = this.n(e.b);
          A.add(a, br, 1);
          A.add(b, br, -1);
          A.add(br, a, 1);
          A.add(br, b, -1);
          if (tr) {
            const r = (tr.be ? 1 : 2) * (e.l / tr.h);
            A.add(br, br, -r);
            const iL = tr.hist.iL.get(e.id)!;
            rhs[br] = tr.be ? -r * iL : -r * iL - tr.hist.vL.get(e.id)!;
          }
          break;
        }
        case 'E': {
          const br = this.L.branch.get(e.id)!;
          const a = this.n(e.a);
          const b = this.n(e.b);
          A.add(a, br, 1);
          A.add(b, br, -1);
          A.add(br, a, 1);
          A.add(br, b, -1);
          A.add(br, this.n(e.c), -e.gain);
          A.add(br, this.n(e.d), e.gain);
          break;
        }
        case 'G': {
          const a = this.n(e.a);
          const b = this.n(e.b);
          const cc = this.n(e.c);
          const d = this.n(e.d);
          A.add(a, cc, e.gm);
          A.add(a, d, -e.gm);
          A.add(b, cc, -e.gm);
          A.add(b, d, e.gm);
          break;
        }
        default:
          break;
      }
    }
  }

  /** Nonlinear device currents and Jacobian at the (limited) operating point. */
  private stampNonlinear(A: SparseMatrix, rhs: Float64Array, x: Float64Array | null, firstIter: boolean) {
    const vt = VT_NOMINAL;
    const gmin = this.s.solver.gmin;
    const gen = (terms: number[], I: number[], J: number[][], vs: number[]) => {
      // KCL rows: current leaving node k is I_k + Σ_j J_kj (v_j − v_j0).
      for (let k = 0; k < terms.length; k++) {
        const row = terms[k]!;
        if (row < 0) continue;
        let lin = I[k]!;
        for (let j = 0; j < terms.length; j++) {
          lin -= J[k]![j]! * vs[j]!;
          A.add(row, terms[j]!, J[k]![j]!);
        }
        rhs[row] = rhs[row]! - lin;
      }
    };
    for (const e of this.L.active) {
      if (e.k === 'D') {
        const a = this.n(e.a);
        const b = this.L.internal.get(e.id) ?? this.n(e.b);
        if (e.rs > 0) this.stampG(A, b, this.n(e.b), 1 / e.rs);
        const vte = e.n * vt;
        const vcrit = vte * Math.log(vte / (Math.SQRT2 * e.is));
        const raw = x ? (a < 0 ? 0 : x[a]!) - (b < 0 ? 0 : x[b]!) : 0;
        const prev = this.junction.get(e.id)?.[0] ?? 0;
        const v = firstIter && !x ? 0 : pnjlim(raw, prev, vte, vcrit);
        this.junction.set(e.id, [v]);
        const ex = Math.exp(Math.min(v / vte, 700));
        const id = e.is * (ex - 1) + gmin * v;
        const gd = (e.is * ex) / vte + gmin;
        // terms a (anode), b (cathode-internal); current leaving a = id, leaving b = −id.
        gen(
          [a, b],
          [id, -id],
          [
            [gd, -gd],
            [-gd, gd],
          ],
          [v, 0],
        );
      } else if (e.k === 'Q') {
        const c = this.n(e.c);
        const b = this.n(e.b);
        const ee = this.n(e.e);
        const vx = (i: number) => (i < 0 || !x ? 0 : x[i]!);
        const vcrit = vt * Math.log(vt / (Math.SQRT2 * e.is));
        const prev = this.junction.get(e.id) ?? [0, 0];
        const vbe = x ? pnjlim(vx(b) - vx(ee), prev[0]!, vt, vcrit) : 0;
        const vbc = x ? pnjlim(vx(b) - vx(c), prev[1]!, vt, vcrit) : 0;
        this.junction.set(e.id, [vbe, vbc]);
        const ef = Math.exp(Math.min(vbe / vt, 700));
        const er = Math.exp(Math.min(vbc / vt, 700));
        const ict = e.is * (ef - er);
        const ib = (e.is / e.bf) * (ef - 1) + (e.is / e.br) * (er - 1) + gmin * (vbe + vbc);
        const ic = ict - (e.is / e.br) * (er - 1) - gmin * vbc;
        const gf = (e.is * ef) / vt;
        const gr = (e.is * er) / vt;
        // Partial derivatives w.r.t. vbe and vbc.
        const dib_dbe = gf / e.bf + gmin;
        const dib_dbc = gr / e.br + gmin;
        const dic_dbe = gf;
        const dic_dbc = -gr - gr / e.br - gmin;
        // Currents leaving terminals: collector = ic, base = ib, emitter = −(ic + ib) (into the device).
        // As functions of (vc, vb, ve): vbe = vb − ve, vbc = vb − vc.
        const Jc = [-dic_dbc, dic_dbe + dic_dbc, -dic_dbe];
        const Jb = [-dib_dbc, dib_dbe + dib_dbc, -dib_dbe];
        const Je = [0, 1, 2].map((j) => -(Jc[j]! + Jb[j]!));
        // Linearisation point in terminal voltages consistent with the limited junctions.
        // Linearisation point in terminal voltages consistent with the limited junctions
        // (ve = 0 reference: vb = vbe, vc = vbe − vbc; the Jacobian depends on differences only).
        gen([c, b, ee], [ic, ib, -(ic + ib)], [Jc, Jb, Je], [vbe - vbc, vbe, 0]);
      } else if (e.k === 'M') {
        const d0 = this.n(e.d);
        const g = this.n(e.g);
        const s0 = this.n(e.s);
        const vx = (i: number) => (i < 0 || !x ? 0 : x[i]!);
        // Symmetric device: the lower-potential channel terminal acts as the source.
        const swap = x ? vx(d0) < vx(s0) : false;
        const d = swap ? s0 : d0;
        const s = swap ? d0 : s0;
        const vgs = vx(g) - vx(s);
        const vds = vx(d) - vx(s);
        const vov = vgs - e.vt;
        let id = 0;
        let gm = 0;
        let gds = 0;
        if (vov > 0) {
          if (vds < vov) {
            id = e.kp * (vov * vds - (vds * vds) / 2) * (1 + e.lambda * vds);
            gm = e.kp * vds * (1 + e.lambda * vds);
            gds = e.kp * (vov - vds) * (1 + e.lambda * vds) + e.kp * (vov * vds - (vds * vds) / 2) * e.lambda;
          } else {
            id = (e.kp / 2) * vov * vov * (1 + e.lambda * vds);
            gm = e.kp * vov * (1 + e.lambda * vds);
            gds = (e.kp / 2) * vov * vov * e.lambda;
          }
        }
        id += gmin * vds;
        gds += gmin;
        // Terminals (d, g, s): leaving d = id, leaving s = −id; partials w.r.t. (vd, vg, vs).
        const Jd = [gds, gm, -gds - gm];
        const Js = Jd.map((v) => -v);
        gen([d, g, s], [id, 0, -id], [Jd, [0, 0, 0], Js], [vds, vgs, 0]);
      }
    }
  }

  newton(
    t: number,
    x0: Float64Array | null,
    scale: number,
    tr: TranCtx | null = null,
    cached: { key: string; lu: LUFactors } | null = null,
  ): NewtonResult {
    const size = this.L.size;
    if (size === 0) return { ok: true, x: new Float64Array(0), iterations: 0, lu: null };
    let x: Float64Array | null = x0 ? Float64Array.from(x0) : null;
    const maxIt = this.nonlinear ? this.s.solver.maxNewtonIterations : 1;
    if (!this.nonlinear || !x) this.junction.clear();
    for (let it = 0; it < maxIt; it++) {
      const A = new SparseMatrix(size);
      const rhs = new Float64Array(size);
      this.stampLinear(A, rhs, t, scale, tr);
      if (this.nonlinear) this.stampNonlinear(A, rhs, x, it === 0);
      let lu: LUFactors;
      const key = tr ? `${tr.h}|${tr.be}` : 'dc';
      if (cached && cached.key === key && !this.nonlinear) lu = cached.lu;
      else {
        const f = factor(A);
        if (!f.ok) return { ok: false, diagnostics: [this.singular(f.singularColumn)] };
        lu = f.lu;
      }
      const xn = solveLU(lu, rhs);
      if (!xn.every(Number.isFinite))
        return {
          ok: false,
          diagnostics: [
            {
              code: 'singular-matrix',
              message: 'The solution is not finite: the circuit is singular or badly scaled.',
              elements: [],
              nets: [],
            },
          ],
        };
      if (!this.nonlinear) return { ok: true, x: xn, iterations: 1, lu };
      if (x) {
        let conv = true;
        for (let i = 0; i < size; i++) {
          const tol =
            this.s.solver.relTol * Math.max(Math.abs(xn[i]!), Math.abs(x[i]!)) +
            (i < this.L.nNodes + this.L.internal.size ? this.s.solver.absTolV : this.s.solver.absTolA);
          if (Math.abs(xn[i]! - x[i]!) > tol) {
            conv = false;
            break;
          }
        }
        if (conv && it > 0) return { ok: true, x: xn, iterations: it + 1, lu };
      }
      x = xn;
    }
    const nl = this.L.active.filter((e) => e.k === 'D' || e.k === 'Q' || e.k === 'M');
    return {
      ok: false,
      diagnostics: [
        {
          code: 'non-convergence',
          message: `Newton iteration did not converge in ${maxIt} iterations (nonlinear devices: ${nl.map((e) => e.id).join(', ')}).`,
          elements: [...new Set(nl.map((e) => e.part))],
          nets: [],
        },
      ],
    };
  }

  private singular(col: number): Diagnostic {
    let what = `unknown #${col}`;
    const nets: string[] = [];
    const elements: string[] = [];
    if (col < this.L.nNodes) {
      const net = [...this.L.node].findIndex((v) => v === col);
      const name = this.c.netlist.nets[net]?.name ?? `net ${net}`;
      what = `the voltage of net ${name}`;
      nets.push(name);
    } else {
      for (const [id, k] of [...this.L.branch, ...this.L.internal])
        if (k === col) {
          what = `the current of ${id}`;
          elements.push(this.L.active.find((e) => e.id === id)?.part ?? id);
        }
    }
    return {
      code: 'singular-matrix',
      message: `Singular circuit matrix: ${what} is not determined (e.g. a node connected only through current sources or capacitors, or redundant ideal sources).`,
      elements,
      nets,
    };
  }

  updateHistory(x: Float64Array, tr: TranCtx) {
    for (const e of this.L.active) {
      if (e.k === 'C') {
        const v = this.vOf(x, e.a) - this.vOf(x, e.b);
        const g = (tr.be ? 1 : 2) * (e.c / tr.h);
        const ieq = tr.be ? g * tr.hist.vC.get(e.id)! : g * tr.hist.vC.get(e.id)! + tr.hist.iC.get(e.id)!;
        tr.hist.iC.set(e.id, g * v - ieq);
        tr.hist.vC.set(e.id, v);
      } else if (e.k === 'L') {
        tr.hist.iL.set(e.id, x[this.L.branch.get(e.id)!]!);
        tr.hist.vL.set(e.id, this.vOf(x, e.a) - this.vOf(x, e.b));
      }
    }
  }

  extract(x: Float64Array, tr: TranCtx | null, t: number): { v: (number | null)[]; i: Map<string, number> } {
    const nl = this.c.netlist;
    const v = nl.nets.map((_, n) => (n === nl.ground ? 0 : this.L.excluded.has(n) ? null : this.vOf(x, n)));
    const vn = (n: N) => (n === nl.ground ? 0 : (v[n] ?? 0));
    const i = new Map<string, number>();
    for (const e of this.L.active) {
      switch (e.k) {
        case 'R':
          i.set(e.id, (vn(e.a) - vn(e.b)) / e.r);
          break;
        case 'V':
        case 'L':
        case 'E':
          // The branch unknown is the current entering terminal a (a→b through the element).
          i.set(e.id, x[this.L.branch.get(e.id)!]!);
          break;
        case 'I':
          i.set(e.id, -waveValue(e.wave, t));
          break;
        case 'C':
          i.set(e.id, tr ? tr.hist.iC.get(e.id)! : 0);
          break;
        case 'G':
          i.set(e.id, e.gm * (vn(e.c) - vn(e.d)));
          break;
        case 'D': {
          const vd = vn(e.a) - (this.L.internal.has(e.id) ? x[this.L.internal.get(e.id)!]! : vn(e.b));
          i.set(
            e.id,
            e.is * (Math.exp(Math.min(vd / (e.n * VT_NOMINAL), 700)) - 1) + this.s.solver.gmin * vd,
          );
          break;
        }
        case 'Q': {
          const vbe = vn(e.b) - vn(e.e);
          const vbc = vn(e.b) - vn(e.c);
          const ef = Math.exp(Math.min(vbe / VT_NOMINAL, 700));
          const er = Math.exp(Math.min(vbc / VT_NOMINAL, 700));
          const ib = (e.is / e.bf) * (ef - 1) + (e.is / e.br) * (er - 1);
          const ic = e.is * (ef - er) - (e.is / e.br) * (er - 1);
          i.set(`${e.id}:c`, ic);
          i.set(`${e.id}:b`, ib);
          i.set(e.id, ic);
          break;
        }
        case 'M': {
          let vd = vn(e.d);
          let vs = vn(e.s);
          const sign = vd >= vs ? 1 : -1;
          if (sign < 0) [vd, vs] = [vs, vd];
          const vov = vn(e.g) - vs - e.vt;
          const vds = vd - vs;
          let id = 0;
          if (vov > 0)
            id =
              vds < vov
                ? e.kp * (vov * vds - (vds * vds) / 2) * (1 + e.lambda * vds)
                : (e.kp / 2) * vov * vov * (1 + e.lambda * vds);
          i.set(e.id, sign * id);
          break;
        }
      }
    }
    return { v, i };
  }

  /** Smallest RC / L-over-R time constant estimated from the conductance diagonal (heuristic). */
  fastestTimeConstant(): number | null {
    const gdiag = new Map<number, number>();
    for (const e of this.L.active)
      if (e.k === 'R')
        for (const n of [e.a, e.b]) {
          const i = this.n(n);
          if (i >= 0) gdiag.set(i, (gdiag.get(i) ?? 0) + 1 / e.r);
        }
    let best: number | null = null;
    for (const e of this.L.active) {
      if (e.k === 'C') {
        const g = Math.max(gdiag.get(this.n(e.a)) ?? 0, gdiag.get(this.n(e.b)) ?? 0);
        if (g > 0) best = Math.min(best ?? Infinity, e.c / g);
      } else if (e.k === 'L') {
        const g = Math.min(gdiag.get(this.n(e.a)) ?? Infinity, gdiag.get(this.n(e.b)) ?? Infinity);
        if (g > 0 && Number.isFinite(g)) best = Math.min(best ?? Infinity, e.l * g);
      }
    }
    return best;
  }
}
