import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Phase 4 milestone F: instanced rendering of repeated catalogue components (identity,
 * selection, visibility, undo preserved) and indicative benchmarks at 100 / 1,000 /
 * 5,000 components, a mixed scene and the constrained robotic arm.
 *
 * By default timings are measured in HEADLESS Chromium with SOFTWARE WebGL (indicative
 * only). With FORGE_BENCH_GPU=1 the same benchmarks run in Chromium's new headless mode on
 * the machine's GPU (ANGLE/Metal on macOS) and are written to a separate results file; the
 * renderer string actually used is recorded with the results. Draw-call and instance
 * counts are deterministic.
 */
const GPU = process.env.FORGE_BENCH_GPU === '1';
if (GPU)
  test.use({
    channel: 'chromium',
    launchOptions: { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] },
  });
type F = Record<string, (...a: never[]) => unknown>;
const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      ((window as unknown as { __forge: F }).__forge[n as string] as (...x: unknown[]) => unknown)(
        ...(a as unknown[]),
      ),
    [name, args] as const,
  ) as Promise<T>;
type Node = { id: string; kind: string; name: string; visible: boolean };
const nodes = async (page: Page) =>
  (await call<{ scene: { nodes: Record<string, Node> } }>(page, 'project')).scene.nodes;
const count = (page: Page) => call<number>(page, 'nodeCount');
type Instancing = { batches: number; instanced: number; drawn: { definitionId: string; count: number }[] };
const instancing = (page: Page) =>
  page.evaluate(
    () =>
      ((window as unknown as { __forge: { instancing?: () => unknown } }).__forge.instancing?.() ??
        null) as Instancing | null,
  );

const CONFIGS = [
  { definitionId: 'hex-nut', step: 0.02 },
  { definitionId: 'machine-screw', step: 0.02 },
  { definitionId: 'ball-bearing', step: 0.03 },
  { definitionId: 'towerpro-sg90', step: 0.04 },
];

/** A reusable-assembly file with `n` catalogue components on a grid (4 configurations). */
function gridAssembly(name: string, n: number, extra: object[] = []) {
  const side = Math.ceil(Math.sqrt(n));
  const members = Array.from({ length: n }, (_, i) => {
    const c = CONFIGS[i % CONFIGS.length]!;
    return {
      kind: 'component',
      name: `${c.definitionId} ${i + 1}`,
      parent: -1,
      position: [((i % side) - side / 2) * 0.045, 0, (Math.floor(i / side) - side / 2) * 0.045],
      rotation: [0, 0, 0, 1],
      definitionId: c.definitionId,
      variantId: null,
      parameters: {},
    };
  });
  return JSON.stringify({
    format: 'forge-assembly',
    version: 1,
    content: {
      version: 2,
      id: name,
      name,
      savedAt: '2026-11-21T00:00:00.000Z',
      topKind: 'group',
      members: [...members, ...extra],
      mechanics: [],
    },
    assets: [],
  });
}

async function boot(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
}

async function importTemplate(page: Page, name: string, text: string) {
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('assembly-import-input').setInputFiles({
    name: `${name}.forge-assembly.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(page.getByTestId('status')).toContainText('Imported reusable assembly');
}

/** Insert a template (one batch command); returns ms until the scene and a frame reflect it. */
async function timedInsert(page: Page, name: string, expectedNodes: number) {
  const t0 = Date.now();
  await page.getByTestId(`assembly-insert-${name}`).click();
  await expect.poll(() => count(page), { timeout: 120_000 }).toBe(expectedNodes);
  await page.waitForFunction(
    () =>
      ((window as unknown as { __forge: { instancing?: () => { instanced: number } } }).__forge.instancing?.()
        .instanced ?? 0) > 0,
    undefined,
    { timeout: 120_000 },
  );
  return Date.now() - t0;
}

/** Click empty sky in the viewport (a genuine click on nothing deselects). */
async function deselect(page: Page) {
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + 20);
}

async function settledFrame(page: Page) {
  await page.waitForTimeout(300);
  return call<{ drawCalls: number; triangles: number }>(page, 'lastFrame');
}

const OUT = GPU ? 'test-results/phase41-benchmarks-gpu.json' : 'test-results/phase4-benchmarks.json';
/** Merge one benchmark into the results file (each test records its own entry). */
function record(key: string, value: unknown) {
  mkdirSync('test-results', { recursive: true });
  const prev = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>) : {};
  writeFileSync(OUT, JSON.stringify({ ...prev, ...results, [key]: value }, null, 2));
}
const results: Record<string, unknown> = {
  environment: GPU
    ? 'Chromium new headless (Playwright), hardware WebGL via ANGLE/Metal, MacBook Air M3 8 GB (renderer string recorded per run).'
    : 'Headless Chromium (Playwright), software WebGL, MacBook Air M3 8 GB — timings indicative only; draw calls / instances deterministic.',
};
/** Mean GPU-complete render time of the current view (ms/frame) and the renderer used. */
async function renderCost(page: Page) {
  return {
    renderMsPerFrame: await call<number>(page, 'benchRender', 30),
    renderer: await call<string>(page, 'rendererName'),
  };
}

test.describe.configure({ mode: 'serial' });

test('instancing preserves identity, selection, visibility and undo', async ({ page }) => {
  await boot(page);
  const plates = Array.from({ length: 5 }, (_, i) => ({
    kind: 'component',
    name: `Plate ${i + 1}`,
    parent: -1,
    position: [-0.6 + i * 0.3, 0, 0.45],
    rotation: [0, 0, 0, 1],
    definitionId: 'arm-base-plate',
    variantId: null,
    parameters: {},
  }));
  await importTemplate(page, 'Grid 100', gridAssembly('Grid 100', 96, plates));
  const base = await count(page);
  await timedInsert(page, 'Grid 100', base + 102);
  await page.getByTestId('library-toggle').click();
  const inst = (await instancing(page))!;
  expect(inst.batches).toBe(5); // 4 grid configurations + the plates
  expect(inst.instanced).toBe(101);

  // Clicking an instanced plate selects exactly that node.
  const all = await nodes(page);
  const plate = Object.values(all).find((n) => n.name === 'Plate 2')!;
  const pt = await call<{ x: number; y: number }>(page, 'screenPointOf', plate.id);
  await page.mouse.click(pt.x, pt.y);
  await expect.poll(() => call<string[]>(page, 'getSelection')).toEqual([plate.id]);
  // The selected node leaves its batch (renders individually with the highlight).
  await expect.poll(async () => (await instancing(page))!.instanced).toBe(100);

  // Hidden nodes are not drawn; undo restores them into the batch.
  await page.getByTestId(`tree-row-${plate.id}`).click();
  await page.getByRole('button', { name: `Hide ${plate.name}` }).click();
  await deselect(page);
  await expect.poll(async () => (await instancing(page))!.instanced).toBe(100);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await nodes(page))[plate.id]!.visible).toBe(true);
  // Undo re-selects the affected node (rendered individually); deselected, it rejoins its batch.
  await deselect(page);
  await expect.poll(() => call<string[]>(page, 'getSelection')).toEqual([]);
  await expect.poll(async () => (await instancing(page))!.instanced).toBe(101);
});

for (const n of [100, 1000, 5000]) {
  test(`benchmark: ${n} components`, async ({ page }) => {
    test.setTimeout(300_000);
    await boot(page);
    const T = Date.now();
    const lap = (what: string) =>
      console.log(`[bench ${n}] ${what} @ ${((Date.now() - T) / 1000).toFixed(1)} s`);
    const per = Math.min(n, 1000);
    await importTemplate(page, `Grid ${per}`, gridAssembly(`Grid ${per}`, per));
    const base = await count(page);
    const times: number[] = [];
    for (let k = 1; k * per <= n; k++)
      times.push(await timedInsert(page, `Grid ${per}`, base + k * (per + 1)));
    await page.getByTestId('library-toggle').click();
    const frame = await settledFrame(page);
    const cost = await renderCost(page);
    const inst = (await instancing(page))!;
    expect(inst.instanced).toBe(n);
    expect(inst.batches).toBe(4);
    // Undo the last insert (one batch command) and time it.
    const t0 = Date.now();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => count(page), { timeout: 120_000 }).toBe(base + (n / per - 1) * (per + 1));
    const undoMs = Date.now() - t0;
    lap('undone');
    record(`components-${n}`, {
      insertMsPerBatch: times,
      drawCalls: frame.drawCalls,
      triangles: frame.triangles,
      instancedNodes: inst.instanced,
      batches: inst.batches,
      undoLastInsertMs: undoMs,
      ...cost,
    });
    // Draw calls stay bounded by configurations × appearances, not by component count.
    expect(frame.drawCalls).toBeLessThan(60);
  });
}

test('benchmark: robotic arm joints and a mixed scene', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page);
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-sample').click();
  await expect(page.getByTestId('status')).toContainText('robotic-arm sample');
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('tree-row-grp-arm').click();
  const jointMs: number[] = [];
  for (const deg of [10, 20, 30, 40, 50]) {
    const f = page.getByTestId('joint-j-shoulder-0-value');
    const t0 = Date.now();
    await f.fill(String(deg));
    await f.press('Enter');
    await expect
      .poll(async () => {
        const p = await call<{
          scene: {
            nodes: Record<string, { mechanical?: { mates: { id: string; coordinates: number[] }[] } }>;
          };
        }>(page, 'project');
        return p.scene.nodes['grp-arm']!.mechanical!.mates.find((m) => m.id === 'j-shoulder')!
          .coordinates[0]!;
      })
      .toBeCloseTo((deg * Math.PI) / 180, 9);
    jointMs.push(Date.now() - t0);
  }
  const armFrame = await settledFrame(page);
  const armCost = await renderCost(page);
  const t1 = Date.now();
  await page.getByTestId('interference-check').click();
  await expect(page.getByTestId('interference-results')).toBeVisible();
  const interferenceMs = Date.now() - t1;
  // Mixed: the constrained arm + controller + 1,000 fasteners/bearings/servos.
  await importTemplate(page, 'Grid 1000', gridAssembly('Grid 1000', 1000));
  const base = await count(page);
  const insertMs = await timedInsert(page, 'Grid 1000', base + 1001);
  await page.getByTestId('library-toggle').click();
  const mixedFrame = await settledFrame(page);
  const mixedCost = await renderCost(page);
  // Joints still respond in the mixed scene (scroll the virtualized tree back to the top).
  await deselect(page);
  await page.getByRole('tree').evaluate((el) => {
    for (let n: Element | null = el; n; n = n.parentElement)
      if ((n as HTMLElement).scrollTop > 0) (n as HTMLElement).scrollTop = 0;
  });
  await page.getByTestId('tree-row-grp-arm').click();
  const f = page.getByTestId('joint-j-elbow-0-value');
  const t2 = Date.now();
  await f.fill('-60');
  await f.press('Enter');
  await expect(page.getByTestId('joint-j-elbow-0-value')).toHaveValue('-60.00');
  const mixedJointMs = Date.now() - t2;
  record('robotic-arm', {
    jointSetPositionMs: jointMs,
    drawCalls: armFrame.drawCalls,
    triangles: armFrame.triangles,
    interferenceCheckMs: interferenceMs,
    ...armCost,
  });
  record('mixed', {
    insert1000Ms: insertMs,
    drawCalls: mixedFrame.drawCalls,
    triangles: mixedFrame.triangles,
    instancing: await instancing(page),
    elbowMoveMs: mixedJointMs,
    ...mixedCost,
  });
});
