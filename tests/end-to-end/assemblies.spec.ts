import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 3 milestone D: the robotic-arm sample, assembly grouping (membership, rename,
 * move, duplicate), user-saved reusable assemblies, and metadata-only connection
 * inspection with compatibility highlighting.
 */
type V3 = [number, number, number];
type F = Record<string, (...a: never[]) => unknown>;
type Node = {
  id: string;
  kind: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  definitionId?: string;
  component?: unknown;
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

test('robotic-arm sample opens with library components, logical groups and no reference warnings', async ({
  page,
}) => {
  await openSample(page);
  const n = await nodes(page);
  const comps = Object.values(n).filter((x) => x.kind === 'component-instance');
  expect(comps).toHaveLength(29);
  expect(await call<unknown[]>(page, 'componentWarnings')).toEqual([]);
  await expect
    .poll(() => call<{ entries: number }>(page, 'componentCache').then((c) => c.entries))
    .toBeGreaterThan(15);
  // Membership inspection.
  await page.getByTestId('tree-row-grp-arm').click();
  await expect(page.getByTestId('group-members')).toContainText('3 × MG996R high-torque servo');
  await expect(page.getByTestId('group-members')).toContainText('1 × SG90 micro servo');
});

test('groups: rename, move (members follow), duplicate; save as reusable assembly and insert it', async ({
  page,
}) => {
  await openSample(page);
  await page.getByTestId('tree-row-grp-arm').click();
  const name = page.getByRole('textbox', { name: 'Name' });
  await name.fill('Arm v1');
  await name.press('Enter');
  await expect.poll(async () => (await nodes(page))['grp-arm']!.name).toBe('Arm v1');
  const before = await call<V3>(page, 'nodeWorldPosition', 'base-servo');
  const px = page.getByTestId('position-x');
  await px.fill('50');
  await px.press('Enter');
  await expect
    .poll(async () => (await call<V3>(page, 'nodeWorldPosition', 'base-servo'))[0])
    .toBeCloseTo(before[0] + 0.05, 9);
  // Save the controller group as a reusable assembly, then insert it (one undoable batch).
  await page.getByTestId('tree-row-grp-controller').click();
  await page.getByTestId('save-assembly').click();
  await expect(page.getByTestId('status')).toContainText('reusable assembly (7 members)');
  const count0 = Object.keys(await nodes(page)).length;
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('assembly-insert-Controller & electronics').click();
  await expect.poll(async () => Object.keys(await nodes(page)).length).toBe(count0 + 8);
  await page.getByTestId('library-toggle').click();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => Object.keys(await nodes(page)).length).toBe(count0);
  // Duplicate the group: same members and configuration, new ids.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.getByTestId('tree-row-grp-arm').click();
  await page.keyboard.press('ControlOrMeta+d');
  await expect
    .poll(async () => Object.values(await nodes(page)).filter((x) => x.name === 'Arm v1 copy').length)
    .toBe(1);
  const all = await nodes(page);
  const copy = Object.values(all).find((x) => x.name === 'Arm v1 copy')!;
  expect(copy.childIds).toHaveLength(all['grp-arm']!.childIds.length);
  expect(copy.childIds.map((id) => all[id]!.component)).toEqual(
    all['grp-arm']!.childIds.map((id) => all[id]!.component),
  );
  // Mates are copied with the members (new ids, ends remapped to the copies).
  const mates = (n: Node) =>
    (n as Node & { mechanical: { mates: { a: { nodeId: string } }[] } }).mechanical.mates;
  expect(mates(copy)).toHaveLength(mates(all['grp-arm']!).length);
  expect(mates(copy).every((m) => copy.childIds.includes(m.a.nodeId))).toBe(true);

  // Saved assemblies are local user data: they survive a reload.
  await page.reload();
  await page.waitForFunction(
    () => (window as unknown as { __forge?: { ready?: boolean } }).__forge?.ready === true,
  );
  await page.getByTestId('library-toggle').click();
  await expect(page.getByTestId('assembly-insert-Controller & electronics')).toBeVisible();
});

test('connection inspection: an Arduino 5 V pin lists compatible jumper/breadboard interfaces and highlights them', async ({
  page,
}) => {
  await openSample(page);
  await page.getByTestId('tree-row-arduino').click();
  await page.getByTestId('component-interfaces-toggle').click();
  await page.getByTestId('interface-header3-5v-3').click();
  const list = page.getByTestId('compatible-list');
  await expect(list).toContainText('compatible interface');
  await expect(list).toContainText('Jumper');
  await expect(list).toContainText('not a validated mate');
  await expect.poll(() => call<number>(page, 'connectionMarkers')).toBeGreaterThan(1);
  // An optical port has no counterpart in this project — nothing is invented.
  await page.getByTestId('tree-row-range-sensor').click();
  await page.getByTestId('component-interfaces-toggle').click();
  await page.getByTestId('interface-tx').click();
  await expect(page.getByTestId('compatible-list')).toContainText('0 compatible interfaces');
});
