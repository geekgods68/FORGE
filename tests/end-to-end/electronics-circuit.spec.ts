import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 6 Milestone A: circuits as first-class engineering data. Place catalogue parts in 3D
 * (+ circuit) and an ideal element, wire them in the schematic AND in 3D, check that the
 * one netlist reflects both, that moving symbols never changes connectivity, and that every
 * edit is undoable.
 */
type F = Record<string, (...a: never[]) => unknown>;
const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      ((window as unknown as { __forge: F }).__forge[n as string] as (...x: unknown[]) => unknown)(
        ...(a as unknown[]),
      ),
    [name, args] as const,
  ) as Promise<T>;
type Circuit = {
  parts: { id: string; label: string; type: string; nodeId: string | null }[];
  wires: number;
  nets: { name: string; pins: string[] }[];
  issues: string[];
};
const circuit = (page: Page) => call<Circuit | null>(page, 'circuit');
const netWith = async (page: Page, pin: string) =>
  (await circuit(page))!.nets.find((n) => n.pins.includes(pin));
const ready = (page: Page) =>
  page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );

async function place(page: Page, definitionId: string) {
  await page.getByTestId('elec-place-select').selectOption(definitionId);
  await page.getByTestId('elec-place').click();
}

test('Phase 6 A: build a circuit in the schematic and in 3D — one explicit netlist, undoable', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await ready(page);
  await page.getByTestId('mode-electronics').click();
  await expect(page.getByTestId('electronics-panel')).toBeVisible();

  // Place catalogue parts (3D + circuit, atomic) and an ideal resistor (schematic only).
  await place(page, 'arduino-uno-r3');
  await place(page, 'led-5mm');
  await page.getByTestId('elec-prim-select').selectOption('resistor');
  await page.getByTestId('elec-prim-add').click();
  await expect
    .poll(async () => (await circuit(page))?.parts.map((p) => p.label))
    .toEqual(['U1', 'LED1', 'R1']);
  const parts = (await circuit(page))!.parts;
  expect(parts.find((p) => p.label === 'U1')!.nodeId).not.toBeNull();
  expect(parts.find((p) => p.label === 'R1')!.nodeId).toBeNull();
  const id = (label: string) => parts.find((p) => p.label === label)!.id;

  // Pins carry their metadata (role and cited limits) in the inspector.
  await page.getByTestId('elec-part-U1').click();
  await expect(page.getByTestId('elec-pins')).toContainText('D13');
  await expect(page.getByTestId('elec-pins')).toContainText('≤ 20 mA');

  // Wire in the schematic: D13 → R1 → LED1 anode.
  await page.getByTestId('elec-schematic-toggle').click();
  await expect(page.getByTestId('schematic')).toBeVisible();
  await page.getByTestId('elec-tool-wire').click();
  await page.getByTestId('sch-pin-U1-D13').click();
  await page.getByTestId('sch-pin-R1-p1').click();
  await page.getByTestId('sch-pin-R1-p2').click();
  await page.getByTestId('sch-pin-LED1-a').click();
  await expect.poll(async () => (await circuit(page))?.wires).toBe(2);
  expect((await netWith(page, 'U1.D13'))!.pins.sort()).toEqual(['R1.p1', 'U1.D13']);

  // Wire in 3D: click the LED cathode pin marker, then a UNO GND pin marker.
  await page.getByTestId('schematic-close').click();
  const clickPin3d = async (key: string) => {
    await expect.poll(() => call<number[] | null>(page, 'pin3d', key)).not.toBeNull();
    const w = await call<[number, number, number]>(page, 'pin3d', key);
    const s = await call<{ x: number; y: number }>(page, 'worldToScreen', w);
    await page.mouse.click(s.x, s.y);
  };
  // Pins are millimetre-sized: frame each component first (F), as a user would.
  const frame = async (label: string) => {
    await page
      .getByText(new RegExp(`^${label} `))
      .first()
      .click();
    await page.keyboard.press('f');
    await page.waitForTimeout(600);
  };
  await frame('LED1');
  await clickPin3d(`${id('LED1')}.k`);
  await frame('U1');
  await clickPin3d(`${id('U1')}.GND.3`);
  await expect.poll(async () => (await circuit(page))?.wires).toBe(3);
  // The UNO's GND pins are one internal net: the cathode is on GND whichever pin was used.
  expect((await netWith(page, 'LED1.k'))!.pins).toEqual(
    expect.arrayContaining(['U1.GND.1', 'U1.GND.2', 'U1.GND.3']),
  );

  // Moving a symbol never changes connectivity.
  const netsBefore = JSON.stringify((await circuit(page))!.nets);
  await page.getByTestId('elec-schematic-toggle').click();
  await page.getByTestId('elec-tool-select').click();
  const r1 = page.getByTestId('sch-part-R1');
  const box = (await r1.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const p = await call<{
        scene: {
          rootId: string;
          nodes: Record<string, { electrical?: { parts: { label: string; schematic: { x: number } }[] } }>;
        };
      }>(page, 'project');
      return p.scene.nodes[p.scene.rootId]!.electrical!.parts.find((x) => x.label === 'R1')!.schematic.x;
    })
    .not.toBe(40);
  expect(JSON.stringify((await circuit(page))!.nets)).toBe(netsBefore);

  // Undo the move and the last wire; redo the wire.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await circuit(page))?.wires).toBe(2);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await circuit(page))?.wires).toBe(3);

  // Checks: the LED has a series resistor, so no missing-current-limit rule fires.
  await page.getByTestId('elec-tab-checks').click();
  expect((await circuit(page))!.issues).not.toContain('missing-current-limit');
  await expect(page.getByTestId('electronics-panel')).toContainText('does not show that a circuit is safe');
});
