import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 1 browser verification against the production build (headless Chromium,
 * software WebGL). Engineering state is read through the read-only window.__forge
 * query hook; every change is made through the real UI.
 */
type Vec3 = [number, number, number];
type Node = {
  id: string;
  name: string;
  parentId: string | null;
  visible: boolean;
  locked: boolean;
  transform: { position: Vec3; scale: Vec3 };
};
type Forge = {
  render: () => { frames: number; lastDrawCalls: number };
  lastFrame: () => { drawCalls: number; triangles: number };
  frameloop: () => string;
  resources: () => {
    geometries: { unique: number; refs: number };
    materials: { unique: number; refs: number };
  };
  queryScene: () => {
    rootId: string;
    revision: number;
    nodes: { id: string; name: string; depth: number }[];
  };
  getNode: (id: string) => Node | null;
  getSelection: () => string[];
  getHistory: () => { undoDepth: number; redoDepth: number };
  project: () => unknown;
  screenPointOf: (id: string) => { x: number; y: number } | null;
  cameraPosition: () => Vec3;
};
const q = <T>(page: Page, fn: (f: Forge, arg: string) => T, arg = '') =>
  page.evaluate(
    ([src, a]) =>
      new Function('f', 'a', `return (${src})(f, a)`)((window as unknown as { __forge: Forge }).__forge, a),
    [fn.toString(), arg],
  ) as Promise<T>;

async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    // Demand rendering: the app renders a few frames on load, then only on change.
    () => ((window as unknown as { __forge?: Forge }).__forge?.render?.().frames ?? 0) >= 1,
    null,
    { timeout: 20_000 },
  );
}
/**
 * Independent ground truth: count real WebGL draw submissions per animation frame by
 * wrapping the WebGL API before the app starts. Frames with zero draws are skipped,
 * so `lastFrameDraws` is the most recent frame that actually rendered.
 */
const instrumentWebGL = () => {
  const W = window as unknown as { __gl: { cur: number; lastFrameDraws: number } };
  W.__gl = { cur: 0, lastFrameDraws: 0 };
  for (const P of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype] as unknown as Record<
    string,
    (...a: unknown[]) => unknown
  >[])
    for (const m of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const orig = P[m];
      if (!orig) continue;
      P[m] = function (this: unknown, ...a: unknown[]) {
        W.__gl.cur++;
        return orig.apply(this, a);
      };
    }
  const tick = () => {
    if (W.__gl.cur > 0) W.__gl.lastFrameDraws = W.__gl.cur;
    W.__gl.cur = 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
const settle = (page: Page) => page.waitForTimeout(400);
const glDraws = (page: Page) =>
  page.evaluate(() => (window as unknown as { __gl: { lastFrameDraws: number } }).__gl.lastFrameDraws);

const nodeNamed = async (page: Page, name: string) => {
  const s = await q(page, (f) => f.queryScene());
  const n = s.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node named ${name}`);
  return n.id;
};
const getNode = (page: Page, id: string) => q(page, (f, a) => f.getNode(a), id) as Promise<Node>;
const history = (page: Page) => q(page, (f) => f.getHistory());

async function createBox(page: Page, widthMm?: string) {
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'box', exact: true }).click();
  if (widthMm) {
    const w = page.getByTestId('create-width');
    await w.fill(widthMm);
    await w.press('Enter');
  }
  await page.getByRole('button', { name: 'Create box' }).click();
  return nodeNamed(page, 'Box');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(instrumentWebGL);
});

test('launches: layout present, canvas renders, physics ready, same-origin only, no console errors', async ({
  page,
}) => {
  const foreign: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => {
    if (!/^(http:\/\/127\.0\.0\.1:4173\/|data:|blob:)/.test(r.url())) foreign.push(r.url());
  });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await expect(page.getByText('FORGE', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Scene hierarchy' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Inspector' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /Reference Cube/ })).toBeVisible();
  await settle(page);
  // The probe counts every render pass (scene + axis gizmo) and must match WebGL's own count.
  const probe = (await q(page, (f) => f.lastFrame())).drawCalls;
  expect(probe).toBeGreaterThan(5);
  expect(probe).toBe(await glDraws(page));
  await expect(page.getByTestId('physics-status')).toHaveText('physics: ready', { timeout: 20_000 });
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test('create primitive → hierarchy → select in viewport → numeric edit → undo → redo', async ({ page }) => {
  await open(page);
  // 2–3. Create a 120 mm box; it appears in the hierarchy with real geometry.
  const id = await createBox(page, '120');
  await expect(page.getByTestId(`tree-row-${id}`)).toBeVisible();
  const node = await getNode(page, id);
  expect((node as unknown as { geometry: { width: number } }).geometry.width).toBeCloseTo(0.12, 12);

  // 4. Viewport selection: click empty space deselects, click the object selects it.
  await page.mouse.click(400, 700);
  await expect.poll(() => q(page, (f) => f.getSelection())).toEqual([]);
  const pt = await q(page, (f, a) => f.screenPointOf(a), id);
  await page.mouse.click(pt!.x, pt!.y);
  await expect.poll(() => q(page, (f) => f.getSelection())).toEqual([id]);

  // 5. Numeric position edit in millimetres → metres internally.
  const x = page.getByTestId('position-x');
  await x.fill('250');
  await x.press('Enter');
  await expect.poll(async () => (await getNode(page, id)).transform.position[0]).toBe(0.25);
  await expect(page.getByTestId('world-position')).toContainText('250.000');

  // 6. Undo (keyboard) reverses it; 7. redo restores it.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await getNode(page, id)).transform.position[0]).toBe(0.4);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await getNode(page, id)).transform.position[0]).toBe(0.25);
  // Toolbar buttons do the same.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await getNode(page, id)).transform.position[0]).toBe(0.4);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => (await getNode(page, id)).transform.position[0]).toBe(0.25);
});

test('export → modify → import restores the exact engineering state', async ({ page }) => {
  page.on('dialog', (d) => d.accept()); // "discard unsaved changes?" confirmation
  await open(page);
  const id = await createBox(page);
  const x = page.getByTestId('position-x');
  await x.fill('-75.25');
  await x.press('Enter');
  await page.getByRole('button', { name: 'Group selected' }).click();
  const exportedState = JSON.stringify(await q(page, (f) => f.project()));

  // 8. Export downloads a .forge.json file.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.forge\.json$/);
  const path = await download.path();
  const fileText = readFileSync(path, 'utf8');
  expect(JSON.parse(fileText).schemaVersion).toBe(7); // Phase 8: project schema v7

  // Change the scene so the import has something to restore.
  await page.getByTestId(`tree-row-${id}`).click();
  await page.keyboard.press('Delete');
  await expect.poll(() => q(page, (f, a) => f.getNode(a), id)).toBeNull();

  // 9–10. Import the exported file; engineering state matches the original exactly.
  await page.getByTestId('import-input').setInputFiles(path);
  await expect(page.getByTestId('status')).toContainText('Imported');
  const restored = JSON.parse(JSON.stringify(await q(page, (f) => f.project())));
  const original = JSON.parse(exportedState);
  expect(restored.scene).toEqual(original.scene);
  expect(restored.id).toBe(original.id);
  expect((await getNode(page, id)).transform.position[0]).toBe(-0.07525);
});

test('a failed import keeps the current project', async ({ page }) => {
  await open(page);
  const before = JSON.stringify(await q(page, (f) => f.project()));
  await page.getByTestId('import-input').setInputFiles({
    name: 'bad.forge.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"schemaVersion":2,"scene":'),
  });
  await expect(page.getByRole('alert')).toContainText('Import failed');
  expect(JSON.stringify(await q(page, (f) => f.project()))).toBe(before);
});

test('gizmo drag commits one history entry with snapped values; Escape cancels a drag', async ({ page }) => {
  await open(page);
  const id = await createBox(page);
  const start = (await getNode(page, id)).transform.position;
  const depth0 = (await history(page)).undoDepth;
  const pt = (await q(page, (f, a) => f.screenPointOf(a), id))!;

  const camBefore = await q(page, (f) => f.cameraPosition());
  // Drag the translate gizmo's centre handle (free move in the view plane).
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(pt.x + i * 6, pt.y - i * 2);
  await page.mouse.up();
  const end = (await getNode(page, id)).transform.position;
  expect(end).not.toEqual(start);
  expect((await history(page)).undoDepth).toBe(depth0 + 1); // 20 pointer moves → ONE entry
  expect(await q(page, (f) => f.cameraPosition())).toEqual(camBefore); // orbit disabled while manipulating
  for (const v of end) expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-9); // 10 mm grid

  // Escape mid-drag restores and commits nothing.
  const pt2 = (await q(page, (f, a) => f.screenPointOf(a), id))!;
  await page.mouse.move(pt2.x, pt2.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(pt2.x - i * 6, pt2.y + i * 3);
  await page.keyboard.press('Escape');
  for (let i = 11; i <= 15; i++) await page.mouse.move(pt2.x - i * 6, pt2.y + i * 3);
  await page.mouse.up();
  expect((await getNode(page, id)).transform.position).toEqual(end);
  expect((await history(page)).undoDepth).toBe(depth0 + 1);
  await expect(page.getByTestId('status')).toContainText('cancelled');

  // Undo returns the object to its pre-drag position.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await getNode(page, id)).transform.position).toEqual(start);
});

test('hierarchy: rename, hide, lock (blocks edits), reparent via parent picker', async ({ page }) => {
  await open(page);
  const id = await createBox(page);
  const row = page.getByTestId(`tree-row-${id}`);
  await row.dblclick();
  await page.getByRole('textbox', { name: 'Rename' }).fill('Part A');
  await page.getByRole('textbox', { name: 'Rename' }).press('Enter');
  await expect(page.getByRole('treeitem', { name: /Part A/ })).toBeVisible();

  await page.getByRole('button', { name: 'Hide Part A' }).click();
  expect((await getNode(page, id)).visible).toBe(false);
  await page.getByRole('button', { name: 'Show Part A' }).click();

  await page.getByRole('button', { name: 'Lock Part A' }).click();
  await row.click();
  await expect(page.getByTestId('position-x')).toBeDisabled();
  await page.getByRole('button', { name: 'Unlock Part A' }).click();

  // Create a group, then move Part A into it with the parent picker.
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: 'Empty group' }).click();
  const groupId = await nodeNamed(page, 'Group');
  await row.click();
  await page.getByRole('combobox', { name: 'Parent' }).selectOption(groupId);
  expect((await getNode(page, id)).parentId).toBe(groupId);
  await expect(page.getByTestId('world-position')).toContainText('400.000');
});

test('draw-call counter tracks scene content exactly (matches WebGL instrumentation)', async ({ page }) => {
  await open(page);
  await settle(page);
  const before = (await q(page, (f) => f.lastFrame())).drawCalls;
  expect(before).toBe(await glDraws(page));
  for (let i = 0; i < 3; i++) await createBox(page);
  await page.keyboard.press('Escape'); // deselect: no gizmo/edge overlay draws
  await settle(page);
  const after = (await q(page, (f) => f.lastFrame())).drawCalls;
  expect(after).toBe(await glDraws(page));
  expect(after - before).toBeGreaterThanOrEqual(3); // ≥ one draw per new box
  // Three identical boxes share one geometry and one material.
  const res = await q(page, (f) => f.resources());
  expect(res.geometries.refs - res.geometries.unique).toBeGreaterThanOrEqual(2);
});

test('demand rendering: idle draws no frames; camera movement and selection render immediately', async ({
  page,
}) => {
  await open(page);
  expect(await q(page, (f) => f.frameloop())).toBe('demand');
  await settle(page);
  const idle0 = (await q(page, (f) => f.render())).frames;
  await page.waitForTimeout(1500);
  expect((await q(page, (f) => f.render())).frames).toBe(idle0); // nothing changed → no frames
  // Orbit drag renders.
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(820, 420, { steps: 10 });
  await page.mouse.up();
  const afterOrbit = (await q(page, (f) => f.render())).frames;
  expect(afterOrbit).toBeGreaterThan(idle0 + 3);
  // A state change (selection highlight) renders without camera movement.
  const cube = (await q(page, (f) => f.queryScene())).nodes[1]!.id;
  await page.getByTestId(`tree-row-${cube}`).click();
  await expect.poll(async () => (await q(page, (f) => f.render())).frames).toBeGreaterThan(afterOrbit);
});
