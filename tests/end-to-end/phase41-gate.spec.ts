import { expect, test, type Page } from '@playwright/test';
import { glb } from './fixtures/glb';

/**
 * Phase 4.1 completion gate (brief), in one browser session, through the UI only:
 *  1. open the robotic-arm project          2. select assembly components
 *  3. drag a compatible part to a mount      4. preview and confirm its mate
 *  5. edit the mate's alignment (inspector)  6. create + edit a geometric constraint
 *  7. import a GLB, declare an interface, mate it to another component
 *  8. save, reload, reopen — relationships intact
 *  9. undo / redo the interactions          10. (no regressions: the full suite runs too)
 */
type F = Record<string, (...a: never[]) => unknown>;
type Rel = {
  id: string;
  name: string;
  type: string;
  alignment?: string;
  driving?: boolean;
  a: { nodeId: string };
  b: { nodeId: string };
};
type Node = {
  id: string;
  kind: string;
  childIds: string[];
  name: string;
  transform: { position: [number, number, number] };
  model?: { interfaces: { id: string }[] };
  mechanical?: { grounded: string[]; mates: Rel[]; constraints: Rel[] };
};
const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      ((window as unknown as { __forge: F }).__forge[n as string] as (...x: unknown[]) => unknown)(
        ...(a as unknown[]),
      ),
    [name, args] as const,
  ) as Promise<T>;
const nodes = async (page: Page) =>
  (await call<{ scene: { nodes: Record<string, Node> } }>(page, 'project')).scene.nodes;
const arm = async (page: Page) => (await nodes(page))['grp-arm']!;
const ready = (page: Page) =>
  page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
async function selectRow(page: Page, id: string) {
  const row = page.getByTestId(`tree-row-${id}`);
  // The tree is virtualized: scroll explicitly (top, then bottom) until the row is rendered.
  for (const top of [0, 1e6]) {
    await page.getByTestId('hierarchy-scroll').evaluate((el, t) => ((el as HTMLElement).scrollTop = t), top);
    await page.waitForTimeout(50);
    if ((await row.count()) > 0) break;
  }
  await row.click();
}
async function openRelationships(page: Page) {
  await selectRow(page, 'grp-arm');
  const section = page.getByTestId('relationships-section');
  if (!(await section.evaluate((d) => (d as HTMLDetailsElement).open)))
    await section.locator('summary').click();
}
/** Snap-drag the selected body so its `source` interface lands on the target's interface. */
async function snapDrag(page: Page, nodeId: string, source: string, targetNode: string, targetIfc: string) {
  const grab = (await call<{ x: number; y: number }>(page, 'bodyScreenPoint', nodeId))!;
  const s = (await call<{ x: number; y: number }>(page, 'interfaceScreenPoint', nodeId, source))!;
  const t = (await call<{ x: number; y: number }>(page, 'interfaceScreenPoint', targetNode, targetIfc))!;
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + (t.x - s.x), grab.y + (t.y - s.y), { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('snap-message')).toContainText('Preview');
}
/** Key-order-independent signature of every arm relationship (persistence comparison). */
const signature = async (page: Page) => {
  const a = (await nodes(page))['grp-arm'];
  if (!a?.mechanical) return null;
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(canon({ members: a.childIds, m: a.mechanical }));
};

test('Phase 4.1 completion gate', async ({ page }) => {
  test.setTimeout(180_000);
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);

  // 1. Open the VEYRIS robotic-arm project.
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-sample').click();
  await expect(page.getByTestId('status')).toContainText('robotic-arm sample');

  // 7a. Import a GLB and keep it as a custom component (inserted later).
  await page.getByText('Inspect an external 3D model').click();
  await page.getByTestId('glb-input').setInputFiles({
    name: 'sensor-plate.glb',
    mimeType: 'model/gltf-binary',
    buffer: glb([0, 0, 0, 60, 0, 0, 0, 6, 40, 60, 6, 40, 0, 6, 0, 60, 0, 40]),
  });
  await page.getByTestId('glb-name').fill('Sensor plate');
  await page.getByTestId('glb-save-button').click();
  await page.getByTestId('library-toggle').click();

  // 2. Select components of the assembly; free screw 1 and move it aside.
  await openRelationships(page);
  await page.getByRole('button', { name: 'Delete Screw 1 through plate' }).click();
  await selectRow(page, 'base-plate');
  await page.getByTestId('frame-selection').click();
  await selectRow(page, 'screw-1');
  await expect(page.getByTestId('component-inspector')).toBeVisible();
  const x0 = (await nodes(page))['screw-1']!.transform.position[0];
  await page.getByTestId('position-x').fill(String((x0 + 0.04) * 1000));
  await page.getByTestId('position-x').press('Enter');
  await expect
    .poll(async () => (await nodes(page))['screw-1']!.transform.position[0])
    .toBeCloseTo(x0 + 0.04, 9);

  // 3–4. Drag it toward hole 1; preview and confirm the mate.
  await page.keyboard.press('s'); // snap mode (shortcut)
  await expect(page.getByTestId('snap-panel')).toBeVisible();
  await snapDrag(page, 'screw-1', 'thread', 'base-plate', 'hole-1');
  await page.getByTestId('snap-confirm').click();
  await page.keyboard.press('s');
  const snapped = (await arm(page)).mechanical!.mates.find((m) => m.b.nodeId === 'screw-1')!;
  expect(snapped.a.nodeId).toBe('base-plate');

  // 5. Edit that mate's alignment in the inspector.
  await openRelationships(page);
  await page.getByRole('button', { name: `Edit ${snapped.name}` }).click();
  await page.getByTestId('mate-editor').getByLabel('Edit mate alignment').selectOption('aligned');
  await page.getByTestId('mate-edit-apply').click();
  await expect
    .poll(async () => (await arm(page)).mechanical!.mates.find((m) => m.id === snapped.id)!.alignment)
    .toBe('aligned');

  // 6. Create a geometric constraint without writing commands, then edit it.
  const nc = page.getByTestId('new-constraint');
  await nc.locator('summary').click();
  await nc.getByLabel('Constraint type').selectOption('parallel');
  await nc.getByLabel('Constraint body A').selectOption('base-plate');
  await nc.getByLabel('Constraint reference A').selectOption('origin:+Y');
  await nc.getByLabel('Constraint body B').selectOption('range-sensor');
  await nc.getByLabel('Constraint reference B').selectOption('origin:+Y');
  await expect(nc.getByTestId('constraint-valid')).toBeVisible();
  await nc.getByTestId('constraint-preview').click();
  await nc.getByTestId('constraint-apply').click();
  await expect(nc.locator('[role="status"]')).toContainText('Constraint added');
  const c = (await arm(page)).mechanical!.constraints[0]!;
  await openRelationships(page);
  await page.getByRole('button', { name: `Edit ${c.name}` }).click();
  await page.getByTestId('constraint-editor').getByLabel('Driving constraint').uncheck();
  await page.getByTestId('constraint-edit-apply').click();
  await expect.poll(async () => (await arm(page)).mechanical!.constraints[0]!.driving).toBe(false);

  // 7b. Insert the GLB component, declare a connection interface, mate it to screw 2.
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('custom-insert-Sensor plate').click();
  await page.getByTestId('library-toggle').click();
  const modelId = Object.values(await nodes(page)).find((n) => n.kind === 'model-instance')!.id;
  await page.getByTestId('model-interface-add').click();
  const form = page.getByTestId('model-interface-form');
  await form.getByLabel('Interface name').fill('Fixing hole');
  await form.getByLabel('Interface type').selectOption('bolt-hole');
  await form.getByLabel('Interface gender').selectOption('female');
  await form.getByLabel('Interface position X (mm)').fill('30');
  await form.getByLabel('Interface position Y (mm)').fill('6');
  await form.getByLabel('Interface position Z (mm)').fill('20');
  await form.getByLabel('Interface compatibility tags').fill('M4-clearance');
  await page.getByTestId('model-interface-apply').click();
  await expect(page.getByTestId('model-interfaces')).toContainText('Connection interfaces (1)');
  await page.keyboard.press('s');
  await snapDrag(page, modelId, 'fixing-hole', 'screw-2', 'thread');
  await page.getByTestId('snap-confirm').click();
  await page.keyboard.press('s');
  await expect
    .poll(async () => (await arm(page)).mechanical!.mates.some((m) => m.b.nodeId === modelId))
    .toBe(true);

  // 9. Undo / redo the last interaction (the model's snap mate).
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(async () => (await arm(page)).mechanical!.mates.some((m) => m.b.nodeId === modelId))
    .toBe(false);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect
    .poll(async () => (await arm(page)).mechanical!.mates.some((m) => m.b.nodeId === modelId))
    .toBe(true);

  // 8. Save, reload, reopen: every relationship and the declared interface persist.
  const before = await signature(page);
  const dofBefore = await (async () => {
    await selectRow(page, 'grp-arm');
    return page.getByTestId('assembly-dof').textContent();
  })();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await ready(page);
  await page.getByTestId('view-project').click();
  await expect.poll(() => signature(page)).toBe(before);
  expect((await nodes(page))[modelId]!.model!.interfaces.map((i) => i.id)).toEqual(['fixing-hole']);
  await selectRow(page, 'grp-arm');
  await expect(page.getByTestId('assembly-dof')).toHaveText(dofBefore!);
  const after = await arm(page);
  expect(after.mechanical!.mates.find((m) => m.id === snapped.id)!.alignment).toBe('aligned');
  expect(after.mechanical!.constraints[0]!.driving).toBe(false);
});
