import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { stepAssembly } from '../../packages/interop/src/__tests__/step-fixtures';

/**
 * Phase 8 browser benchmark: UI responsiveness while (a) a STEP assembly is tessellated by
 * OCCT in the worker and (b) the digital twin ingests 20 Hz synthetic telemetry and drives
 * the preview pose. Headless Chromium uses SOFTWARE WebGL: frame figures are indicative.
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
async function startProbe(page: Page) {
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
}
async function stopProbe(page: Page) {
  const b = await page.evaluate(() => {
    const w = window as unknown as { __bench: { frames: number[]; long: number[]; on: boolean } };
    w.__bench.on = false;
    return { frames: w.__bench.frames.slice(1), long: w.__bench.long };
  });
  const s = [...b.frames].sort((x, y) => x - y);
  const q = (p: number) => +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(1);
  const heap = await page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
  );
  return {
    frames: b.frames.length,
    frameMs: { median: q(0.5), p95: q(0.95), max: +(s[s.length - 1] ?? 0).toFixed(1) },
    longTasks: b.long.length,
    longestTaskMs: +Math.max(0, ...b.long).toFixed(0),
    jsHeapMB: heap === null ? null : +(heap / 1048576).toFixed(1),
  };
}

test('Phase 8 benchmark: UI responsiveness during STEP import and live twin telemetry', async ({ page }) => {
  test.setTimeout(300_000);
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  // (a) STEP: 100-part assembly tessellated in the worker.
  const step = stepAssembly(
    Array.from({ length: 100 }, (_, i) => ({
      name: `P${i}`,
      size: [20, 10, 5] as [number, number, number],
      at: [(i % 10) * 25, Math.floor(i / 10) * 15, 0] as [number, number, number],
    })),
  );
  await page.getByTestId('interop-toggle').click();
  await startProbe(page);
  const t0 = Date.now();
  await page
    .getByTestId('interop-file')
    .setInputFiles({ name: 'asm100.step', mimeType: 'application/step', buffer: Buffer.from(step) });
  await expect(page.getByTestId('interop-format')).toContainText('detected step', { timeout: 120_000 });
  const stepWall = Date.now() - t0;
  const workerMs = Number(
    /analysed in (\d+) ms/.exec((await page.getByTestId('interop-format').textContent()) ?? '')?.[1] ?? NaN,
  );
  const stepUi = await stopProbe(page);
  await page.getByTestId('interop-confirm').click();
  await expect(page.getByTestId('interop-message')).toContainText('inserted');
  await page.getByTestId('interop-close').click();
  // (b) Twin: 15 s of live 20 Hz synthetic telemetry with recording.
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-veyris-twin').click();
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('mode-twin').click();
  await page.getByTestId('twin-create').click();
  await page.getByTestId('twin-connect').click();
  await expect(page.getByTestId('twin-link')).toHaveText('live', { timeout: 10_000 });
  await page.getByTestId('twin-record').click();
  await startProbe(page);
  await page.waitForTimeout(15_000);
  const twinUi = await stopProbe(page);
  const tw = await call<{
    samples: Record<string, number>;
    clock: { latencyP95Ms: number; driftPpm: number };
    stats: { missingMessages: number };
  }>(page, 'twin');
  await page.getByTestId('twin-stop-record').click();
  await page.getByTestId('twin-disconnect').click();
  const storage = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? null);
  const results = {
    when: new Date().toISOString(),
    note: 'Headless Chromium (software WebGL); single runs; indicative.',
    stepImport: {
      parts: 100,
      fileKB: +(step.length / 1024).toFixed(0),
      wallMs: stepWall,
      workerAnalyseMs: workerMs,
      ui: stepUi,
    },
    twinLive: {
      seconds: 15,
      samples: tw.samples,
      latencyP95Ms: +tw.clock.latencyP95Ms.toFixed(2),
      driftPpm: +tw.clock.driftPpm.toFixed(1),
      missingMessages: tw.stats.missingMessages,
      ui: twinUi,
    },
    storageUsageKB: storage === null ? null : Math.round(storage / 1024),
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/phase8-browser-benchmarks.json', JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
  expect(tw.samples.d).toBeGreaterThan(250);
});
