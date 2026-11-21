import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 2 expansion: every zone is navigable and renders its own interior and signage;
 * the zone lifecycle keeps only active + required (+ ≤ 1 prefetch) loaded, ignores
 * stale loads, recovers from errors, releases zone resources on unload and never
 * touches workspace or project data.
 */
type V3 = [number, number, number];
type F = Record<string, (...a: never[]) => unknown>;
type ZoneInfo = { id: string; name: string; kind: string; code: string; corridorId: string | null };
type States = Record<string, { state: string; role: string | null; error?: string }>;
type Sign = { zoneId: string; kind: string; lines: string[]; position: number[] };

const LAB20 = 'lab-20-central-conjuring-workshop';
const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      ((window as unknown as { __forge: F }).__forge[n as string] as (...x: unknown[]) => unknown)(
        ...(a as unknown[]),
      ),
    [name, args] as const,
  ) as Promise<T>;
const states = (page: Page) => call<States>(page, 'zoneStates');

async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
}
async function waitLoaded(page: Page, id: string) {
  const required = await call<string[]>(page, 'requiredZones', id);
  await expect
    .poll(
      async () => {
        const s = await states(page);
        return (
          required.every((r) => s[r]?.state === 'active') &&
          !Object.values(s).some((x) => x.state === 'unloading')
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}
async function enterFacility(page: Page) {
  await page.getByTestId('view-facility').click();
  await waitLoaded(page, LAB20);
}
async function openDirectory(page: Page) {
  const d = page.locator('details', { has: page.getByText('Zone directory') });
  if ((await d.getAttribute('open')) === null) await d.locator('summary').click();
}
async function go(page: Page, id: string, wait = true) {
  await openDirectory(page);
  await page.getByTestId(`dir-${id}`).getByRole('button').click();
  if (wait) await waitLoaded(page, id);
}

test('every lab, environment and corridor is enterable with its own interior and correct signage; only the required set stays loaded', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await enterFacility(page);
  const zones = await call<ZoneInfo[]>(page, 'zones');
  expect(zones.filter((z) => z.kind === 'laboratory')).toHaveLength(22);
  expect(zones.filter((z) => z.kind === 'environment')).toHaveLength(6);
  const fingerprints = new Map<string, number>();
  for (const z of zones) {
    await go(page, z.id);
    await expect(page.getByTestId('zone-name')).toHaveText(z.name);
    // Loaded set = active zone + its required corridor (+ at most one prefetch, which is not rendered).
    const required = await call<string[]>(page, 'requiredZones', z.id);
    const s = await states(page);
    const live = Object.entries(s).filter(([, v]) => v.state !== 'unloaded');
    expect(
      live
        .filter(([, v]) => v.role !== 'prefetch')
        .map(([id]) => id)
        .sort(),
    ).toEqual([...required].sort());
    expect(live.filter(([, v]) => v.role === 'prefetch').length).toBeLessThanOrEqual(1);
    // The room's interior is actually rendered (instanced architecture + furnishings + signs).
    const g = await call<{ mounted: boolean; draws: number; instances: number; signs: number }>(
      page,
      'zoneGeometry',
      z.id,
    );
    expect(g.mounted).toBe(true);
    expect(g.instances).toBeGreaterThan(z.kind === 'corridor' ? 5 : 60);
    if (z.kind !== 'corridor') fingerprints.set(z.id, g.instances);
    // Signage matches the registry: identity panel inside, door sign in its corridor.
    const signs = await call<Record<string, Sign>>(page, 'renderedSigns');
    if (z.kind !== 'corridor') {
      expect(signs[`${z.id}:identity`]?.lines[0]).toBe(`${z.code} · ${z.name}`);
      const door = signs[`${z.corridorId}:door:${z.id}`];
      expect(door?.lines.slice(0, 2)).toEqual([z.code, z.name]);
    }
    // Nothing outside the loaded set is mounted or has signs.
    for (const sg of Object.values(signs)) expect(required).toContain(sg.zoneId);
  }
  // Rooms are distinct builds (furnishing sets differ), not one template repeated.
  expect(new Set(fingerprints.values()).size).toBeGreaterThan(15);
  const t = (await call<{ zoneId: string; ms: number; coldModules: boolean }[]>(page, 'transitions')).filter(
    (x) => !x.coldModules,
  );
  const ms = t.map((x) => x.ms).sort((a, b) => a - b);
  console.log(
    `[bench] warm transitions n=${ms.length} median=${ms[Math.floor(ms.length / 2)]!.toFixed(1)}ms p90=${ms[Math.floor(ms.length * 0.9)]!.toFixed(1)}ms max=${ms.at(-1)!.toFixed(1)}ms (software WebGL)`,
  );
  expect(errors).toEqual([]);
});

test('repeated transitions release zone resources: GPU resources return to baseline, JS heap does not grow', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize / 1048576;
  };
  await open(page);
  const heapProject = await heap();
  await enterFacility(page);
  const rooms = (await call<ZoneInfo[]>(page, 'zones')).filter((z) => z.kind !== 'corridor').map((z) => z.id);
  const read = async () => ({
    resources: await call<unknown>(page, 'resources'),
    signs: await call<{ textures: number; refs: number }>(page, 'signTextures'),
    renderer: (await call<{ rendererInfo: { geometries: number; textures: number } }>(page, 'gpuEstimate'))
      .rendererInfo,
  });
  // renderer.info counts only resources uploaded by a rendered frame: wait until two
  // consecutive reads agree so a snapshot is never taken mid-upload.
  const snapshot = async () => {
    let prev = JSON.stringify(await read());
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(250);
      const cur = JSON.stringify(await read());
      if (cur === prev) return JSON.parse(cur) as Awaited<ReturnType<typeof read>>;
      prev = cur;
    }
    return JSON.parse(prev) as Awaited<ReturnType<typeof read>>;
  };
  // Warm-up cycle: fetch every template chunk and compile every program once.
  for (const id of rooms) await go(page, id);
  await go(page, LAB20);
  const base = await snapshot();
  const heapBase = await heap();
  let heapPeak = heapBase;
  let gpuPeak = 0;
  for (let round = 0; round < 3; round++) {
    for (const id of rooms) {
      await go(page, id);
      gpuPeak = Math.max(gpuPeak, (await call<{ totalMB: number }>(page, 'gpuEstimate')).totalMB);
    }
    await go(page, LAB20);
    heapPeak = Math.max(heapPeak, await heap());
  }
  const after = await snapshot();
  const heapAfter = await heap();
  console.log(
    `[bench] heap: project view ${heapProject.toFixed(1)} MB, facility baseline ${heapBase.toFixed(1)} MB, after ${3 * rooms.length} transitions ${heapAfter.toFixed(1)} MB (peak ${heapPeak.toFixed(1)} MB); GPU estimate peak ${gpuPeak} MB; renderer ${JSON.stringify(after.renderer)}`,
  );
  expect(after).toEqual(base); // every zone-specific geometry/material/texture/instance buffer was released
  expect(heapAfter - heapBase).toBeLessThan(10); // no per-transition retention
  expect(heapPeak - heapProject).toBeLessThan(150); // budget: < 150 MB additional JS heap
  expect(gpuPeak).toBeLessThan(200); // budget: ≤ 200 MB estimated facility GPU memory
});

test('a stale load that finishes after the user moved on never activates its zone', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/\/LabRoom-[^/]+\.js$/, async (route) => {
    await gate;
    await route.continue();
  });
  await open(page);
  await enterFacility(page);
  await go(page, 'lab-01-central-intelligence', false);
  await expect.poll(async () => (await states(page))['lab-01-central-intelligence']?.state).toBe('loading');
  await go(page, LAB20); // move on before the chunk arrives
  release();
  await expect
    .poll(() => call<{ staleIgnored: number }>(page, 'zoneCounters').then((c) => c.staleIgnored))
    .toBeGreaterThanOrEqual(1);
  expect((await states(page))['lab-01-central-intelligence']).toBeUndefined();
  expect(
    (await call<{ mounted: boolean }>(page, 'zoneGeometry', 'lab-01-central-intelligence')).mounted,
  ).toBe(false);
  expect((await call<{ mounted: boolean }>(page, 'zoneGeometry', LAB20)).mounted).toBe(true);
});

test('a zone that fails to load shows an error and recovers with Retry', async ({ page }) => {
  await page.route(/\/EnvironmentRoom-[^/]+\.js$/, (route) => route.abort());
  await open(page);
  await enterFacility(page);
  const env = 'env-underwater-tank';
  await go(page, env, false);
  await expect(page.getByTestId('zone-error')).toContainText('failed to load');
  expect((await states(page))[env]?.state).toBe('error');
  // Its corridor (separate chunk) still loaded; the previous room was released.
  await expect.poll(async () => (await states(page))['corridor-environments']?.state).toBe('active');
  expect((await states(page))[LAB20]).toBeUndefined();
  await page.unroute(/\/EnvironmentRoom-[^/]+\.js$/);
  await page.getByRole('button', { name: 'Retry' }).click();
  await waitLoaded(page, env);
  await expect(page.getByTestId('zone-error')).toHaveCount(0);
  expect((await call<{ mounted: boolean }>(page, 'zoneGeometry', env)).mounted).toBe(true);
});

test('prefetch: hovering a destination loads its code only (not rendered), at most one at a time', async ({
  page,
}) => {
  await open(page);
  await enterFacility(page);
  await openDirectory(page);
  const lab3 = 'lab-03-autonomous-robot-learning';
  const lab4 = 'lab-04-research-computing';
  await page.getByTestId(`dir-${lab3}`).getByRole('button').hover();
  await expect.poll(async () => (await states(page))[lab3]).toEqual({ state: 'active', role: 'prefetch' });
  expect((await call<{ mounted: boolean }>(page, 'zoneGeometry', lab3)).mounted).toBe(false);
  expect(
    Object.keys(await call<Record<string, Sign>>(page, 'renderedSigns')).some((k) => k.startsWith(lab3)),
  ).toBe(false);
  await page.getByTestId(`dir-${lab4}`).getByRole('button').hover();
  await expect.poll(async () => (await states(page))[lab4]?.role).toBe('prefetch');
  const s = await states(page);
  expect(s[lab3]).toBeUndefined();
  expect(Object.values(s).filter((v) => v.role === 'prefetch')).toHaveLength(1);
});

test('zone transitions never discard workspace layout or engineering project data', async ({ page }) => {
  await open(page);
  await enterFacility(page);
  await page.getByTestId('item-row-bench-c').click();
  await page.getByRole('button', { name: 'Mount here' }).click();
  await expect(page.getByTestId('mounted-bench')).toHaveText('Bench C');
  const cube = (await call<{ nodes: { id: string }[] }>(page, 'queryScene')).nodes[1]!.id;
  const layoutBefore = await call<unknown>(page, 'layout');
  const projectBefore = await call<{ revision: number }>(page, 'project');
  const expected: V3 = [-5, 1.05, -6];
  for (const id of ['lab-12-additive-manufacturing', 'env-wind-tunnel-bay', 'corridor-d-main']) {
    await go(page, id);
    // Lab 20 is unloaded: its bench (and the project mounted on it) are not rendered…
    expect(await call<V3 | null>(page, 'nodeWorldPosition', cube)).toBeNull();
  }
  await go(page, LAB20);
  // …but nothing was discarded: same layout, same project, same placement.
  expect(await call<unknown>(page, 'layout')).toEqual(layoutBefore);
  expect(await call<{ revision: number }>(page, 'project')).toEqual(projectBefore);
  await expect
    .poll(async () => {
      const p = await call<V3 | null>(page, 'nodeWorldPosition', cube);
      return !!p && p.every((v, i) => Math.abs(v - expected[i]!) < 1e-6);
    })
    .toBe(true);
});
