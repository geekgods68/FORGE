import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Phase 4 acceptance workflow (brief §23, steps 1–18), in one browser session:
 * launch → Lab 20 → robotic-arm sample → component interfaces → edit a mate (preview,
 * confirm, alignment measured) → revolute joint → dependent motion → undo/redo →
 * assembly tree → explode/restore → measurement → save/reload → relationships persist →
 * export/import → identity and parameters survive.
 */
type V3 = [number, number, number];
type F = Record<string, (...a: never[]) => unknown>;
type Mate = {
  id: string;
  name: string;
  type: string;
  alignment: string;
  coordinates: number[];
  a: { nodeId: string; ref: { kind: string; interfaceId?: string } };
  b: { nodeId: string; ref: { kind: string; interfaceId?: string } };
};
type Node = {
  id: string;
  kind: string;
  name: string;
  childIds: string[];
  component?: { parameters: Record<string, unknown>; materialId: string | null };
  mechanical?: { grounded: string[]; mates: Mate[] };
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
const nodes = async (page: Page) =>
  (await call<{ scene: { nodes: Record<string, Node> } }>(page, 'project')).scene.nodes;
const arm = async (page: Page) => (await nodes(page))['grp-arm']!;
const mate = async (page: Page, id: string) => (await arm(page)).mechanical!.mates.find((m) => m.id === id);
const modelWorld = async (page: Page, id: string) =>
  (await call<{ position: V3 }>(page, 'getWorldTransform', id)).position;
const rendered = (page: Page, id: string) => call<V3 | null>(page, 'nodeWorldPosition', id);
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const ready = (page: Page) =>
  page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
/** Key-order-independent JSON (persistence writes keys in canonical order). */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;
/** Identity + configuration of every arm member and every relationship (for round-trip comparison). */
const armSignature = async (page: Page) => {
  const all = await nodes(page);
  const a = all['grp-arm'];
  if (!a?.mechanical) return null; // not loaded yet: let expect.poll retry
  return JSON.stringify(
    canonical({
      members: a.childIds.map((id) => [id, all[id]!.name, all[id]!.component ?? null]),
      grounded: a.mechanical!.grounded,
      mates: a.mechanical!.mates,
    }),
  );
};

test('Phase 4 acceptance workflow (18 steps) in Lab 20', async ({ page }) => {
  test.setTimeout(180_000);
  page.on('dialog', (d) => d.accept());
  // 1. Launch FORGE.
  await page.goto('/');
  await ready(page);
  // 2. Enter Lab 20 (facility view; the zone becomes active).
  await page.getByTestId('view-facility').click();
  await expect
    .poll(async () => (await call<Record<string, { state: string }>>(page, 'zoneStates'))[LAB20]?.state, {
      timeout: 30_000,
    })
    .toBe('active');
  // 3. Open the robotic-arm sample and mount it on a bench in Lab 20.
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-sample').click();
  await expect(page.getByTestId('status')).toContainText('robotic-arm sample');
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('item-row-bench-c').click();
  await page.getByRole('button', { name: 'Mount here' }).click();
  await expect(page.getByTestId('mounted-bench')).toHaveText('Bench C');
  await page.getByTestId('layer-project').click();
  await expect.poll(() => rendered(page, 'gripper')).not.toBeNull();

  // 4–5. Select a mechanical component and inspect its mounting interfaces.
  await page.getByTestId('tree-row-wrist-servo').click();
  await page.getByTestId('component-interfaces-toggle').click();
  await expect(page.getByTestId('interface-output')).toBeVisible();
  await expect(page.getByTestId('mate-driven-note')).toBeVisible();

  // 6. Edit a mate: replace the wrist joint with a new revolute mate on the same interfaces.
  const wrist = (await mate(page, 'j-wrist'))!;
  expect(wrist.a.ref.interfaceId).toBe('output');
  await page.getByTestId('tree-row-grp-arm').click();
  await page.getByText(/^Mates & constraints/).click(); // collapsed when there are many
  await page.getByRole('button', { name: 'Delete Wrist roll joint' }).click();
  await expect.poll(async () => (await mate(page, 'j-wrist')) ?? null).toBeNull();
  await expect(page.getByTestId('assembly-dof')).not.toHaveText('4'); // the gripper is no longer placed by a joint
  await page.getByTestId('new-mate').locator('summary').click();
  await page.getByLabel('Mate body A').selectOption(wrist.a.nodeId);
  await page.getByLabel('Mate interface A').selectOption(wrist.a.ref.interfaceId!);
  await page.getByLabel('Mate body B').selectOption(wrist.b.nodeId);
  await page.getByLabel('Mate interface B').selectOption(wrist.b.ref.interfaceId!);
  await page.getByLabel('Mate type').selectOption('revolute');
  await page.getByLabel('Mate alignment').selectOption(wrist.alignment);
  await page.getByTestId('mate-preview').click();
  await expect(page.getByTestId('new-mate').locator('[role="status"]')).toContainText('Preview shown');
  await page.getByTestId('mate-confirm').click();
  await expect(page.getByTestId('new-mate').locator('[role="status"]')).toContainText('Mate created');
  await expect(page.getByTestId('assembly-dof')).toHaveText('4');
  const newWrist = (await arm(page)).mechanical!.mates.find(
    (m) => m.type === 'revolute' && m.b.nodeId === wrist.b.nodeId,
  )!;
  expect(newWrist.id).not.toBe('j-wrist');

  // 7. Confirm alignment: the two interface frames coincide (measured), axes opposed.
  await page.getByTestId('measure').locator('summary').click();
  await page.getByLabel('Measure body 1').selectOption(wrist.a.nodeId);
  await page.getByLabel('Measure interface 1').selectOption(wrist.a.ref.interfaceId!);
  await page.getByLabel('Measure body 2').selectOption(wrist.b.nodeId);
  await page.getByLabel('Measure interface 2').selectOption(wrist.b.ref.interfaceId!);
  await expect(page.getByTestId('measure-distance')).toContainText('0.000 mm');
  await expect(page.getByTestId('measure-angle')).toHaveText(
    wrist.alignment === 'opposed' ? '180.000°' : '0.000°',
  );

  // 8–9. Modify a revolute joint (shoulder); dependent components reposition, base does not.
  const plate0 = await modelWorld(page, 'base-plate');
  const grip0 = await modelWorld(page, 'gripper');
  const f = page.getByTestId('joint-j-shoulder-0-value');
  await f.fill('35');
  await f.press('Enter');
  await expect
    .poll(async () => (await mate(page, 'j-shoulder'))!.coordinates[0]!)
    .toBeCloseTo((35 * Math.PI) / 180, 9);
  const grip1 = await modelWorld(page, 'gripper');
  expect(dist(grip1, grip0)).toBeGreaterThan(0.01);
  expect(dist(await modelWorld(page, 'base-plate'), plate0)).toBeLessThan(1e-12);

  // 10. Undo and redo.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await mate(page, 'j-shoulder'))!.coordinates[0]!).toBeCloseTo(0, 12);
  expect(dist(await modelWorld(page, 'gripper'), grip0)).toBeLessThan(1e-9);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect
    .poll(async () => (await mate(page, 'j-shoulder'))!.coordinates[0]!)
    .toBeCloseTo((35 * Math.PI) / 180, 9);
  expect(dist(await modelWorld(page, 'gripper'), grip1)).toBeLessThan(1e-9);

  // 11. Inspect the assembly tree.
  await page.getByTestId('tree-row-grp-arm').click();
  await expect(page.getByTestId('assembly-members')).toContainText('Base plate');
  await expect(page.locator('[data-member="base-plate"]')).toHaveAttribute('data-state', 'grounded');
  await expect(page.getByTestId('assembly-relationships')).toBeVisible();

  // 12–13. Exploded view, then exact restore (view only: revision unchanged).
  const rev = (await call<{ revision: number }>(page, 'project')).revision;
  const shown0 = (await rendered(page, 'gripper'))!;
  await page.getByTestId('explode').fill('1.5');
  await expect.poll(async () => dist((await rendered(page, 'gripper'))!, shown0)).toBeGreaterThan(0.01);
  await page.getByTestId('explode').fill('0');
  await expect.poll(async () => dist((await rendered(page, 'gripper'))!, shown0)).toBeLessThan(1e-9);
  expect((await call<{ revision: number }>(page, 'project')).revision).toBe(rev);

  // 14. Perform a measurement (base plate hole ↔ gripper: a non-zero, finite distance).
  await page.getByLabel('Measure body 1').selectOption('base-plate');
  await page.getByLabel('Measure interface 1').selectOption('hole-1');
  await page.getByLabel('Measure body 2').selectOption('gripper');
  await page.getByLabel('Measure interface 2').selectOption('');
  const text = await page.getByTestId('measure-distance').textContent();
  const mm = Number(/([\d.]+) mm/.exec(text ?? '')?.[1]);
  expect(mm).toBeGreaterThan(10);

  // 15–16. Save and reload: all relationships persist (including the re-created wrist mate).
  const sig = await armSignature(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await ready(page);
  await page.getByTestId('view-project').click();
  await expect.poll(() => armSignature(page)).toBe(sig);
  expect((await mate(page, newWrist.id))!.type).toBe('revolute');

  // 17–18. Export and import: assembly identity and parameters survive.
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const file = readFileSync((await (await dl).path())!);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect.poll(async () => (await nodes(page))['grp-arm'] ?? null).toBeNull();
  await page
    .getByTestId('import-input')
    .setInputFiles({ name: 'arm.forge.json', mimeType: 'application/json', buffer: file });
  await expect.poll(() => armSignature(page)).toBe(sig);
  await page.getByTestId('tree-row-grp-arm').click();
  await expect(page.getByTestId('assembly-dof')).toHaveText('4');
});
