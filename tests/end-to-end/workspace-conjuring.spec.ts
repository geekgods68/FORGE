import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 3 workspace integration: the active workbench is detected from the mount;
 * moving the project to another bench (even in another lab) relocates it WITHOUT
 * rewriting component-local coordinates; conjuring works on benches outside Lab 20.
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
type N = {
  id: string;
  kind: string;
  definitionId?: string;
  transform: { position: V3 };
  component?: unknown;
};
const comps = async (page: Page) =>
  Object.values((await call<{ scene: { nodes: Record<string, N> } }>(page, 'project')).scene.nodes).filter(
    (n) => n.kind === 'component-instance' && n.component,
  );

async function conjureAtSurfaceCentre(page: Page, query: string, id: string) {
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-search').fill(query);
  await page.getByTestId(`library-item-${id}`).click();
  await page.getByTestId('library-conjure').click();
  const g = await call<{ surfaceCentre: V3; surface: string }>(page, 'ghost');
  expect(g.surface).toBe('bench');
  const pt = await call<{ x: number; y: number }>(page, 'worldToScreen', g.surfaceCentre);
  await page.mouse.move(pt.x + 4, pt.y + 4);
  await page.mouse.move(pt.x, pt.y);
  await expect.poll(() => call<{ valid: boolean }>(page, 'ghost')).toMatchObject({ valid: true });
  await page.mouse.click(pt.x, pt.y);
  await page.getByTestId('library-toggle').click();
}

test('switching workbenches relocates the project without rewriting component-local coordinates; conjuring works in Lab 1', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
  await page.getByTestId('view-facility').click();
  await expect
    .poll(
      async () =>
        (await call<Record<string, { state: string }>>(page, 'zoneStates'))[
          'lab-20-central-conjuring-workshop'
        ]?.state,
    )
    .toBe('active');
  await page.getByTestId('item-row-bench-c').click();
  await page.getByRole('button', { name: 'Mount here' }).click();
  await page.getByTestId('layer-project').click();
  await conjureAtSurfaceCentre(page, 'sg90', 'towerpro-sg90');
  await expect.poll(async () => (await comps(page)).length).toBe(1);
  const [servo] = await comps(page);
  const local = servo!.transform.position;
  const worldC = await call<V3>(page, 'nodeWorldPosition', servo!.id);

  // Move the project to Bench D (zone x +10 m from Bench C): local unchanged, world shifts.
  await page.getByTestId('item-row-bench-d').click();
  await page.getByRole('button', { name: 'Mount here' }).click();
  await expect(page.getByTestId('mounted-bench')).toHaveText('Bench D');
  expect((await comps(page))[0]!.transform.position).toEqual(local);
  await expect
    .poll(async () => (await call<V3>(page, 'nodeWorldPosition', servo!.id))[0])
    .toBeCloseTo(worldC[0] + 10, 9);

  // Another lab: place a bench in Lab 1, mount there, conjure on it.
  await page.getByText('Zone directory').click();
  await page.getByTestId('dir-lab-01-central-intelligence').getByRole('button').click();
  await expect
    .poll(
      async () =>
        (await call<Record<string, { state: string }>>(page, 'zoneStates'))['lab-01-central-intelligence']
          ?.state,
    )
    .toBe('active');
  await page.getByRole('combobox', { name: 'Equipment type' }).selectOption('bench-standard');
  await page.getByRole('button', { name: 'Place' }).click();
  await expect
    .poll(
      async () =>
        Object.values(
          (await call<{ items: Record<string, { zoneId: string }> }>(page, 'layout')).items,
        ).filter((i) => i.zoneId === 'lab-01-central-intelligence').length,
    )
    .toBe(1);
  await page.getByRole('button', { name: 'Mount here' }).click();
  await page.getByTestId('layer-project').click();
  await conjureAtSurfaceCentre(page, 'hc-sr04', 'hc-sr04');
  await expect.poll(async () => (await comps(page)).length).toBe(2);
  expect((await comps(page)).find((n) => n.id === servo!.id)!.transform.position).toEqual(local);
  // Facility geometry remains protected: no command addresses it; the project file has no facility data.
  const doc = JSON.stringify(await call<unknown>(page, 'project'));
  expect(doc).not.toMatch(/lab-01|bench-|zoneId|mountedProjectId/);
});
