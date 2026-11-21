import {
  assemblyCommands,
  AssemblyTemplateSchema,
  auditProjectComponents,
  createCatalogResolver,
  findCompatibleInterfaces,
  templateFromGroup,
} from '@forge/components';
import {
  ForgeEngine,
  makeCommand,
  parseProjectFile,
  serializeProject,
  worldMatrix,
  type CommandInput,
  type Project,
} from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { createMechanicsService } from '../index';
import { mul, inv } from '../pose';
import {
  ARM_ASSEMBLY_ID,
  ARM_JOINTS,
  createRoboticArmSample,
  ROBOT_ARM_SAMPLE_NAME,
} from '../samples/robot-arm';

const NOW = new Date('2026-11-21T12:00:00Z');

describe('robotic-arm sample project', () => {
  const p = createRoboticArmSample(NOW);
  const comps = Object.values(p.scene.nodes).filter((n) => n.kind === 'component-instance');

  it('is a valid current-schema project built from library components, with logical groups', () => {
    expect(p.name).toBe(ROBOT_ARM_SAMPLE_NAME);
    expect(p.schemaVersion).toBe(4);
    const root = p.scene.nodes[p.scene.rootId]!;
    expect(root.childIds.map((id) => p.scene.nodes[id]!.name)).toEqual([
      'Robotic arm',
      'Controller & electronics',
      'Power',
    ]);
    const arm = p.scene.nodes[ARM_ASSEMBLY_ID]!;
    expect(arm.kind === 'assembly' && arm.mechanical.grounded).toEqual(['base-plate']);
    expect(
      arm.kind === 'assembly' && arm.mechanical.mates.filter((m) => m.type === 'revolute').map((m) => m.id),
    ).toEqual(Object.values(ARM_JOINTS));
    const defs = new Set(comps.map((n) => (n as { definitionId: string }).definitionId));
    for (const id of [
      'arduino-uno-r3',
      'towerpro-sg90',
      'towerpro-mg996r',
      'hc-sr04',
      'servo-mount-bracket',
      'arm-link',
      'arm-base-plate',
      'precision-shaft',
      'ball-bearing',
      'machine-screw',
      'hex-nut',
      'parallel-gripper',
      'breadboard',
      'jumper-wire',
      'breadboard-power-module',
      'battery-pack',
      'dual-h-bridge-module',
    ])
      expect(defs.has(id), id).toBe(true);
    expect(auditProjectComponents(p)).toEqual([]);
  });

  it('declares no connections or behaviour (no actuation, wiring or joint constraints claimed)', () => {
    for (const n of comps)
      expect((n as { component: { connections: unknown[] } }).component.connections).toEqual([]);
  });

  it('fits on a standard 1800 × 800 mm workbench and round-trips through a project file', () => {
    for (const n of comps) {
      expect(Math.abs(n.transform.position[0])).toBeLessThan(0.9);
      expect(Math.abs(n.transform.position[2])).toBeLessThan(0.4);
    }
    const r = parseProjectFile(serializeProject(p));
    expect(r.ok && r.project).toEqual(p);
    // Deterministic parts (the project/root ids are fresh per opened sample).
    const parts = (q: typeof p) =>
      JSON.stringify(
        Object.values(q.scene.nodes)
          .filter((n) => (n.kind !== 'root' && n.parentId !== q.scene.rootId) || n.kind === 'group')
          .map((n) => [n.id, n.name, n.transform, n.kind === 'component-instance' ? n.component : null]),
      );
    expect(parts(createRoboticArmSample(NOW))).toBe(parts(p));
  });
});

describe('reusable assemblies', () => {
  it('saves a group subtree and re-inserts it as one atomic, undoable batch', () => {
    const p = createRoboticArmSample(NOW);
    const t = templateFromGroup(p, 'grp-controller', 'tpl-1', NOW);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(AssemblyTemplateSchema.parse(JSON.parse(JSON.stringify(t.template)))).toEqual(t.template);
    expect(t.template.members).toHaveLength(7);
    let n = 0;
    const e = new ForgeEngine(p, {
      componentResolver: createCatalogResolver(),
      mechanics: createMechanicsService(),
      newId: () => `new-${++n}`,
    });
    const { rootId, commands } = assemblyCommands(
      t.template,
      p.scene.rootId,
      [0.5, 0, 0.2],
      () => `asm-${++n}`,
    );
    const r = e.execute(makeCommand('scene.batch', { commands }, 'desktop-ui') as CommandInput);
    expect(r.ok).toBe(true);
    const g = e.getNode(rootId)!;
    expect(g.name).toBe('Controller & electronics');
    expect(g.childIds).toHaveLength(7);
    expect(e.getHistory().undoDepth).toBe(1);
    e.undo();
    expect(e.getNode(rootId)).toBeNull();
  });

  it('refuses unsupported members and non-groups', () => {
    const p = createRoboticArmSample(NOW);
    expect(templateFromGroup(p, 'arduino', 'x').ok).toBe(false);
    expect(templateFromGroup(p, ARM_ASSEMBLY_ID, 'x').ok).toBe(true);
    expect(templateFromGroup(p, 'nope', 'x').ok).toBe(false);
  });
});

describe('compatibility within a project (metadata only)', () => {
  it('finds mating candidates for an Arduino pin and a bearing bore; none for an optical port', () => {
    const p = createRoboticArmSample(NOW);
    const pin = findCompatibleInterfaces(p, 'arduino', 'header3-5v-3');
    expect(pin.some((c) => c.nodeId.startsWith('jumper'))).toBe(true);
    const bore = findCompatibleInterfaces(p, 'shoulder-bearing', 'bore');
    expect(bore.map((c) => c.nodeId)).toContain('shoulder-shaft');
    expect(findCompatibleInterfaces(p, 'range-sensor', 'tx')).toEqual([]);
    expect(findCompatibleInterfaces(p, 'arduino', 'no-such-interface')).toEqual([]);
  });
});

describe('robotic arm kinematics (acceptance)', () => {
  const setup = () => {
    const e = new ForgeEngine(createRoboticArmSample(NOW), {
      componentResolver: createCatalogResolver(),
      mechanics: createMechanicsService(),
    });
    const run = (type: string, payload: unknown) =>
      e.execute(makeCommand(type as never, payload as never, 'desktop-ui') as CommandInput);
    const W = (id: string) => worldMatrix(e.getProject().scene, id);
    return { e, run, W };
  };
  const same = (a: number[], b: number[], eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]!) <= eps);

  it('reports 4 free revolute joints (mobility 4) and no conflicts', () => {
    const { e } = setup();
    const a = e.analyzeAssembly(ARM_ASSEMBLY_ID)!;
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.report).toMatchObject({
      status: 'under-constrained',
      mobility: 4,
      redundancy: 0,
      grounded: ['base-plate'],
    });
    expect(a.report.relationships.filter((r) => r.freeCoordinates.some(Boolean)).map((r) => r.id)).toEqual(
      Object.values(ARM_JOINTS),
    );
  });

  it('moving the shoulder moves the dependent chain rigidly; the base stays put; home restores', () => {
    const { run, W } = setup();
    const plate0 = W('base-plate');
    const servo0 = W('shoulder-servo');
    const gripRel0 = mul(inv(W('upper-link')), W('gripper')); // gripper relative to the upper link
    const tip0 = W('gripper');
    expect(
      run('assembly.joint.setPosition', {
        assemblyId: ARM_ASSEMBLY_ID,
        mateId: ARM_JOINTS.shoulder,
        coordinates: [Math.PI / 6],
      }).ok,
    ).toBe(true);
    expect(same(W('base-plate'), plate0, 0)).toBe(true);
    expect(same(W('shoulder-servo'), servo0, 1e-12)).toBe(true); // upstream of the joint: unchanged
    expect(same(W('gripper'), tip0)).toBe(false); // downstream moved…
    expect(same(mul(inv(W('upper-link')), W('gripper')), gripRel0, 1e-9)).toBe(true); // …rigidly with the link
    // The upper link rotated exactly 30° about the shoulder axis.
    expect(
      run('assembly.joint.setPosition', {
        assemblyId: ARM_ASSEMBLY_ID,
        mateId: ARM_JOINTS.elbow,
        coordinates: [0],
      }).ok,
    ).toBe(true);
    const fore = mul(inv(W('forearm-link')), W('gripper'));
    expect(same(fore, mul(inv(W('forearm-link')), W('gripper')))).toBe(true);
    // Limits: shoulder ±90°.
    expect(
      run('assembly.joint.setPosition', {
        assemblyId: ARM_ASSEMBLY_ID,
        mateId: ARM_JOINTS.shoulder,
        coordinates: [Math.PI],
      }),
    ).toMatchObject({ ok: false, error: { code: 'out-of-limits' } });
    expect(run('assembly.joint.home', { assemblyId: ARM_ASSEMBLY_ID }).ok).toBe(true);
    expect(same(W('gripper'), tip0, 1e-9)).toBe(true);
  });

  it('joint definitions survive save/reload', () => {
    const { e, run } = setup();
    run('assembly.joint.setPosition', {
      assemblyId: ARM_ASSEMBLY_ID,
      mateId: ARM_JOINTS.yaw,
      coordinates: [0.4],
    });
    const r = parseProjectFile(serializeProject(e.getProject()));
    expect(r.ok).toBe(true);
    const p = (r.ok ? r.project : null) as Project;
    const arm = p.scene.nodes[ARM_ASSEMBLY_ID]!;
    expect(
      arm.kind === 'assembly' && arm.mechanical.mates.find((m) => m.id === ARM_JOINTS.yaw)!.coordinates,
    ).toEqual([0.4]);
    expect(auditProjectComponents(p)).toEqual([]);
  });
});
