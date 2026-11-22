import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 7 browser benchmark (brief §30): UI responsiveness while a research campaign runs in
 * the page (the scheduler yields between runs and between simulation chunks), campaign wall
 * time, and IndexedDB storage. Short campaigns. Headless Chromium uses SOFTWARE WebGL, so frame
 * intervals are indicative only.
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
const ready = (page: Page) =>
  page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
type Research = {
  experiments: { id: string; runs: { state: string }[] }[];
  progress: { phase: string; total: number; completed: number } | null;
};

async function measure(page: Page, sample: string, template: string, experimentId: string) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  await page.getByTestId('library-toggle').click();
  await page.getByTestId(sample).click();
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('mode-research').click();
  const labels = await page.getByTestId('res-template').locator('option').allTextContents();
  await page.getByTestId('res-template').selectOption({ label: labels.find((l) => l.includes(template))! });
  await page.getByTestId('res-new').click();
  await page.getByTestId('res-validate').click();
  await expect(page.getByTestId('res-validation-result')).toContainText('Valid:', { timeout: 30_000 });
  await page.evaluate(() => {
    const w = window as unknown as { __bench: { frames: number[]; long: number[]; on: boolean } };
    w.__bench = { frames: [], long: [], on: true };
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__bench.long.push(e.duration))).observe({
      type: 'longtask',
      buffered: false,
    });
    let last = performance.now();
    const loop = (t: number) => {
      w.__bench.frames.push(t - last);
      last = t;
      if (w.__bench.on) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const heap = () =>
    page.evaluate(
      () =>
        (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
    );
  const heap0 = await heap();
  const storage0 = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? null);
  const t0 = Date.now();
  await page.getByTestId('res-launch').click();
  await expect
    .poll(async () => (await call<Research>(page, 'research')).progress?.phase, {
      timeout: 300_000,
      intervals: [100],
    })
    .toBe('completed');
  const wallMs = Date.now() - t0;
  const b = await page.evaluate(() => {
    const w = window as unknown as { __bench: { frames: number[]; long: number[]; on: boolean } };
    w.__bench.on = false;
    return { frames: w.__bench.frames.slice(1), long: w.__bench.long };
  });
  const heap1 = await heap();
  const storage1 = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? null);
  const r = await call<Research>(page, 'research');
  const runs = r.experiments.find((e) => e.id === experimentId)!.runs;
  const sorted = [...b.frames].sort((x, y) => x - y);
  const q = (p: number) =>
    +(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0).toFixed(1);
  expect(runs.every((x) => x.state === 'COMPLETED')).toBe(true);
  return {
    sample,
    experiment: experimentId,
    runs: runs.length,
    campaignWallMs: wallMs,
    runsPerS: +((runs.length / wallMs) * 1000).toFixed(2),
    frames: b.frames.length,
    frameIntervalMs: { median: q(0.5), p95: q(0.95), max: +(sorted[sorted.length - 1] ?? 0).toFixed(1) },
    longTasks: { count: b.long.length, longestMs: +Math.max(0, ...b.long).toFixed(0) },
    jsHeapMB: heap1 === null ? null : +(heap1 / 1048576).toFixed(1),
    jsHeapGrowthMB: heap0 === null || heap1 === null ? null : +((heap1 - heap0) / 1048576).toFixed(1),
    storageGrowthKB:
      storage0 === null || storage1 === null ? null : +((storage1 - storage0) / 1024).toFixed(0),
  };
}

test('Phase 7 benchmark: UI responsiveness during research campaigns', async ({ page }) => {
  test.setTimeout(600_000);
  const results = {
    when: new Date().toISOString(),
    note: 'Headless Chromium, software WebGL; single runs; indicative, not guarantees.',
    campaigns: [
      await measure(page, 'library-open-sample', 'Arm payload', 'exp-a-payload'),
      await measure(page, 'library-open-rc-study', 'RC sweep', 'exp-d-rc'),
    ],
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/phase7-browser-benchmarks.json', JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
});
