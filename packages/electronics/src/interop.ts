import { ElectricalDefinitionSchema, type ElectricalDefinition } from '@forge/engineering-core';
import { compileNetlist } from './netlist';

/**
 * Electrical data interchange.
 *  - FORGE electrical bundle (JSON): the complete, validated electrical definition. Imports
 *    are untrusted: size-limited, parsed, and validated by the same schema as project files.
 *  - SPICE-style netlist EXPORT of the analog subset (R, C, L, V, I, E, G, D, Q, M). It is a
 *    preparation for interoperability, NOT a verified SPICE translation: it has not been
 *    checked against a SPICE simulator, and devices without a SPICE equivalent are listed as
 *    comments. Import of SPICE or KiCad files is not supported.
 */
export const ELECTRICAL_BUNDLE_FORMAT = 'forge-electrical-bundle';
export const ELECTRICAL_BUNDLE_VERSION = 1;
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

export function exportElectricalBundle(def: ElectricalDefinition, meta: { project?: string } = {}): string {
  return JSON.stringify(
    {
      format: ELECTRICAL_BUNDLE_FORMAT,
      version: ELECTRICAL_BUNDLE_VERSION,
      exportedFrom: meta.project ?? null,
      definition: def,
    },
    null,
    2,
  );
}

export type BundleResult =
  { ok: true; definition: ElectricalDefinition } | { ok: false; error: string; details: string[] };

export function parseElectricalBundle(text: string): BundleResult {
  if (text.length > MAX_BUNDLE_BYTES)
    return {
      ok: false,
      error: `File too large (${text.length} bytes; limit ${MAX_BUNDLE_BYTES}).`,
      details: [],
    };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'Not valid JSON.', details: [e instanceof Error ? e.message : String(e)] };
  }
  if (!doc || typeof doc !== 'object')
    return { ok: false, error: 'Not a FORGE electrical bundle.', details: [] };
  const o = doc as { format?: unknown; version?: unknown; definition?: unknown };
  if (o.format !== ELECTRICAL_BUNDLE_FORMAT)
    return { ok: false, error: 'Not a FORGE electrical bundle (missing "format").', details: [] };
  if (o.version !== ELECTRICAL_BUNDLE_VERSION)
    return { ok: false, error: `Unsupported bundle version ${String(o.version)}.`, details: [] };
  const v = ElectricalDefinitionSchema.safeParse(o.definition);
  if (!v.success)
    return {
      ok: false,
      error: `Invalid circuit (${v.error.issues.length} problem${v.error.issues.length === 1 ? '' : 's'}).`,
      details: v.error.issues.slice(0, 50).map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`),
    };
  return { ok: true, definition: v.data };
}

const spiceName = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');

export function exportSpiceNetlist(def: ElectricalDefinition): string {
  const nl = compileNetlist(def);
  const node = (partId: string, t: string) => {
    const n = nl.terminalNet(partId, t);
    if (n === undefined) return '?';
    return n === nl.ground ? '0' : spiceName(nl.nets[n]!.name);
  };
  const lines = [
    `* ${def.name} — exported by FORGE (SPICE-style subset; not verified against a SPICE simulator)`,
    `* Reference node 0 = ${nl.ground >= 0 ? nl.nets[nl.ground]!.name : '(none)'}`,
  ];
  const models: string[] = [];
  const wave = (w: (typeof def.parts)[number]['device'] & { type: 'vsource' | 'isource' }) => {
    const x = w.waveform;
    switch (x.kind) {
      case 'dc':
        return `DC ${x.value}`;
      case 'step':
        return `PWL(0 ${x.v0} ${x.atS} ${x.v0} ${x.atS + 1e-12} ${x.v1})`;
      case 'pulse':
        return `PULSE(${x.v1} ${x.v2} ${x.delayS} ${x.riseS} ${x.fallS} ${x.widthS} ${x.periodS})`;
      case 'sine':
        return `SIN(${x.offset} ${x.amplitude} ${x.frequencyHz} ${x.delayS} 0 ${x.phaseDeg})`;
      case 'pwl':
        return `PWL(${x.points.map(([t, v]) => `${t} ${v}`).join(' ')})`;
    }
  };
  for (const p of def.parts) {
    const d = p.device;
    const n = (t: string) => node(p.id, t);
    const id = spiceName(p.label);
    switch (d.type) {
      case 'resistor':
        lines.push(`R${id} ${n('p1')} ${n('p2')} ${d.resistanceOhm}`);
        break;
      case 'capacitor': {
        const [a, b] = d.polarized ? ['pos', 'neg'] : ['p1', 'p2'];
        lines.push(
          `C${id} ${n(a)} ${n(b)} ${d.capacitanceF}${d.initialVoltageV !== null ? ` IC=${d.initialVoltageV}` : ''}`,
        );
        break;
      }
      case 'inductor':
        lines.push(
          `L${id} ${n('p1')} ${n('p2')} ${d.inductanceH}${d.initialCurrentA !== null ? ` IC=${d.initialCurrentA}` : ''}`,
        );
        break;
      case 'vsource':
        if (d.seriesResistanceOhm > 0) {
          lines.push(
            `V${id} ${n('pos')}_int ${n('neg')} ${wave(d)}`,
            `R${id}_s ${n('pos')}_int ${n('pos')} ${d.seriesResistanceOhm}`,
          );
        } else lines.push(`V${id} ${n('pos')} ${n('neg')} ${wave(d)}`);
        break;
      case 'isource':
        // SPICE: current flows from n+ through the source to n−; FORGE: out of "pos" into the circuit.
        lines.push(`I${id} ${n('neg')} ${n('pos')} ${wave(d)}`);
        break;
      case 'vcvs':
        lines.push(`E${id} ${n('out+')} ${n('out-')} ${n('ctl+')} ${n('ctl-')} ${d.gain}`);
        break;
      case 'vccs':
        lines.push(`G${id} ${n('out+')} ${n('out-')} ${n('ctl+')} ${n('ctl-')} ${d.transconductanceS}`);
        break;
      case 'diode':
      case 'led':
        lines.push(`D${id} ${n('a')} ${n('k')} DM_${id}`);
        models.push(
          `.model DM_${id} D(IS=${d.model.saturationCurrentA} N=${d.model.emissionCoefficient} RS=${d.model.seriesResistanceOhm})`,
        );
        break;
      case 'npn':
        lines.push(`Q${id} ${n('c')} ${n('b')} ${n('e')} QM_${id}`);
        models.push(`.model QM_${id} NPN(IS=${d.saturationCurrentA} BF=${d.betaF} BR=${d.betaR})`);
        break;
      case 'nmos':
        // Level 1 with KP·W/L = K (W = L = 1 µm).
        lines.push(`M${id} ${n('d')} ${n('g')} ${n('s')} ${n('s')} MM_${id} W=1u L=1u`);
        models.push(
          `.model MM_${id} NMOS(LEVEL=1 VTO=${d.thresholdV} KP=${d.transconductanceAPerV2} LAMBDA=${d.lambdaPerV})`,
        );
        break;
      case 'potentiometer':
        lines.push(
          `R${id}_aw ${n('a')} ${n('w')} ${d.resistanceOhm * Math.max(1e-4, d.position)}`,
          `R${id}_wb ${n('w')} ${n('b')} ${d.resistanceOhm * Math.max(1e-4, 1 - d.position)}`,
        );
        break;
      case 'switch':
        if (d.closed) lines.push(`R${id} ${n('p1')} ${n('p2')} ${d.onResistanceOhm} ; closed switch`);
        else lines.push(`* ${p.label}: open switch (no element)`);
        break;
      case 'ground':
      case 'junction':
        break;
      default:
        lines.push(`* ${p.label} (${d.type}): no SPICE equivalent exported (behavioural/digital model)`);
    }
  }
  lines.push(...models, `.tran ${def.settings.transient.stepS} ${def.settings.transient.stopS}`, '.end');
  return lines.join('\n') + '\n';
}
