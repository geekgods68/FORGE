import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 6 browser acceptance workflow (brief §23).
 *  A — steps 1–12 from scratch in the Electronics & PCB lab (no physics setup: the runtime
 *      runs, and the sensor honestly reports no echo because there is no world to sense).
 *  B — steps 12–22 on the saved Arduino ultrasonic servo sample (physics + electronics).
 *  C — the four-joint arm's electronic control path.
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
const ready = (page: Page) =>
  page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
type Circuit = {
  parts: { id: string; label: string; type: string; nodeId: string | null }[];
  wires: number;
  nets: { name: string; pins: string[] }[];
  issues: string[];
  firmware: { id: string; revision: number }[];
};
const circuit = (page: Page) => call<Circuit | null>(page, 'circuit');
type Dev = {
  label: string;
  type: string;
  status: string;
  lastMeasurement: { geometricM: number | null; reportedM: number | null; echoUs: number } | null;
  geometricNow: number | null;
  targetRad: number | null;
  angleDeg: number | null;
  pulseUs: number | null;
};
type Cosim = {
  state: string;
  active: boolean;
  time: number;
  mcus: { label: string; state: string; serial: string; errors: string[] }[];
  devices: Dev[];
};
const cosim = (page: Page) => call<Cosim>(page, 'cosim');
const dev = async (page: Page, label: string) => (await cosim(page)).devices.find((d) => d.label === label)!;
const serial = async (page: Page) => (await cosim(page)).mcus[0]?.serial ?? '';
const lastReading = async (page: Page) => {
  const m = /distance_cm=([\d.]+) angle=(\d+)\r\n(?![\s\S]*distance_cm)/.exec(await serial(page));
  return m ? { cm: Number(m[1]), angle: Number(m[2]) } : null;
};
type Joint = { mateId: string; q: number };
const jointQ = async (page: Page, id: string) =>
  (await call<{ joints: Joint[] }>(page, 'sim')).joints.find((j) => j.mateId === id)!.q;
const deg = (r: number) => (r * 180) / Math.PI;
/** Engineering geometry: every node except the root (whose simulation/circuit setups are data, not geometry). */
const geometry = async (page: Page) => {
  const p = await call<{ scene: { rootId: string; nodes: Record<string, unknown> } }>(page, 'project');
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(
    canon(Object.fromEntries(Object.entries(p.scene.nodes).filter(([k]) => k !== p.scene.rootId))),
  );
};

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

test('Phase 6 A (steps 1–12): build the Arduino–HC-SR04–servo circuit in the Electronics & PCB lab', async ({
  page,
}) => {
  test.setTimeout(180_000);
  // 1–2. Launch FORGE; enter the electronics laboratory and mount the project on a bench there.
  await page.goto('/');
  await ready(page);
  await page.getByTestId('view-facility').click();
  await page.getByText('Zone directory').click();
  await page.getByTestId('dir-lab-15-electronics-pcb').getByRole('button').click();
  await expect
    .poll(
      async () =>
        (await call<Record<string, { state: string }>>(page, 'zoneStates'))['lab-15-electronics-pcb']?.state,
      { timeout: 30_000 },
    )
    .toBe('active');
  await page.getByRole('combobox', { name: 'Equipment type' }).selectOption('bench-standard');
  await page.getByRole('button', { name: 'Place' }).click();
  await page.getByRole('button', { name: 'Mount here' }).click();
  await page.getByTestId('layer-project').click();

  // 3–4. Open the component library and place an Arduino UNO on the bench.
  await conjureAtSurfaceCentre(page, 'arduino uno', 'arduino-uno-r3');
  const uno = Object.values(
    (await call<{ scene: { nodes: Record<string, { id: string; definitionId?: string }> } }>(page, 'project'))
      .scene.nodes,
  ).find((n) => n.definitionId === 'arduino-uno-r3')!;

  // Electronics mode: add the placed UNO to the circuit; 5–6. place the HC-SR04 and a servo.
  await page.getByTestId('mode-electronics').click();
  await page.getByTestId(`elec-link-${uno.id}`).click();
  for (const id of ['hc-sr04', 'towerpro-sg90']) {
    await page.getByTestId('elec-place-select').selectOption(id);
    await page.getByTestId('elec-place').click();
  }
  await expect
    .poll(async () => (await circuit(page))?.parts.map((p) => p.label))
    .toEqual(['U1', 'US1', 'SV1']);

  // 7–8. Open the schematic and wire the supported connections.
  await page.getByTestId('elec-schematic-toggle').click();
  await page.getByTestId('elec-tool-wire').click();
  for (const [a, b] of [
    ['U1-5V', 'US1-vcc'],
    ['U1-GND.1', 'US1-gnd'],
    ['U1-D7', 'US1-trig'],
    ['US1-echo', 'U1-D8'],
    ['U1-D9', 'SV1-signal'],
    ['U1-5V', 'SV1-vplus'],
    ['U1-GND.2', 'SV1-gnd'],
  ]) {
    await page.getByTestId(`sch-pin-${a}`).click();
    await page.getByTestId(`sch-pin-${b}`).click();
  }
  // 9. Verify net connectivity (explicit wiring; GND pins of the UNO share one net).
  await expect.poll(async () => (await circuit(page))?.wires).toBe(7);
  const nets = (await circuit(page))!.nets;
  const netOf = (pin: string) => nets.find((n) => n.pins.includes(pin))!.pins.sort();
  expect(netOf('US1.trig')).toEqual(['U1.D7', 'US1.trig']);
  expect(netOf('US1.echo')).toEqual(['U1.D8', 'US1.echo']);
  expect(netOf('SV1.signal')).toEqual(['SV1.signal', 'U1.D9']);
  expect(netOf('US1.gnd')).toEqual(expect.arrayContaining(['SV1.gnd', 'U1.GND.1', 'U1.GND.2', 'US1.gnd']));
  await page.getByTestId('schematic-close').click();
  await page.getByTestId('elec-tool-select').click();
  // The servo on the UNO's 5 V rail is reported (current unknown), not silently accepted.
  expect((await circuit(page))!.issues).toContain('controller-rail-load');

  // 10–11. Open the code editor, load the ultrasonic template, check it and assign it to U1.
  await page.getByTestId('elec-tab-code').click();
  await page.getByTestId('elec-fw-new').selectOption('ultrasonic');
  await expect(page.getByTestId('elec-fw-source')).toHaveValue(/pulseIn\(ECHO_PIN, HIGH, 30000\)/);
  await page.getByTestId('elec-fw-check').click();
  await expect(page.getByTestId('elec-fw-result')).toContainText('Check passed');
  await page.getByTestId('elec-fw-assign-U1').selectOption({ label: 'Ultrasonic servo gauge' });
  await expect(page.getByTestId('elec-pin-map')).toContainText('US1.trig');

  // 12. Start: the firmware runs and drives the servo; without a physics world the sensor
  // has nothing to observe, so the firmware truthfully prints "no echo".
  await page.getByTestId('mode-simulation').click();
  await expect(page.getByTestId('cosim-panel')).toBeVisible();
  await page.getByTestId('cosim-start').click();
  await expect.poll(() => serial(page), { timeout: 15_000 }).toContain('no echo');
  await expect.poll(async () => (await dev(page, 'SV1')).pulseUs, { timeout: 10_000 }).not.toBeNull();
  expect((await cosim(page)).mcus[0]!.state).toBe('running');
});

test('Phase 6 B (steps 12–22): ultrasonic servo gauge — geometry → echo → firmware → servo → joint motion', async ({
  page,
}) => {
  test.setTimeout(240_000);
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-ultrasonic').click();
  await expect(page.getByTestId('status')).toContainText('ultrasonic servo gauge');
  await page.getByTestId('library-toggle').click();
  const geometryBefore = await geometry(page);

  // Inspect the circuit, wiring and firmware.
  await page.getByTestId('mode-electronics').click();
  await expect(page.getByTestId('elec-part-US1')).toBeVisible();
  await page.getByTestId('elec-schematic-toggle').click();
  await expect(page.getByTestId('sch-part-US1')).toBeVisible();
  await page.getByTestId('schematic-close').click();
  await page.getByTestId('elec-tab-code').click();
  await expect(page.getByTestId('elec-fw-source')).toHaveValue(/pulseIn/);

  // 12. Start the co-simulation (physics + electronics on one clock).
  await page.getByTestId('mode-simulation').click();
  await expect(page.getByTestId('sim-state')).toHaveText('ready');
  await expect(page.getByTestId('cosim-state')).toHaveText('ready');
  await page.getByTestId('sim-start').click();
  await expect(page.getByTestId('cosim-state')).toHaveText('running');

  // 14. The distance printed by the firmware matches the simulated geometry.
  await expect.poll(async () => (await lastReading(page))?.cm ?? 0, { timeout: 20_000 }).toBeGreaterThan(10);
  const g1 = (await dev(page, 'US1')).geometricNow!;
  const fromGeometry = (g: number) => (((2 * g) / (331.3 + 0.606 * 20)) * 1e6 * 0.0343) / 2;
  await expect
    .poll(async () => Math.abs((await lastReading(page))!.cm - fromGeometry(g1)), { timeout: 10_000 })
    .toBeLessThan(0.05);
  // 15–16. Controller output and servo response: pulse → target → the physical joint follows.
  const r1 = (await lastReading(page))!;
  await expect
    .poll(async () => Math.abs(deg(await jointQ(page, 'j-gauge')) - (r1.angle - 90)), { timeout: 15_000 })
    .toBeLessThan(2);

  // 13. Move the target 12 cm further away: new geometry → new echo → new angle → new pose.
  await page.getByTestId('cosim-target-z').fill('0.37');
  await page.getByTestId('cosim-target-z').press('Enter');
  await expect
    .poll(async () => (await lastReading(page))!.cm - r1.cm, { timeout: 15_000 })
    .toBeGreaterThan(11.5);
  const r2 = (await lastReading(page))!;
  expect(r2.angle).toBeGreaterThan(r1.angle + 40);
  await expect
    .poll(async () => Math.abs(deg(await jointQ(page, 'j-gauge')) - (r2.angle - 90)), { timeout: 15_000 })
    .toBeLessThan(2);

  // 17. Logic analyser: the ECHO pulse width measured from recorded transitions.
  await page.getByTestId('inst-tab-logic').click();
  await expect(page.getByTestId('inst-logic')).toBeVisible();
  await expect(page.getByTestId('inst-logic-stats')).toContainText('high pulse');

  // 19. Pause: time stops for physics and electronics together.
  await page.getByTestId('sim-pause').click();
  await expect(page.getByTestId('cosim-state')).toHaveText('paused');
  const tp = (await cosim(page)).time;
  await page.waitForTimeout(300);
  expect((await cosim(page)).time).toBe(tp);

  // 18. Export signal + motion telemetry on the shared timeline.
  await page.getByTestId('inst-tab-telemetry').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('cosim-export-csv').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.electrical\.csv$/);
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv).toContain('# FORGE electrical telemetry');
  expect(csv).toContain('SV1.q [rad] (measured)');
  expect(csv).toContain('US1.reported [m] (measured)');
  expect(csv).toMatch(/firmware Ultrasonic servo gauge rev 1/);
  expect(csv.split('\n').filter((l) => l && !l.startsWith('#')).length).toBeGreaterThan(50);

  // Modify the control logic (reverse the mapping), save it, and run again.
  await page.getByTestId('mode-electronics').click();
  await page.getByTestId('elec-tab-code').click();
  const src = await page.getByTestId('elec-fw-source').inputValue();
  await page
    .getByTestId('elec-fw-source')
    .fill(
      src.replace('int angle = (int)((clamped - NEAR_CM)', 'int angle = 180 - (int)((clamped - NEAR_CM)'),
    );
  await page.getByTestId('elec-fw-save').click();
  await expect.poll(async () => (await circuit(page))!.firmware[0]!.revision).toBe(2);
  await page.getByTestId('mode-simulation').click();
  await page.getByTestId('sim-start').click();
  await expect
    .poll(async () => (await lastReading(page))?.angle ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(90);
  // The reversed mapping drives the joint to the other side.
  await expect.poll(async () => deg(await jointQ(page, 'j-gauge')), { timeout: 15_000 }).toBeGreaterThan(0);

  // 19. Reset: time 0 for both.
  await page.getByTestId('sim-reset').click();
  await expect(page.getByTestId('cosim-time')).toHaveText('0.000');

  // 20–22. Save and reload: circuit and firmware persist; the engineering geometry is intact.
  await page.getByTestId('mode-cad').click();
  expect(await geometry(page)).toBe(geometryBefore);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await ready(page);
  await expect.poll(() => geometry(page)).toBe(geometryBefore);
  const c = (await circuit(page))!;
  expect(c.parts.map((p) => p.label)).toEqual(['U1', 'US1', 'SV1']);
  expect(c.wires).toBe(7);
  expect(c.firmware[0]!.revision).toBe(2);
});

test('Phase 6: the four-joint arm accepts controller commands through its servo electronics', async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-arm-electronics').click();
  await expect(page.getByTestId('status')).toContainText('robotic arm with electronics');
  await page.getByTestId('library-toggle').click();
  // Separate servo supply with a shared ground: no rail-load or ground findings.
  const issues = (await circuit(page))!.issues;
  expect(issues).not.toContain('controller-rail-load');
  expect(issues).not.toContain('incomplete-ground');

  await page.getByTestId('mode-simulation').click();
  await expect(page.getByTestId('sim-state')).toHaveText('ready');
  await page.getByTestId('sim-start').click();
  await expect.poll(() => serial(page), { timeout: 20_000 }).toContain('pose=');
  // Programmatic command over the serial monitor: shoulder to 60° (= CAD pose − 30°).
  await page.getByTestId('serial-in-U1').fill('S 60');
  await page.getByTestId('serial-send-U1').click();
  await expect.poll(() => serial(page), { timeout: 10_000 }).toContain('joint 1 -> 60');
  await expect.poll(async () => (await dev(page, 'SV2')).angleDeg ?? 0, { timeout: 10_000 }).toBeLessThan(61);
  const shoulder = await jointQ(page, 'j-shoulder');
  void shoulder;
  await expect.poll(async () => deg(await jointQ(page, 'j-shoulder')), { timeout: 15_000 }).toBeLessThan(-25);
  // Every servo receives pulses from the firmware.
  for (const sv of ['SV1', 'SV2', 'SV3', 'SV4']) expect((await dev(page, sv)).pulseUs).not.toBeNull();
});
