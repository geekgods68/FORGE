import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRIMITIVE_SHAPES } from '../scene/schemas';
import { createProject, DEFAULT_PRIMITIVE_GEOMETRY } from '../project/create';
import { MAX_PROJECT_FILE_BYTES, parseProjectFile, projectFileName, serializeProject } from '../project/file';
import { loadProjectDocument } from '../project/migrate';
import { expectOk, makeEngine } from './helpers';

const phase0Fixture = readFileSync(
  fileURLToPath(new URL('../../../../tests/fixtures/phase0-v1-project.json', import.meta.url)),
  'utf8',
);

function richProject() {
  const h = makeEngine();
  h.group('asm', undefined, { position: [0.5, 0, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] });
  for (const shape of PRIMITIVE_SHAPES) {
    expectOk(
      h.run('scene.node.create', {
        node: {
          kind: 'primitive',
          id: `p-${shape}`,
          parentId: 'asm',
          geometry: DEFAULT_PRIMITIVE_GEOMETRY[shape],
          transform: { position: [0.123456789, 0.05, -0.1], scale: [1, 2.5, 1] },
          metadata: { material: 'Al 6061 (unverified)', qty: 2, critical: false },
        },
      }),
    );
  }
  h.run('scene.node.create', {
    node: { kind: 'reference', id: 'datum', referenceType: 'datum-axes', sizeM: 0.25 },
  });
  h.run('scene.node.lock', { nodeId: 'p-box', locked: true });
  h.run('scene.node.visibility', { nodeId: 'p-cone', visible: false });
  return h.engine.getProject();
}

describe('.forge.json export/import', () => {
  it('round-trips a hierarchy with every primitive, transforms, lock/visibility and metadata exactly', () => {
    const p = richProject();
    const text = serializeProject(p);
    const r = parseProjectFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project).toEqual(p);
    expect(serializeProject(r.project)).toBe(text); // deterministic
    expect(r.project.scene.nodes['p-box']!.transform.position[0]).toBe(0.123456789); // no display rounding
  });

  it('is deterministic: same state → byte-identical file, independent of key insertion order', () => {
    const p = richProject();
    const shuffled = {
      ...p,
      scene: { ...p.scene, nodes: Object.fromEntries(Object.entries(p.scene.nodes).reverse()) },
    };
    expect(serializeProject(shuffled)).toBe(serializeProject(p));
  });

  it.each([
    ['malformed JSON', '{"schemaVersion": 2,', 'corrupt'],
    ['not an object', '[1,2,3]', 'corrupt'],
    ['missing schemaVersion', '{"id":"x"}', 'invalid'],
    [
      'future schema version',
      JSON.stringify({ ...createProject(), schemaVersion: 9 }),
      'unsupported-version',
    ],
    [
      'unknown schema version 0',
      JSON.stringify({ ...createProject(), schemaVersion: 0 }),
      'unsupported-version',
    ],
  ])('rejects %s', (_n, text, code) => {
    expect(parseProjectFile(text)).toMatchObject({ ok: false, error: { code } });
  });

  it('rejects circular hierarchies, duplicate/mismatched ids, invalid transforms, missing properties and unsupported objects', () => {
    const base = () => JSON.parse(serializeProject(richProject()));
    const cases: [string, (d: ReturnType<typeof base>) => void, RegExp][] = [
      [
        'cycle',
        (d) => {
          d.scene.nodes['asm'].parentId = 'p-box';
          d.scene.nodes['p-box'].childIds = ['asm'];
        },
        /reachable|parent/,
      ],
      [
        'duplicate id',
        (d) => {
          d.scene.nodes['p-sphere'].id = 'p-box';
        },
        /does not match id/,
      ],
      [
        'NaN-like transform',
        (d) => {
          d.scene.nodes['p-box'].transform.position = [null, 0, 0];
        },
        /position/,
      ],
      [
        'zero scale',
        (d) => {
          d.scene.nodes['p-box'].transform.scale = [0, 1, 1];
        },
        /scale/,
      ],
      [
        'missing property',
        (d) => {
          delete d.scene.nodes['p-box'].visible;
        },
        /visible/,
      ],
      [
        'unsupported object kind',
        (d) => {
          d.scene.nodes['p-box'].kind = 'black-hole';
        },
        /kind/,
      ],
      [
        'unknown component definition',
        (d) => {
          d.scene.nodes['p-box'] = {
            ...d.scene.nodes['p-box'],
            kind: 'component-instance',
            definitionId: 'nope',
          };
        },
        /unknown component definition/,
      ],
    ];
    for (const [name, mutate, pattern] of cases) {
      const d = base();
      mutate(d);
      const r = parseProjectFile(JSON.stringify(d));
      expect(r.ok, name).toBe(false);
      if (!r.ok && r.error.code === 'invalid') expect(r.error.details.join('\n'), name).toMatch(pattern);
      else expect.fail(`${name}: expected invalid, got ${JSON.stringify(r)}`);
    }
  });

  it('refuses files larger than the limit before parsing', () => {
    const r = parseProjectFile(' '.repeat(MAX_PROJECT_FILE_BYTES + 1));
    expect(r).toMatchObject({ ok: false, error: { code: 'too-large' } });
  });

  it('produces safe file names', () => {
    expect(projectFileName('Rover arm v2 / test')).toBe('Rover-arm-v2-test.forge.json');
    expect(projectFileName('///')).toBe('forge-project.forge.json');
  });
});

describe('Phase 0 (schema v1) compatibility', () => {
  it('migrates a genuine Phase 0 project file to the current schema, preserving ids, names and transforms', () => {
    const v1 = JSON.parse(phase0Fixture);
    const r = parseProjectFile(phase0Fixture);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBe(1);
    const p = r.project;
    expect(p.schemaVersion).toBe(3); // v1 → current
    expect(p.id).toBe(v1.id);
    expect(p.scene.rootId).toBe(v1.scenes[0].id);
    const inst = v1.scenes[0].instances[0];
    const node = p.scene.nodes[inst.id]!;
    expect(node.kind).toBe('component-instance');
    expect(node.name).toBe(inst.name);
    expect(node.transform.position).toEqual(inst.transform.position);
    expect(node.transform.rotation).toEqual(inst.transform.rotation);
    expect(node.transform.scale).toEqual([1, 1, 1]);
    expect(p.definitions.map((d) => d.id)).toContain(inst.definitionId);
  });

  it('rejects an invalid v1 document with v1 field paths', () => {
    const v1 = JSON.parse(phase0Fixture);
    v1.scenes[0].instances[0].definitionId = 'missing';
    const r = loadProjectDocument(v1);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'invalid')
      expect(r.error.details.join('\n')).toMatch(/unknown component definition/);
  });
});
