import type { Device, ElectricalDefinition, Waveform } from '@forge/engineering-core';
import { buildDefinition, parseSiValue, verifyConnectivity, type PartSpec } from '../electrical';
import { err, info, MAX_INPUT_BYTES, warn, type Diagnostic } from '../schemas';

/**
 * SPICE netlist import (the subset FORGE's MNA solver represents).
 *
 * Supported elements: R, C (IC=), L (IC=), V and I with DC / PULSE / SIN (no damping) / PWL,
 * E (VCVS), G (VCCS), D (with .model D: IS, N, RS), Q (NPN with .model NPN: IS, BF, BR),
 * M (NMOS level 1 with .model NMOS: VTO, KP, LAMBDA; K = KP·W/L). `.tran tstep tstop` sets
 * the transient settings. Node 0 / GND is the reference.
 *
 * Everything else is identified, never silently dropped: subcircuits (.subckt/X),
 * behavioural sources (B), current-controlled sources (F/H), coupled inductors (K),
 * switches (S/W), transmission lines (T), PNP/PMOS, AC/noise/DC/OP analyses, .param
 * expressions, .include/.lib (FORGE never opens other files) and unknown model
 * parameters. Unsupported ELEMENTS block the import unless the user explicitly accepts a
 * partial import (they are then listed in the provenance record).
 */
declare const TextDecoder: { new (label?: string): { decode(input: Uint8Array): string } };

export interface SpiceElement {
  name: string;
  letter: string;
  nodes: string[];
  supported: boolean;
  reason?: string;
}
export interface SpiceParse {
  ok: boolean;
  title: string;
  definition: ElectricalDefinition | null;
  elements: SpiceElement[];
  /** Source connectivity: node → (part label, pin) terminals. */
  nodes: Map<string, { label: string; pin: string }[]>;
  connectivity: ReturnType<typeof verifyConnectivity> | null;
  analyses: string[];
  unsupported: string[];
  /** Unsupported elements were omitted (only with allowPartial). */
  partial: boolean;
  diagnostics: Diagnostic[];
}

const GROUND = new Set(['0', 'gnd', 'GND', 'Gnd']);

/** Split a card into tokens, keeping function groups like PULSE(...) together. */
function tokenize(line: string): string[] {
  const t = line
    .replace(/\s*=\s*/g, '=')
    .replace(/\(\s*/g, '(')
    .replace(/\s*\)/g, ')');
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of t) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (/[\s,]/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch === ',' ? ' ' : ch;
  }
  if (cur) out.push(cur);
  return out;
}
const fnArgs = (tok: string) => {
  const m = /^\w+\((.*)\)$/.exec(tok);
  return m ? m[1]!.split(/[\s,]+/).filter(Boolean) : null;
};
const kv = (toks: string[]) => {
  const r: Record<string, string> = {};
  for (const t of toks) {
    const m = /^([A-Za-z_]\w*)=(.+)$/.exec(t);
    if (m) r[m[1]!.toUpperCase()] = m[2]!;
  }
  return r;
};

export interface SpiceOptions {
  allowPartial?: boolean;
}

export function parseSpice(bytes: Uint8Array, opts: SpiceOptions = {}): SpiceParse {
  const d: Diagnostic[] = [];
  const unsupported: string[] = [];
  const analyses: string[] = [];
  const empty = (): SpiceParse => ({
    ok: false,
    title: '',
    definition: null,
    elements: [],
    nodes: new Map(),
    connectivity: null,
    analyses,
    unsupported,
    partial: false,
    diagnostics: d,
  });
  if (bytes.byteLength > MAX_INPUT_BYTES.spice) {
    d.push(err('too-large', `Netlist larger than ${MAX_INPUT_BYTES.spice / 1024} KiB.`));
    return empty();
  }
  const raw = new TextDecoder('utf-8').decode(bytes).split(/\r?\n/);
  const title = (raw[0] ?? '').trim();
  // Join continuation lines; strip comments.
  const cards: { text: string; line: number }[] = [];
  raw.slice(1).forEach((l, i) => {
    const s = l
      .replace(/;.*$/, '')
      .replace(/\s\$\s.*$/, '')
      .trim();
    if (!s || s.startsWith('*')) return;
    if (s.startsWith('+') && cards.length) cards[cards.length - 1]!.text += ` ${s.slice(1)}`;
    else cards.push({ text: s, line: i + 2 });
  });
  const models = new Map<string, { type: string; params: Record<string, string> }>();
  let tran: { stepS: number; stopS: number } | null = null;
  let inSub = 0;
  for (const c of cards) {
    const toks = tokenize(c.text);
    const k = toks[0]!.toLowerCase();
    if (!k.startsWith('.')) continue;
    if (k === '.subckt') {
      inSub++;
      unsupported.push(`subcircuit definition ${toks[1] ?? ''} (line ${c.line})`);
    } else if (k === '.ends') inSub = Math.max(0, inSub - 1);
    else if (k === '.model' && !inSub) {
      const name = toks[1];
      const spec = toks.slice(2).join(' ');
      const m = /^(\w+)\s*\((.*)\)\s*$/.exec(spec) ?? /^(\w+)\s*(.*)$/.exec(spec);
      if (name && m)
        models.set(name.toUpperCase(), { type: m[1]!.toUpperCase(), params: kv(tokenize(m[2]!)) });
    } else if (k === '.tran') {
      const step = parseSiValue(toks[1] ?? '');
      const stop = parseSiValue(toks[2] ?? '');
      if (step && stop && step > 0 && stop > 0) tran = { stepS: step, stopS: stop };
      else d.push(warn('spice-tran', `.tran on line ${c.line} could not be read.`));
      if (toks.slice(3).some((t) => /uic/i.test(t)))
        analyses.push('.tran UIC (initial conditions from IC= are always used by FORGE)');
      analyses.push(c.text);
    } else if (['.op', '.ac', '.dc', '.noise', '.tf', '.sens', '.four', '.pz', '.disto'].includes(k)) {
      analyses.push(c.text);
      unsupported.push(`analysis directive ${k} (FORGE runs DC operating point and transient only)`);
    } else if (k === '.include' || k === '.inc' || k === '.lib') {
      unsupported.push(`${k} ${toks[1] ?? ''} — FORGE never opens other files; paste the contents instead`);
      d.push(warn('spice-include', `${k} on line ${c.line} was not followed (no file access).`));
    } else if (k === '.param') unsupported.push(`.param ${toks.slice(1).join(' ')} (parameter expressions)`);
    else if (k === '.end') break;
    else if (
      ![
        '.options',
        '.option',
        '.print',
        '.plot',
        '.probe',
        '.save',
        '.control',
        '.endc',
        '.temp',
        '.ic',
        '.nodeset',
        '.global',
      ].includes(k)
    )
      unsupported.push(`directive ${k}`);
    else if (k !== '.end') unsupported.push(`directive ${k} (ignored)`);
  }

  const parts: PartSpec[] = [];
  const elements: SpiceElement[] = [];
  const value = (tok: string | undefined, what: string, name: string) => {
    if (tok && /[{}]/.test(tok)) {
      d.push(err('spice-param', `${name}: ${what} "${tok}" uses a parameter expression (not supported).`));
      return null;
    }
    const v = tok === undefined ? null : parseSiValue(tok);
    if (v === null) d.push(err('spice-value', `${name}: cannot read ${what} "${tok ?? ''}".`));
    return v;
  };
  const waveform = (
    toks: string[],
    name: string,
    defaults: { stepS: number; stopS: number },
  ): Waveform | null => {
    let rest = toks.filter((t) => !/^AC$/i.test(t));
    const acIdx = toks.findIndex((t) => /^AC$/i.test(t));
    if (acIdx >= 0) {
      unsupported.push(`${name}: AC small-signal specification ignored`);
      rest = toks.slice(0, acIdx);
    }
    if (rest[0] && /^DC$/i.test(rest[0])) rest = rest.slice(1);
    const fn = rest.find((t) => /^(PULSE|SIN|PWL|EXP|SFFM|AM)\(/i.test(t));
    if (!fn) {
      if (!rest.length) return { kind: 'dc', value: 0 };
      const v = value(rest[0], 'value', name);
      return v === null ? null : { kind: 'dc', value: v };
    }
    const kind = fn.slice(0, fn.indexOf('(')).toUpperCase();
    const a = (fnArgs(fn) ?? []).map((x) => parseSiValue(x));
    if (a.some((x) => x === null)) {
      d.push(err('spice-value', `${name}: cannot read the ${kind} arguments.`));
      return null;
    }
    const n = a as number[];
    if (kind === 'PULSE') {
      if (n.length < 2) {
        d.push(err('spice-value', `${name}: PULSE needs at least V1 and V2.`));
        return null;
      }
      const [
        v1,
        v2,
        td = 0,
        tr = defaults.stepS,
        tf = defaults.stepS,
        pw = defaults.stopS,
        per = defaults.stopS,
      ] = n;
      return { kind: 'pulse', v1: v1!, v2: v2!, delayS: td, riseS: tr, fallS: tf, widthS: pw, periodS: per };
    }
    if (kind === 'SIN') {
      const [vo = 0, va = 0, freq = 1 / defaults.stopS, td = 0, theta = 0, phase = 0] = n;
      if (theta !== 0) {
        d.push(err('spice-unsupported', `${name}: damped SIN (THETA=${theta}) is not supported.`));
        return null;
      }
      return { kind: 'sine', offset: vo, amplitude: va, frequencyHz: freq, delayS: td, phaseDeg: phase };
    }
    if (kind === 'PWL') {
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i]!, n[i + 1]!]);
      return { kind: 'pwl', points: pts };
    }
    d.push(err('spice-unsupported', `${name}: ${kind} source waveform is not supported.`));
    return null;
  };
  const defaults = tran ?? { stepS: 1e-6, stopS: 1e-3 };
  inSub = 0;
  for (const c of cards) {
    const toks = tokenize(c.text);
    const name = toks[0]!;
    const k = name.toLowerCase();
    if (k === '.subckt') inSub++;
    if (k === '.ends') inSub = Math.max(0, inSub - 1);
    if (k === '.end') break;
    if (k.startsWith('.') || inSub) continue;
    const letter = name[0]!.toUpperCase();
    const reject = (reason: string, nodes: string[] = []) => {
      elements.push({ name, letter, nodes, supported: false, reason });
      unsupported.push(`${name}: ${reason}`);
      d.push(
        (opts.allowPartial ? warn : err)(
          'spice-element',
          `${name} (line ${c.line}): ${reason}${opts.allowPartial ? ' — omitted (partial import accepted)' : ''}.`,
        ),
      );
    };
    const add = (device: Record<string, unknown>, pins: Record<string, string>, note = '') => {
      elements.push({ name, letter, nodes: Object.values(pins), supported: true });
      parts.push({ label: name, device: device as Device, pins, note });
    };
    const p = kv(toks.slice(3));
    switch (letter) {
      case 'R': {
        const v = value(toks[3], 'resistance', name);
        if (v !== null && v > 0)
          add({ type: 'resistor', resistanceOhm: v, powerRatingW: null }, { p1: toks[1]!, p2: toks[2]! });
        else if (v !== null) d.push(err('spice-value', `${name}: resistance must be positive.`));
        break;
      }
      case 'C': {
        const v = value(toks[3], 'capacitance', name);
        const ic = p.IC !== undefined ? parseSiValue(p.IC) : null;
        if (v !== null && v > 0)
          add(
            {
              type: 'capacitor',
              capacitanceF: v,
              voltageRatingV: null,
              initialVoltageV: ic,
              polarized: false,
            },
            { p1: toks[1]!, p2: toks[2]! },
          );
        break;
      }
      case 'L': {
        const v = value(toks[3], 'inductance', name);
        const ic = p.IC !== undefined ? parseSiValue(p.IC) : null;
        if (v !== null && v > 0)
          add(
            { type: 'inductor', inductanceH: v, currentRatingA: null, initialCurrentA: ic },
            { p1: toks[1]!, p2: toks[2]! },
          );
        break;
      }
      case 'V':
      case 'I': {
        const w = waveform(toks.slice(3), name, defaults);
        if (!w) break;
        if (letter === 'V')
          add(
            {
              type: 'vsource',
              waveform: w,
              seriesResistanceOhm: 0,
              currentLimitA: null,
              purpose: w.kind === 'dc' ? 'supply' : 'signal',
            },
            { pos: toks[1]!, neg: toks[2]! },
          );
        // SPICE: current flows from n+ through the source to n−; FORGE: out of "pos" into the circuit.
        else add({ type: 'isource', waveform: w }, { pos: toks[2]!, neg: toks[1]! });
        break;
      }
      case 'E':
      case 'G': {
        if (toks.some((t) => /^POLY\(/i.test(t))) {
          reject('polynomial controlled source (POLY) is not supported', toks.slice(1, 3));
          break;
        }
        const v = value(toks[5], letter === 'E' ? 'gain' : 'transconductance', name);
        if (v === null) break;
        const pins = { 'out+': toks[1]!, 'out-': toks[2]!, 'ctl+': toks[3]!, 'ctl-': toks[4]! };
        add(letter === 'E' ? { type: 'vcvs', gain: v } : { type: 'vccs', transconductanceS: v }, pins);
        break;
      }
      case 'D': {
        const m = models.get((toks[3] ?? '').toUpperCase());
        if (!m || m.type !== 'D') {
          reject(`diode model "${toks[3] ?? ''}" is not defined with .model … D(…)`, toks.slice(1, 3));
          break;
        }
        const extra = Object.keys(m.params).filter((x) => !['IS', 'N', 'RS'].includes(x));
        if (extra.length)
          unsupported.push(
            `${name}: diode model parameters ${extra.join(', ')} ignored (FORGE uses IS, N, RS)`,
          );
        add(
          {
            type: 'diode',
            model: {
              saturationCurrentA: parseSiValue(m.params.IS ?? '1e-14') ?? 1e-14,
              emissionCoefficient: parseSiValue(m.params.N ?? '1') ?? 1,
              seriesResistanceOhm: parseSiValue(m.params.RS ?? '0') ?? 0,
            },
            maxForwardCurrentA: null,
            maxReverseVoltageV: null,
            preset: `spice:${toks[3]}`.slice(0, 64),
          },
          { a: toks[1]!, k: toks[2]! },
        );
        break;
      }
      case 'Q': {
        // Q c b e [substrate] model
        const modelTok = toks.length >= 6 && models.has(toks[5]!.toUpperCase()) ? toks[5]! : toks[4]!;
        const m = models.get((modelTok ?? '').toUpperCase());
        if (!m || (m.type !== 'NPN' && m.type !== 'PNP')) {
          reject(`BJT model "${modelTok ?? ''}" is not defined`, toks.slice(1, 4));
          break;
        }
        if (m.type === 'PNP') {
          reject('PNP transistors are not modelled by FORGE', toks.slice(1, 4));
          break;
        }
        const extra = Object.keys(m.params).filter((x) => !['IS', 'BF', 'BR'].includes(x));
        if (extra.length)
          unsupported.push(
            `${name}: BJT model parameters ${extra.join(', ')} ignored (Ebers–Moll IS, BF, BR only)`,
          );
        add(
          {
            type: 'npn',
            saturationCurrentA: parseSiValue(m.params.IS ?? '1e-16') ?? 1e-16,
            betaF: parseSiValue(m.params.BF ?? '100') ?? 100,
            betaR: parseSiValue(m.params.BR ?? '1') ?? 1,
            maxCollectorCurrentA: null,
          },
          { c: toks[1]!, b: toks[2]!, e: toks[3]! },
        );
        break;
      }
      case 'M': {
        const m = models.get((toks[5] ?? '').toUpperCase());
        if (!m || (m.type !== 'NMOS' && m.type !== 'PMOS')) {
          reject(`MOSFET model "${toks[5] ?? ''}" is not defined`, toks.slice(1, 5));
          break;
        }
        if (m.type === 'PMOS') {
          reject('PMOS transistors are not modelled by FORGE', toks.slice(1, 5));
          break;
        }
        const level = parseSiValue(m.params.LEVEL ?? '1');
        if (level !== 1) {
          reject(`MOSFET LEVEL=${m.params.LEVEL} (only level 1 is represented)`, toks.slice(1, 5));
          break;
        }
        if (toks[4] !== toks[3])
          d.push(
            warn(
              'spice-body',
              `${name}: body terminal ${toks[4]} differs from the source; the body effect is not modelled.`,
            ),
          );
        const W = parseSiValue(p.W ?? '1') ?? 1;
        const L = parseSiValue(p.L ?? '1') ?? 1;
        const kp = parseSiValue(m.params.KP ?? '2e-5') ?? 2e-5;
        add(
          {
            type: 'nmos',
            thresholdV: parseSiValue(m.params.VTO ?? '0') ?? 0,
            transconductanceAPerV2: (kp * W) / L,
            lambdaPerV: parseSiValue(m.params.LAMBDA ?? '0') ?? 0,
            maxDrainCurrentA: null,
          },
          { d: toks[1]!, g: toks[2]!, s: toks[3]! },
          `K = KP·W/L = ${kp}·${W}/${L}`,
        );
        break;
      }
      case 'X':
        reject('subcircuit instance (subcircuits are not supported)', toks.slice(1, -1));
        break;
      case 'B':
        reject('behavioural source (B) is not supported', toks.slice(1, 3));
        break;
      case 'F':
      case 'H':
        reject('current-controlled source (F/H) is not supported', toks.slice(1, 3));
        break;
      case 'K':
        reject('inductor coupling (K) is not supported', []);
        break;
      case 'S':
      case 'W':
        reject('controlled switch (S/W) is not supported', toks.slice(1, 3));
        break;
      case 'T':
        reject('transmission line (T) is not supported', toks.slice(1, 5));
        break;
      default:
        reject(`unknown element type "${letter}"`, []);
    }
  }
  if (!parts.length) d.push(err('spice-empty', 'No supported circuit elements were found.'));
  // Connectivity.
  const allNodes = new Set(
    parts.flatMap((x) => Object.values(x.pins).filter((v): v is string => v !== null)),
  );
  const ground = [...allNodes].find((n) => GROUND.has(n)) ?? null;
  if (!ground) d.push(err('spice-ground', 'No reference node (0 or GND).'));
  const nodes = new Map<string, { label: string; pin: string }[]>();
  for (const x of parts)
    for (const [pin, node] of Object.entries(x.pins)) {
      if (node === null) continue;
      const key = GROUND.has(node) ? '0' : node;
      nodes.set(key, [...(nodes.get(key) ?? []), { label: x.label, pin }]);
    }
  for (const [n, t] of nodes)
    if (t.length === 1 && n !== '0')
      d.push(
        warn('spice-floating', `Node ${n} connects to only one terminal (${t[0]!.label}.${t[0]!.pin}).`),
      );
  if (d.some((x) => x.severity === 'error')) return { ...empty(), title, elements, nodes };
  const pinsNormalised = parts.map((x) => ({
    ...x,
    pins: Object.fromEntries(
      Object.entries(x.pins).map(([k, v]) => [k, v !== null && GROUND.has(v) ? '0' : v]),
    ),
  }));
  const built = buildDefinition(title || 'SPICE import', pinsNormalised, ground ? '0' : null);
  if (built.def && tran)
    built.def.settings.transient = { ...built.def.settings.transient, stepS: tran.stepS, stopS: tran.stopS };
  d.push(...built.diagnostics);
  if (!built.def) return { ...empty(), title, elements, nodes };
  // Ground part's own terminal belongs to node 0 too.
  nodes.set('0', [...(nodes.get('0') ?? []), { label: 'GND', pin: 'gnd' }]);
  const connectivity = verifyConnectivity(built.def, nodes);
  if (!connectivity.ok) d.push(...connectivity.problems.map((m) => err('connectivity', m)));
  else
    d.push(
      info(
        'connectivity',
        `Connectivity verified: ${connectivity.nets} nodes, ${connectivity.terminals} terminals identical to the source.`,
      ),
    );
  const partial = elements.some((e) => !e.supported);
  return {
    ok: !d.some((x) => x.severity === 'error'),
    title,
    definition: built.def,
    elements,
    nodes,
    connectivity,
    analyses,
    unsupported,
    partial,
    diagnostics: d,
  };
}
