import { expect, test, type Page } from '@playwright/test';

type Forge = {
  ready: boolean;
  render?: () => { frames: number; lastDrawCalls: number; lastTriangles: number };
  cameraPosition?: () => [number, number, number];
  project: () => { id: string; name: string };
  storageNamespace: string;
};
const projectId = (page: Page) =>
  page.evaluate(() => (window as unknown as { __forge: Forge }).__forge.project().id);
const storageNamespace = (page: Page) =>
  page.evaluate(() => (window as unknown as { __forge: Forge }).__forge.storageNamespace);

async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    () => {
      const f = (window as unknown as { __forge?: Forge }).__forge;
      return !!f?.render && f.render().frames > 5;
    },
    null,
    { timeout: 20_000 },
  );
}
const camera = (page: Page) =>
  page.evaluate(() => (window as unknown as { __forge: Forge }).__forge.cameraPosition!());

test('launches: identity, rendering canvas, physics ready, same-origin only, no console errors', async ({
  page,
}) => {
  const foreign: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!/^(http:\/\/127\.0\.0\.1:4173\/|data:|blob:)/.test(u)) foreign.push(u);
  });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));

  await open(page);
  await expect(page.getByRole('heading', { name: 'FORGE' })).toBeVisible();
  await expect(page.getByText('Engineering Research Environment')).toBeVisible();
  await expect(page.getByText('Phase 0 · Foundation')).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();

  const stats = await page.evaluate(() => (window as unknown as { __forge: Forge }).__forge.render!());
  expect(stats.lastDrawCalls).toBeGreaterThan(0);
  expect(stats.lastTriangles).toBeGreaterThan(0);

  await expect(page.getByTestId('physics-status')).toContainText(/^ready — Rapier \d+\.\d+\.\d+/, {
    timeout: 20_000,
  });
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test('orbit controls move the camera; Reset camera restores the initial view', async ({ page }) => {
  await open(page);
  const initial = await camera(page);
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(900, 380, { steps: 12 });
  await page.mouse.up();
  const orbited = await camera(page);
  const moved = Math.hypot(...orbited.map((v, i) => v - initial[i]!));
  expect(moved).toBeGreaterThan(0.2);

  await page.getByRole('button', { name: /Reset camera/ }).click();
  await expect
    .poll(async () => Math.hypot(...(await camera(page)).map((v, i) => v - initial[i]!)))
    .toBeLessThan(1e-6);
});

test('create → rotate → save survives a full page reload', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /New project/ }).click();
  const id = await projectId(page);
  await page.getByRole('button', { name: /Rotate object/ }).click();
  await page.getByRole('button', { name: /Rotate object/ }).click();
  await expect(page.getByTestId('instance-pose')).toContainText('yaw 30.0°');
  await page.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByRole('status')).toContainText(/Saved/);

  await page.reload();
  await open(page);
  expect(await projectId(page)).toBe(id);
  await expect(page.getByTestId('instance-pose')).toContainText('yaw 30.0°');
  await expect(page.getByRole('status')).toContainText(/Opened saved project/);
});

test('invalid stored project data produces an understandable error and keeps the open project', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: /^Save$/ }).click();
  const id = await projectId(page);
  const ns = await storageNamespace(page);
  await page.evaluate(
    ([key]) => localStorage.setItem(key!, '{"schemaVersion":1,"id":"x"'),
    [`${ns}:project:${id}`],
  );
  await page.getByRole('button', { name: /Reload saved/ }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Saved project is not valid JSON');
  await expect(alert).toContainText('left unchanged');
  expect(await projectId(page)).toBe(id);
});
