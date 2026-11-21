import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4.1 — mechanical assembly interaction completion (browser):
 * mate editing, constraint creation/editing, drag-to-snap (preview, cancel, confirm,
 * undo/redo) and user-declared interfaces on imported GLB models. Everything is driven
 * through the UI; the debug hooks only READ state.
 */
type V3 = [number, number, number];
type F = Record<string, (...a: never[]) => unknown>;
type Mate = {
  id: string;
  name: string;
  type: string;
  alignment: string;
  offsetRad: number;
  coordinates: number[];
  home: number[];
  limits: ({ min: number; max: number } | null)[];
  suppressed: boolean;
  a: { nodeId: string; ref: { kind: string; interfaceId?: string } };
  b: { nodeId: string; ref: { kind: string; interfaceId?: string } };
};
type Constraint = { id: string; name: string; type: string; value: number | null; driving: boolean };
type Node = {
  id: string;
  kind: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  transform: { position: V3 };
  mechanical?: { grounded: string[]; mates: Mate[]; constraints: Constraint[] };
  model?: { interfaces: { id: string; position: V3; compatibility: string[] }[] };
};
const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      ((window as unknown as { __forge: F }).__forge[n as string] as (...x: unknown[]) => unknown)(
        ...(a as unknown[]),
      ),
    [name, args] as const,
  ) as Promise<T>;
const project = (page: Page) =>
  call<{ revision: number; scene: { nodes: Record<string, Node> } }>(page, 'project');
const nodes = async (page: Page) => (await project(page)).scene.nodes;
const arm = async (page: Page) => (await nodes(page))['grp-arm']!;
const mate = async (page: Page, id: string) => (await arm(page)).mechanical!.mates.find((m) => m.id === id);
const revision = async (page: Page) => (await project(page)).revision;
const worldOf = async (page: Page, id: string) =>
  (await call<{ position: V3 }>(page, 'getWorldTransform', id)).position;
const worldRot = async (page: Page, id: string) =>
  (await call<{ rotation: [number, number, number, number] }>(page, 'getWorldTransform', id)).rotation;
/** Angle between two unit quaternions (rad). */
const qAngle = (a: readonly number[], b: readonly number[]) =>
  2 * Math.acos(Math.min(1, Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!)));
const rendered = (page: Page, id: string) => call<V3 | null>(page, 'nodeWorldPosition', id);
const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const deg = (d: number) => (d * Math.PI) / 180;
const ready = (page: Page) =>
  page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
type SnapState = {
  mode: boolean;
  dragging: boolean;
  candidates: { key: string; px: number }[];
  ghost: boolean;
  targetMarkers: number;
  pending: {
    nodeId: string;
    chosen: string;
    candidates: string[];
    type: string;
    message: { ok: boolean; text: string } | null;
  } | null;
};
const snapState = (page: Page) => call<SnapState>(page, 'snapState');

async function openArm(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-sample').click();
  await expect(page.getByTestId('status')).toContainText('robotic-arm sample');
  await page.getByTestId('library-toggle').click();
  await expect.poll(() => rendered(page, 'gripper')).not.toBeNull();
}
/** Deselect (so Ctrl+Z reaches the editor) by clicking the viewport sky. */
async function deselect(page: Page) {
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 20, y: 20 } });
}
async function openRelationships(page: Page) {
  await page.getByTestId('tree-row-grp-arm').click();
  const section = page.getByTestId('relationships-section');
  if (!(await section.evaluate((d) => (d as HTMLDetailsElement).open)))
    await section.locator('summary').click();
}

test('mate editor: alignment, offset, limits, home, suppression and safe type conversion — validated, undoable', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openArm(page);
  await openRelationships(page);

  // Alignment: preview, apply (one command), undo, redo.
  const grip0 = await worldOf(page, 'gripper');
  const rot0 = await worldRot(page, 'gripper');
  const rev0 = await revision(page);
  await page.getByRole('button', { name: 'Edit Wrist roll joint' }).click();
  const ed = page.getByTestId('mate-editor');
  await expect(ed).toBeVisible();
  // Only safe conversions are offered.
  const types = await ed.getByLabel('Edit mate type').locator('option').allTextContents();
  expect(types.map((t) => t.split(' ')[0])).toEqual(['fixed', 'revolute', 'prismatic', 'cylindrical']);
  await ed.getByLabel('Edit mate alignment').selectOption('aligned');
  await expect(page.getByTestId('mate-edit-valid')).toBeVisible();
  await page.getByTestId('mate-edit-preview').click();
  expect(await revision(page)).toBe(rev0); // preview commits nothing
  await page.getByTestId('mate-edit-apply').click();
  await expect(ed).toBeHidden();
  expect((await mate(page, 'j-wrist'))!.alignment).toBe('aligned');
  expect(await revision(page)).toBe(rev0 + 1);
  // The gripper's origin is its wrist interface: flipping the axis turns it 180° in place.
  expect(qAngle(await worldRot(page, 'gripper'), rot0)).toBeCloseTo(Math.PI, 6);
  expect(dist(await worldOf(page, 'gripper'), grip0)).toBeLessThan(1e-9);
  await deselect(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await mate(page, 'j-wrist'))!.alignment).toBe('opposed');
  expect(qAngle(await worldRot(page, 'gripper'), rot0)).toBeLessThan(1e-6);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await mate(page, 'j-wrist'))!.alignment).toBe('aligned');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await mate(page, 'j-wrist'))!.alignment).toBe('opposed');

  // Limits that exclude the current coordinate: refused before anything is committed.
  await openRelationships(page);
  await page.getByRole('button', { name: 'Edit Wrist roll joint' }).click();
  await page.getByTestId('mate-edit-min-0').fill('10');
  await expect(page.getByTestId('mate-edit-error')).toContainText('outside the new limits');
  const revBad = await revision(page);
  await page.getByTestId('mate-edit-apply').click();
  await expect(page.getByTestId('mate-editor').getByRole('alert').last()).toContainText('outside');
  expect(await revision(page)).toBe(revBad);
  // Home outside the limits is refused too; a valid home + offset + limits applies in one step.
  await page.getByTestId('mate-edit-min-0').fill('-60');
  await page.getByTestId('mate-edit-max-0').fill('60');
  await page.getByTestId('mate-edit-home-0').fill('75');
  await expect(page.getByTestId('mate-edit-error')).toContainText('home position is outside');
  await page.getByTestId('mate-edit-home-0').fill('45');
  await page.getByTestId('mate-edit-offset').fill('30');
  await expect(page.getByTestId('mate-edit-valid')).toBeVisible();
  await page.getByTestId('mate-edit-apply').click();
  const m1 = (await mate(page, 'j-wrist'))!;
  expect(m1.limits[0]!.min).toBeCloseTo(deg(-60), 12);
  expect(m1.limits[0]!.max).toBeCloseTo(deg(60), 12);
  expect(m1.home[0]).toBeCloseTo(deg(45), 12);
  expect(m1.offsetRad).toBeCloseTo(deg(30), 12);
  expect(await revision(page)).toBe(revBad + 1);
  // The new home is used by the Home pose.
  await page.getByTestId('joints-home').click();
  await expect.poll(async () => (await mate(page, 'j-wrist'))!.coordinates[0]!).toBeCloseTo(deg(45), 9);

  // Safe type conversion revolute → cylindrical keeps the angle (and adds a length coordinate).
  await page.getByRole('button', { name: 'Edit Wrist roll joint' }).click();
  await page.getByTestId('mate-editor').getByLabel('Edit mate type').selectOption('cylindrical');
  await expect(page.getByTestId('mate-edit-home-1')).toBeVisible();
  await page.getByTestId('mate-edit-apply').click();
  await expect.poll(async () => (await mate(page, 'j-wrist'))!.type).toBe('cylindrical');
  expect((await mate(page, 'j-wrist'))!.coordinates[0]).toBeCloseTo(deg(45), 9);
  await expect(page.locator('[data-joint="j-wrist"] input[type="range"]')).toHaveCount(2);

  // Suppression: the joint no longer drives the gripper (it becomes a free body).
  await page.getByRole('button', { name: 'Edit Wrist roll joint' }).click();
  await page.getByTestId('mate-editor').getByLabel('Suppress mate').check();
  await page.getByTestId('mate-edit-apply').click();
  await expect.poll(async () => (await mate(page, 'j-wrist'))!.suppressed).toBe(true);
  await expect(page.locator('[data-relationship="j-wrist"]')).toContainText('suppressed');
  await expect(page.locator('[data-member="gripper"]')).toHaveAttribute('data-state', 'free');
  // Undo the suppression and the conversion.
  await deselect(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await mate(page, 'j-wrist'))!.suppressed).toBe(false);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await mate(page, 'j-wrist'))!.type).toBe('revolute');
});

test('invalid alignment: an edit that contradicts a closed loop is rejected and the assembly is unchanged', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openArm(page);
  await page.getByTestId('tree-row-grp-arm').click();
  // Close a loop: a fixed mate on the same interfaces as the wrist joint (consistent at 0°).
  await page.getByTestId('new-mate').locator('summary').click();
  await page.getByLabel('Mate body A').selectOption('wrist-servo');
  await page.getByLabel('Mate interface A').selectOption('output');
  await page.getByLabel('Mate body B').selectOption('gripper');
  await page.getByLabel('Mate interface B').selectOption('wrist');
  await page.getByLabel('Mate type').selectOption('fixed');
  await page.getByTestId('mate-confirm').click();
  await expect(page.getByTestId('new-mate').locator('[role="status"]')).toContainText('Mate created');
  const lock = (await arm(page)).mechanical!.mates.at(-1)!;
  expect(lock.type).toBe('fixed');
  await openRelationships(page);
  await page.getByRole('button', { name: `Edit ${lock.name}` }).click();
  const before = JSON.stringify(await project(page));
  await page.getByTestId('mate-editor').getByLabel('Edit mate alignment').selectOption('aligned');
  // The dry run reports the conflict and names the relationships involved.
  await expect(page.getByTestId('mate-edit-error')).toContainText('cannot all be satisfied');
  await expect(page.getByTestId('mate-edit-preview')).toBeDisabled();
  await page.getByTestId('mate-edit-apply').click();
  await expect(page.getByTestId('mate-editor').getByRole('alert').last()).toContainText('cannot');
  expect(JSON.stringify(await project(page))).toBe(before);
  await page.getByTestId('mate-edit-cancel').click();
  await expect(page.getByTestId('mate-editor')).toBeHidden();
});

test('constraints: create with preview, edit value, check-only, contradictory rejected, delete, undo', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openArm(page);
  await openRelationships(page);
  // Free the range sensor so a driving constraint can position it.
  await page.getByRole('button', { name: 'Delete Range sensor on plate' }).click();
  await expect.poll(async () => (await mate(page, 'm-sensor')) ?? null).toBeNull();

  await page.getByTestId('new-constraint').locator('summary').click();
  const nc = page.getByTestId('new-constraint');
  await nc.getByLabel('Constraint type').selectOption('distance');
  await nc.getByLabel('Constraint body A').selectOption('base-plate');
  await nc.getByLabel('Constraint reference A').selectOption('ifc:hole-1');
  await nc.getByLabel('Constraint body B').selectOption('range-sensor');
  await nc.getByLabel('Constraint reference B').selectOption('origin:+Y');
  const measured = Number(
    /currently ([\d.]+) mm/.exec((await nc.getByTestId('constraint-measured').textContent()) ?? '')![1],
  );
  expect(measured).toBeGreaterThan(10);
  const target = Math.round(measured + 20);
  await nc.getByTestId('constraint-value').fill(String(target));
  await expect(nc.getByTestId('constraint-valid')).toBeVisible();
  const rev0 = await revision(page);
  await nc.getByTestId('constraint-preview').click();
  expect(await revision(page)).toBe(rev0);
  await nc.getByTestId('constraint-apply').click();
  await expect(nc.locator('[role="status"]')).toContainText('Constraint added');
  const c = (await arm(page)).mechanical!.constraints[0]!;
  expect(c).toMatchObject({ type: 'distance', driving: true });
  expect(c.value!).toBeCloseTo(target / 1000, 12);
  await expect(nc.getByTestId('constraint-measured')).toContainText(`currently ${target} mm`);

  // Edit the value (one command) and switch it to check-only.
  await openRelationships(page);
  await page.getByRole('button', { name: `Edit ${c.name}` }).click();
  await page.getByTestId('constraint-edit-value').fill(String(target + 10));
  await expect(page.getByTestId('constraint-edit-valid')).toBeVisible();
  await page.getByTestId('constraint-edit-apply').click();
  await expect
    .poll(async () => (await arm(page)).mechanical!.constraints[0]!.value!)
    .toBeCloseTo((target + 10) / 1000, 12);
  await page.getByRole('button', { name: `Edit ${c.name}` }).click();
  await page.getByTestId('constraint-editor').getByLabel('Driving constraint').uncheck();
  await page.getByTestId('constraint-edit-apply').click();
  await expect(page.locator(`[data-relationship="${c.id}"]`)).toContainText('check only');

  // Contradictory: the base servo is fixed to the grounded plate — their origins cannot coincide.
  await nc.getByLabel('Constraint type').selectOption('coincident');
  await nc.getByLabel('Constraint body A').selectOption('base-plate');
  await nc.getByLabel('Constraint reference A').selectOption('origin:+Y');
  await nc.getByLabel('Constraint body B').selectOption('base-servo');
  await nc.getByLabel('Constraint reference B').selectOption('origin:+Y');
  await expect(nc.getByTestId('constraint-error')).toContainText('cannot all be satisfied');
  const before = JSON.stringify(await project(page));
  await nc.getByTestId('constraint-apply').click();
  await expect(nc.getByRole('alert').last()).toContainText('cannot');
  expect(JSON.stringify(await project(page))).toBe(before);

  // Delete, then undo restores it.
  await page.getByRole('button', { name: `Delete ${c.name}` }).click();
  await expect.poll(async () => (await arm(page)).mechanical!.constraints.length).toBe(0);
  await deselect(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await arm(page)).mechanical!.constraints.length).toBe(1);
});

/** Drag the selected body so that its `source` interface lands on `target` (screen space). */
async function snapDrag(
  page: Page,
  nodeId: string,
  source: string,
  target: { nodeId: string; interfaceId: string },
  release = true,
) {
  const grab = (await call<{ x: number; y: number }>(page, 'bodyScreenPoint', nodeId))!;
  const s = (await call<{ x: number; y: number }>(page, 'interfaceScreenPoint', nodeId, source))!;
  const t = (await call<{ x: number; y: number }>(
    page,
    'interfaceScreenPoint',
    target.nodeId,
    target.interfaceId,
  ))!;
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + (t.x - s.x) / 2, grab.y + (t.y - s.y) / 2, { steps: 6 });
  await page.mouse.move(grab.x + (t.x - s.x), grab.y + (t.y - s.y), { steps: 6 });
  if (release) await page.mouse.up();
}

test('drag-to-snap: compatible targets highlighted, ghost preview, cancel restores, confirm mates, undo/redo', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await openArm(page);
  await openRelationships(page);
  // Free screw 1 and move it aside (ordinary free movement via the inspector).
  await page.getByRole('button', { name: 'Delete Screw 1 through plate' }).click();
  await expect.poll(async () => (await mate(page, 'm-screw-1')) ?? null).toBeNull();
  await page.getByTestId('tree-row-base-plate').click();
  await page.getByTestId('frame-selection').click(); // zoom onto the plate
  await page.getByTestId('tree-row-screw-1').click();
  const x0 = (await nodes(page))['screw-1']!.transform.position[0];
  await page.getByTestId('position-x').fill(String((x0 + 0.04) * 1000));
  await page.getByTestId('position-x').press('Enter');
  await expect
    .poll(async () => (await nodes(page))['screw-1']!.transform.position[0])
    .toBeCloseTo(x0 + 0.04, 9);
  const moved = await worldOf(page, 'screw-1');

  // Snap mode on: the gizmo is replaced by snap dragging.
  await page.getByTestId('tool-mate-snap').click();
  await expect(page.getByTestId('snap-hint')).toContainText('compatible pairing');
  const rev0 = await revision(page);

  // 1. Release away from every interface: nothing changes.
  const g = (await call<{ x: number; y: number }>(page, 'bodyScreenPoint', 'screw-1'))!;
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.mouse.move(g.x, g.y - 140, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('status')).toContainText('No compatible interface within reach');
  expect(await revision(page)).toBe(rev0);
  await expect.poll(async () => dist((await rendered(page, 'screw-1'))!, moved)).toBeLessThan(1e-9);

  // 2. Drag toward hole 3: targets highlighted, nearest candidate + ghost while dragging.
  await snapDrag(page, 'screw-1', 'thread', { nodeId: 'base-plate', interfaceId: 'hole-3' }, false);
  const during = await snapState(page);
  expect(during.dragging).toBe(true);
  expect(during.targetMarkers).toBeGreaterThanOrEqual(8); // 4 holes + 4 nuts (compatible only)
  expect(during.candidates[0]?.key).toBe('thread|base-plate|hole-3');
  expect(during.ghost).toBe(true);
  expect(await revision(page)).toBe(rev0); // the drag is render-only
  await page.mouse.up();
  await expect.poll(async () => (await snapState(page)).pending?.chosen).toBe('thread|base-plate|hole-3');
  await expect(page.getByTestId('snap-message')).toContainText('Preview');
  expect(await revision(page)).toBe(rev0);

  // 3. Cancel: the screw is shown back where it was; the model never changed.
  await page.getByTestId('snap-cancel').click();
  await expect.poll(async () => (await snapState(page)).pending).toBeNull();
  await expect.poll(async () => dist((await rendered(page, 'screw-1'))!, moved)).toBeLessThan(1e-9);
  expect(await revision(page)).toBe(rev0);
  expect(dist(await worldOf(page, 'screw-1'), moved)).toBeLessThan(1e-12);

  // 4. Drag again, Escape cancels mid-drag.
  await snapDrag(page, 'screw-1', 'thread', { nodeId: 'base-plate', interfaceId: 'hole-3' }, false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(async () => (await snapState(page)).dragging).toBe(false);
  expect((await snapState(page)).pending).toBeNull();
  await expect.poll(async () => dist((await rendered(page, 'screw-1'))!, moved)).toBeLessThan(1e-9);

  // 5. Drag, release, confirm: one mate command places the thread on hole 3.
  await snapDrag(page, 'screw-1', 'thread', { nodeId: 'base-plate', interfaceId: 'hole-3' });
  await expect(page.getByTestId('snap-message')).toContainText('Preview');
  await page.getByTestId('snap-confirm').click();
  await expect.poll(async () => (await snapState(page)).pending).toBeNull();
  expect(await revision(page)).toBe(rev0 + 1);
  const snapped = (await arm(page)).mechanical!.mates.find((m) => m.b.nodeId === 'screw-1')!;
  expect(snapped).toMatchObject({
    type: 'fixed',
    a: { nodeId: 'base-plate', ref: { kind: 'interface', interfaceId: 'hole-3' } },
    b: { nodeId: 'screw-1', ref: { kind: 'interface', interfaceId: 'thread' } },
  });
  const hole3 = await worldOf(page, 'screw-3'); // screw 3 sits in hole 3 (same plan position)
  const s1 = await worldOf(page, 'screw-1');
  expect(Math.hypot(s1[0] - hole3[0], s1[2] - hole3[2])).toBeLessThan(1e-9);
  await expect.poll(async () => dist((await rendered(page, 'screw-1'))!, s1)).toBeLessThan(1e-9);

  // 6. Undo / redo the snap.
  await page.getByTestId('tool-mate-snap').click(); // leave snap mode
  await deselect(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(async () => (await arm(page)).mechanical!.mates.some((m) => m.b.nodeId === 'screw-1'))
    .toBe(false);
  expect(dist(await worldOf(page, 'screw-1'), moved)).toBeLessThan(1e-12);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect
    .poll(async () => (await arm(page)).mechanical!.mates.some((m) => m.b.nodeId === 'screw-1'))
    .toBe(true);
});

test('rendering: repeated fasteners are instanced in the facility view too; the GPU estimate counts instance buffers once', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openArm(page);
  type Inst = { batches: number; instanced: number };
  // Project view: 4 screws + 4 nuts in two batches; 8 instance matrices × 64 B.
  await expect.poll(async () => (await call<Inst>(page, 'instancing')).instanced).toBe(8);
  const est = await call<{ kind: string; estimate: boolean; instanceBytes: number }>(page, 'gpuEstimate');
  expect(est).toMatchObject({ kind: 'estimate', estimate: true, instanceBytes: 8 * 64 });
  // Facility view: mount the arm on bench C in Lab 20 — the same batches are used there.
  await page.getByTestId('view-facility').click();
  await expect
    .poll(
      async () =>
        (await call<Record<string, { state: string }>>(page, 'zoneStates'))[
          'lab-20-central-conjuring-workshop'
        ]?.state,
      {
        timeout: 30_000,
      },
    )
    .toBe('active');
  await page.getByTestId('item-row-bench-c').click();
  await page.getByRole('button', { name: 'Mount here' }).click();
  await expect(page.getByTestId('mounted-bench')).toHaveText('Bench C');
  await page.getByTestId('layer-project').click();
  await expect.poll(() => rendered(page, 'nut-1')).not.toBeNull();
  await expect.poll(async () => (await call<Inst>(page, 'instancing')).instanced).toBe(8);
  expect((await call<Inst>(page, 'instancing')).batches).toBe(2);
  // Selecting a nut takes it out of its batch (drawn individually, highlighted); the three
  // remaining nuts fall below the 4-instance threshold, so only the 4 screws stay instanced.
  await page.getByTestId('tree-row-nut-1').click();
  await expect.poll(async () => (await call<Inst>(page, 'instancing')).instanced).toBe(4);
  expect((await call<Inst>(page, 'instancing')).batches).toBe(1);
});
