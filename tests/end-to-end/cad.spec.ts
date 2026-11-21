import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4 milestone D: feature parts (holes, patterns, edits, rejected geometry with the
 * previous state kept) and constrained sketches extruded into parts.
 */
type F = Record<string, (...a: never[]) => unknown>;
type Node = { id: string; kind: string; features?: { type: string; diameter?: number }[] };
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
const selected = async (page: Page) => (await nodes(page))[(await call<string[]>(page, 'getSelection'))[0]!]!;

async function boot(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    () => (window as unknown as { __forge?: { ready?: boolean } }).__forge?.ready === true,
  );
}

test('part: hole, pattern and edit regenerate; invalid geometry is refused and the part is kept', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('create-part').click();
  await expect(page.getByTestId('part-inspector')).toBeVisible();
  const part = await selected(page);
  expect(part.kind).toBe('part');
  // 100 × 60 × 5 mm plate.
  await expect(page.getByTestId('part-volume')).toContainText('30.00 cm³');

  // Through hole Ø5 at (−30, 0) mm.
  await page.getByTestId('add-hole').locator('summary').click();
  await page.getByTestId('hole-u').fill('-30');
  await page.getByTestId('hole-d').fill('5');
  await page.getByTestId('hole-create').click();
  await expect
    .poll(async () => (await selected(page)).features!.map((f) => f.type))
    .toEqual(['extrude', 'hole']);
  const holeVol = Math.PI * 2.5 ** 2 * 5; // mm³
  await expect(page.getByTestId('part-volume')).toContainText(`${((30000 - holeVol) / 1000).toFixed(2)} cm³`);

  // Rectangular pattern 3 × 1 @ 30 mm.
  await page.getByTestId('add-pattern').locator('summary').click();
  await page.getByLabel('Pattern target').selectOption({ index: 1 });
  await page.getByTestId('pattern-nu').fill('3');
  await page.getByTestId('pattern-su').fill('30');
  await page.getByTestId('pattern-create').click();
  await expect.poll(async () => (await selected(page)).features!.length).toBe(3);
  await expect(page.getByTestId('part-volume')).toContainText(
    `${((30000 - 3 * holeVol) / 1000).toFixed(2)} cm³`,
  );

  // A hole outside the plate is refused; the part is unchanged.
  const before = JSON.stringify(await selected(page));
  await page.getByTestId('hole-u').fill('80');
  await page.getByTestId('hole-create').click();
  await expect(page.getByTestId('cad-error')).toContainText('Nothing was changed');
  expect(JSON.stringify(await selected(page))).toBe(before);

  // Parametric edit of the hole diameter (patterned copies follow): Ø5 → Ø6.
  const holeId = (await selected(page)).features!.find((f) => f.type === 'hole') as unknown as { id: string };
  const dia = page.getByTestId(`hole-diameter-${holeId.id}`);
  await dia.fill('6');
  await dia.press('Enter');
  await expect
    .poll(async () => (await selected(page)).features!.find((f) => f.type === 'hole')!.diameter)
    .toBeCloseTo(0.006, 12);
  await expect(page.getByTestId('part-volume')).toContainText(
    `${((30000 - 3 * Math.PI * 9 * 5) / 1000).toFixed(2)} cm³`,
  );
  // Undo restores the previous diameter.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(async () => (await nodes(page))[part.id]!.features!.find((f) => f.type === 'hole')!.diameter)
    .toBeCloseTo(0.005, 12);
});

test('sketch: constraints change DOF, conflicts are refused, and the profile extrudes to a part', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('create-sketch').click();
  await expect(page.getByTestId('sketch-inspector')).toBeVisible();
  // Rectangle with horizontal/vertical constraints: 4 points (8 vars) − 4 = 4 DOF.
  await expect(page.getByTestId('sketch-dof')).toHaveText('4');
  const add = page.getByTestId('sketch-add-constraint');
  await add.locator('summary').click();
  await page.getByLabel('Constraint type').selectOption('distance');
  await page.getByLabel('Constraint entity 1').selectOption('r-l0');
  await page.getByTestId('sketch-constraint-value').fill('120');
  await page.getByTestId('sketch-constraint-add').click();
  await expect(page.getByTestId('sketch-dof')).toHaveText('3');
  // A second, contradictory length on the same line is refused.
  await page.getByTestId('sketch-constraint-value').fill('80');
  await page.getByTestId('sketch-constraint-add').click();
  await expect(page.getByTestId('cad-error')).toBeVisible();
  await expect(page.getByTestId('sketch-dof')).toHaveText('3');

  await page.getByTestId('sketch-extrude-depth').fill('8');
  await page.getByTestId('sketch-extrude').click();
  await expect(page.getByTestId('part-inspector')).toBeVisible();
  // 120 × 60 × 8 mm.
  await expect(page.getByTestId('part-volume')).toContainText('57.60 cm³');
});
