import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 5 browser workflow (brief §18): open Forge → robotic-arm sample → Simulation mode →
 * configure gravity → start → control a joint → time-dependent motion → telemetry → change
 * the payload → response → pause → reset → CAD unchanged → export telemetry → reload.
 */
type F = Record<string, (...a: never[]) => unknown>;
type Joint = {
  mateId: string;
  q: number;
  qd: number;
  actuator: { applied: number; saturated: boolean; target: number } | null;
};
type Sim = { phase: string; time: number; joints: Joint[]; events: { kind: string; message: string }[] };
type Node = {
  id: string;
  kind: string;
  childIds: string[];
  transform: unknown;
  simulation?: { gravity: number[]; payloads: { massKg: number }[] };
};
const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      ((window as unknown as { __forge: F }).__forge[n as string] as (...x: unknown[]) => unknown)(
        ...(a as unknown[]),
      ),
    [name, args] as const,
  ) as Promise<T>;
const sim = (page: Page) => call<Sim>(page, 'sim');
const shoulder = async (page: Page) => (await sim(page)).joints.find((j) => j.mateId === 'j-shoulder')!;
const nodes = async (page: Page) =>
  (await call<{ scene: { rootId: string; nodes: Record<string, Node> } }>(page, 'project')).scene;
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
/** CAD state: every node except the root's simulation setup (key-order-independent JSON). */
const cad = async (page: Page) => {
  const s = await nodes(page);
  const n = { ...s.nodes, [s.rootId]: { ...s.nodes[s.rootId]!, simulation: undefined } };
  return JSON.stringify(canon(n));
};
const ready = (page: Page) =>
  page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
const deg = (r: number) => (r * 180) / Math.PI;
async function selectRow(page: Page, id: string) {
  const row = page.getByTestId(`tree-row-${id}`);
  // The tree is virtualized: scroll explicitly (top, then bottom) until the row is rendered.
  for (const top of [0, 1e6]) {
    await page.getByTestId('hierarchy-scroll').evaluate((el, t) => ((el as HTMLElement).scrollTop = t), top);
    await page.waitForTimeout(50);
    if ((await row.count()) > 0) break;
  }
  await row.click();
}

test('Phase 5: robotic-arm dynamics in Simulation mode', async ({ page }) => {
  test.setTimeout(180_000);
  page.on('dialog', (d) => d.accept());
  // 1–2. Open Forge and the robotic-arm sample.
  await page.goto('/');
  await ready(page);
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-sample').click();
  await expect(page.getByTestId('status')).toContainText('robotic-arm sample');
  await page.getByTestId('library-toggle').click();
  const cadBefore = await cad(page);
  const revisionBefore = (await call<{ revision: number }>(page, 'project')).revision;

  // 3. Enter Simulation mode: the physics engine loads and the arm is bridged.
  await page.getByTestId('mode-simulation').click();
  await expect(page.getByTestId('simulation-panel')).toBeVisible();
  await expect(page.getByTestId('sim-state')).toHaveText('ready');
  await expect(page.getByTestId('sim-joints')).toContainText('Shoulder joint');
  await expect(page.getByTestId('sim-validity')).toContainText('approximate');

  // Inspect mass and joint properties (select the gripper body).
  await selectRow(page, 'gripper');
  await expect(page.getByTestId('sim-body-mass')).toContainText('0.0300 kg');
  await expect(page.getByTestId('sim-body')).toContainText('not measured'); // labelled generic value

  // 4. Configure gravity (undoable setup change).
  await page.getByTestId('sim-gravity-y').fill('-9.81');
  await page.getByTestId('sim-gravity-y').press('Enter');
  await expect
    .poll(async () => (await nodes(page)).nodes[(await nodes(page)).rootId]!.simulation!.gravity[1])
    .toBe(-9.81);

  // 5. Start: simulated time advances.
  await page.getByTestId('sim-start').click();
  await expect(page.getByTestId('sim-state')).toHaveText('running');
  await expect.poll(async () => (await sim(page)).time, { timeout: 10_000 }).toBeGreaterThan(0.2);

  // 6–7. Command the shoulder to 30°: the joint moves over time (not instantly) and settles.
  await page.getByTestId('sim-joint-target-j-shoulder').fill('30');
  await page.getByTestId('sim-joint-target-j-shoulder').press('Enter');
  await expect.poll(async () => deg((await shoulder(page)).q), { timeout: 15_000 }).toBeGreaterThan(29.5);
  // Time-dependent, speed-limited motion (from the recorded telemetry): intermediate angles
  // were passed through, and 0 → 29° took at least 29°/(no-load speed) of simulated time.
  const rise = await call<{ t: number[]; v: number[] }>(page, 'simSeries', 'j-shoulder.q');
  const start = rise.t[rise.v.findIndex((v) => deg(v) > 0.5)]!;
  const end = rise.t[rise.v.findIndex((v) => deg(v) > 29)]!;
  expect(rise.v.some((v) => deg(v) > 5 && deg(v) < 25)).toBe(true);
  expect(end - start).toBeGreaterThanOrEqual((29 * Math.PI) / 180 / 6.16 - 1 / 60);
  // The rendered gripper follows the simulated pose (display only).
  expect(await call<number[] | null>(page, 'simUnitPosition', 'gripper')).not.toBeNull();

  // 8. Telemetry: the shoulder channel records the motion.
  await page.getByTestId('sim-channel').selectOption('j-shoulder.q');
  await expect(page.getByTestId('sim-plot')).toBeVisible();
  const series = await call<{ t: number[]; v: number[] }>(page, 'simSeries', 'j-shoulder.q');
  expect(series.t.length).toBeGreaterThan(20);
  expect(deg(Math.max(...series.v))).toBeGreaterThan(29);
  expect(deg(series.v[0]!)).toBeLessThan(1);

  // 9–10. Change the payload: the shoulder needs more effort to hold the same angle.
  await expect.poll(async () => Math.abs((await shoulder(page)).actuator!.applied) > 0).toBe(true);
  await page.waitForTimeout(500);
  const effortBefore = Math.abs((await shoulder(page)).actuator!.applied);
  await page.getByTestId('sim-payload-mass-payload-ee').fill('0.2');
  await page.getByTestId('sim-payload-mass-payload-ee').press('Enter');
  await expect
    .poll(async () => Math.abs((await shoulder(page)).actuator!.applied), { timeout: 10_000 })
    .toBeGreaterThan(effortBefore + 0.1);

  // 12. Encounter a modelled effort limit: 1 kg and 60° exceed the cited stall torque.
  await page.getByTestId('sim-payload-mass-payload-ee').fill('1');
  await page.getByTestId('sim-payload-mass-payload-ee').press('Enter');
  await page.getByTestId('sim-joint-target-j-shoulder').fill('60');
  await page.getByTestId('sim-joint-target-j-shoulder').press('Enter');
  await expect(page.getByTestId('sim-joint-sat-j-shoulder')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('sim-events')).toContainText('effort saturated');

  // 11. Pause: time stops.
  await page.getByTestId('sim-pause').click();
  await expect(page.getByTestId('sim-state')).toHaveText('paused');
  const tp = (await sim(page)).time;
  await page.waitForTimeout(300);
  expect((await sim(page)).time).toBe(tp);

  // 14. Export telemetry (CSV) before resetting.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('sim-export-csv').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.telemetry\.csv$/);
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv).toContain('# FORGE simulation telemetry');
  expect(csv).toContain('Shoulder joint applied effort [N·m] (applied)');
  expect(csv.split('\n').filter((l) => l && !l.startsWith('#')).length).toBeGreaterThan(20);

  // 13. Reset: back to t = 0 and the original configuration; the CAD design is unchanged.
  await page.getByTestId('sim-reset').click();
  await expect(page.getByTestId('sim-time')).toHaveText('0.000');
  expect(deg((await shoulder(page)).q)).toBeCloseTo(0, 6);
  expect(await cad(page)).toBe(cadBefore);
  await page.getByTestId('mode-cad').click();
  await expect(page.getByTestId('simulation-panel')).toHaveCount(0);
  expect(await cad(page)).toBe(cadBefore);
  // Only setup commands were recorded (gravity, payload ×2): no per-step history entries.
  expect((await call<{ revision: number }>(page, 'project')).revision).toBe(revisionBefore + 3);

  // 15. Save and reload: the project and its simulation setup persist.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await ready(page);
  await page.getByTestId('view-project').click();
  await expect.poll(() => cad(page)).toBe(cadBefore);
  const root = (await nodes(page)).nodes[(await nodes(page)).rootId]!;
  expect(root.simulation!.gravity[1]).toBe(-9.81);
  expect(root.simulation!.payloads[0]!.massKg).toBe(1);
  await page.getByTestId('mode-simulation').click();
  await expect(page.getByTestId('sim-state')).toHaveText('ready');
});

test('Phase 5: open-ended experiment — a steel block dropped onto the work surface', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await ready(page);
  const scene = await nodes(page);
  const cube = scene.nodes[scene.rootId]!.childIds?.[0] as string | undefined;
  const cubeId = cube ?? Object.values(scene.nodes).find((n) => n.kind === 'primitive')!.id;
  // Raise the 300 mm reference cube 0.5 m (CAD mode), then simulate it.
  await selectRow(page, cubeId);
  await page.getByTestId('position-y').fill('650');
  await page.getByTestId('position-y').press('Enter');
  await page.getByTestId('mode-simulation').click();
  await page.getByTestId('sim-create').click();
  await expect(page.getByTestId('sim-state')).toHaveText('ready');
  // A loose body is a fixed obstacle by default; make it dynamic: its mass is unknown (no material) → refused.
  await page.getByTestId('sim-body-mode').selectOption('dynamic');
  await page.getByTestId('sim-rebuild').click();
  await expect(page.getByTestId('sim-issues')).toContainText('Mass of');
  await expect(page.getByTestId('sim-start')).toBeDisabled();
  // Choose an explicit approximate mass model: volume × steel density.
  await page.getByTestId('sim-body-mass-source').selectOption('material');
  await page.getByTestId('sim-body-material').selectOption('steel-1018');
  await page.getByTestId('sim-rebuild').click();
  await expect(page.getByTestId('sim-body-mass')).toContainText('212.4900 kg'); // 0.027 m³ × 7870 kg/m³
  await page.getByTestId('sim-start').click();
  // Falls 0.5 m (≈ 0.32 s) and comes to rest ON the surface (centre at 0.15 m), not through it.
  await expect
    .poll(async () => (await call<number[]>(page, 'simUnitPosition', cubeId))[1], { timeout: 15_000 })
    .toBeLessThan(0.16);
  await page.waitForTimeout(1500);
  const y = (await call<number[]>(page, 'simUnitPosition', cubeId))[1]!;
  expect(Math.abs(y - 0.15)).toBeLessThan(0.002);
  await expect(page.getByTestId('sim-body-contacts')).not.toHaveText('none');
});
