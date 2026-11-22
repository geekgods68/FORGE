import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 6 browser benchmark (brief §21): UI responsiveness while the electronics
 * co-simulation runs with physics and rendering — the Arduino–HC-SR04–servo demo and the
 * four-joint arm control configuration. Short runs (3 s each). Headless Chromium renders
 * WebGL in SOFTWARE, so frame intervals are indicative; co-simulation costs are CPU-bound.
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

async function measure(
  page: Page,
  sample: 'library-open-ultrasonic' | 'library-open-arm-electronics',
  ms: number,
) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  await page.getByTestId('library-toggle').click();
  await page.getByTestId(sample).click();
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('mode-simulation').click();
  await expect(page.getByTestId('cosim-state')).toHaveText('ready');
  await page.evaluate(() => {
    const w = window as unknown as { __bench: { frames: number[]; long: number[] } };
    w.__bench = { frames: [], long: [] };
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__bench.long.push(e.duration))).observe({
      type: 'longtask',
      buffered: false,
    });
    let last = performance.now();
    const loop = (t: number) => {
      w.__bench.frames.push(t - last);
      last = t;
      if (w.__bench.frames.length < 100000) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const heap0 = await page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
  );
  await page.getByTestId('sim-start').click();
  await page.waitForTimeout(ms);
  await page.getByTestId('sim-pause').click();
  const cs = await call<{ time: number; physicsSteps: number; mcus: { serial: string }[] }>(page, 'cosim');
  const ui = await page.getByTestId('cosim-stats').textContent();
  const b = await page.evaluate(
    () => (window as unknown as { __bench: { frames: number[]; long: number[] } }).__bench,
  );
  const f = b.frames.slice(5).sort((x, y) => x - y);
  const heap1 = await page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
  );
  return {
    realSeconds: ms / 1000,
    simulatedSeconds: +cs.time.toFixed(3),
    physicsSteps: cs.physicsSteps,
    serialBytes: cs.mcus[0]?.serial.length ?? 0,
    frames: f.length,
    frameIntervalMedianMs: +(f[Math.floor(f.length / 2)] ?? 0).toFixed(1),
    frameIntervalP95Ms: +(f[Math.floor(f.length * 0.95)] ?? 0).toFixed(1),
    longTasks: b.long.length,
    longestTaskMs: +Math.max(0, ...b.long).toFixed(0),
    jsHeapMB: heap1 === null ? null : +(heap1 / 1048576).toFixed(1),
    jsHeapGrowthMB: heap0 === null || heap1 === null ? null : +((heap1 - heap0) / 1048576).toFixed(1),
    cosimStats: ui,
    renderer: await call<string>(page, 'rendererName'),
  };
}

const results: Record<string, unknown> = {
  environment: 'Headless Chromium, SOFTWARE WebGL, MacBook Air M3 8 GB — frame timings indicative only',
};
test.describe.configure({ mode: 'serial' });
test.afterAll(() => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/phase6-browser-benchmarks.json', JSON.stringify(results, null, 2) + '\n');
});

test('Phase 6 benchmark: Arduino–HC-SR04–servo demo in Simulation mode', async ({ page }) => {
  test.setTimeout(120_000);
  const r = await measure(page, 'library-open-ultrasonic', 3000);
  results.ultrasonicDemo = r;
  expect(r.simulatedSeconds).toBeGreaterThan(1.5); // keeps up with (most of) real time
  expect(r.serialBytes).toBeGreaterThan(100);
});

test('Phase 6 benchmark: four-joint arm control configuration', async ({ page }) => {
  test.setTimeout(120_000);
  const r = await measure(page, 'library-open-arm-electronics', 3000);
  results.armControl = r;
  expect(r.simulatedSeconds).toBeGreaterThan(1.5);
});
