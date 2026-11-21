import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 2 polish: first-person walking (WASD, mouse-look, collision, zone handover),
 * automatic ceiling cutaway, corridor connector stubs, and reliable return to editing.
 */
type V3 = [number, number, number];
type F = Record<string, (...a: never[]) => unknown>;
type States = Record<string, { state: string; role: string | null }>;
const LAB20 = 'lab-20-central-conjuring-workshop';
const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      ((window as unknown as { __forge: F }).__forge[n as string] as (...x: unknown[]) => unknown)(
        ...(a as unknown[]),
      ),
    [name, args] as const,
  ) as Promise<T>;
const cam = (page: Page) => call<V3>(page, 'cameraPosition');

async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
}
async function waitActive(page: Page, id: string) {
  await expect
    .poll(async () => (await call<States>(page, 'zoneStates'))[id]?.state, { timeout: 20_000 })
    .toBe('active');
}
async function enterFacility(page: Page) {
  await page.getByTestId('view-facility').click();
  await waitActive(page, LAB20);
}
/** Hold a key for `ms` (the walker integrates real frame time). */
async function hold(page: Page, key: string, ms: number) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

test('ceilings are drawn when walking and cut away automatically for overhead inspection', async ({
  page,
}) => {
  await open(page);
  await enterFacility(page);
  await expect
    .poll(() => call<Record<string, boolean>>(page, 'ceilings'))
    .toMatchObject({ [LAB20]: false, 'corridor-e-main': false });
  await page.getByTestId('nav-walk').click();
  await expect
    .poll(() => call<Record<string, boolean>>(page, 'ceilings'))
    .toMatchObject({ [LAB20]: true, 'corridor-e-main': true });
  // Ceilings are architecture: never pickable, never part of the layout.
  await page.keyboard.press('Escape');
  await expect.poll(() => call<string>(page, 'navMode')).toBe('orbit');
  await expect.poll(() => call<Record<string, boolean>>(page, 'ceilings')).toMatchObject({ [LAB20]: false });
  // Overhead preset restored ([x, 13, z + 9.5] for Lab 20).
  await expect.poll(() => cam(page)).toEqual([0, 13, 2]);
});

test('corridor openings to unloaded neighbours show a vestibule, without loading the neighbour', async ({
  page,
}) => {
  await open(page);
  await enterFacility(page);
  const d = page.locator('details', { has: page.getByText('Zone directory') });
  await d.locator('summary').click();
  await page.getByTestId('dir-corridor-a-main').getByRole('button').click();
  await waitActive(page, 'corridor-a-main');
  await expect
    .poll(() => call<string[]>(page, 'stubs'))
    .toEqual(['corridor-a-main:concourse-1', 'corridor-a-main:concourse-2']);
  const live = Object.entries(await call<States>(page, 'zoneStates')).filter(
    ([, s]) => s.role !== 'prefetch',
  );
  expect(live.map(([id]) => id)).toEqual(['corridor-a-main']); // concourse segments are NOT loaded
  await page.getByTestId('dir-concourse-3').getByRole('button').click();
  await waitActive(page, 'concourse-3');
  await expect
    .poll(() => call<string[]>(page, 'stubs'))
    .toEqual(['concourse-3:corridor-b-main', 'concourse-3:corridor-c-main']);
});

test('first-person walking: WASD + mouse-look, wall collision, zone handover, and return to the editor', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await enterFacility(page);
  const layoutBefore = await call<unknown>(page, 'layout');
  const projectBefore = await call<{ revision: number }>(page, 'project');
  await page.getByTestId('nav-walk').click();
  await expect(page.getByTestId('walk-hud')).toBeVisible();
  // Spawn: eye height, just inside Lab 20's door, facing into the room (−Z).
  await expect.poll(() => cam(page)).toEqual([0, 1.6, expect.closeTo(-3.1, 6)]);
  const dir = await call<V3>(page, 'cameraDirection');
  expect(dir[2]).toBeLessThan(-0.99);

  // Walk forward (fast) toward the north wall: movement happens, but the wall stops us.
  await hold(page, 'Shift', 0); // ensure no stale modifier
  await page.keyboard.down('Shift');
  await hold(page, 'w', 6000);
  await page.keyboard.up('Shift');
  const atWall = await cam(page);
  expect(atWall[2]).toBeLessThan(-10); // moved well into the room
  expect(atWall[2]).toBeGreaterThanOrEqual(-13.5 + 0.25 - 1e-6); // never through the wall
  expect(await call<string>(page, 'currentZone')).toBe(LAB20);
  // Strafe (D) moves sideways along +X.
  await hold(page, 'd', 800);
  expect((await cam(page))[0]).toBeGreaterThan(0.3);

  // Mouse-look: dragging turns the view.
  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 20, cy);
  await page.mouse.up();
  const turned = await call<V3>(page, 'cameraDirection');
  expect(turned[0]).toBeGreaterThan(0.3); // dragging right turns right (toward +X)

  // Stop and start walking again: the walker respawns just inside Lab 20's door.
  await page.keyboard.press('Escape');
  await expect.poll(() => call<string>(page, 'navMode')).toBe('orbit');
  await page.getByTestId('nav-walk').click();
  await expect.poll(() => cam(page)).toEqual([0, 1.6, expect.closeTo(-3.1, 6)]);
  // Turn around with the arrow keys until facing the door (+Z), then walk through it.
  await expect
    .poll(
      async () => {
        await hold(page, 'ArrowLeft', 120);
        return (await call<V3>(page, 'cameraDirection'))[2];
      },
      { timeout: 30_000, intervals: [0] },
    )
    .toBeGreaterThan(0.9);
  await expect
    .poll(
      async () => {
        await hold(page, 'w', 250);
        return call<string>(page, 'currentZone');
      },
      { timeout: 30_000, intervals: [0] },
    )
    .toBe('corridor-e-main');
  // The lifecycle followed the walker: Corridor E is now the active zone; Lab 20 was released.
  await expect
    .poll(async () =>
      Object.entries(await call<States>(page, 'zoneStates'))
        .filter(([, s]) => s.role !== 'prefetch')
        .map(([id, s]) => `${id}:${s.role}`),
    )
    .toEqual(['corridor-e-main:active']);
  expect((await cam(page))[1]).toBe(1.6);

  // Escape leaves walking; "Return to editor" goes back to the engineering view.
  await page.keyboard.press('Escape');
  await expect.poll(() => call<string>(page, 'navMode')).toBe('orbit');
  await expect(page.getByTestId('walk-hud')).toHaveCount(0);
  await page.getByTestId('nav-walk').click();
  await expect(page.getByTestId('walk-hud')).toBeVisible();
  await page.getByTestId('walk-return-editor').click();
  await expect.poll(() => call<string>(page, 'view')).toBe('project');
  expect(await call<string>(page, 'navMode')).toBe('orbit');

  // Walking issued no commands: layout and project are untouched…
  expect(await call<unknown>(page, 'layout')).toEqual(layoutBefore);
  expect(await call<{ revision: number }>(page, 'project')).toEqual(projectBefore);
  // …and engineering editing works normally afterwards.
  const cube = (await call<{ nodes: { id: string }[] }>(page, 'queryScene')).nodes[1]!.id;
  await page.getByTestId(`tree-row-${cube}`).click();
  const px = page.getByTestId('position-x');
  await px.fill('120');
  await px.press('Enter');
  await expect
    .poll(async () => (await call<{ revision: number }>(page, 'project')).revision)
    .toBe(projectBefore.revision + 1);
  expect(errors).toEqual([]);
});
