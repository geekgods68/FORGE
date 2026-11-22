import { massProperties } from '@forge/mechanics';
import { describe, expect, it } from 'vitest';
import {
  buildPhysicsModel,
  combine,
  createRoboticArmSimulationSample,
  eigenSym3,
  mat3Mul,
  pointMass,
  quatFromMat3,
  simulationOf,
  solidMass,
  transpose3,
  type Mat3,
} from '../index';

const close = (a: readonly number[], b: readonly number[], tol: number) =>
  a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThanOrEqual(tol));

describe('mass properties (closed form)', () => {
  it('box inertia about its centre', () => {
    const m = solidMass({ type: 'box', size: [0.2, 0.1, 0.05], at: [1, 2, 3], app: 'primary' }, 1000);
    expect(m.massKg).toBeCloseTo(1, 12);
    close(m.com, [1, 2, 3], 1e-15);
    close(
      [m.inertia[0], m.inertia[4], m.inertia[8]],
      [(0.01 + 0.0025) / 12, (0.04 + 0.0025) / 12, (0.04 + 0.01) / 12],
      1e-15,
    );
  });

  it('a rectangular prism equals the equivalent box for every extrusion axis', () => {
    const outline: [number, number][] = [
      [-0.03, -0.01],
      [0.05, -0.01],
      [0.05, 0.02],
      [-0.03, 0.02],
    ];
    for (const axis of ['x', 'y', 'z'] as const) {
      const p = solidMass({ type: 'prism', outline, depth: 0.04, axis, at: [0, 0, 0], app: 'primary' }, 2700);
      // (u, v, w) → (x, y, z) per the outline convention; u ∈ [−0.03, 0.05], v ∈ [−0.01, 0.02].
      const size = axis === 'z' ? [0.08, 0.03, 0.04] : axis === 'x' ? [0.04, 0.03, 0.08] : [0.08, 0.04, 0.03];
      const centre = axis === 'z' ? [0.01, 0.005, 0] : axis === 'x' ? [0, 0.005, 0.01] : [0.01, 0, 0.005];
      const b = solidMass(
        {
          type: 'box',
          size: size as [number, number, number],
          at: centre as [number, number, number],
          app: 'primary',
        },
        2700,
      );
      expect(p.massKg).toBeCloseTo(b.massKg, 12);
      close(p.com, b.com, 1e-12);
      close(p.inertia, b.inertia, 1e-12);
    }
  });

  it('holes are subtracted exactly (plate with a hole = plate − hole cylinder approximated by a square)', () => {
    const sq = (c: number, h: number): [number, number][] => [
      [c - h, -h],
      [c + h, -h],
      [c + h, h],
      [c - h, h],
    ];
    const plate = solidMass(
      {
        type: 'prism',
        outline: sq(0, 0.05),
        holes: [sq(0.02, 0.01)],
        depth: 0.01,
        axis: 'y',
        at: [0, 0, 0],
        app: 'primary',
      },
      1000,
    );
    const full = solidMass({ type: 'box', size: [0.1, 0.01, 0.1], at: [0, 0, 0], app: 'primary' }, 1000);
    const hole = solidMass({ type: 'box', size: [0.02, 0.01, 0.02], at: [0.02, 0, 0], app: 'primary' }, 1000);
    const neg = { ...hole, massKg: -hole.massKg, inertia: hole.inertia.map((v) => -v) as Mat3 };
    const expected = combine([full, neg])!;
    expect(plate.massKg).toBeCloseTo(expected.massKg, 12);
    close(plate.com, expected.com, 1e-12);
    close(plate.inertia, expected.inertia, 1e-12);
  });

  it('cylinders, tubes and spheres', () => {
    const c = solidMass(
      { type: 'cylinder', r: 0.01, h: 0.1, axis: 'x', at: [0, 0, 0], app: 'primary' },
      7850,
    );
    const m = 7850 * Math.PI * 1e-4 * 0.1;
    close([c.inertia[0], c.inertia[4]], [(m * 1e-4) / 2, (m * (3e-4 + 0.01)) / 12], 1e-15);
    const s = solidMass({ type: 'sphere', r: 0.1, at: [0, 0, 0], app: 'primary' }, 1000);
    expect(s.inertia[0]).toBeCloseTo(0.4 * s.massKg * 0.01, 15);
  });

  it('parallel-axis composition and principal axes', () => {
    const two = combine([pointMass(1, [-1, 0, 0]), pointMass(1, [1, 0, 0])])!;
    expect(two.com).toEqual([0, 0, 0]);
    close([two.inertia[0], two.inertia[4], two.inertia[8]], [0, 2, 2], 1e-15);
    const I: Mat3 = [3, 1, 0.5, 1, 2, 0.2, 0.5, 0.2, 1];
    const e = eigenSym3(I);
    const V = e.vectors;
    const D: Mat3 = [e.values[0], 0, 0, 0, e.values[1], 0, 0, 0, e.values[2]];
    close(mat3Mul(mat3Mul(V, D), transpose3(V)), I, 1e-12);
    const q = quatFromMat3(V);
    expect(Math.hypot(...q)).toBeCloseTo(1, 12);
  });
});

describe('bridge mass properties match the Phase 4 measurement', () => {
  it('every arm body with model mass data: same mass and centre of mass', () => {
    const p = createRoboticArmSimulationSample(new Date('2026-11-22T00:00:00Z'));
    const model = buildPhysicsModel(p.scene, simulationOf(p.scene)!);
    let checked = 0;
    for (const b of model.bodies.filter((x) => x.mode === 'dynamic'))
      for (const src of b.massSources) {
        if (src.source === 'user') continue;
        const ref = massProperties(p.scene, src.nodeId);
        expect(src.massKg).toBeCloseTo(ref.massKg!, 12);
        checked++;
      }
    expect(checked).toBeGreaterThanOrEqual(8);
    // The welded body's COM is the mass-weighted mean of its parts (body frame origin).
    for (const b of model.bodies.filter((x) => x.mode === 'dynamic')) close(b.mass!.com, [0, 0, 0], 1e-15);
  });
});
