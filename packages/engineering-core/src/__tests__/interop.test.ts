import { describe, expect, it } from 'vitest';
import {
  createProject,
  ForgeEngine,
  loadProjectDocument,
  makeCommand,
  PROJECT_SCHEMA_VERSION,
  type CommandInput,
} from '../index';

/** Phase 8: import provenance records on the project root (schema v7). */
const at = new Date('2026-11-26T00:00:00Z');
const hash = `sha256-${'a'.repeat(64)}`;
const record = (nodeIds: string[], id = 'imp-1') => ({
  id,
  format: 'stl' as const,
  formatVersion: null,
  fileName: 'part.stl',
  byteLength: 684,
  sourceHash: hash,
  referencedFiles: [],
  importedAt: at.toISOString(),
  importer: 'forge-interop 1',
  sourceUnit: 'mm',
  toMetres: 0.001,
  upAxis: 'Z' as const,
  handedness: 'right' as const,
  geometryClass: 'mesh' as const,
  nodeIds,
  assetHashes: [],
  summary: { triangles: 12 },
  conversions: [],
  unsupported: [],
  warnings: [],
  nodesFingerprint: hash,
});
const run = (e: ForgeEngine, type: string, payload: unknown) =>
  e.execute(makeCommand(type as never, payload as never, 'test') as CommandInput);

describe('interop.import.record', () => {
  it('records provenance atomically with the imported nodes and survives save/load', () => {
    const e = new ForgeEngine(createProject('P', at), { now: () => at });
    const r = run(e, 'scene.batch', {
      commands: [
        { type: 'scene.node.create', payload: { node: { kind: 'group', id: 'g1', name: 'Imported' } } },
        { type: 'interop.import.record', payload: { record: record(['g1']) } },
      ],
    });
    expect(r.ok).toBe(true);
    const p = e.getProject();
    const root = p.scene.nodes[p.scene.rootId]!;
    expect(root.kind === 'root' && root.imports?.[0]?.id).toBe('imp-1');
    expect(p.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    const back = loadProjectDocument(JSON.parse(JSON.stringify(p)));
    expect(back.ok).toBe(true);
    e.undo();
    const root2 = e.getProject().scene.nodes[e.getProject().scene.rootId]!;
    expect(root2.kind === 'root' && root2.imports).toBeFalsy();
    expect(e.getProject().scene.nodes['g1']).toBeUndefined();
  });

  it('refuses records for nodes that do not exist, duplicates, and unknown ids to forget', () => {
    const e = new ForgeEngine(createProject('P', at), { now: () => at });
    expect(run(e, 'interop.import.record', { record: record(['missing']) }).ok).toBe(false);
    run(e, 'scene.node.create', { node: { kind: 'group', id: 'g1', name: 'G' } });
    expect(run(e, 'interop.import.record', { record: record(['g1']) }).ok).toBe(true);
    expect(run(e, 'interop.import.record', { record: record(['g1']) }).ok).toBe(false);
    expect(run(e, 'interop.import.forget', { importId: 'nope' }).ok).toBe(false);
    expect(run(e, 'interop.import.forget', { importId: 'imp-1' }).ok).toBe(true);
  });

  it('migrates a v6 file to v7 unchanged', () => {
    const p = { ...createProject('Old', at), schemaVersion: 6 };
    const r = loadProjectDocument(JSON.parse(JSON.stringify(p)));
    expect(r.ok && r.migratedFrom).toBe(6);
    expect(r.ok && r.project.schemaVersion).toBe(7);
  });
});
