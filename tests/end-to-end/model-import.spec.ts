import { expect, test } from '@playwright/test';

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
