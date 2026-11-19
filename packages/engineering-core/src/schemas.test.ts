import { describe, expect, it } from 'vitest';
import { COMPONENT_CATEGORIES } from './categories';
import { activeScene, createProject, DEMO_CUBE_DEFINITION, newId, validateProject } from './project';
import { PROJECT_SCHEMA_VERSION, type Project } from './schemas';
import { rotateAboutWorldY, yawOf } from './transform';
import { degToRad, formatLength, radToDeg, SI_UNITS } from './units';

const mutate = (fn: (p: Project) => void): Project => {
  const p = createProject('Test');
  fn(p);
  return p;
};
const errorsOf = (data: unknown) => {
  const r = validateProject(data);
  return r.ok ? [] : r.errors;
};

describe('createProject', () => {
  it('produces a valid, versioned project in SI units with one demo instance', () => {
    const p = createProject('Bench test', new Date('2026-11-19T12:00:00Z'));
    expect(validateProject(p).ok).toBe(true);
    expect(p.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(p.units).toEqual(SI_UNITS);
    expect(p.createdAt).toBe('2026-11-19T12:00:00.000Z');
    const scene = activeScene(p);
    expect(scene.instances).toHaveLength(1);
    expect(scene.instances[0]!.definitionId).toBe(DEMO_CUBE_DEFINITION.id);
    // Cube rests on the ground plane: centre at half its 0.3 m height.
    expect(scene.instances[0]!.transform.position).toEqual([0, 0.15, 0]);
  });

  it('assigns fresh stable ids each time', () => {
    const a = createProject();
    const b = createProject();
    expect(a.id).not.toBe(b.id);
    expect(activeScene(a).instances[0]!.id).not.toBe(activeScene(b).instances[0]!.id);
    expect(newId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('definitions vs instances', () => {
  it('one definition supports many instances with independent identity, pose and configuration', () => {
    const p = mutate((p) => {
      const s = activeScene(p);
      s.instances.push({
        id: 'second',
        definitionId: DEMO_CUBE_DEFINITION.id,
        name: 'Second cube',
        transform: { position: [1, 0.15, -2], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
        configuration: { label: 'B', tolerance_m: 0.001, fixtured: true },
      });
    });
    expect(validateProject(p).ok).toBe(true);
    const [a, b] = activeScene(p).instances;
    expect(a!.definitionId).toBe(b!.definitionId);
    expect(a!.transform).not.toEqual(b!.transform);
    expect(p.definitions).toHaveLength(1);
  });
});

describe('validation rejects bad data with readable paths', () => {
  const cases: [string, (p: Project) => void, RegExp][] = [
    ['NaN position', (p) => (activeScene(p).instances[0]!.transform.position[0] = NaN), /position/],
    ['infinite position', (p) => (activeScene(p).instances[0]!.transform.position[1] = Infinity), /position/],
    ['out-of-bounds position', (p) => (activeScene(p).instances[0]!.transform.position[2] = 1e9), /within/],
    [
      'non-unit quaternion',
      (p) => (activeScene(p).instances[0]!.transform.rotation = [0, 0, 0, 2]),
      /unit quaternion/,
    ],
    [
      'unknown definition',
      (p) => (activeScene(p).instances[0]!.definitionId = 'nope'),
      /unknown component definition/,
    ],
    ['unknown material', (p) => (p.definitions[0]!.materialId = 'nope'), /unknown material/],
    [
      'unknown category',
      (p) => ((p.definitions[0] as { categoryId: string }).categoryId = 'magic'),
      /categoryId/,
    ],
    ['wrong unit', (p) => ((p.units as { length: string }).length = 'mm'), /units\.length/],
    [
      'duplicate instance id',
      (p) => {
        const s = activeScene(p);
        s.instances.push({ ...s.instances[0]! });
      },
      /duplicate id/,
    ],
    [
      'assembly member missing',
      (p) => activeScene(p).assemblies.push({ id: 'a', name: 'A', memberInstanceIds: ['ghost'] }),
      /unknown instance/,
    ],
    ['bad active scene', (p) => (p.activeSceneId = 'ghost'), /activeSceneId/],
    ['wrong schema version', (p) => ((p as { schemaVersion: number }).schemaVersion = 2), /schemaVersion/],
    [
      'non-relative model uri',
      (p) =>
        (p.definitions[0]!.geometry = {
          kind: 'model',
          asset: {
            uri: 'https://example.com/x.glb',
            unitScaleToMetres: 1,
            upAxis: 'Y',
            dimensionsValidated: false,
          },
        }),
      /uri/,
    ],
  ];
  it.each(cases)('%s', (_n, fn, pattern) => {
    const errors = errorsOf(mutate(fn));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toMatch(pattern);
  });

  it('rejects non-objects', () => {
    expect(errorsOf(null)[0]).toMatch(/\(root\)/);
    expect(errorsOf('hello').length).toBeGreaterThan(0);
  });
});

describe('units and rotation conventions', () => {
  it('radians internally, degrees at the UI boundary', () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI, 12);
    expect(radToDeg(Math.PI / 2)).toBeCloseTo(90, 12);
    expect(formatLength(0.15)).toBe('150.0 mm');
    expect(formatLength(2.5)).toBe('2.500 m');
  });

  it('rotation about +Y stays a unit quaternion and accumulates correctly', () => {
    let q: [number, number, number, number] = [0, 0, 0, 1];
    for (let i = 0; i < 24; i++) q = rotateAboutWorldY(q, degToRad(15)); // 360°
    expect(Math.hypot(...q)).toBeCloseTo(1, 12);
    expect(Math.abs(radToDeg(yawOf(q)))).toBeLessThan(1e-9);
    expect(radToDeg(yawOf(rotateAboutWorldY([0, 0, 0, 1], degToRad(15))))).toBeCloseTo(15, 9);
  });

  it('defines all 28 planned catalogue categories with unique ids', () => {
    expect(COMPONENT_CATEGORIES).toHaveLength(28);
    expect(new Set(COMPONENT_CATEGORIES.map(([id]) => id)).size).toBe(28);
  });
});
