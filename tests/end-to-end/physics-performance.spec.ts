import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 5 browser benchmark (brief §15): physics + rendering in Simulation mode for 100 and
 * 1,000 falling boxes and the robotic arm. Measures display-frame intervals (main-thread
 * responsiveness), simulated vs real time, the physics step time and long tasks. Short runs
 * (3 s each). Headless Chromium uses SOFTWARE WebGL unless FORGE_BENCH_GPU=1, so frame times
 * are indicative; the physics step time is CPU-bound and comparable.
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
const ready = (page: Page) =>
  page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
type Project = {
  scene: { rootId: string; nodes: Record<string, Record<string, unknown> & { childIds: string[] }> };
} & Record<string, unknown>;

const body = (nodeId: string) => ({
  nodeId,
  mode: 'dynamic',
  mass: { source: 'user', massKg: 1, note: 'benchmark' },
  collider: 'auto',
  friction: 0.5,
  restitution: 0.1,
  linearDamping: 0,
  angularDamping: 0,
  ccd: false,
  linearVelocity: [0, 0, 0],
  angularVelocity: [0, 0, 0],
  contactLoadRatingN: null,
});

/** The default project with its cube replaced by `n` 50 mm boxes in layers, plus a simulation setup. */
function boxesProject(base: Project, n: number): Project {
  const p = structuredClone(base);
  const root = p.scene.nodes[p.scene.rootId]!;
  for (const c of root.childIds) delete p.scene.nodes[c];
  root.childIds = [];
  const side = 10;
  for (let i = 0; i < n; i++) {
    const layer = Math.floor(i / (side * side));
    const k = i % (side * side);
    const id = `box-${i}`;
    p.scene.nodes[id] = {
      id,
      kind: 'primitive',
      name: id,
      parentId: p.scene.rootId,
      childIds: [],
      transform: {
        position: [
          ((k % side) - side / 2) * 0.07,
          0.05 + layer * 0.07,
          (Math.floor(k / side) - side / 2) * 0.07,
        ],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      visible: true,
      locked: false,
      metadata: {},
      geometry: { shape: 'box', width: 0.05, height: 0.05, depth: 0.05 },
      color: '#8a93a3',
    };
    root.childIds.push(id);
  }
  root.simulation = {
    schemaVersion: 1,
    name: `Bench ${n}`,
    solver: { timestepS: 1 / 120, substeps: 4, solverIterations: 8, maxCatchUpSteps: 16, lengthUnitM: 0.01 },
    gravityEnabled: true,
    gravity: [0, -9.80665, 0],
    ground: { enabled: true, heightM: 0, friction: 0.6, restitution: 0.1 },
    selfCollision: false,
    allowSleeping: false,
    initialPose: 'current',
    bodies: Array.from({ length: n }, (_, i) => body(`box-${i}`)),
    joints: [],
    payloads: [],
    thresholds: { maxAngularSpeed: 50, contactForceN: null, limitTolerance: 0.01 },
    recording: { sampleRateHz: 60, maxSamples: 6000 },
    approvals: { ignoreDrivingConstraints: false, ignoreUnsupportedLimits: false },
  };
  p.name = `Physics bench ${n}`;
  return p;
}

/** Run the simulation for `ms` of real time and measure frames, simulated time and long tasks. */
async function measure(page: Page, ms: number) {
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
  const t0 = (await call<{ time: number }>(page, 'sim')).time;
  await page.getByTestId('sim-start').click();
  await page.waitForTimeout(ms);
  await page.getByTestId('sim-pause').click();
  const s = await call<{
    time: number;
    stats: { meanStepMs: number; maxStepMs: number; lagFrames: number };
    phase: string;
  }>(page, 'sim');
  const b = await page.evaluate(
    () => (window as unknown as { __bench: { frames: number[]; long: number[] } }).__bench,
  );
  const f = b.frames.slice(5).sort((x, y) => x - y);
  const heap = await page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
  );
  return {
    realSeconds: ms / 1000,
    simulatedSeconds: +(s.time - t0).toFixed(3),
    physicsStepMeanMs: +s.stats.meanStepMs.toFixed(3),
    physicsStepMaxMs: +s.stats.maxStepMs.toFixed(3),
    lagFrames: s.stats.lagFrames,
    frames: f.length,
    frameIntervalMedianMs: +(f[Math.floor(f.length / 2)] ?? 0).toFixed(1),
    frameIntervalP95Ms: +(f[Math.floor(f.length * 0.95)] ?? 0).toFixed(1),
    longTasks: b.long.length,
    longestTaskMs: +Math.max(0, ...b.long).toFixed(0),
    jsHeapMB: heap === null ? null : +(heap / 1048576).toFixed(1),
    renderer: await call<string>(page, 'rendererName'),
    phase: s.phase,
  };
}

const results: Record<string, unknown> = {
  environment: GPU
    ? 'Chromium new headless, hardware WebGL (ANGLE/Metal), MacBook Air M3 8 GB'
    : 'Headless Chromium, SOFTWARE WebGL, MacBook Air M3 8 GB — frame timings indicative only',
};
const OUT = GPU
  ? 'test-results/phase5-browser-benchmarks-gpu.json'
  : 'test-results/phase5-browser-benchmarks.json';
test.describe.configure({ mode: 'serial' });
test.afterAll(() => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
});

for (const n of [100, 1000])
  test(`physics benchmark: ${n} falling boxes`, async ({ page }) => {
    test.setTimeout(120_000);
    page.on('dialog', (d) => d.accept());
    await page.goto('/');
    await ready(page);
    const project = boxesProject(await call<Project>(page, 'project'), n);
    await page.getByTestId('import-input').setInputFiles({
      name: `bench-${n}.forge.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await expect.poll(() => call<number>(page, 'nodeCount')).toBe(n + 1);
    await page.getByTestId('mode-simulation').click();
    await expect(page.getByTestId('sim-state')).toHaveText('ready', { timeout: 30_000 });
    const r = await measure(page, 3000);
    results[`boxes-${n}`] = r;
    expect(r.phase).toBe('paused');
    expect(r.simulatedSeconds).toBeGreaterThan(0);
  });

test('physics benchmark: robotic arm under motor control', async ({ page }) => {
  test.setTimeout(120_000);
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-sample').click();
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('mode-simulation').click();
  await expect(page.getByTestId('sim-state')).toHaveText('ready');
  await page.getByTestId('sim-joint-target-j-yaw').fill('90');
  await page.getByTestId('sim-joint-target-j-yaw').press('Enter');
  const r = await measure(page, 3000);
  results.arm = r;
  expect(r.simulatedSeconds).toBeGreaterThan(1);
});
