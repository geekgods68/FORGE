import { expect, test, type Page } from '@playwright/test';

const ID = 'part-enclosure-1';
type Doc = { revision: number; entities: Record<string, { transform: { position: number[]; rotation: number[] } }> };

const doc = (page: Page) => page.evaluate(() => (window as any).__workshop.document as Doc);
const pos = async (page: Page) => (await doc(page)).entities[ID]!.transform.position;
const undoDepth = (page: Page) => page.evaluate(() => (window as any).__workshop.undoDepth as number);
const partPoint = (page: Page) => page.evaluate((id) => (window as any).__workshop.entityClientPoint(id) as { x: number; y: number }, ID);

async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__workshop?.ready === true);
  await page.waitForFunction(() => (window as any).__workshop.xrState !== 'checking');
  await page.waitForTimeout(300); // let the first frames render so picking has geometry
}

test('loads with only same-origin requests and a truthful XR state on desktop', async ({ page }) => {
  const foreign: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:4173/') && !r.url().startsWith('data:')) foreign.push(r.url());
  });
  await open(page);
  await page.waitForTimeout(1000);
  expect(foreign).toEqual([]);
  const state = await page.evaluate(() => (window as any).__workshop.xrState);
  // This Mac has no headset runtime; Chrome exposes navigator.xr but not immersive-vr.
  expect(state).toBe('vr-unsupported');
  await expect(page.locator('#enter-vr')).toBeDisabled();
  await expect(page.locator('#xr-status')).toContainText('Desktop mode only');
});

test('without WebXR the app still runs in desktop mode and says so', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'xr', { get: () => undefined, configurable: true });
  });
  await open(page);
  expect(await page.evaluate(() => (window as any).__workshop.xrState)).toBe('no-webxr');
  await expect(page.locator('#enter-vr')).toBeDisabled();
});

test('desktop drag moves the part on the bench plane as ONE undo step; undo restores it', async ({ page }) => {
  await open(page);
  const before = await pos(page);
  const p = await partPoint(page);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(p.x + i * 5, p.y);
  expect(await pos(page)).toEqual(before); // preview only while dragging
  await page.mouse.up();
  const after = await pos(page);
  expect(after[0]).toBeGreaterThan(before[0]! + 0.02);
  expect(after[1]).toBeCloseTo(before[1]!, 6); // stays at bench height
  expect(await undoDepth(page)).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  const restored = await pos(page);
  restored.forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 9));
});

test('Escape during a drag cancels it with no document or history change', async ({ page }) => {
  await open(page);
  const before = await doc(page);
  const p = await partPoint(page);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 120, p.y + 40, { steps: 10 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await doc(page)).toEqual(before);
  expect(await undoDepth(page)).toBe(0);
});

test('window blur during a drag cancels it (source lost)', async ({ page }) => {
  await open(page);
  const before = await doc(page);
  const p = await partPoint(page);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 100, p.y, { steps: 5 });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  expect(await doc(page)).toEqual(before);
});

test('Q rotates the selected part 15° as one step; R resets it; both undoable', async ({ page }) => {
  await open(page);
  const p = await partPoint(page);
  await page.mouse.click(p.x, p.y); // select (click without movement commits nothing)
  expect(await undoDepth(page)).toBe(0);
  await page.keyboard.press('q');
  const q = (await doc(page)).entities[ID]!.transform.rotation;
  expect((2 * Math.atan2(q[1]!, q[3]!) * 180) / Math.PI).toBeCloseTo(15, 6);
  await page.keyboard.press('r');
  expect((await doc(page)).entities[ID]!.transform.rotation).toEqual([0, 0, 0, 1]);
  expect(await undoDepth(page)).toBe(2);
});

test('scripted edits use the same validated dispatcher and undo identically; stale edits are rejected', async ({ page }) => {
  await open(page);
  const ok = await page.evaluate((id) => (window as any).__workshop.dispatchScripted([{ type: 'entity.setTransform', id, transform: { position: [0.3, 0.775, -0.6], rotation: [0, 0, 0, 1] } }]), ID);
  expect(ok).toMatchObject({ ok: true, revision: 1 });
  expect((await pos(page))[0]).toBe(0.3);
  const stale = await page.evaluate((id) => (window as any).__workshop.dispatchScripted([{ type: 'entity.setTransform', id, transform: { position: [0.5, 0.775, -0.6], rotation: [0, 0, 0, 1] } }], 0), ID);
  expect(stale).toMatchObject({ ok: false, code: 'stale-revision' });
  const bad = await page.evaluate((id) => (window as any).__workshop.dispatchScripted([{ type: 'entity.setTransform', id, transform: { position: [NaN, 0, 0], rotation: [0, 0, 0, 1] } }]), ID);
  expect(bad).toMatchObject({ ok: false, code: 'invalid-geometry' });
  await page.evaluate(() => (window as any).__workshop.undo());
  expect((await pos(page))[0]).toBe(0);
  expect(await page.evaluate((id) => (window as any).__workshop.meshCountFor(id), ID)).toBe(1);
});
