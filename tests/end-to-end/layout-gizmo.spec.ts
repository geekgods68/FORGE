import { expect, test, type Page } from '@playwright/test';

/**
 * Workspace layout gizmo, driven with real pointer events on the TransformControls
 * picker handles (not the inspector): valid move, rejected move, undo/redo, frame
 * readouts and persistence. Bench A starts at zone (−5, 0, −3) in Lab 20 (zone origin
 * facility (0, 0, −7.5)); Bench B sits at zone (5, 0, −3).
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
type Layout = { revision: number; items: Record<string, { pose: { position: V3; yaw: number } }> };
const layout = (page: Page) => call<Layout>(page, 'layout');
const benchA = async (page: Page) => (await layout(page)).items['bench-a']!.pose.position;
const depth = async (page: Page) => (await call<{ undoDepth: number }>(page, 'workspaceHistory')).undoDepth;

async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
}

/** Drag the named picker handle so the item moves by `dxM` metres along facility +X. */
async function dragHandle(page: Page, handle: string, from: V3, dxM: number) {
  const h = await expect
    .poll(() => call<{ x: number; y: number } | null>(page, 'layoutGizmoHandle', handle))
    .not.toBeNull()
    .then(() => call<{ x: number; y: number }>(page, 'layoutGizmoHandle', handle));
  const a = await call<{ x: number; y: number }>(page, 'worldToScreen', from);
  const b = await call<{ x: number; y: number }>(page, 'worldToScreen', [from[0] + dxM, from[1], from[2]]);
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  const steps = 15;
  for (let i = 1; i <= steps; i++)
    await page.mouse.move(h.x + ((b.x - a.x) * i) / steps, h.y + ((b.y - a.y) * i) / steps);
  await page.mouse.up();
}

test('layout gizmo drag: valid move, rejected collision, undo/redo, frames and persistence', async ({
  page,
}) => {
  await open(page);
  await page.getByTestId('view-facility').click();
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __forge: { zoneStates: () => Record<string, { state: string }> } }
      ).__forge.zoneStates()['lab-20-central-conjuring-workshop']?.state === 'active',
  );
  await page.getByTestId('item-row-bench-a').click();
  await expect(page.getByTestId('edit-layer')).toHaveText('editing: layout');
  expect(await benchA(page)).toEqual([-5, 0, -3]);
  const rev0 = (await layout(page)).revision;
  const depth0 = await depth(page);

  // 1. Valid drag on the X handle: ~1.5 m east. One history entry for the whole drag,
  //    X snapped to the 10 mm grid, Z untouched (single-axis handle), floor-level.
  await dragHandle(page, 'X', [-5, 0.9, -10.5], 1.5);
  await expect.poll(() => depth(page)).toBe(depth0 + 1);
  const moved = await benchA(page);
  expect(moved[0]).toBeGreaterThan(-4);
  expect(moved[0]).toBeLessThan(-3);
  expect(Math.abs(moved[0] * 100 - Math.round(moved[0] * 100))).toBeLessThan(1e-6);
  expect(moved[1]).toBe(0);
  expect(moved[2]).toBeCloseTo(-3, 9);
  expect((await layout(page)).revision).toBe(rev0 + 1);
  // Coordinate frames: facility = zone origin (0, 0, −7.5) + item pose; inspector shows both.
  const fp = await call<V3>(page, 'itemFacilityPosition', 'bench-a');
  expect(fp[0]).toBeCloseTo(moved[0], 9);
  expect(fp[2]).toBeCloseTo(-10.5, 9);
  await expect(page.getByTestId('item-facility-position')).toContainText(
    `${(moved[0] * 1000).toFixed(1)}, 0.0, -10500.0`,
  );
  await expect(page.getByTestId('item-x')).toHaveValue((moved[0] * 1000).toFixed(1));

  // 2. Rejected drag: onto Bench B (x = 5). Nothing commits; the rendered bench snaps back.
  const handleBefore = (await call<{ x: number; y: number }>(page, 'layoutGizmoHandle', 'X'))!;
  await dragHandle(page, 'X', [moved[0], 0.9, -10.5], 5 - 0.4 - moved[0]);
  await expect(page.getByRole('alert')).toContainText('overlap');
  expect(await benchA(page)).toEqual(moved);
  expect((await layout(page)).revision).toBe(rev0 + 1);
  expect(await depth(page)).toBe(depth0 + 1);
  await expect
    .poll(async () => {
      const h = (await call<{ x: number; y: number }>(page, 'layoutGizmoHandle', 'X'))!;
      return Math.hypot(h.x - handleBefore.x, h.y - handleBefore.y);
    })
    .toBeLessThan(2);

  // 3. Undo / redo in the layout layer (separate from the project history).
  const projectRev = (await call<{ revision: number }>(page, 'project')).revision;
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => benchA(page)).toEqual([-5, 0, -3]);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => benchA(page)).toEqual(moved);
  expect((await call<{ revision: number }>(page, 'project')).revision).toBe(projectRev);

  // 4. Persistence: save the layout, reload, and the dragged pose is restored.
  await page.getByRole('button', { name: 'Save layout' }).click();
  await page.reload();
  await open(page);
  expect(await benchA(page)).toEqual(moved);
});
