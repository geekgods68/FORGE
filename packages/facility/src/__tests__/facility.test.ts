import { createProject, serializeProject, type Vec3 } from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { CENTRAL_WORKSHOP_ID, CORRIDOR_E_ID } from '../facility-v1';
import {
  chainToFacility,
  convertPoint,
  pointFromFacility,
  pointToFacility,
  transformToFacility,
} from '../frames';
import { defaultWorkspaceLayout } from '../layout';
import {
  FACILITY,
  getEquipment,
  getZone,
  implementedZones,
  itemFootprint,
  mountChain,
  validateFacility,
  zonesToLoad,
} from '../registry';
import { validateLayout, WorkspaceEngine, type WorkspaceResult } from '../workspace';

const close = (a: readonly number[], b: readonly number[], eps = 1e-9) =>
  a.every((v, i) => Math.abs(v - b[i]!) <= eps);
const workshop = getZone(CENTRAL_WORKSHOP_ID)!;

describe('facility definition (read-only)', () => {
  it('satisfies all structural invariants: 22 labs once each, 6 environments, no overlapping zones', () => {
    expect(validateFacility(FACILITY)).toEqual([]);
    const labs = FACILITY.zones.filter((z) => z.kind === 'laboratory');
    expect(labs).toHaveLength(22);
    expect(FACILITY.zones.filter((z) => z.kind === 'environment')).toHaveLength(6);
    expect(FACILITY.wings.map((w) => w.letter)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(getZone(CENTRAL_WORKSHOP_ID)).toMatchObject({
      labNumber: 20,
      wingId: 'wing-e',
      status: 'implemented',
    });
  });

  // Revision 2 (Phase 2 expansion): every room is built; nothing is merely registered.
  it('every lab, environment and corridor is implemented with a renderer module (no planned zones)', () => {
    expect(FACILITY.revision).toBe(2);
    expect(FACILITY.zones.filter((z) => z.status === 'planned')).toEqual([]);
    for (const z of implementedZones()) expect(z.moduleKey).toBeTruthy();
    expect(implementedZones()).toHaveLength(FACILITY.zones.length);
  });

  it('is deeply frozen: architecture cannot be mutated at runtime', () => {
    expect(() => {
      (workshop.pose.position as number[])[0] = 99;
    }).toThrow();
    expect(() => {
      (FACILITY.zones as unknown[]).push({});
    }).toThrow();
  });
});

describe('lazy-loading set', () => {
  it('loads the current zone plus implemented neighbours through open portals only', () => {
    expect(zonesToLoad(CENTRAL_WORKSHOP_ID)).toEqual([CENTRAL_WORKSHOP_ID, CORRIDOR_E_ID]);
    expect(zonesToLoad('lab-01-central-intelligence')).toEqual([
      'lab-01-central-intelligence',
      'corridor-a-main',
    ]);
    expect(zonesToLoad('nope')).toEqual([]);
  });
});

describe('coordinate frames', () => {
  const benchA = defaultWorkspaceLayout().items['bench-a']!;
  const bench = getEquipment('bench-standard')!;

  it('project origin on a mounted bench maps to zone + item + mount offsets in the facility frame', () => {
    // zone (0,0,−7.5) · bench (−5,0,−3) · mount (0,0.9,0)
    const chain = mountChain(workshop, benchA, bench)!;
    expect(close(pointToFacility([0, 0, 0], chain), [-5, 0.9, -10.5])).toBe(true);
    expect(close(pointToFacility([0.1, 0.05, 0], chain), [-4.9, 0.95, -10.5])).toBe(true);
  });

  it('respects yaw: a bench rotated +90° maps its local +X to facility −Z', () => {
    const rotated = { pose: { position: [2, 0, 0] as Vec3, yaw: Math.PI / 2 } };
    const chain = mountChain(workshop, rotated, bench)!;
    const o = pointToFacility([0, 0, 0], chain);
    const x = pointToFacility([1, 0, 0], chain);
    expect(close([x[0] - o[0], x[1] - o[1], x[2] - o[2]], [0, 0, -1])).toBe(true);
  });

  it('conversions are exact inverses and compose across frames (project on bench A ↔ bench D)', () => {
    const layout = defaultWorkspaceLayout();
    const a = mountChain(workshop, layout.items['bench-a']!, bench)!;
    const d = mountChain(workshop, { pose: { position: [5, 0, 1.5], yaw: 0.7 } }, bench)!;
    const p: Vec3 = [0.123456, 0.05, -0.2];
    expect(close(pointFromFacility(pointToFacility(p, a), a), p, 1e-12)).toBe(true);
    expect(close(convertPoint(convertPoint(p, a, d), d, a), p, 1e-12)).toBe(true);
  });

  it('engineering node transforms lift into the facility frame without shear', () => {
    const chain = mountChain(workshop, benchA, bench)!;
    const t = transformToFacility({ position: [0.1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 2, 1] }, chain);
    expect(close(t.position, [-4.9, 0.9, -10.5])).toBe(true);
    expect(close(t.scale, [1, 2, 1])).toBe(true);
    expect(chainToFacility(chain)[15]).toBe(1);
  });

  it('footprints rotate: a 90° bench swaps width and depth', () => {
    const fp = itemFootprint({ position: [0, 0, 0], yaw: Math.PI / 2 }, bench);
    expect(close([fp.max[0] - fp.min[0], fp.max[1] - fp.min[1]], [0.8, 1.8])).toBe(true);
  });
});

describe('WorkspaceEngine', () => {
  let n = 0;
  const mk = () =>
    new WorkspaceEngine(defaultWorkspaceLayout(new Date('2026-11-20T00:00:00Z'), 'ws-1'), {
      newId: () => `w${++n}`,
      now: () => new Date('2026-11-20T00:00:00Z'),
    });
  const cmd = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
    commandId: `c${++n}`,
    type,
    payload,
    metadata: { source: 'test', timestamp: '2026-11-20T00:00:00.000Z', ...extra },
  });
  const code = (r: WorkspaceResult) => (r.ok ? 'ok' : r.error.code);
  const place = (x: number, z: number, equipmentId = 'bench-standard', areaId = 'bench-floor', yaw = 0) =>
    cmd('workspace.item.place', { equipmentId, zoneId: CENTRAL_WORKSHOP_ID, areaId, position: [x, z], yaw });

  it('the starter layout is valid against the facility', () => {
    expect(validateLayout(defaultWorkspaceLayout())).toMatchObject({ ok: true });
  });

  it('places equipment in a free spot; enforces area bounds, collisions, categories and built zones', () => {
    const w = mk();
    expect(code(w.execute(place(0, 3)))).toBe('ok');
    expect(code(w.execute(place(-5, -3)))).toBe('collision'); // onto Bench A
    expect(code(w.execute(place(8.1, 3)))).toBe('out-of-bounds'); // past the wall margin
    expect(code(w.execute(place(0, 0.5, 'tool-cabinet', 'conjuring-dais')))).toBe('not-allowed-here');
    expect(
      code(
        w.execute(
          cmd('workspace.item.place', {
            equipmentId: 'bench-standard',
            zoneId: 'lab-01-central-intelligence',
            areaId: 'bench-floor',
            position: [0, 0],
          }),
        ),
      ),
    ).toBe('ok'); // revision 2: Lab 1 is built, so its bench floor accepts equipment
    // Corridors are circulation only: no placement areas, so nothing can be placed there.
    expect(
      code(
        w.execute(
          cmd('workspace.item.place', {
            equipmentId: 'bench-standard',
            zoneId: 'corridor-a-main',
            areaId: 'bench-floor',
            position: [0, 0],
          }),
        ),
      ),
    ).not.toBe('ok');
  });

  it('facility architecture is not addressable: zones/walls are not workspace items and unknown command types are refused', () => {
    const w = mk();
    const before = JSON.stringify(w.getLayout());
    expect(code(w.execute(cmd('workspace.item.move', { itemId: CORRIDOR_E_ID, position: [0, 0] })))).toBe(
      'not-found',
    );
    expect(code(w.execute(cmd('workspace.item.remove', { itemId: CENTRAL_WORKSHOP_ID })))).toBe('not-found');
    expect(code(w.execute(cmd('facility.wall.move', { wallId: 'north', dx: 1 })))).toBe('unknown-command');
    expect(code(w.execute(cmd('scene.node.delete', { nodeId: 'x' })))).toBe('unknown-command');
    expect(JSON.stringify(w.getLayout())).toBe(before);
  });

  it('moves are validated, atomic and undoable; locked items cannot move', () => {
    const w = mk();
    const r = w.execute(
      cmd('workspace.item.move', { itemId: 'bench-a', position: [-5, -1], yaw: Math.PI / 2 }),
    );
    expect(code(r)).toBe('ok');
    expect(w.getItem('bench-a')!.pose).toEqual({ position: [-5, 0, -1], yaw: Math.PI / 2 });
    const failed = w.execute(cmd('workspace.item.move', { itemId: 'bench-a', position: [5, -3] }));
    expect(code(failed)).toBe('collision');
    expect(w.getItem('bench-a')!.pose.position).toEqual([-5, 0, -1]);
    w.undo();
    expect(w.getItem('bench-a')!.pose).toEqual({ position: [-5, 0, -3], yaw: 0 });
    w.redo();
    expect(w.getItem('bench-a')!.pose.position).toEqual([-5, 0, -1]);
    expect(code(w.execute(cmd('workspace.item.lock', { itemId: 'bench-a', locked: true })))).toBe('ok');
    expect(code(w.execute(cmd('workspace.item.move', { itemId: 'bench-a', position: [-5, -2] })))).toBe(
      'locked',
    );
  });

  it('mounting: workbenches only; a project is on at most one bench; one undo step restores both benches', () => {
    const w = mk();
    expect(code(w.execute(cmd('workspace.bench.mount', { itemId: 'cabinet-1', projectId: 'p1' })))).toBe(
      'not-a-workbench',
    );
    expect(code(w.execute(cmd('workspace.bench.mount', { itemId: 'bench-a', projectId: 'p1' })))).toBe('ok');
    const r = w.execute(cmd('workspace.bench.mount', { itemId: 'bench-b', projectId: 'p1' }));
    expect(r).toMatchObject({ ok: true, affectedIds: ['bench-b', 'bench-a'] });
    expect(w.benchForProject('p1')!.id).toBe('bench-b');
    expect(w.getItem('bench-a')!.mountedProjectId).toBeNull();
    w.undo();
    expect(w.benchForProject('p1')!.id).toBe('bench-a');
  });

  it('rejects stale revisions, malformed payloads and denied sources without changes', () => {
    const w = mk();
    const before = JSON.stringify(w.getLayout());
    expect(
      code(
        w.execute(
          cmd('workspace.item.move', { itemId: 'bench-a', position: [-5, -1] }, { expectedRevision: 9 }),
        ),
      ),
    ).toBe('stale-revision');
    expect(code(w.execute(cmd('workspace.item.move', { itemId: 'bench-a', position: [NaN, 0] })))).toBe(
      'invalid-command',
    );
    expect(
      code(
        w.execute(cmd('workspace.item.move', { itemId: 'bench-a', position: [-5, -1] }, { source: 'vey' })),
      ),
    ).toBe('permission-denied');
    expect(JSON.stringify(w.getLayout())).toBe(before);
  });

  it('validateLayout rejects overlapping items, unknown equipment and newer facility revisions', () => {
    const l = defaultWorkspaceLayout();
    const overlap = structuredClone(l);
    overlap.items['bench-b']!.pose.position = [-5, 0, -3];
    expect(validateLayout(overlap)).toMatchObject({ ok: false });
    const unknown = structuredClone(l);
    unknown.items['bench-b']!.equipmentId = 'warp-drive';
    expect(validateLayout(unknown)).toMatchObject({ ok: false });
    expect(validateLayout({ ...l, facilityRevision: 99 })).toMatchObject({ ok: false });
  });
});

describe('persistence boundaries', () => {
  it('engineering project files carry no facility or workspace data (Phase 1 format unchanged)', () => {
    const text = serializeProject(createProject());
    expect(JSON.parse(text).schemaVersion).toBe(5); // Phase 5 schema; still no layout data
    for (const key of ['workspace', 'facility', 'zone', 'mountedProjectId', 'bench'])
      expect(text).not.toContain(`"${key}`);
  });

  it('workspace layouts reference projects by id only and contain no facility geometry', () => {
    const w = new WorkspaceEngine(defaultWorkspaceLayout());
    w.execute({
      commandId: 'x',
      type: 'workspace.bench.mount',
      payload: { itemId: 'bench-a', projectId: 'some-project-id' },
      metadata: { source: 'test', timestamp: new Date().toISOString() },
    });
    const text = JSON.stringify(w.getLayout());
    expect(text).toContain('"mountedProjectId":"some-project-id"');
    expect(text).not.toContain('"scene"');
    expect(text).not.toContain('"portals"');
    expect(text).not.toContain('"footprint"');
  });
});
