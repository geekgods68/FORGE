import { describe, expect, it } from 'vitest';
import { decompose, compose, invert, multiply, transformPoint, IDENTITY_MAT4 } from '../math/mat4';
import { eulerXYZFromQuat, quatFromEulerXYZ } from '../math/euler';
import { snap, DEFAULT_SNAP } from '../math/snapping';
import { createProject } from '../project/create';
import { flattenTree, validateGraph, worldMatrix } from '../scene/graph';
import type { SceneGraph } from '../scene/schemas';
import { degToRad, radToDeg } from '../units';
import { close, expectOk, makeEngine } from './helpers';

const Q90Y: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

describe('math', () => {
  it('compose/decompose round-trips TRS and invert gives identity', () => {
    const trs = {
      position: [1.5, -2, 0.25] as [number, number, number],
      rotation: Q90Y,
      scale: [2, 3, 0.5] as [number, number, number],
    };
    const m = compose(trs);
    const { trs: back, exact } = decompose(m);
    expect(exact).toBe(true);
    expect(close(back.position, trs.position)).toBe(true);
    expect(close(back.rotation, trs.rotation)).toBe(true);
    expect(close(back.scale, trs.scale)).toBe(true);
    expect(close(multiply(m, invert(m)!), IDENTITY_MAT4)).toBe(true);
  });

  it('detects shear that TRS cannot represent', () => {
    const parent = compose({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 1] });
    const child = compose({
      position: [0, 0, 0],
      rotation: quatFromEulerXYZ([0, 0, Math.PI / 4]),
      scale: [1, 1, 1],
    });
    expect(decompose(multiply(parent, child)).exact).toBe(false);
  });

  it('XYZ Euler ↔ quaternion round-trips (radians internally, degrees at the UI)', () => {
    for (const deg of [
      [10, 20, 30],
      [-45, 80, 170],
      [0, 0, 0],
    ] as const) {
      const e = deg.map(degToRad) as [number, number, number];
      const back = eulerXYZFromQuat(quatFromEulerXYZ(e)).map(radToDeg);
      expect(close(back, deg, 1e-9)).toBe(true);
    }
  });

  it('snaps to grid without binary noise; disabled step is a no-op', () => {
    expect(snap(0.1234, 0.01)).toBe(0.12);
    expect(snap(0.305, 0.01)).toBe(0.31);
    expect(radToDeg(snap(degToRad(37), DEFAULT_SNAP.rotationRad))).toBeCloseTo(30, 12);
    expect(snap(0.1 + 0.2, 0.1)).toBe(0.3);
    expect(snap(0.1234, 0)).toBe(0.1234);
    expect(DEFAULT_SNAP.translationM).toBe(0.01);
  });
});

describe('validateGraph', () => {
  const base = (): SceneGraph => JSON.parse(JSON.stringify(createProject().scene));

  it('accepts a fresh project', () => {
    expect(validateGraph(base())).toEqual([]);
  });

  it('detects a parent/child cycle (unreachable from root)', () => {
    const g = base();
    const [a, b] = ['a', 'b'];
    const n = (id: string, parentId: string, childIds: string[]) => ({
      ...g.nodes[g.rootId]!,
      kind: 'group' as const,
      id,
      name: id,
      parentId,
      childIds,
    });
    g.nodes[a] = n(a, b, [b]);
    g.nodes[b] = n(b, a, [a]);
    expect(
      validateGraph(g)
        .map((i) => i.message)
        .join('\n'),
    ).toMatch(/not reachable from the root/);
  });

  it('detects inconsistent parent links, missing children and orphans', () => {
    const g = base();
    const cube = g.nodes[g.rootId]!.childIds[0]!;
    g.nodes[g.rootId]!.childIds.push('ghost');
    g.nodes[cube]!.parentId = 'elsewhere';
    const msgs = validateGraph(g)
      .map((i) => i.message)
      .join('\n');
    expect(msgs).toMatch(/child "ghost" does not exist/);
    expect(msgs).toMatch(/parent "elsewhere" does not exist/);
  });

  it('detects key/id mismatch (duplicate identity) and a second root', () => {
    const g = base();
    const cube = g.nodes[g.rootId]!.childIds[0]!;
    g.nodes['dup'] = { ...g.nodes[cube]! };
    expect(
      validateGraph(g)
        .map((i) => i.message)
        .join('\n'),
    ).toMatch(/does not match id/);
  });
});

describe('hierarchy and world transforms', () => {
  it('a child inherits its parent world transform while keeping its own local transform', () => {
    const { engine, group, box } = makeEngine();
    expectOk(group('g', undefined, { position: [1, 0, 0], rotation: Q90Y }));
    expectOk(box('c', 'g', [0, 0, -1]));
    // Local stays as given …
    expect(engine.getNode('c')!.transform.position).toEqual([0, 0, -1]);
    // … world = parent ∘ child: rotating (0,0,-1) by +90° about Y gives (-1,0,0), then +X 1 → (0,0,0).
    const w = engine.getWorldTransform('c')!;
    expect(close(w.position, [0, 0, 0])).toBe(true);
    expect(close(transformPoint(worldMatrix(engine.getProject().scene, 'c'), [0, 0, 0]), [0, 0, 0])).toBe(
      true,
    );
  });

  it('flattenTree lists the hierarchy depth-first from the root', () => {
    const { engine, group, box, cubeId, rootId } = makeEngine();
    group('g');
    box('a', 'g');
    expect(flattenTree(engine.getProject().scene)).toEqual([
      { id: rootId, depth: 0 },
      { id: cubeId, depth: 1 },
      { id: 'g', depth: 1 },
      { id: 'a', depth: 2 },
    ]);
  });
});
