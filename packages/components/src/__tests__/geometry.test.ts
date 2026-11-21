import { describe, expect, it } from 'vitest';
import { getDefinition } from '../catalog';
import { checkCompatibility } from '../connections';
import { evaluate, resolveParameters } from '../evaluate';
import { getMaterial, MATERIALS } from '../materials';
import { solidVolume } from '../geometry/solids';

const def = (id: string) => getDefinition(id)!;
const ev = (id: string, overrides = {}, variant: string | null = null, material?: string | null) => {
  const d = def(id);
  const r = resolveParameters(d, variant, overrides);
  if (!r.ok) throw new Error(r.issues.join('; '));
  return evaluate(d, r.values, material === undefined ? d.materialId : material);
};

describe('parameters', () => {
  it('resolves defaults → variant → overrides, in metres', () => {
    const r = resolveParameters(def('aluminium-plate'), 't10', { length: 0.3 });
    expect(r.ok).toBe(true);
    expect(r.values).toMatchObject({ length: 0.3, width: 0.1, thickness: 0.01 });
  });

  it('rejects out-of-range, wrong-type, unknown and unsupported combinations', () => {
    expect(resolveParameters(def('aluminium-plate'), null, { thickness: -1 }).issues.join()).toMatch(
      /outside/,
    );
    expect(resolveParameters(def('aluminium-plate'), null, { thickness: 'thick' }).issues.join()).toMatch(
      /must be a length/,
    );
    expect(resolveParameters(def('aluminium-plate'), null, { colour: 1 }).issues.join()).toMatch(
      /Unknown parameter/,
    );
    expect(resolveParameters(def('aluminium-plate'), 'nope').issues.join()).toMatch(/Unknown variant/);
    expect(resolveParameters(def('machine-screw'), null, { size: 'M7' }).issues.join()).toMatch(
      /not an available option/,
    );
    // Cross-parameter rule from the generator.
    expect(
      resolveParameters(def('round-tube'), null, { outerDiameter: 0.01, wall: 0.006 }).issues.join(),
    ).toMatch(/Wall thickness/);
    expect(
      resolveParameters(def('spur-gear'), null, { module: 0.001, teeth: 10, bore: 0.01 }).issues.join(),
    ).toMatch(/Bore is too large/);
  });
});

describe('geometry generators', () => {
  it('a 300 mm plate occupies 0.3 m; bounds are exact and the base sits on y = 0', () => {
    const e = ev('aluminium-plate', { length: 0.3, width: 0.1, thickness: 0.005 });
    expect(e.size[0]).toBeCloseTo(0.3, 12);
    expect(e.size[1]).toBeCloseTo(0.005, 12);
    expect(e.size[2]).toBeCloseTo(0.1, 12);
    expect(e.bounds.min[1]).toBeCloseTo(0, 12);
    expect(e.volumeM3).toBeCloseTo(0.3 * 0.1 * 0.005, 15);
  });

  it('mass = modelled volume × density (exact representation), with corner holes subtracted', () => {
    const solid = ev('aluminium-plate', { length: 0.1, width: 0.1, thickness: 0.01 });
    expect(solid.mass).toMatchObject({ source: 'geometry-density' });
    expect(solid.mass.massKg).toBeCloseTo(0.1 * 0.1 * 0.01 * 2700, 9);
    const holed = ev('aluminium-plate', { length: 0.1, width: 0.1, thickness: 0.01, holes: 'M5' });
    expect(holed.mass.massKg!).toBeLessThan(solid.mass.massKg!);
    expect(holed.interfaces.filter((i) => i.type === 'bolt-hole')).toHaveLength(4);
  });

  it('standard dimensions: ISO 4032 M3 nut 5.5 mm across flats × 2.4 mm; 608 bearing 8 × 22 × 7 mm; NEMA 17 face 42.3 mm', () => {
    const nut = ev('hex-nut', { size: 'M3' });
    expect(nut.size[1]).toBeCloseTo(0.0024, 9);
    expect(Math.min(nut.size[0], nut.size[2])).toBeCloseTo(0.0055, 6); // across flats
    const b = ev('ball-bearing', { series: '608' });
    expect(b.size).toEqual([expect.closeTo(0.022, 9), expect.closeTo(0.007, 9), expect.closeTo(0.022, 9)]);
    expect(b.interfaces.find((i) => i.id === 'bore')!.compatibility).toContain('shaft-8mm');
    expect(ev('stepper-nema', { frame: '17' }).size[0]).toBeCloseTo(0.0423, 9);
  });

  it('extrusion presets: 2040 is 20 × 40 mm in section; mass is labelled approximate', () => {
    const e = ev('t-slot-extrusion', { length: 0.5 }, '2040');
    expect(e.size[2]).toBeCloseTo(0.02, 9);
    expect(e.size[1]).toBeCloseTo(0.04, 9);
    expect(e.size[0]).toBeCloseTo(0.5, 9);
    expect(e.mass.source).toBe('geometry-density-approximate');
  });

  it('is deterministic: identical inputs produce identical geometry', () => {
    expect(JSON.stringify(ev('spur-gear'))).toBe(JSON.stringify(ev('spur-gear')));
    expect(JSON.stringify(ev('arduino-uno-r3'))).toBe(JSON.stringify(ev('arduino-uno-r3')));
  });

  it('named models reproduce published overall dimensions', () => {
    const uno = ev('arduino-uno-r3');
    const pcb = uno.solids[0]!;
    expect(pcb.type).toBe('prism');
    const xs = (pcb as { outline: [number, number][] }).outline.map((p) => p[0]);
    const zs = (pcb as { outline: [number, number][] }).outline.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.0686, 9); // published 68.6 × 53.4 mm outline
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(0.0534, 9);
    expect(uno.interfaces.filter((i) => i.id.startsWith('mount-hole'))).toHaveLength(4);
    const sg = ev('towerpro-sg90');
    expect(sg.bounds.max[1]).toBeCloseTo(0.031, 6);
    expect(def('towerpro-sg90').specifiedMassKg).toBe(0.009);
    const mg = ev('towerpro-mg996r');
    expect(mg.bounds.max[1]).toBeCloseTo(0.0429, 6);
    expect(uno.interfaces.filter((i) => i.signal === 'D13')).toHaveLength(1);
  });

  it('envelope models never fabricate geometric mass; unknown density stays unknown', () => {
    const servo = ev('micro-servo-generic');
    expect(servo.volumeM3).toBeNull();
    expect(servo.mass).toMatchObject({ massKg: null, source: 'unknown' });
    expect(ev('towerpro-mg996r').mass).toMatchObject({ massKg: 0.055, source: 'specified' });
    expect(ev('aluminium-plate', {}, null, 'unspecified').mass).toMatchObject({
      massKg: null,
      source: 'unknown',
    });
    expect(ev('aluminium-plate', {}, null, 'no-such-material').mass.note).toMatch(/No material/);
  });

  it('volumes of primitive solids are exact', () => {
    expect(
      solidVolume({ type: 'tube', ro: 2, ri: 1, h: 1, axis: 'x', at: [0, 0, 0], app: 'primary' }),
    ).toBeCloseTo(3 * Math.PI, 12);
    expect(solidVolume({ type: 'sphere', r: 1, at: [0, 0, 0], app: 'primary' })).toBeCloseTo(
      (4 / 3) * Math.PI,
      12,
    );
  });
});

describe('materials', () => {
  it('unknown properties are null, never zero; every material cites a source', () => {
    for (const m of MATERIALS) {
      for (const k of [
        'densityKgM3',
        'youngsModulusPa',
        'yieldStrengthPa',
        'ultimateStrengthPa',
        'thermalConductivityWmK',
        'electricalConductivitySm',
      ] as const)
        expect(m[k]).not.toBe(0);
      expect(m.source.length).toBeGreaterThan(5);
    }
    expect(getMaterial('unspecified')!.densityKgM3).toBeNull();
    expect(getMaterial('tpu-95a')!.youngsModulusPa).toBeNull();
    expect(getMaterial('al-6061-t6')!.status).toBe('approximate');
  });
});

describe('connection compatibility (metadata only)', () => {
  const uno = () => ev('arduino-uno-r3').interfaces;
  it('matches by type, gender and shared descriptor — and explains refusals', () => {
    const d13 = uno().find((i) => i.signal === 'D13')!;
    const jumperM = ev('jumper-wire', {}, 'mm-100').interfaces[0]!;
    expect(checkCompatibility(d13, jumperM).compatible).toBe(true);
    const jumperF = ev('jumper-wire', {}, 'ff-200').interfaces[0]!;
    const r = checkCompatibility(d13, jumperF);
    expect(r.compatible).toBe(false);
    expect(r.reasons.join()).toMatch(/Both sides are female/);
    const bore = ev('ball-bearing').interfaces.find((i) => i.id === 'bore')!;
    expect(
      checkCompatibility(bore, ev('precision-shaft', { diameter: 0.008 }).interfaces[0]!).compatible,
    ).toBe(true);
    expect(
      checkCompatibility(bore, ev('precision-shaft', { diameter: 0.005 }).interfaces[0]!).compatible,
    ).toBe(false);
    expect(checkCompatibility(bore, d13).compatible).toBe(false);
  });
});
