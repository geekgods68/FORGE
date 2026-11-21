import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/** External model inspection: valid GLB measured in the confirmed unit/up-axis; invalid files explained. */
function glb(positions: number[]): Buffer {
  const bin = Buffer.from(new Float32Array(positions).buffer);
  const min = [0, 1, 2].map((i) => Math.min(...positions.filter((_, k) => k % 3 === i)));
  const max = [0, 1, 2].map((i) => Math.max(...positions.filter((_, k) => k % 3 === i)));
  let json = JSON.stringify({
    asset: { version: '2.0', generator: 'FORGE e2e' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max }],
  });
  while (json.length % 4) json += ' ';
  const j = Buffer.from(json);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(j.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, j, bh, bin]);
}

test('a GLB is validated, measured in the confirmed unit and up-axis, and gains no engineering data', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
  await page.getByTestId('library-toggle').click();
  await page.getByText('Inspect an external 3D model').click();
  // A 100 × 20 × 50 (model units) triangle pair.
  const file = glb([0, 0, 0, 100, 0, 0, 0, 20, 50, 100, 20, 50, 0, 20, 0, 100, 0, 50]);
  await page
    .getByTestId('glb-input')
    .setInputFiles({ name: 'bracket.glb', mimeType: 'model/gltf-binary', buffer: file });
  await expect(page.getByTestId('glb-size')).toHaveText('100.0 mm × 20.0 mm × 50.0 mm');
  await page.getByTestId('glb-up').selectOption('Z');
  await expect(page.getByTestId('glb-size')).toHaveText('100.0 mm × 50.0 mm × 20.0 mm');
  await page.getByTestId('glb-unit').selectOption('cm');
  await expect(page.getByTestId('glb-size')).toHaveText('1000.0 mm × 500.0 mm × 200.0 mm');
  await expect(page.getByTestId('glb-hash')).toContainText('sha256:');
  await expect(page.getByTestId('glb-report')).toContainText('none inferred');
  // Nothing entered the project.
  const comps = await page.evaluate(
    () =>
      Object.values(
        (
          window as unknown as {
            __forge: { project: () => { scene: { nodes: Record<string, { kind: string }> } } };
          }
        ).__forge.project().scene.nodes,
      ).filter((n) => n.kind === 'component-instance').length,
  );
  expect(comps).toBe(0);
  // Invalid file: explained, not loaded.
  await page.getByTestId('glb-input').setInputFiles({
    name: 'bad.glb',
    mimeType: 'model/gltf-binary',
    buffer: Buffer.from('definitely not glTF'),
  });
  await expect(page.getByTestId('glb-issues')).toContainText('Not a GLB file');
});

type F = Record<string, (...a: never[]) => unknown>;
const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page
    .evaluate(
      ([n, a]) =>
        ((window as unknown as { __forge: F }).__forge[n as string] as (...x: unknown[]) => unknown)(
          ...(a as unknown[]),
        ),
      [name, args] as const,
    )
    .catch((e: Error) => {
      throw new Error(`__forge.${name}: ${e.message}`);
    }) as Promise<T>;
/** Rendered model state, or null until the viewport's diagnostics are registered (retried by poll). */
const models = (page: Page) =>
  page.evaluate(() => {
    const f = (window as unknown as { __forge?: { modelInstances?: () => unknown } }).__forge;
    return (f?.modelInstances?.() ?? null) as { loaded: number; loading: number; missing: number } | null;
  });
const firstFrame = (page: Page) =>
  page.waitForFunction(
    () =>
      ((window as unknown as { __forge?: { render?: () => { frames: number } } }).__forge?.render?.()
        .frames ?? 0) >= 1,
  );
async function boot(page: Page) {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await firstFrame(page);
}

test('GLB → persistent custom component → instance survives reload; bundle carries the asset; a missing asset is a labelled placeholder', async ({
  page,
  browser,
}) => {
  await boot(page);
  expect(await call<string>(page, 'assetStoreKind')).toBe('indexeddb');
  await page.getByTestId('library-toggle').click();
  await page.getByText('Inspect an external 3D model').click();
  const file = glb([0, 0, 0, 100, 0, 0, 0, 20, 50, 100, 20, 50, 0, 20, 0, 100, 0, 50]);
  await page
    .getByTestId('glb-input')
    .setInputFiles({ name: 'bracket.glb', mimeType: 'model/gltf-binary', buffer: file });
  await expect(page.getByTestId('glb-size')).toHaveText('100.0 mm × 20.0 mm × 50.0 mm');
  await page.getByTestId('glb-name').fill('Test bracket');
  await page.getByTestId('glb-save-button').click();
  await expect(page.getByTestId('custom-models')).toContainText('Test bracket');
  await page.getByTestId('custom-insert-Test bracket').click();
  await page.getByTestId('library-toggle').click();
  await expect.poll(() => models(page)).toEqual({ loaded: 1, loading: 0, missing: 0 });
  expect(await call<string[]>(page, 'missingAssets')).toEqual([]);

  // Save + reload: the library entry and the instance's bytes persist locally (IndexedDB).
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await page.waitForFunction(
    () => (window as unknown as { __forge?: { ready?: boolean } }).__forge?.ready === true,
  );
  await expect.poll(() => models(page)).toEqual({ loaded: 1, loading: 0, missing: 0 });
  expect((await call<{ name: string }[]>(page, 'customModels')).map((m) => m.name)).toEqual(['Test bracket']);

  // Portable bundle: contains the asset bytes.
  const dl = page.waitForEvent('download');
  await page.getByTestId('export-bundle').click();
  const bundlePath = await (await dl).path();
  const bundle = readFileSync(bundlePath!, 'utf8');
  const parsed = JSON.parse(bundle) as { format: string; assets: { hash: string }[] };
  expect(parsed.format).toBe('forge-bundle');
  expect(parsed.assets).toHaveLength(1);
  // Plain project file (no assets) for the missing-asset case.
  const dl2 = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const plain = readFileSync((await (await dl2).path())!, 'utf8');

  // A fresh browser profile (empty asset store).
  const ctx = await browser.newContext();
  const fresh = await ctx.newPage();
  await boot(fresh);
  // Plain project: the model is a labelled placeholder and reported missing; data is kept.
  await fresh
    .getByTestId('import-input')
    .setInputFiles({ name: 'p.forge.json', mimeType: 'application/json', buffer: Buffer.from(plain) });
  await expect.poll(() => models(fresh)).toEqual({ loaded: 0, loading: 0, missing: 1 });
  expect(await call<string[]>(fresh, 'missingAssets')).toEqual([parsed.assets[0]!.hash]);
  // Exporting a bundle now is refused (never a silently broken bundle).
  await fresh.getByTestId('export-bundle').click();
  await expect(fresh.getByTestId('status')).toContainText('not in this browser');
  // Importing the bundle restores the asset; the model loads.
  await fresh.getByTestId('import-input').setInputFiles({
    name: 'p.forge-bundle.json',
    mimeType: 'application/json',
    buffer: Buffer.from(bundle),
  });
  await expect.poll(() => models(fresh)).toEqual({ loaded: 1, loading: 0, missing: 0 });
  expect(await call<string[]>(fresh, 'missingAssets')).toEqual([]);
  // A tampered bundle is refused and stores nothing.
  const tampered = JSON.parse(bundle) as { assets: { base64: string }[] };
  tampered.assets[0]!.base64 = Buffer.from('tampered').toString('base64');
  await fresh.getByTestId('import-input').setInputFiles({
    name: 't.forge-bundle.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(tampered)),
  });
  await expect(fresh.getByTestId('status')).toContainText('integrity');
  await ctx.close();
});
