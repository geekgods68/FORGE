import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 2 vertical slice: Wing E Central Conjuring & Integration Workshop + Corridor E.
 * Verifies lazy loading, the three ownership layers (facility read-only, workspace
 * layout, engineering project), coordinate frames, and separate persistence.
 */
type V3 = [number, number, number];
type F = Record<string, (...a: never[]) => unknown>;
const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      ((window as unknown as { __forge: F }).__forge[n as string] as (...x: unknown[]) => unknown)(
        ...(a as unknown[]),
      ),
    [name, args] as const,
  ) as Promise<T>;
type Item = {
  id: string;
  name: string;
  pose: { position: V3; yaw: number };
  mountedProjectId: string | null;
};
type Layout = { revision: number; items: Record<string, Item> };
const layout = (page: Page) => call<Layout>(page, 'layout');
const projectRev = async (page: Page) => (await call<{ revision: number }>(page, 'project')).revision;
const close = (a: readonly number[], b: readonly number[], eps = 1e-6) =>
  a.every((v, i) => Math.abs(v - b[i]!) <= eps);

async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
}
async function enterFacility(page: Page) {
  await page.getByTestId('view-facility').click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __forge: { loadedZoneModules: () => string[] } }).__forge.loadedZoneModules()
        .length === 2,
    null,
    { timeout: 15_000 },
  );
  await expect(page.getByTestId('zone-name')).toHaveText('Central Conjuring & Integration Workshop');
}

test('zones load lazily: nothing before entering the facility; only the slice (no planned zones) after', async ({
  page,
}) => {
  const zoneChunks: string[] = [];
  const foreign: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/(CentralWorkshop|CorridorE)-/.test(u)) zoneChunks.push(u.split('/').pop()!);
    if (!/^(http:\/\/127\.0\.0\.1:4173\/|data:|blob:)/.test(u)) foreign.push(u);
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await open(page);
  expect(await call<string[]>(page, 'loadedZoneModules')).toEqual([]);
  expect(zoneChunks).toEqual([]);
  await enterFacility(page);
  expect(await call<string[]>(page, 'loadedZoneModules')).toEqual(['central-workshop', 'corridor-e']);
  expect(zoneChunks.sort()).toEqual([
    expect.stringMatching(/^CentralWorkshop-/),
    expect.stringMatching(/^CorridorE-/),
  ]);
  // Planned zones are listed (22 labs + 6 environments + corridor) but cannot be entered.
  await page.getByText('Zone directory').click();
  const directory = page.getByRole('list', { name: 'Zone directory' });
  await expect(directory.getByRole('listitem')).toHaveCount(29);
  await expect(directory.getByText('planned')).toHaveCount(27);
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test('architecture is not editable: clicking walls selects nothing in either edit layer', async ({
  page,
}) => {
  await open(page);
  await enterFacility(page);
  const before = await layout(page);
  // A point on the workshop's north wall (facility frame): zone z −7.5 − 6 = −13.5, 2.5 m up.
  const wall = await call<{ x: number; y: number }>(page, 'worldToScreen', [3.5, 2.5, -13.55]);
  await page.getByTestId('layer-layout').click();
  await page.mouse.click(wall.x, wall.y);
  expect(await call(page, 'itemSelection')).toBeNull();
  await page.getByTestId('layer-project').click();
  await page.mouse.click(wall.x, wall.y);
  expect(await call(page, 'getSelection')).toEqual([]);
  expect(await layout(page)).toEqual(before);
  // Positive control: in the same view, a click on equipment in the layout layer DOES select it,
  // so the negative results above are meaningful (bench A top centre: facility (−5, 0.9, −10.5)).
  await page.getByTestId('layer-layout').click();
  const bench = await call<{ x: number; y: number }>(page, 'worldToScreen', [-5, 0.9, -10.5]);
  await page.mouse.click(bench.x, bench.y);
  await expect.poll(() => call(page, 'itemSelection')).toBe('bench-a');
});

test('layout editing: validated moves, collision rejection, separate undo history from the project', async ({
  page,
}) => {
  await open(page);
  await enterFacility(page);
  const rev0 = await projectRev(page);
  await page.getByTestId('item-row-bench-a').click(); // switches to the layout layer
  await expect(page.getByTestId('edit-layer')).toHaveText('editing: layout');
  const x = page.getByTestId('item-x');
  await x.fill('-4000');
  await x.press('Enter');
  await expect.poll(async () => (await layout(page)).items['bench-a']!.pose.position).toEqual([-4, 0, -3]);
  // Collision with Bench B is refused; nothing changes.
  const r1 = (await layout(page)).revision;
  await x.fill('5000');
  await x.press('Enter');
  await expect(page.getByRole('alert')).toContainText('overlap');
  expect((await layout(page)).revision).toBe(r1);
  expect((await layout(page)).items['bench-a']!.pose.position).toEqual([-4, 0, -3]);
  // Rotation in degrees → radians.
  const yaw = page.getByTestId('item-yaw');
  await yaw.fill('90');
  await yaw.press('Enter');
  await expect.poll(async () => (await layout(page)).items['bench-a']!.pose.yaw).toBeCloseTo(Math.PI / 2, 12);
  // Undo in the layout layer touches only the layout history.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await layout(page)).items['bench-a']!.pose.yaw).toBe(0);
  expect(await projectRev(page)).toBe(rev0);
  // Placing new equipment finds a free, valid spot.
  await page.getByRole('combobox', { name: 'Equipment type' }).selectOption('tool-cabinet');
  await page.getByRole('button', { name: 'Place' }).click();
  await expect.poll(async () => Object.keys((await layout(page)).items).length).toBe(10);
});

test('project mounted on a bench: frames place it exactly; engineering edits stay in the project layer', async ({
  page,
}) => {
  await open(page);
  await enterFacility(page);
  await page.getByTestId('item-row-bench-c').click();
  await page.getByRole('button', { name: 'Mount here' }).click();
  await expect(page.getByTestId('mounted-bench')).toHaveText('Bench C');
  const cube = (await call<{ nodes: { id: string }[] }>(page, 'queryScene')).nodes[1]!.id;
  // Bench C at zone (−5, 0, 1.5); zone at facility (0, 0, −7.5); mount +0.9 m; cube local (0, 0.15, 0).
  const expected: V3 = [-5, 1.05, -6];
  await expect
    .poll(async () => close((await call<V3>(page, 'nodeWorldPosition', cube))!, expected))
    .toBe(true);
  // Inspector shows the same facility coordinates (computed from frames, not the renderer).
  await page.getByTestId('layer-project').click();
  await page.getByTestId(`tree-row-${cube}`).click();
  await expect(page.getByTestId('facility-position')).toContainText('-5000.0, 1050.0, -6000.0');
  // Editing the project in the facility view uses the project history, not the layout.
  const layoutRev = (await layout(page)).revision;
  const px = page.getByTestId('position-x');
  await px.fill('50');
  await px.press('Enter');
  await expect
    .poll(async () => close((await call<V3>(page, 'nodeWorldPosition', cube))!, [-4.95, 1.05, -6]))
    .toBe(true);
  expect((await layout(page)).revision).toBe(layoutRev);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(async () => close((await call<V3>(page, 'nodeWorldPosition', cube))!, expected))
    .toBe(true);
});

test('separate persistence: layout and project save to different stores and files and survive reload', async ({
  page,
}) => {
  await open(page);
  await enterFacility(page);
  await page.getByTestId('item-row-bench-d').click();
  await page.getByTestId('item-z').fill('2500');
  await page.getByTestId('item-z').press('Enter');
  await page.getByRole('button', { name: 'Mount here' }).click();
  await page.getByRole('button', { name: 'Save layout' }).click();
  await page.getByRole('button', { name: /^Save$/ }).click();
  const projectId = (await call<{ id: string }>(page, 'project')).id;

  const keys = await page.evaluate(() => Object.keys(localStorage).sort());
  expect(keys.filter((k) => k.startsWith('forge:project:'))).toHaveLength(1);
  expect(keys.filter((k) => k.startsWith('forge:workspace:'))).toHaveLength(1);

  // Files: the project file contains no workspace data; the layout file references the project by id only.
  const [projDl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export' }).first().click(),
  ]);
  const projectText = readFileSync((await projDl.path())!, 'utf8');
  expect(projectText).not.toMatch(/mountedProjectId|workspace|bench-d/);
  const [layoutDl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('region', { name: 'Workspace' }).getByRole('button', { name: 'Export' }).click(),
  ]);
  expect(layoutDl.suggestedFilename()).toMatch(/\.forge-workspace\.json$/);
  const layoutText = readFileSync((await layoutDl.path())!, 'utf8');
  expect(layoutText).toContain(`"mountedProjectId": "${projectId}"`);
  expect(layoutText).not.toMatch(/"scene"|"childIds"/);

  await page.reload();
  await open(page);
  const l = await layout(page);
  expect(l.items['bench-d']!.pose.position).toEqual([5, 0, 2.5]);
  expect(l.items['bench-d']!.mountedProjectId).toBe(projectId);
  expect((await call<{ id: string }>(page, 'project')).id).toBe(projectId);
});

test('a corrupt layout file is rejected and the current layout is kept', async ({ page }) => {
  await open(page);
  await enterFacility(page);
  const before = await layout(page);
  await page.getByTestId('layout-import-input').setInputFiles({
    name: 'bad.forge-workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        ...before,
        items: { x: { ...before.items['bench-a'], id: 'x', pose: { position: [99, 0, 0], yaw: 0 } } },
      }),
    ),
  });
  await expect(page.getByRole('alert')).toContainText('Layout import failed');
  expect(await layout(page)).toEqual(before);
});
