import {
  ForgeEngine,
  makeCommand,
  parseProjectFile,
  serializeProject,
  type CommandInput,
} from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import {
  assemblyCommands,
  AssemblyTemplateSchema,
  findCompatibleInterfaces,
  templateFromGroup,
} from '../assemblies';
import { auditProjectComponents } from '../audit';
import { createCatalogResolver } from '../resolver';
import { createRoboticArmSample, ROBOT_ARM_SAMPLE_NAME } from '../samples/robot-arm';

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
      'Fastener set (base)',
      'Controller & electronics',
      'Power',
    ]);
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
    const t = templateFromGroup(p, 'grp-fasteners', 'tpl-1', NOW);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(AssemblyTemplateSchema.parse(JSON.parse(JSON.stringify(t.template)))).toEqual(t.template);
    expect(t.template.members).toHaveLength(8);
    let n = 0;
    const e = new ForgeEngine(p, { componentResolver: createCatalogResolver(), newId: () => `new-${++n}` });
    const { rootId, commands } = assemblyCommands(
      t.template,
      p.scene.rootId,
      [0.5, 0, 0.2],
      () => `asm-${++n}`,
    );
    const r = e.execute(makeCommand('scene.batch', { commands }, 'desktop-ui') as CommandInput);
    expect(r.ok).toBe(true);
    const g = e.getNode(rootId)!;
    expect(g.name).toBe('Fastener set (base)');
    expect(g.childIds).toHaveLength(8);
    expect(e.getHistory().undoDepth).toBe(1);
    e.undo();
    expect(e.getNode(rootId)).toBeNull();
  });

  it('refuses unsupported members and non-groups', () => {
    const p = createRoboticArmSample(NOW);
    expect(templateFromGroup(p, 'arduino', 'x').ok).toBe(false);
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
