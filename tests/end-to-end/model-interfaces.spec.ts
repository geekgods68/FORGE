import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { glb } from './fixtures/glb';

/**
 * Phase 4.1 — imported GLB components get USER-DECLARED connection interfaces:
 * define one (validated), see its marker, undo/redo it, save it to the library component,
 * mate the model to a catalogue part (drag-to-snap), and keep everything across save and
 * reload. A project written before Phase 4.1 (model without interfaces) still loads.
 */
type V3 = [number, number, number];
type Q = [number, number, number, number];
type F = Record<string, (...a: never[]) => unknown>;
type Ifc = { id: string; name: string; position: V3; direction: V3; compatibility: string[] };
type Node = {
  id: string;
  kind: string;
  name: string;
  parentId: string | null;
  model?: { interfaces: Ifc[]; assetHash: string };
  mechanical?: {
    mates: {
      id: string;
      a: { nodeId: string; ref: { interfaceId?: string } };
      b: { nodeId: string; ref: { interfaceId?: string } };
    }[];
  };
};

const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      ((window as unknown as { __forge: F }).__forge[n as string] as (...x: unknown[]) => unknown)(
        ...(a as unknown[]),
      ),
    [name, args] as const,
  ) as Promise<T>;
const nodes = async (page: Page) =>
  (await call<{ scene: { nodes: Record<string, Node> } }>(page, 'project')).scene.nodes;
const ready = (page: Page) =>
  page.waitForFunction(
    () =>
      (window as unknown as { __forge?: { ready?: boolean; render?: () => { frames: number } } }).__forge
        ?.ready === true &&
      ((window as unknown as { __forge: { render?: () => { frames: number } } }).__forge.render?.().frames ??
        0) >= 1,
  );
/** Select a tree row, scrolling the virtualized hierarchy until it is rendered. */
async function selectRow(page: Page, id: string) {
  const row = page.getByTestId(`tree-row-${id}`);
  // The tree is virtualized: scroll explicitly (top, then bottom) until the row is rendered.
  for (const top of [0, 1e6]) {
    await page.getByTestId('hierarchy-scroll').evaluate((el, t) => ((el as HTMLElement).scrollTop = t), top);
    await page.waitForTimeout(50);
    if ((await row.count()) > 0) break;
  }
  await row.click();
}
const rotate = (q: Q, v: V3): V3 => {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0]! + (y * t[2]! - z * t[1]!),
    v[1] + w * t[1]! + (z * t[0]! - x * t[2]!),
    v[2] + w * t[2]! + (x * t[1]! - y * t[0]!),
  ];
};
const worldPoint = async (page: Page, id: string, local: V3): Promise<V3> => {
  const w = await call<{ position: V3; rotation: Q }>(page, 'getWorldTransform', id);
  const r = rotate(w.rotation, local);
  return [w.position[0] + r[0], w.position[1] + r[1], w.position[2] + r[2]];
};

test('GLB component: declare an interface, marker, undo/redo, library save, snap-mate to a screw, persist; legacy file loads', async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  // Robotic arm sample + an imported block (100 × 20 × 50 mm) saved as a custom component.
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-sample').click();
  await expect(page.getByTestId('status')).toContainText('robotic-arm sample');
  await page.getByText('Inspect an external 3D model').click();
  await page.getByTestId('glb-input').setInputFiles({
    name: 'mount-block.glb',
    mimeType: 'model/gltf-binary',
    buffer: glb([0, 0, 0, 100, 0, 0, 0, 20, 50, 100, 20, 50, 0, 20, 0, 100, 0, 50]),
  });
  await expect(page.getByTestId('glb-size')).toHaveText('100.0 mm × 20.0 mm × 50.0 mm');
  await expect(page.getByTestId('glb-report')).toContainText('none inferred');
  await page.getByTestId('glb-name').fill('Mount block');
  await page.getByTestId('glb-save-button').click();
  await expect(page.getByTestId('custom-models')).toContainText('0 interfaces');
  await page.getByTestId('custom-insert-Mount block').click();
  await page.getByTestId('library-toggle').click();
  const modelId = Object.values(await nodes(page)).find((n) => n.kind === 'model-instance')!.id;

  // Legacy compatibility: the same project without the new `interfaces` field still loads.
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const legacy = JSON.parse(readFileSync((await (await dl).path())!, 'utf8')) as {
    scene: { nodes: Record<string, { model?: Record<string, unknown> }> };
  };
  expect(legacy.scene.nodes[modelId]!.model!.interfaces).toEqual([]);
  delete legacy.scene.nodes[modelId]!.model!.interfaces;
  await page.getByTestId('import-input').setInputFiles({
    name: 'legacy.forge.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(legacy)),
  });
  await expect.poll(async () => (await nodes(page))[modelId]?.model?.interfaces ?? null).toEqual([]);

  // Declare an interface on the instance (nothing is inferred: the list starts empty).
  await selectRow(page, modelId);
  const mi = page.getByTestId('model-interfaces');
  await expect(mi).toContainText('Connection interfaces (0)');
  await expect(mi).toContainText('never inferred');
  await page.getByTestId('model-interface-add').click();
  const form = page.getByTestId('model-interface-form');
  await form.getByLabel('Interface name').fill('Mount hole');
  await form.getByLabel('Interface type').selectOption('bolt-hole');
  await form.getByLabel('Interface gender').selectOption('female');
  await form.getByLabel('Interface position X (mm)').fill('50');
  await form.getByLabel('Interface position Y (mm)').fill('20');
  await form.getByLabel('Interface position Z (mm)').fill('25');
  await form.getByLabel('Interface mounting axis').selectOption('+Y');
  await form.getByLabel('Interface diameter (mm)').fill('4.5');
  // Validation: a compatibility tag is required.
  await page.getByTestId('model-interface-apply').click();
  await expect(page.getByTestId('model-interface-issues')).toContainText('at least one compatibility tag');
  expect((await nodes(page))[modelId]!.model!.interfaces).toEqual([]);
  await form.getByLabel('Interface compatibility tags').fill('M4-clearance');
  await page.getByTestId('model-interface-apply').click();
  await expect(mi).toContainText('Connection interfaces (1)');
  const ifc = (await nodes(page))[modelId]!.model!.interfaces[0]!;
  expect(ifc).toMatchObject({
    id: 'mount-hole',
    type: 'bolt-hole',
    gender: 'female',
    direction: [0, 1, 0],
    compatibility: ['M4-clearance'],
    dimensions: { diameter: 0.0045 },
  });
  expect(ifc.position[0]).toBeCloseTo(0.05, 12);
  expect(ifc.position[1]).toBeCloseTo(0.02, 12);
  expect(ifc.position[2]).toBeCloseTo(0.025, 12);
  // Marker drawn on the model.
  await expect
    .poll(async () => (await call<Record<string, string[]>>(page, 'frameMarkers'))['model-interfaces'])
    .toEqual(['mount-hole']);
  // A duplicate id is refused.
  await page.getByTestId('model-interface-add').click();
  await form.getByLabel('Interface name').fill('Mount hole');
  await form.getByLabel('Interface compatibility tags').fill('M4-clearance');
  await page.getByTestId('model-interface-apply').click();
  await expect(page.getByTestId('model-interface-issues')).toContainText('duplicate interface id');
  await form.getByRole('button', { name: 'Cancel' }).click();

  // Undo / redo the declaration.
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await nodes(page))[modelId]!.model!.interfaces.length).toBe(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await nodes(page))[modelId]!.model!.interfaces.length).toBe(1);

  // Save the declaration to the reusable custom component.
  await selectRow(page, modelId);
  await expect(page.getByTestId('model-interface-library-state')).toContainText('differs');
  await page.getByTestId('model-interface-save-library').click();
  await expect(page.getByTestId('model-interface-library-state')).toContainText('same as this instance');
  expect((await call<{ interfaces: Ifc[] }[]>(page, 'customModels'))[0]!.interfaces.map((i) => i.id)).toEqual(
    ['mount-hole'],
  );

  // Mate it: snap the block's declared hole onto screw 2's thread (compatible: M4-clearance).
  await selectRow(page, 'base-plate');
  await page.getByTestId('frame-selection').click();
  await selectRow(page, modelId);
  await page.getByTestId('tool-mate-snap').click();
  await expect(page.getByTestId('snap-hint')).toContainText('compatible pairing');
  const grab = (await call<{ x: number; y: number }>(page, 'bodyScreenPoint', modelId))!;
  const s = (await call<{ x: number; y: number }>(page, 'interfaceScreenPoint', modelId, 'mount-hole'))!;
  const t = (await call<{ x: number; y: number }>(page, 'interfaceScreenPoint', 'screw-2', 'thread'))!;
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + (t.x - s.x), grab.y + (t.y - s.y), { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => (await call<{ pending: { chosen: string } | null }>(page, 'snapState')).pending?.chosen)
    .toBe(`mount-hole|screw-2|thread`);
  await expect(page.getByTestId('snap-message')).toContainText('Preview');
  await page.getByTestId('snap-confirm').click();
  await page.getByTestId('tool-mate-snap').click();
  const after = await nodes(page);
  expect(after[modelId]!.parentId).toBe('grp-arm'); // inserted into the assembly in the same step
  const m = after['grp-arm']!.mechanical!.mates.find((x) => x.b.nodeId === modelId)!;
  expect(m).toMatchObject({
    a: { nodeId: 'screw-2', ref: { interfaceId: 'thread' } },
    b: { ref: { interfaceId: 'mount-hole' } },
  });
  const hole = await worldPoint(page, modelId, ifc.position);
  const thread = await worldPoint(page, 'screw-2', [0, 0, 0]);
  expect(Math.hypot(hole[0] - thread[0], hole[1] - thread[1], hole[2] - thread[2])).toBeLessThan(1e-9);

  // The mate form offers the imported model's declared interface too.
  await selectRow(page, 'grp-arm');
  await page.getByTestId('new-mate').locator('summary').click();
  await page.getByLabel('Mate body A').selectOption(modelId);
  await expect(page.getByLabel('Mate interface A').locator('option')).toContainText(['Mount hole']);

  // Save and reload: the interface, the mate and the library definition persist.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await ready(page);
  await page.getByTestId('view-project').click();
  await expect
    .poll(async () => (await nodes(page))[modelId]?.model?.interfaces.map((i) => i.id) ?? null)
    .toEqual(['mount-hole']);
  expect((await nodes(page))['grp-arm']!.mechanical!.mates.some((x) => x.b.nodeId === modelId)).toBe(true);
  expect((await call<{ interfaces: Ifc[] }[]>(page, 'customModels'))[0]!.interfaces.length).toBe(1);
  await page.getByTestId('library-toggle').click();
  await expect(page.getByTestId('custom-models')).toContainText('1 interface');
  // Removing an interface a mate uses is refused (the relationship would be orphaned).
  await page.getByTestId('library-toggle').click();
  await selectRow(page, modelId);
  await page.getByRole('button', { name: 'Delete interface Mount hole' }).click();
  await expect(page.getByTestId('model-interface-issues')).toContainText('in use');
  expect((await nodes(page))[modelId]!.model!.interfaces.length).toBe(1);
});
