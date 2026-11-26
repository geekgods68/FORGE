import { analogCircuitOf, compileNetlist, exportSpiceNetlist } from '@forge/electronics';
import { ForgeEngine, makeCommand, type CommandInput } from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { exportCircuit, planCircuitImport } from '../circuit';
import { parseSiValue } from '../electrical';
import { importKicad } from '../formats/kicad';
import { parseSpice } from '../formats/spice';
import { importStatus } from '../provenance';
import { AT, emptyProject } from './fixtures';

const enc = new TextEncoder();
export const RC_CIR = `RC charging test (5 V, 1 kOhm, 1 uF)
* tau = R*C = 1 ms
V1 in 0 DC 5
R1 in out 1k
C1 out 0 1u IC=0
.tran 2u 6m
.end
`;

export const KICAD_NET = `(export (version "E")
  (design (source "/home/user/blink/blink.kicad_sch") (tool "Eeschema 7.0.10"))
  (components
    (comp (ref "R1") (value "330") (footprint "Resistor_THT:R_Axial_DIN0207") (libsource (lib "Device") (part "R") (description "Resistor")))
    (comp (ref "C1") (value "100n") (footprint "Capacitor_SMD:C_0603") (libsource (lib "Device") (part "C") (description "Capacitor")))
    (comp (ref "D1") (value "LED") (footprint "LED_THT:LED_D5.0mm") (libsource (lib "Device") (part "LED") (description "LED")))
    (comp (ref "BT1") (value "5V") (footprint "Battery:BatteryHolder") (libsource (lib "Device") (part "Battery") (description "Battery")))
    (comp (ref "J1") (value "Conn_01x02") (footprint "Connector:Header") (libsource (lib "Connector_Generic") (part "Conn_01x02") (description "Connector"))))
  (nets
    (net (code "1") (name "+5V") (node (ref "BT1") (pin "1") (pinfunction "+")) (node (ref "R1") (pin "1")) (node (ref "J1") (pin "1")))
    (net (code "2") (name "Net-(D1-A)") (node (ref "R1") (pin "2")) (node (ref "D1") (pin "2") (pinfunction "A")) (node (ref "C1") (pin "1")))
    (net (code "3") (name "GND") (node (ref "BT1") (pin "2") (pinfunction "-")) (node (ref "D1") (pin "1") (pinfunction "K")) (node (ref "C1") (pin "2")) (node (ref "J1") (pin "2")))))
`;

export const KICAD_PCB = `(kicad_pcb (version 20221018) (generator pcbnew)
  (net 0 "") (net 1 "VIN") (net 2 "OUT") (net 3 "GND")
  (footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (at 100 50 90)
    (property "Reference" "R1") (property "Value" "10k")
    (pad "1" smd roundrect (at -0.8 0) (size 0.8 0.9) (layers "F.Cu") (net 1 "VIN"))
    (pad "2" smd roundrect (at 0.8 0) (size 0.8 0.9) (layers "F.Cu") (net 2 "OUT"))
    (model "\${KICAD6_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603.wrl"))
  (footprint "Capacitor_SMD:C_0603_1608Metric" (layer "B.Cu") (at 110 50 0)
    (property "Reference" "C1") (property "Value" "1u")
    (pad "1" smd roundrect (at -0.8 0) (size 0.8 0.9) (layers "B.Cu") (net 2 "OUT"))
    (pad "2" smd roundrect (at 0.8 0) (size 0.8 0.9) (layers "B.Cu") (net 3 "GND")))
  (segment (start 100 50) (end 110 50) (width 0.25) (layer "F.Cu") (net 2)))
`;

function apply(project: ReturnType<typeof emptyProject>, commands: unknown[]) {
  const e = new ForgeEngine(project, { now: () => AT });
  return {
    engine: e,
    result: e.execute(makeCommand('scene.batch', { commands } as never, 'test') as CommandInput),
  };
}

describe('SI values', () => {
  it('parses SPICE/KiCad suffixes (M = milli, MEG = mega, 4k7 notation, µ)', () => {
    expect(parseSiValue('1k')).toBe(1000);
    expect(parseSiValue('4k7')).toBeCloseTo(4700, 9);
    expect(parseSiValue('1MEG')).toBe(1e6);
    expect(parseSiValue('10m')).toBeCloseTo(0.01, 12);
    expect(parseSiValue('2.2uF')).toBeCloseTo(2.2e-6, 18);
    expect(parseSiValue('100n')).toBeCloseTo(1e-7, 18);
    expect(parseSiValue('47µ')).toBeCloseTo(4.7e-5, 15);
    expect(parseSiValue('330')).toBe(330);
    expect(parseSiValue('abc')).toBeNull();
  });
});

describe('SPICE import', () => {
  it('imports an RC circuit with exact values and verified connectivity', () => {
    const r = parseSpice(enc.encode(RC_CIR));
    expect(r.ok).toBe(true);
    const def = r.definition!;
    const part = (id: string) => def.parts.find((p) => p.id === id)!.device;
    expect(part('R1')).toMatchObject({ type: 'resistor', resistanceOhm: 1000 });
    expect(part('C1')).toMatchObject({ type: 'capacitor', capacitanceF: 1e-6, initialVoltageV: 0 });
    expect(part('V1')).toMatchObject({ type: 'vsource', waveform: { kind: 'dc', value: 5 } });
    expect(def.settings.transient.stepS).toBe(2e-6);
    expect(def.settings.transient.stopS).toBe(6e-3);
    expect(r.connectivity).toMatchObject({ ok: true, nets: 3, terminals: 7 });
  });

  it('simulates the imported RC with the existing transient solver: matches 5(1 − e^(−t/τ))', () => {
    const def = parseSpice(enc.encode(RC_CIR)).definition!;
    const c = analogCircuitOf(def);
    const res = c.transient(def.settings.transient.stopS, def.settings.transient.stepS, { maxPoints: 4000 });
    if (!res.ok) throw new Error('transient failed');
    const out = c.netlist.nets.find((n) => n.name === 'out')!;
    const v = res.v[out.index]!;
    let maxErr = 0;
    for (let k = 0; k < res.t.length; k++)
      maxErr = Math.max(maxErr, Math.abs(v[k]! - 5 * (1 - Math.exp(-res.t[k]! / 1e-3))));
    // Trapezoidal integration at Δt = τ/500: error well below 1 mV.
    expect(maxErr).toBeLessThan(1e-3);
    const at1tau = v[res.t.findIndex((t) => t >= 1e-3)]!;
    expect(Math.abs(at1tau - 5 * (1 - Math.exp(-1)))).toBeLessThan(0.01);
  });

  it('round-trips through the SPICE exporter: same values and identical connectivity', () => {
    const a = parseSpice(enc.encode(RC_CIR)).definition!;
    const text = exportSpiceNetlist(a);
    expect(text).toMatch(/^R1 \S+ \S+ 1000$/m);
    const b = parseSpice(enc.encode(text));
    expect(b.ok).toBe(true);
    for (const id of ['R1', 'C1', 'V1'])
      expect(b.definition!.parts.find((p) => p.id === id)!.device).toEqual(
        a.parts.find((p) => p.id === id)!.device,
      );
    const groups = (def: typeof a) => {
      const nl = compileNetlist(def);
      return nl.nets
        .map((n) =>
          n.pins
            .map((p) => `${def.parts.find((x) => x.id === p.partId)!.label}.${p.pin}`)
            .sort()
            .join(' '),
        )
        .filter((s) => s.includes(' '))
        .sort();
    };
    expect(groups(b.definition!)).toEqual(groups(a));
  });

  it('maps every supported element kind and models', () => {
    const r = parseSpice(
      enc.encode(`all supported
V1 vcc 0 PULSE(0 5 1u 1n 1n 5u 10u)
I1 0 a 1m
L1 a b 10mH IC=1m
R1 b 0 4k7
E1 e 0 a 0 2
G1 0 g a 0 1m
Rg g 0 1k
Re e 0 1k
D1 vcc d DMOD
Rd d 0 1k
Q1 c b2 0 QN
Rc vcc c 1k
Rb vcc b2 100k
M1 dd gg 0 0 NM W=10u L=2u
Rdd vcc dd 1k
Rgg vcc gg 1k
.model DMOD D(IS=1e-12 N=1.5 RS=2 CJO=1p)
.model QN NPN(IS=1e-15 BF=150 BR=2 VAF=50)
.model NM NMOS(LEVEL=1 VTO=1.5 KP=50u LAMBDA=0.01)
.tran 1u 1m
.end
`),
    );
    expect(r.ok).toBe(true);
    const dev = (id: string) =>
      r.definition!.parts.find((p) => p.id === id)!.device as unknown as Record<string, unknown>;
    expect(dev('V1').waveform).toMatchObject({ kind: 'pulse', v1: 0, v2: 5, delayS: 1e-6, periodS: 1e-5 });
    expect(dev('I1')).toMatchObject({ type: 'isource' });
    expect(dev('L1')).toMatchObject({ inductanceH: 0.01, initialCurrentA: 0.001 });
    expect(dev('E1')).toMatchObject({ type: 'vcvs', gain: 2 });
    expect(dev('D1')).toMatchObject({
      type: 'diode',
      model: { saturationCurrentA: 1e-12, emissionCoefficient: 1.5, seriesResistanceOhm: 2 },
    });
    expect(dev('Q1')).toMatchObject({ type: 'npn', betaF: 150 });
    expect(dev('M1').transconductanceAPerV2).toBeCloseTo((50e-6 * 10) / 2, 12);
    expect(r.unsupported.join(' ')).toMatch(/CJO/);
    expect(r.unsupported.join(' ')).toMatch(/VAF/);
    // I n+ n−: SPICE current flows n+ → n− inside the source; FORGE "pos" is where it leaves.
    const nl = compileNetlist(r.definition!);
    expect(nl.nets[nl.terminalNet('I1', 'pos')!]!.name).toBe('a');
  });

  it('identifies unsupported constructs and refuses them unless a partial import is accepted', () => {
    const src = `unsupported
V1 a 0 5
R1 a b 1k
X1 b 0 OPAMP
B1 c 0 V=V(a)*2
.subckt OPAMP in out
R9 in out 1
.ends
.include models.lib
.ac dec 10 1 1meg
.end
`;
    const strict = parseSpice(enc.encode(src));
    expect(strict.ok).toBe(false);
    expect(
      strict.diagnostics
        .filter((d) => d.code === 'spice-element')
        .map((d) => d.message)
        .join(' '),
    ).toMatch(/X1.*B1|B1.*X1/s);
    const partial = parseSpice(enc.encode(src), { allowPartial: true });
    expect(partial.ok).toBe(true);
    expect(partial.partial).toBe(true);
    expect(partial.definition!.parts.map((p) => p.id).sort()).toEqual(['GND', 'R1', 'V1']);
    expect(partial.unsupported.join('\n')).toMatch(/subcircuit definition OPAMP/);
    expect(partial.unsupported.join('\n')).toMatch(/\.include/);
    expect(partial.unsupported.join('\n')).toMatch(/\.ac/);
    expect(
      parseSpice(enc.encode('no ground\nR1 a b 1k\nV1 a b 1\n.end')).diagnostics.some(
        (d) => d.code === 'spice-ground',
      ),
    ).toBe(true);
    expect(
      parseSpice(enc.encode('bad\nR1 a 0 {RVAL}\n.end')).diagnostics.some((d) => d.code === 'spice-param'),
    ).toBe(true);
  });

  it('inserts the circuit as one undoable step with provenance; replacing needs confirmation', () => {
    const project = emptyProject();
    const r = parseSpice(enc.encode(RC_CIR));
    const input = {
      file: { name: 'rc.cir', bytes: enc.encode(RC_CIR) },
      format: 'spice' as const,
      formatVersion: null,
      definition: r.definition,
      diagnostics: r.diagnostics,
      unsupported: r.unsupported,
      connectivity: r.connectivity,
    };
    const plan = planCircuitImport(input, { replaceExisting: false, importId: 'imp-rc', now: AT }, project);
    expect(plan.ok).toBe(true);
    const { engine, result } = apply(project, plan.commands);
    expect(result.ok).toBe(true);
    const p = engine.getProject();
    const root = p.scene.nodes[p.scene.rootId]!;
    if (root.kind !== 'root') throw new Error('root');
    expect(root.electrical!.parts).toHaveLength(4);
    const rec = root.imports![0]!;
    expect(importStatus(rec, p.scene)).toBe('unmodified');
    expect(
      planCircuitImport(input, { replaceExisting: false, importId: 'imp-2' }, p).diagnostics.some(
        (d) => d.code === 'circuit-exists',
      ),
    ).toBe(true);
    const ex = exportCircuit(root.electrical!, 'spice');
    expect(ex.text).toMatch(/^C1 \S+ 0 0\.000001 IC=0$/m);
    engine.undo();
    const back = engine.getProject().scene.nodes[engine.getProject().scene.rootId]!;
    expect(back.kind === 'root' && back.electrical).toBeFalsy();
  });
});

describe('KiCad import', () => {
  it('maps a netlist: exact symbols map, unmapped parts are reported (not substituted), connectivity verified', () => {
    const r = importKicad(enc.encode(KICAD_NET), 'kicad-netlist');
    expect(r.ok).toBe(true);
    const status = Object.fromEntries(r.mappings.map((m) => [m.ref, m.status]));
    expect(status).toEqual({ R1: 'mapped', C1: 'mapped', D1: 'mapped', BT1: 'mapped', J1: 'unmapped' });
    const dev = (id: string) =>
      r.definition!.parts.find((p) => p.id === id)!.device as unknown as Record<string, unknown>;
    expect(dev('R1')).toMatchObject({ type: 'resistor', resistanceOhm: 330 });
    expect(dev('C1')).toMatchObject({ type: 'capacitor', capacitanceF: 1e-7 });
    expect(dev('BT1')).toMatchObject({ type: 'vsource', waveform: { kind: 'dc', value: 5 } });
    expect(r.definition!.parts.some((p) => p.id === 'J1')).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'kicad-unmapped')!.message).toMatch(
      /J1 \(Connector_Generic:Conn_01x02/,
    );
    // LED polarity follows the pin functions (K = pin 1, A = pin 2).
    const nl = compileNetlist(r.definition!);
    expect(nl.nets[nl.terminalNet('D1', 'k')!]!.name).toBe('GND');
    expect(r.connectivity).toMatchObject({ ok: true, nets: 3 });
  });

  it('accepts manual mappings and explicit omission', () => {
    const r = importKicad(enc.encode(KICAD_NET), 'kicad-netlist', { J1: { as: 'resistor', value: 1e6 } });
    expect(r.mappings.find((m) => m.ref === 'J1')!.status).toBe('manual');
    expect(r.definition!.parts.find((p) => p.id === 'J1')!.device).toMatchObject({
      type: 'resistor',
      resistanceOhm: 1e6,
    });
    expect(r.connectivity!.ok).toBe(true);
    const o = importKicad(enc.encode(KICAD_NET), 'kicad-netlist', { J1: { as: 'omit' } });
    expect(o.mappings.find((m) => m.ref === 'J1')!.status).toBe('omitted');
    expect(o.diagnostics.some((d) => d.code === 'kicad-unmapped')).toBe(false);
  });

  it('imports PCB connectivity from pad nets with placement, and states the scope', () => {
    const r = importKicad(enc.encode(KICAD_PCB), 'kicad-pcb');
    expect(r.ok).toBe(true);
    expect(r.doc!.components.find((c) => c.ref === 'C1')!.placement).toEqual({
      x: 110,
      y: 50,
      rotation: 0,
      side: 'back',
    });
    const nl = compileNetlist(r.definition!);
    expect(nl.terminalNet('R1', 'p2')).toBe(nl.terminalNet('C1', 'p1'));
    expect(r.diagnostics.some((d) => d.code === 'kicad-pcb-scope')).toBe(true);
    expect(r.doc!.unsupported.join(' ')).toMatch(/3D model/);
    expect(r.doc!.unsupported.join(' ')).toMatch(/no electromagnetic or thermal analysis/);
    expect(r.definition!.parts.find((p) => p.id === 'R1')!.note).toMatch(/PCB front at \(100, 50\) mm, 90°/);
  });

  it('reads schematics for inspection only and refuses malformed files', () => {
    const sch = importKicad(
      enc.encode(
        '(kicad_sch (version 20230121) (generator eeschema) (symbol (lib_id "Device:R") (property "Reference" "R1") (property "Value" "1k")))',
      ),
      'kicad-schematic',
    );
    expect(sch.ok).toBe(false);
    expect(sch.doc!.components[0]).toMatchObject({ ref: 'R1', part: 'R' });
    expect(sch.diagnostics[0]!.message).toMatch(/Export → Netlist/);
    expect(
      importKicad(enc.encode('(export (version "E") (components'), 'kicad-netlist').diagnostics[0]!.code,
    ).toBe('kicad-syntax');
  });
});

describe('research integration', () => {
  it('runs a Phase 7 R × C sweep on an imported SPICE circuit: τ = RC within 1 %', async () => {
    const { Campaign, MemoryRunDataStore, ResearchEngine, rcSweepExperiment } =
      await import('@forge/research');
    const { loadRapier } = await import('@forge/physics');
    const r = parseSpice(enc.encode(RC_CIR));
    const plan = planCircuitImport(
      {
        file: { name: 'rc.cir', bytes: enc.encode(RC_CIR) },
        format: 'spice',
        formatVersion: null,
        definition: r.definition,
        diagnostics: r.diagnostics,
        unsupported: r.unsupported,
        connectivity: r.connectivity,
      },
      { replaceExisting: false, importId: 'imp-rc', now: AT },
      emptyProject(),
    );
    const { engine } = apply(emptyProject(), plan.commands);
    const project = engine.getProject();
    // The template targets electrical.part.R1 / C1 — the imported SPICE designators.
    const base = rcSweepExperiment(project);
    const draft = {
      ...base,
      measurements: base.measurements.map((m) =>
        m.source.kind === 'signal' ? { ...m, source: { kind: 'signal' as const, signal: 'V(out)' } } : m,
      ),
    };
    const re = ResearchEngine.empty(project.id, () => AT);
    expect(re.execute({ type: 'experiment.create', payload: { experiment: draft } }).ok).toBe(true);
    const p = await new Campaign(re, new MemoryRunDataStore(), project, draft.id, await loadRapier()).run();
    expect(p.failed).toBe(0);
    const runs = re.runsOf(draft.id);
    expect(runs).toHaveLength(9);
    for (const run of runs) {
      const R = run.config.applied.find((a) => a.target === 'electrical.part.R1.resistanceOhm')!
        .value as number;
      const C = run.config.applied.find((a) => a.target === 'electrical.part.C1.capacitanceF')!
        .value as number;
      expect(Math.abs(run.outcomes.tau!.value! - R * C) / (R * C)).toBeLessThan(0.01);
    }
  }, 60_000);
});
