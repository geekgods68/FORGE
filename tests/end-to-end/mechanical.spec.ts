import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4: the constrained robotic-arm acceptance workflow (hierarchy, joint editing
 * within limits, dependent motion, home, exploded view + exact restore, save/reload with
 * joints intact) and recovery from invalid mates / out-of-limit input.
 */
type V3 = [number, number, number];
type F = Record<string, (...a: never[]) => unknown>;
type Mate = { id: string; type: string; coordinates: number[] };
type Node = {
  id: string;
  kind: string;
  name: string;
  childIds: string[];
  transform: { position: V3; rotation: number[] };
  mechanical?: { grounded: string[]; mates: Mate[] };
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
const modelWorld = async (page: Page, id: string) =>
  (await call<{ position: V3 }>(page, 'getWorldTransform', id)).position;
const rendered = (page: Page, id: string) => call<V3>(page, 'nodeWorldPosition', id);
const mate = async (page: Page, id: string) =>
  (await nodes(page))['grp-arm']!.mechanical!.mates.find((m) => m.id === id)!;
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

async function openSample(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-sample').click();
  await expect(page.getByTestId('status')).toContainText('robotic-arm sample');
  await page.getByTestId('library-toggle').click();
}

async function setJoint(page: Page, mateId: string, value: string) {
  const f = page.getByTestId(`joint-${mateId}-0-value`);
  await f.fill(value);
  await f.press('Enter');
}

test('robotic arm: hierarchy, joints within limits, dependent motion, home, explode/restore, save/reload', async ({
  page,
}) => {
  await openSample(page);
  // 2. Inspect the hierarchy: the arm is a grounded assembly with four free revolute joints.
  await page.getByTestId('tree-row-grp-arm').click();
  await expect(page.getByTestId('assembly-inspector')).toBeVisible();
  await expect(page.getByTestId('assembly-dof')).toHaveText('4');
  await expect(page.getByTestId('assembly-status')).toContainText('Under-constrained');
  await expect(page.locator('[data-member="base-plate"]')).toHaveAttribute('data-state', 'grounded');
  await expect(page.locator('[data-member="gripper"]')).toHaveAttribute('data-state', 'mated');

  const plate0 = await modelWorld(page, 'base-plate');
  const grip0 = await modelWorld(page, 'gripper');
  const upper0 = await modelWorld(page, 'upper-link');
  const fore0 = await modelWorld(page, 'forearm-link');

  // 3. Shoulder within limits: the dependent chain repositions, the grounded base does not.
  await setJoint(page, 'j-shoulder', '30');
  await expect.poll(async () => (await mate(page, 'j-shoulder')).coordinates[0]!).toBeCloseTo(Math.PI / 6, 9);
  expect(dist(await modelWorld(page, 'base-plate'), plate0)).toBeLessThan(1e-12);
  const grip1 = await modelWorld(page, 'gripper');
  expect(dist(grip1, grip0)).toBeGreaterThan(0.01);
  // Rigid chain: the forearm keeps its distance from the upper link.
  const d0 = dist(upper0, fore0);
  expect(dist(await modelWorld(page, 'upper-link'), await modelWorld(page, 'forearm-link'))).toBeCloseTo(
    d0,
    9,
  );
  // The renderer shows the solved pose.
  await expect.poll(async () => dist(await rendered(page, 'gripper'), grip1)).toBeLessThan(1e-6);

  // Out of limits (±90°) is refused with a message; nothing changes.
  const rev = (await call<{ revision: number }>(page, 'project')).revision;
  await setJoint(page, 'j-shoulder', '120');
  await expect(page.locator('[data-joint="j-shoulder"] [role="alert"]')).toContainText('limit');
  expect((await call<{ revision: number }>(page, 'project')).revision).toBe(rev);

  // 4. Elbow: the forearm and everything after it move; the upper link does not.
  const upper1 = await modelWorld(page, 'upper-link');
  await setJoint(page, 'j-elbow', '-45');
  await expect.poll(async () => dist(await modelWorld(page, 'gripper'), grip1)).toBeGreaterThan(0.01);
  expect(dist(await modelWorld(page, 'upper-link'), upper1)).toBeLessThan(1e-9);

  // Keyboard on the slider: one undoable command per release.
  const undo0 = (await call<{ undoDepth: number }>(page, 'getHistory')).undoDepth;
  await page.getByTestId('joint-j-wrist-0').focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => (await call<{ undoDepth: number }>(page, 'getHistory')).undoDepth)
    .toBe(undo0 + 1);

  // 5. Restore home.
  await page.getByTestId('joints-home').click();
  await expect.poll(async () => dist(await modelWorld(page, 'gripper'), grip0)).toBeLessThan(1e-9);

  // 6. Explode (view only) and restore exactly.
  const revBefore = (await call<{ revision: number }>(page, 'project')).revision;
  await page.getByTestId('explode').fill('1');
  await expect.poll(async () => dist(await rendered(page, 'gripper'), grip0)).toBeGreaterThan(0.01);
  expect(dist(await modelWorld(page, 'gripper'), grip0)).toBeLessThan(1e-9); // model untouched
  expect((await call<{ revision: number }>(page, 'project')).revision).toBe(revBefore);
  await page.getByTestId('explode').fill('0');
  await expect.poll(async () => dist(await rendered(page, 'gripper'), grip0)).toBeLessThan(1e-9);

  // Interference check runs and labels its results honestly.
  await page.getByTestId('interference-check').click();
  await expect(page.getByTestId('interference-results')).toContainText('contact');
  await expect(page.getByTestId('assembly-mass')).toContainText('Mass:');

  // 7. Save and reload: joints, limits and the solved pose survive.
  await setJoint(page, 'j-shoulder', '20');
  await expect
    .poll(async () => (await mate(page, 'j-shoulder')).coordinates[0]!)
    .toBeCloseTo((20 * Math.PI) / 180, 9);
  const gripSaved = await modelWorld(page, 'gripper');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await page.waitForFunction(
    () => (window as unknown as { __forge?: { ready?: boolean } }).__forge?.ready === true,
  );
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page
    .getByRole('menuitem', { name: /Robotic arm/ })
    .first()
    .click();
  await expect
    .poll(async () => (await nodes(page))['grp-arm']?.mechanical?.mates.length ?? 0)
    .toBeGreaterThan(4);
  expect((await mate(page, 'j-shoulder')).coordinates[0]).toBeCloseTo((20 * Math.PI) / 180, 12);
  expect(dist(await modelWorld(page, 'gripper'), gripSaved)).toBeLessThan(1e-9);
  await page.getByTestId('tree-row-grp-arm').click();
  await expect(page.getByTestId('assembly-dof')).toHaveText('4');
});

test('invalid mates are refused atomically and the editor recovers', async ({ page }) => {
  await openSample(page);
  await page.getByTestId('tree-row-grp-arm').click();
  const before = JSON.stringify(await nodes(page));
  await page.getByTestId('new-mate').locator('summary').click();
  // A fixed mate between the grounded base plate and the gripper contradicts the 4-joint
  // chain (6 equations, 4 DOF, unreachable pose): preview and confirm are both refused.
  await page.getByLabel('Mate body A').selectOption('base-plate');
  await page.getByLabel('Mate interface A').selectOption({ index: 1 });
  await page.getByLabel('Mate body B').selectOption('gripper');
  await page.getByLabel('Mate interface B').selectOption({ index: 1 });
  await page.getByLabel('Mate type').selectOption('fixed');
  await page.getByTestId('mate-preview').click();
  const msg = page.getByTestId('new-mate').locator('[role="alert"]');
  await expect(msg).toContainText('cannot all be satisfied');
  expect(JSON.stringify(await nodes(page))).toBe(before); // a preview never commits
  await page.getByTestId('mate-confirm').click();
  await expect(msg).toContainText('cannot all be satisfied');
  expect(JSON.stringify(await nodes(page))).toBe(before); // refused atomically
  // Recovery: joints still work afterwards.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await setJoint(page, 'j-yaw', '10');
  await expect
    .poll(async () => (await mate(page, 'j-yaw')).coordinates[0]!)
    .toBeCloseTo((10 * Math.PI) / 180, 9);

  // Mate-driven bodies cannot be moved directly.
  await page.getByTestId('tree-row-gripper').click();
  await expect(page.getByTestId('mate-driven-note')).toBeVisible();
  await expect(page.getByTestId('position-x')).toBeDisabled();
});
