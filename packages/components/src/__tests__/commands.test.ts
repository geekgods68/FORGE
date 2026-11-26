import {
  createProject,
  ForgeEngine,
  makeCommand,
  parseProjectFile,
  PROJECT_SCHEMA_VERSION,
  serializeProject,
  type CommandInput,
  type SceneNode,
} from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { auditProjectComponents } from '../audit';
import { createCatalogResolver } from '../resolver';

const newEngine = (resolver = true) => {
  let n = 0;
  return new ForgeEngine(createProject('Components'), {
    newId: () => `id-${++n}`,
    ...(resolver ? { componentResolver: createCatalogResolver() } : {}),
  });
};
const run = (e: ForgeEngine, type: string, payload: unknown) =>
  e.execute(makeCommand(type as never, payload as never, 'desktop-ui') as CommandInput);
const conjure = (e: ForgeEngine, definitionId: string, extra: Record<string, unknown> = {}) =>
  run(e, 'scene.node.create', { node: { kind: 'component-instance', definitionId, ...extra } });
const node = (e: ForgeEngine, id: string) =>
  e.getNode(id) as Extract<SceneNode, { kind: 'component-instance' }>;

describe('conjuring through engine commands', () => {
  it('creates a component instance with a resolved reference (metres) — one undoable step', () => {
    const e = newEngine();
    const r = conjure(e, 'towerpro-sg90', { transform: { position: [0.1, 0, -0.05] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const n = node(e, r.affectedIds[0]!);
    expect(n.kind).toBe('component-instance');
    expect(n.name).toBe('SG90 micro servo');
    expect(n.component).toMatchObject({
      variantId: null,
      materialId: null,
      connections: [],
      snapshot: { categoryId: 'motors-actuators', tier: 'B', dataStatus: 'datasheet-cited' },
    });
    expect(n.component!.snapshot.boundsM[1]).toBeCloseTo(0.031, 6);
    expect(e.getHistory().undoDepth).toBe(1);
    e.undo();
    expect(e.getNode(n.id)).toBeNull();
    e.redo();
    expect(node(e, n.id).component).toEqual(n.component);
  });

  it('variants and parameter overrides are validated and stored fully resolved', () => {
    const e = newEngine();
    const r = conjure(e, 't-slot-extrusion', { variantId: '2040', parameters: { length: 0.3 } });
    expect(r.ok).toBe(true);
    const n = node(e, r.ok ? r.affectedIds[0]! : '');
    expect(n.name).toBe('T-slot aluminium extrusion · 2040 (20 × 40)');
    expect(n.component!.parameters).toMatchObject({ series: '20', cellsWide: 1, cellsHigh: 2, length: 0.3 });
  });

  it('rejects unknown components, invalid parameters, forbidden materials and scale — atomically', () => {
    const e = newEngine();
    const rev = e.getProject().revision;
    const bad = [
      conjure(e, 'no-such-part'),
      conjure(e, 'aluminium-plate', { parameters: { thickness: -0.001 } }),
      conjure(e, 'aluminium-plate', { parameters: { nonsense: 1 } }),
      conjure(e, 'towerpro-sg90', { materialId: 'pla' }),
      conjure(e, 'aluminium-plate', { materialId: 'unobtainium' }),
      conjure(e, 'aluminium-plate', { transform: { scale: [2, 1, 1] } }),
    ];
    expect(bad.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
      'unknown-component',
      'invalid-parameters',
      'invalid-parameters',
      'invalid-parameters',
      'invalid-parameters',
      'invalid-transform',
    ]);
    expect(e.getProject().revision).toBe(rev);
    expect(
      newEngine(false).execute(
        makeCommand(
          'scene.node.create',
          { node: { kind: 'component-instance', definitionId: 'arm-link' } },
          'desktop-ui',
        ) as CommandInput,
      ),
    ).toMatchObject({ ok: false, error: { code: 'unknown-component' } });
  });

  it('configure edits dimensions/variant/material through parameters; undo restores; locks are enforced', () => {
    const e = newEngine();
    const r = conjure(e, 'aluminium-plate');
    const id = r.ok ? r.affectedIds[0]! : '';
    expect(run(e, 'scene.component.configure', { nodeId: id, parameters: { length: 0.25 } }).ok).toBe(true);
    expect(node(e, id).component!.parameters.length).toBe(0.25);
    expect(node(e, id).component!.snapshot.boundsM[0]).toBeCloseTo(0.25, 12);
    expect(run(e, 'scene.component.configure', { nodeId: id, variantId: 't10' }).ok).toBe(true);
    expect(node(e, id).component!.parameters).toMatchObject({ thickness: 0.01, length: 0.2 }); // variant replaces overrides
    expect(run(e, 'scene.component.configure', { nodeId: id, materialId: 'steel-1018' }).ok).toBe(true);
    expect(node(e, id).component!.materialId).toBe('steel-1018');
    const bad = run(e, 'scene.component.configure', { nodeId: id, parameters: { width: 99 } });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid-parameters' } });
    e.undo();
    e.undo();
    e.undo();
    expect(node(e, id).component!.parameters.length).toBe(0.2);
    run(e, 'scene.node.lock', { nodeId: id, locked: true });
    expect(run(e, 'scene.component.configure', { nodeId: id, parameters: { length: 0.3 } })).toMatchObject({
      ok: false,
      error: { code: 'locked' },
    });
    expect(
      run(e, 'scene.component.configure', { nodeId: e.getProject().scene.rootId, parameters: {} }),
    ).toMatchObject({ ok: false });
  });

  it('cannot deform components through scale — directly, via a group, or by reparenting under a scaled group', () => {
    const e = newEngine();
    const a = conjure(e, 'arm-link');
    const id = a.ok ? a.affectedIds[0]! : '';
    expect(run(e, 'scene.node.transform', { nodeId: id, scale: [1, 2, 1] })).toMatchObject({
      ok: false,
      error: { code: 'invalid-transform' },
    });
    const g = run(e, 'scene.node.group', { nodeIds: [id] });
    const gid = g.ok ? g.affectedIds[0]! : '';
    expect(run(e, 'scene.node.transform', { nodeId: gid, scale: [2, 2, 2] })).toMatchObject({
      ok: false,
      error: { code: 'invalid-transform' },
    });
    const s = run(e, 'scene.node.create', { node: { kind: 'group', transform: { scale: [2, 1, 1] } } });
    const sid = s.ok ? s.affectedIds[0]! : '';
    expect(run(e, 'scene.node.reparent', { nodeId: gid, parentId: sid })).toMatchObject({
      ok: false,
      error: { code: 'invalid-transform' },
    });
    // Rotation/translation remain free.
    expect(
      run(e, 'scene.node.transform', {
        nodeId: id,
        position: [0.1, 0, 0],
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      }).ok,
    ).toBe(true);
  });

  it('duplicate, group, delete and batch work with components; a failing batch step changes nothing', () => {
    const e = newEngine();
    const a = conjure(e, 'towerpro-mg996r');
    const id = a.ok ? a.affectedIds[0]! : '';
    const d = run(e, 'scene.node.duplicate', { nodeId: id, offset: [0.05, 0, 0] });
    const copy = node(e, d.ok ? d.affectedIds[0]! : '');
    expect(copy.component).toEqual(node(e, id).component);
    expect(copy.definitionId).toBe('towerpro-mg996r');
    const g = run(e, 'scene.node.group', { nodeIds: [id, copy.id], name: 'Shoulder servos' });
    expect(g.ok).toBe(true);
    const rev = e.getProject().revision;
    const batch = run(e, 'scene.batch', {
      commands: [
        {
          type: 'scene.node.create',
          payload: { node: { kind: 'component-instance', definitionId: 'hc-sr04' } },
        },
        { type: 'scene.component.configure', payload: { nodeId: id, parameters: { caseLength: 1 } } },
      ],
    });
    expect(batch).toMatchObject({ ok: false, error: { code: 'invalid-parameters' } });
    expect(e.getProject().revision).toBe(rev);
    expect(run(e, 'scene.node.delete', { nodeId: copy.id }).ok).toBe(true);
  });
});

describe('persistence', () => {
  it('component instances round-trip through the project file with variant, material and parameters intact', () => {
    const e = newEngine();
    conjure(e, 'aluminium-plate', { variantId: 't6', materialId: 'al-7075-t6', parameters: { holes: 'M4' } });
    conjure(e, 'arduino-uno-r3', { transform: { position: [0.2, 0, 0] } });
    const text = serializeProject(e.getProject());
    const r = parseProjectFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project).toEqual(e.getProject());
    expect(auditProjectComponents(r.project)).toEqual([]);
    expect(serializeProject(r.project)).toBe(text); // canonical, byte-identical
  });

  it('a missing definition is a recoverable warning (metadata preserved), never a substitution', () => {
    const e = newEngine();
    const r = conjure(e, 'towerpro-sg90');
    const id = r.ok ? r.affectedIds[0]! : '';
    const doc = JSON.parse(serializeProject(e.getProject()));
    doc.scene.nodes[id].definitionId = 'vendor-x-servo-9000';
    const loaded = parseProjectFile(JSON.stringify(doc));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const w = auditProjectComponents(loaded.project);
    expect(w).toEqual([expect.objectContaining({ nodeId: id, kind: 'missing-definition' })]);
    expect(
      (loaded.project.scene.nodes[id] as { component: { snapshot: { name: string } } }).component.snapshot
        .name,
    ).toBe('SG90 micro servo');
  });

  it('rejects structurally invalid component data (non-unit scale, dangling connection, bad snapshot)', () => {
    const e = newEngine();
    const r = conjure(e, 'arm-link');
    const id = r.ok ? r.affectedIds[0]! : '';
    const base = JSON.parse(serializeProject(e.getProject()));
    const scaled = structuredClone(base);
    scaled.scene.nodes[id].transform.scale = [2, 1, 1];
    expect(parseProjectFile(JSON.stringify(scaled))).toMatchObject({ ok: false });
    const dangling = structuredClone(base);
    dangling.scene.nodes[id].component.connections = [
      { interfaceId: 'joint-a', targetNodeId: 'ghost', targetInterfaceId: 'x' },
    ];
    expect(parseProjectFile(JSON.stringify(dangling))).toMatchObject({ ok: false });
    const badSnap = structuredClone(base);
    badSnap.scene.nodes[id].component.snapshot.categoryId = 'not-a-category';
    expect(parseProjectFile(JSON.stringify(badSnap))).toMatchObject({ ok: false });
  });

  it('legacy v2 projects load (migrated to the current schema) and newer-than-supported versions are refused', () => {
    const doc = JSON.parse(serializeProject(createProject('Phase 2 project')));
    doc.schemaVersion = 2;
    const r = parseProjectFile(JSON.stringify(doc));
    expect(r).toMatchObject({ ok: true, migratedFrom: 2 });
    if (r.ok) expect(r.project.schemaVersion).toBe(7);
    expect(
      parseProjectFile(JSON.stringify({ ...doc, schemaVersion: PROJECT_SCHEMA_VERSION + 1 })),
    ).toMatchObject({
      ok: false,
      error: { code: 'unsupported-version' },
    });
  });
});
