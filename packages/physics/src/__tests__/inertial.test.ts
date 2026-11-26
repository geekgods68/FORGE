import {
  createProject,
  defaultSimulationDefinition,
  inertiaIssue,
  MassSettingSchema,
} from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { buildPhysicsModel, SceneBuilder } from '../index';

/** Phase 8: explicit mass properties (e.g. from a URDF <inertial>) are used as given. */
const at = new Date('2026-11-26T00:00:00Z');

describe('inertial mass source', () => {
  it('transforms the declared COM and tensor by the body pose (90° about Z swaps Ixx and Iyy)', () => {
    const b = new SceneBuilder(createProject('Inertial', at));
    for (const c of b.graph.nodes[b.graph.rootId]!.childIds) b.run('scene.node.delete', { nodeId: c });
    const s = Math.SQRT1_2;
    b.run('assembly.create', { id: 'asm', name: 'Robot', nodeIds: [] });
    b.run('scene.node.create', {
      node: {
        kind: 'group',
        parentId: 'asm',
        id: 'link',
        name: 'Link without geometry',
        transform: { position: [1, 2, 3], rotation: [0, 0, s, s] },
      },
    });
    b.run('physics.simulation.create', {
      definition: {
        ...defaultSimulationDefinition(),
        bodies: [
          {
            nodeId: 'link',
            mode: 'dynamic',
            mass: {
              source: 'inertial',
              massKg: 2,
              comM: [0.1, 0, 0],
              inertia: [0.01, 0.02, 0.025, 0, 0, 0],
              note: 'test',
            },
            collider: 'none',
            friction: 0.5,
            restitution: 0,
            linearDamping: 0,
            angularDamping: 0,
            ccd: false,
            linearVelocity: [0, 0, 0],
            angularVelocity: [0, 0, 0],
            contactLoadRatingN: null,
          },
        ],
      },
    });
    const m = buildPhysicsModel(b.graph, b.definition);
    expect(m.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const body = m.bodies.find((x) => x.unitIds.includes('link'))!;
    expect(body.mass!.massKg).toBe(2);
    // COM: (0.1, 0, 0) rotated +90° about Z → (0, 0.1, 0), plus the node position.
    expect(body.origin[0]).toBeCloseTo(1, 12);
    expect(body.origin[1]).toBeCloseTo(2.1, 12);
    expect(body.origin[2]).toBeCloseTo(3, 12);
    const I = body.mass!.inertia;
    expect(I[0]).toBeCloseTo(0.02, 12);
    expect(I[4]).toBeCloseTo(0.01, 12);
    expect(I[8]).toBeCloseTo(0.025, 12);
    expect(body.massSources[0]!.source).toBe('inertial');
  });

  it('refuses tensors that are not physically realisable', () => {
    expect(inertiaIssue([1, 1, 1, 0, 0, 0])).toBeNull();
    expect(inertiaIssue([1, 1, 3, 0, 0, 0])).toMatch(/triangle/);
    expect(inertiaIssue([1, 1, 1, 2, 0, 0])).toMatch(/positive definite/);
    expect(
      MassSettingSchema.safeParse({
        source: 'inertial',
        massKg: 1,
        comM: [0, 0, 0],
        inertia: [-1, 1, 1, 0, 0, 0],
        note: '',
      }).success,
    ).toBe(false);
  });
});
