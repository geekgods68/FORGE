import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 3: component library and conjuring, end to end — library navigation and search,
 * configuration, ghost placement on the active workbench, manipulation, duplicate,
 * undo/redo, persistence, export/import, cancellation, invalid placement, malformed data,
 * and the facility/workspace layers staying untouched.
 */
type V3 = [number, number, number];
type F = Record<string, (...a: never[]) => unknown>;
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
type ComponentNode = {
  id: string;
  kind: string;
  name: string;
  definitionId: string;
  transform: { position: V3; rotation: [number, number, number, number] };
  component: {
    variantId: string | null;
    parameters: Record<string, unknown>;
    materialId: string | null;
    snapshot: { name: string; tier: string };
  };
};
const LAB20 = 'lab-20-central-conjuring-workshop';
const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      ((window as unknown as { __forge: F }).__forge[n as string] as (...x: unknown[]) => unknown)(
        ...(a as unknown[]),
      ),
    [name, args] as const,
  ) as Promise<T>;
const project = (page: Page) =>
  call<{ id: string; revision: number; scene: { nodes: Record<string, ComponentNode> } }>(page, 'project');
const components = async (page: Page) =>
  Object.values((await project(page)).scene.nodes).filter(
    (n) => n.kind === 'component-instance' && n.component,
  );

async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
}
async function enterLab20WithBench(page: Page) {
  await page.getByTestId('view-facility').click();
  await expect
    .poll(async () => (await call<Record<string, { state: string }>>(page, 'zoneStates'))[LAB20]?.state, {
      timeout: 20_000,
    })
    .toBe('active');
  await page.getByTestId('item-row-bench-c').click();
  await page.getByRole('button', { name: 'Mount here' }).click();
  await expect(page.getByTestId('mounted-bench')).toHaveText('Bench C');
  await page.getByTestId('layer-project').click();
}
/** Hover the centre of the active work surface (+ offset in metres along its X), then return the point. */
async function hoverSurface(page: Page, dx = 0) {
  const g = await call<{ surfaceCentre: V3 }>(page, 'ghost');
  const c = g.surfaceCentre;
  const pt = await call<{ x: number; y: number }>(page, 'worldToScreen', [c[0] + dx, c[1], c[2]]);
  await page.mouse.move(pt.x + 4, pt.y + 4);
  await page.mouse.move(pt.x, pt.y);
  return pt;
}

test('library → configure → ghost placement on the workbench → manipulate, duplicate, undo/redo, save, reload, export/import', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await open(page);
  await enterLab20WithBench(page);
  const layoutBefore = await call<{ items: Record<string, unknown> }>(page, 'layout');
  const zonesBefore = await call<unknown>(page, 'zoneStates');

  // Library: 28 categories, navigate a category and subcategory.
  await page.getByTestId('library-toggle').click();
  await expect(page.getByRole('list', { name: 'Categories' }).getByRole('listitem')).toHaveCount(28);
  await page.getByTestId('library-category-motors-actuators').click();
  await page.getByTestId('library-sub-micro-servos').click();
  await expect(page.getByTestId('library-item-towerpro-sg90')).toBeVisible();
  // Search for a servo and select a named model.
  await page.getByRole('button', { name: 'All categories' }).click();
  await page.getByTestId('library-search').fill('servo');
  await expect(page.getByTestId('library-item-towerpro-mg996r')).toBeVisible();
  await page.getByTestId('library-item-towerpro-mg996r').click();
  await expect(page.getByTestId('library-detail-name')).toHaveText('MG996R high-torque servo');
  await expect(page.getByTestId('library-detail')).toContainText('datasheet-cited');
  await expect(page.getByTestId('library-detail')).toContainText('simulation: unsupported');

  // Ghost placement: nothing exists until confirmed; R rotates; click on the bench creates ONE node.
  const rev0 = (await project(page)).revision;
  await page.getByTestId('library-conjure').click();
  await expect(page.getByTestId('library-placing')).toBeVisible();
  const pt = await hoverSurface(page);
  await expect
    .poll(() => call<{ valid: boolean; surface: string; inSceneGraph: boolean }>(page, 'ghost'))
    .toMatchObject({ valid: true, surface: 'bench', inSceneGraph: false });
  expect((await project(page)).revision).toBe(rev0);
  await page.keyboard.press('r');
  await page.mouse.click(pt.x, pt.y);
  await expect.poll(async () => (await components(page)).length).toBe(1);
  const [servo] = await components(page);
  expect(servo!.definitionId).toBe('towerpro-mg996r');
  expect(servo!.component.snapshot).toMatchObject({ name: 'MG996R high-torque servo', tier: 'B' });
  expect(servo!.transform.rotation[1]).toBeCloseTo(Math.sin(Math.PI / 24), 9); // 15° about +Y
  expect((await project(page)).revision).toBe(rev0 + 1);
  expect(await call<string[]>(page, 'getSelection')).toEqual([servo!.id]);
  // Placed in the project frame on Bench C's mount (facility (−5, 0.9, −6)).
  const world = await call<V3>(page, 'nodeWorldPosition', servo!.id);
  expect(Math.abs(world[0] - -5)).toBeLessThan(0.9);
  expect(world[1]).toBeCloseTo(0.9, 6);
  await expect(page.getByTestId('component-family')).toHaveText('MG996R high-torque servo');

  // Manipulate (precision field), duplicate, undo/redo.
  const px = page.getByTestId('position-x');
  await px.fill('100');
  await px.press('Enter');
  await expect.poll(async () => (await components(page))[0]!.transform.position[0]).toBeCloseTo(0.1, 9);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.getByTestId(`tree-row-${servo!.id}`).click();
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(async () => (await components(page)).length).toBe(2);
  const copy = (await components(page)).find((n) => n.id !== servo!.id)!;
  expect(copy.component).toEqual((await components(page)).find((n) => n.id === servo!.id)!.component);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await components(page)).length).toBe(1);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await components(page)).length).toBe(2);

  // A Tier A part, configured in the library then edited through its parameters in the inspector.
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-search').fill('aluminium plate');
  await page.getByTestId('library-item-aluminium-plate').click();
  await page.getByTestId('library-param-length').fill('120');
  await page.getByTestId('library-param-length').press('Enter');
  await page.getByTestId('library-param-width').fill('60');
  await page.getByTestId('library-param-width').press('Enter');
  await expect(page.getByTestId('library-size')).toContainText('120.0 mm');
  await page.getByTestId('library-conjure').click();
  const pt2 = await hoverSurface(page, 0.5);
  await expect.poll(() => call<{ valid: boolean }>(page, 'ghost')).toMatchObject({ valid: true });
  await page.mouse.click(pt2.x, pt2.y);
  await expect.poll(async () => (await components(page)).length).toBe(3);
  const plate = (await components(page)).find((n) => n.definitionId === 'aluminium-plate')!;
  expect(plate.component.parameters).toMatchObject({ length: 0.12, width: 0.06 });
  expect(plate.component.variantId).toBeNull(); // generic search words never preselect a variant
  const thick = page.getByTestId('component-param-thickness');
  await thick.fill('6');
  await thick.press('Enter');
  await expect
    .poll(async () => (await components(page)).find((n) => n.id === plate.id)!.component.parameters.thickness)
    .toBeCloseTo(0.006, 12);
  await expect(page.getByTestId('component-dimensions')).toContainText('120.0 mm × 6.00 mm × 60.0 mm');
  await expect(page.getByTestId('component-mass')).toContainText('geometry-density');
  await expect(page.getByTestId('scale-locked-note')).toBeVisible();

  // Save → reload: components remain, correctly positioned.
  const before = await components(page);
  await page.getByRole('button', { name: 'Save layout' }).click(); // the bench mount is workspace data (saved separately)
  await page.getByRole('button', { name: /^Save$/ }).click();
  await page.reload();
  await open(page);
  const after = await components(page);
  const full = (n: ComponentNode) => JSON.stringify(canon([n.id, n.definitionId, n.transform, n.component]));
  expect(after.map(full).sort()).toEqual(before.map(full).sort());
  expect(await call<unknown[]>(page, 'componentWarnings')).toEqual([]);

  // Export → import: identity and metadata survive.
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export' }).first().click(),
  ]);
  const text = readFileSync((await dl.path())!, 'utf8');
  const doc = JSON.parse(text);
  expect(doc.schemaVersion).toBe(5);
  expect(
    Object.values(doc.scene.nodes as Record<string, ComponentNode>)
      .filter((n) => n.component)
      .map((n) => n.definitionId)
      .sort(),
  ).toEqual(['aluminium-plate', 'towerpro-mg996r', 'towerpro-mg996r']);
  await page.getByTestId(`tree-row-${plate.id}`).click();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await components(page)).length).toBe(2);
  await page
    .getByTestId('import-input')
    .setInputFiles({ name: 'p.forge.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.getByTestId('status')).toContainText('Imported');
  const key = (n: ComponentNode) => JSON.stringify(canon([n.id, n.definitionId, n.component]));
  expect((await components(page)).map(key).sort()).toEqual(before.map(key).sort());

  // Facility and workspace layers untouched by all of the above (layout only changed by the mount, before).
  await page.getByTestId('view-facility').click();
  expect((await call<{ items: Record<string, unknown> }>(page, 'layout')).items).toEqual(layoutBefore.items);
  await expect.poll(() => call<unknown>(page, 'zoneStates')).toEqual(zonesBefore);
  expect(errors).toEqual([]);
});

test('placement can be cancelled (Esc and Cancel) and invalid placement creates nothing', async ({
  page,
}) => {
  await open(page);
  await enterLab20WithBench(page);
  const rev0 = (await project(page)).revision;
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-search').fill('sg90');
  await page.getByTestId('library-item-towerpro-sg90').click();
  await page.getByTestId('library-conjure').click();
  await hoverSurface(page);
  await expect.poll(() => call<{ active: boolean }>(page, 'ghost')).toMatchObject({ active: true });
  await page.keyboard.press('Escape');
  await expect.poll(() => call<unknown>(page, 'conjure')).toBeNull();
  await expect.poll(() => call<{ active: boolean }>(page, 'ghost')).toMatchObject({ active: false });
  await page.getByTestId('library-conjure').click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => call<unknown>(page, 'conjure')).toBeNull();
  // Off the bench: the ghost is invalid and clicking creates nothing.
  await page.getByTestId('library-conjure').click();
  const off = await hoverSurface(page, 3);
  await expect
    .poll(() => call<{ valid: boolean; position: V3 | null }>(page, 'ghost'))
    .toMatchObject({ valid: false });
  await page.mouse.click(off.x, off.y);
  await expect(page.getByTestId('status')).toContainText('Invalid placement');
  expect((await project(page)).revision).toBe(rev0);
  expect(await components(page)).toEqual([]);
  // A part that can never fit the 1800 × 800 mm work surface.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('library-search').fill('aluminium plate');
  await page.getByTestId('library-item-aluminium-plate').click();
  await page.getByTestId('library-param-length').fill('2500');
  await page.getByTestId('library-param-length').press('Enter');
  await page.getByTestId('library-conjure').click();
  const c = await hoverSurface(page);
  await expect.poll(() => call<{ valid: boolean }>(page, 'ghost')).toMatchObject({ valid: false });
  await page.mouse.click(c.x, c.y);
  expect((await project(page)).revision).toBe(rev0);
  // Out-of-range parameters disable conjuring with an explanation.
  await page.keyboard.press('Escape');
  await page.getByTestId('library-param-thickness').fill('-3');
  await page.getByTestId('library-param-thickness').press('Enter');
  await expect(page.getByTestId('library-detail').getByRole('alert')).toContainText('outside');
  await expect(page.getByTestId('library-conjure')).toBeDisabled();
});

test('malformed component data: unknown definitions load as labelled placeholders; invalid instances are rejected', async ({
  page,
}) => {
  page.on('dialog', (d) => d.accept());
  await open(page);
  // Build a project with one catalogue component through the real UI path (project view, build area).
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-search').fill('hc-sr04');
  await page.getByTestId('library-item-hc-sr04').click();
  await page.getByTestId('library-conjure').click();
  const c = await hoverSurface(page);
  await expect
    .poll(() => call<{ valid: boolean; surface: string }>(page, 'ghost'))
    .toMatchObject({ valid: true, surface: 'build-area' });
  await page.mouse.click(c.x, c.y);
  await expect.poll(async () => (await components(page)).length).toBe(1);
  const doc = JSON.parse(JSON.stringify(await project(page)));
  const id = (await components(page))[0]!.id;

  const missing = structuredClone(doc);
  missing.scene.nodes[id].definitionId = 'vendor-x-unknown-sensor';
  await page.getByTestId('import-input').setInputFiles({
    name: 'm.forge.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(missing)),
  });
  await expect(page.getByTestId('status')).toContainText('placeholder');
  expect(await call<{ kind: string }[]>(page, 'componentWarnings')).toEqual([
    expect.objectContaining({ kind: 'missing-definition' }),
  ]);
  await page.getByTestId(`tree-row-${id}`).click();
  await expect(page.getByTestId('component-inspector')).toContainText('not in this component library');
  await expect(page.getByTestId('component-inspector')).toContainText('HC-SR04'); // stored identity preserved

  const before = JSON.stringify(await project(page));
  const scaled = structuredClone(doc);
  scaled.scene.nodes[id].transform.scale = [3, 1, 1];
  await page.getByTestId('import-input').setInputFiles({
    name: 's.forge.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(scaled)),
  });
  await expect(page.getByTestId('status')).toContainText('Import failed');
  expect(JSON.stringify(await project(page))).toBe(before);
});
