import { createCatalogResolver } from '@forge/components';
import { ForgeEngine, makeCommand, worldMatrix, type CommandInput } from '@forge/engineering-core';
import {
  bodyInterfaces,
  createMechanicsService,
  createRoboticArmSample,
  transformPoint,
} from '@forge/mechanics';
import { describe, expect, it } from 'vitest';
import { rankCandidates, snapCommand, snapContext, suggestMateType } from './snapLogic';

function arm() {
  const e = new ForgeEngine(createRoboticArmSample(new Date('2026-11-22T00:00:00Z')), {
    componentResolver: createCatalogResolver(),
    mechanics: createMechanicsService(),
  });
  const run = (type: string, payload: unknown) =>
    e.execute(makeCommand(type as never, payload as never, 'desktop-ui') as CommandInput);
  return { e, run };
}

describe('drag-to-snap logic', () => {
  it('only free bodies with interfaces may be snapped (grounded / mate-driven / groups refused)', () => {
    const { e } = arm();
    const g = e.getProject().scene;
    expect(snapContext(g, 'base-plate')).toMatchObject({ ok: false });
    expect((snapContext(g, 'base-plate') as { reason: string }).reason).toContain('grounded');
    expect((snapContext(g, 'gripper') as { reason: string }).reason).toContain('already placed by mates');
    expect((snapContext(g, 'grp-arm') as { reason: string }).reason).toContain('cannot be snapped');
  });

  it('targets are the COMPATIBLE interfaces of the other members (declared metadata only)', () => {
    const { e, run } = arm();
    expect(run('assembly.mate.delete', { assemblyId: 'grp-arm', mateId: 'm-screw-1' }).ok).toBe(true);
    const ctx = snapContext(e.getProject().scene, 'screw-1');
    if (!ctx.ok) throw new Error(ctx.reason);
    const keys = ctx.targets.map((t) => t.key);
    // The four M4 clearance holes and the four M4 nuts; never the screw itself.
    for (const k of [1, 2, 3, 4]) {
      expect(keys).toContain(`thread|base-plate|hole-${k}`);
      expect(keys).toContain(`thread|nut-${k}|thread`);
    }
    expect(keys.some((k) => k.includes('|screw-1|'))).toBe(false);
    // Electrical, optical and servo interfaces are not declared compatible with a screw thread.
    expect(keys.some((k) => /range-sensor|arduino|wrist-servo/.test(k))).toBe(false);
    const hole = ctx.targets.find((t) => t.key === 'thread|base-plate|hole-1')!;
    expect(hole.suggestedType).toBe('fixed');
    expect(hole.shared).toEqual(['M4-clearance']);
  });

  it('the confirmed snap is one mate command that places the source interface on the target', () => {
    const { e, run } = arm();
    run('assembly.mate.delete', { assemblyId: 'grp-arm', mateId: 'm-screw-1' });
    const g = e.getProject().scene;
    const ctx = snapContext(g, 'screw-1');
    if (!ctx.ok) throw new Error(ctx.reason);
    const t = ctx.targets.find((x) => x.key === 'thread|base-plate|hole-2')!;
    const cmd = snapCommand(g, 'screw-1', t, 'fixed', 'opposed');
    expect(cmd.type).toBe('assembly.mate.create');
    const rev = e.getProject().revision;
    expect(run(cmd.type, cmd.payload).ok).toBe(true);
    expect(e.getProject().revision).toBe(rev + 1); // one undoable step
    const s = e.getProject().scene;
    const thread = (bodyInterfaces(s, 'screw-1') as { position: [number, number, number] }[])[0]!;
    const at = transformPoint(worldMatrix(s, 'screw-1'), thread.position);
    expect(at[0]).toBeCloseTo(t.targetWorld.p[0], 9);
    expect(at[1]).toBeCloseTo(t.targetWorld.p[1], 9);
    expect(at[2]).toBeCloseTo(t.targetWorld.p[2], 9);
    e.undo();
    expect(snapContext(e.getProject().scene, 'screw-1').ok).toBe(true); // free again
  });

  it('a body outside any assembly is inserted and mated in one batch', () => {
    const { e, run } = arm();
    const r = run('scene.node.create', {
      node: { kind: 'component-instance', id: 'loose', definitionId: 'machine-screw', variantId: 'm4x12' },
    });
    expect(r.ok).toBe(true);
    const g = e.getProject().scene;
    const ctx = snapContext(g, 'loose');
    if (!ctx.ok) throw new Error(ctx.reason);
    const cmd = snapCommand(g, 'loose', ctx.targets[0]!, 'fixed', 'opposed');
    expect(cmd.type).toBe('scene.batch');
    const rev = e.getProject().revision;
    expect(run(cmd.type, cmd.payload).ok).toBe(true);
    expect(e.getProject().revision).toBe(rev + 1);
    expect(e.getProject().scene.nodes.loose!.parentId).toBe('grp-arm');
  });

  it('ranks candidates by on-screen distance within the radius', () => {
    expect(
      rankCandidates(
        [
          { key: 'b', px: 10 },
          { key: 'a', px: 10 },
          { key: 'c', px: 3 },
          { key: 'far', px: 80 },
          { key: 'nan', px: Number.NaN },
        ],
        36,
      ).map((p) => p.key),
    ).toEqual(['c', 'a', 'b']);
  });

  it('suggests a mate type from the paired interface types', () => {
    const i = (type: string) => ({ type }) as never;
    expect(suggestMateType(i('slider'), i('mechanical-mount'))).toBe('prismatic');
    expect(suggestMateType(i('revolute-joint'), i('shaft-coupling'))).toBe('revolute');
    expect(suggestMateType(i('bolt-hole'), i('bolt-hole'))).toBe('fixed');
  });
});
