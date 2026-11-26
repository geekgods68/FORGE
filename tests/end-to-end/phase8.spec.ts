import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { stepAssembly } from '../../packages/interop/src/__tests__/step-fixtures';

/**
 * Phase 8 browser demonstrations (brief §33–35), driven through the FORGE UI:
 *  A — external mechanical assembly: STEP import (OCCT in a worker), dimensions/orientation,
 *      provenance, attachment to the native arm, mechanical simulation, STL export,
 *      re-import, preservation report;
 *  B — external circuit: SPICE RC import, connectivity, simulation via a Phase 7 experiment
 *      (τ = RC), parameter variation, SPICE export;
 *  C — VEYRIS arm digital twin with DETERMINISTIC SYNTHETIC telemetry (no hardware in CI):
 *      mapping, connection, live state, stale/disconnect detection, recording, replay,
 *      simulation-vs-observation comparison, research integration, reload, CAD unchanged,
 *      actuation unavailable.
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
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
        )
      : v;
const geometry = async (page: Page) => {
  const p = await call<{ scene: { rootId: string; nodes: Record<string, unknown> } }>(page, 'project');
  return JSON.stringify(
    canon(Object.fromEntries(Object.entries(p.scene.nodes).filter(([k]) => k !== p.scene.rootId))),
  );
};
async function openDialog(page: Page) {
  await page.getByTestId('interop-toggle').click();
  await expect(page.getByTestId('interop-dialog')).toBeVisible();
}

test('Phase 8 A: external STEP assembly → attach to the arm → simulate → export STL → re-import', async ({
  page,
}) => {
  test.setTimeout(240_000);
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-sample').click();
  await page.getByTestId('library-toggle').click();
  const arm = await geometry(page);
  // Select the native gripper body so the import can be attached to it.
  await page.evaluate(() => (window as unknown as { __forge: { project: () => unknown } }).__forge.project());
  await page
    .getByRole('treeitem', { name: /Gripper/i })
    .first()
    .click();

  // 1–3. Import a STEP assembly (bracket plate 60 × 40 × 5 mm with a 10 mm boss) and inspect it.
  await openDialog(page);
  const step = stepAssembly([
    { name: 'Plate', size: [60, 40, 5], at: [0, 0, 0] },
    { name: 'Boss', size: [10, 10, 10], at: [25, 15, 5] },
  ]);
  await page
    .getByTestId('interop-file')
    .setInputFiles({ name: 'bracket.step', mimeType: 'application/step', buffer: Buffer.from(step) });
  await expect(page.getByTestId('interop-format')).toContainText('detected step', { timeout: 60_000 });
  await expect(page.getByTestId('interop-class')).toContainText('tessellated B-rep');
  // Z-up STEP → FORGE +Y up: 60 (x) × 15 (up: 5 + 10) × 40 (depth) mm.
  await expect(page.getByTestId('interop-size')).toContainText('60.000 mm × 15.000 mm × 40.000 mm');
  await expect(page.getByTestId('interop-hierarchy')).toContainText('Plate');
  await expect(page.getByTestId('interop-hierarchy')).toContainText('Boss');
  // 4–5. Insert and attach to the gripper with an explicit mass and the bounding-box collider.
  await page.getByTestId('interop-name').fill('Imported STEP bracket');
  await page.getByTestId('interop-mass').fill('0.03');
  await page.getByTestId('interop-attach').check();
  await expect(page.getByTestId('interop-dryrun')).toContainText('Ready');
  await page.getByTestId('interop-confirm').click();
  await expect(page.getByTestId('interop-message')).toContainText('inserted (one undo step)');
  const imports = await call<
    { id: string; format: string; nodeIds: string[]; status: string; geometryClass: string }[]
  >(page, 'imports');
  expect(imports).toHaveLength(1);
  expect(imports[0]).toMatchObject({
    format: 'step',
    status: 'unmodified',
    geometryClass: 'tessellated-brep',
  });
  const bracket = imports[0]!.nodeIds[0]!;
  await page.getByTestId('interop-close').click();
  await expect(page.getByTestId('provenance-class')).toHaveText('tessellated-brep');
  await expect(page.getByTestId('provenance-status')).toHaveText('unmodified');

  // 6. Supported mechanical simulation: the bracket is welded to the gripper and moves with it.
  await page.getByTestId('mode-simulation').click();
  await expect(page.getByTestId('sim-state')).toHaveText('ready', { timeout: 30_000 });
  await page.getByTestId('sim-start').click();
  await expect(page.getByTestId('sim-state')).toHaveText('running');
  await page.waitForTimeout(1500);
  await page.getByTestId('sim-pause').click();
  const pb = await call<number[] | null>(page, 'simUnitPosition', bracket);
  const pg = await call<number[] | null>(page, 'simUnitPosition', 'gripper');
  expect(pb).not.toBeNull();
  expect(pg).not.toBeNull();
  await page.getByTestId('mode-cad').click();

  // 7. Export the imported part as STL (mm, +Z up).
  await page.getByRole('treeitem', { name: 'Imported STEP bracket' }).click();
  await expect(page.getByTestId('provenance-class')).toHaveText('tessellated-brep');
  await openDialog(page);
  await page.getByTestId('interop-tab-export').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('interop-export').click()]);
  await expect(page.getByTestId('interop-export-report')).toContainText('Discarded');
  const exported = await readFile((await dl.path())!);
  // 8–9. Re-import the exported STL: same dimensions (float32 precision).
  await page.getByTestId('interop-tab-import').click();
  await page
    .getByTestId('interop-file')
    .setInputFiles({ name: 'bracket-export.stl', mimeType: 'model/stl', buffer: exported });
  await expect(page.getByTestId('interop-format')).toContainText('detected stl');
  // The export is world-placed (the bracket rides on the rotated gripper), so the axis order
  // may differ from the source frame; the extents, closure and volume are preserved.
  const size = (await page.getByTestId('interop-size').textContent())!;
  const dims = [...size.matchAll(/([\d.]+) mm/g)]
    .slice(0, 3)
    .map((m) => Number(m[1]))
    .sort((x, y) => x - y);
  expect(dims).toEqual([15, 40, 60]);
  expect(size).toContain('closed, volume 13.000 cm³');
  await expect(page.getByTestId('interop-unsupported')).toContainText('units');
  // Native arm geometry is unchanged apart from the added bracket and its mate.
  const after = JSON.parse(await geometry(page)) as Record<string, unknown>;
  const before = JSON.parse(arm) as Record<string, unknown>;
  for (const id of Object.keys(before)) if (id !== 'grp-arm') expect(after[id]).toEqual(before[id]);
});

test('Phase 8 B: SPICE RC import → connectivity → Phase 7 sweep (τ = RC) → SPICE export', async ({
  page,
}) => {
  test.setTimeout(240_000);
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  await openDialog(page);
  const cir =
    'RC charging (5 V, 1 kOhm, 1 uF)\nV1 in 0 DC 5\nR1 in out 1k\nC1 out 0 1u IC=0\n.tran 2u 6m\n.end\n';
  await page
    .getByTestId('interop-file')
    .setInputFiles({ name: 'rc.cir', mimeType: 'text/plain', buffer: Buffer.from(cir) });
  await expect(page.getByTestId('interop-class')).toContainText('connectivity verified (3 nets, 7 terminals');
  await page.getByTestId('interop-confirm').click();
  await expect(page.getByTestId('interop-message')).toContainText('circuit inserted');
  await page.getByTestId('interop-close').click();
  const circuit = await call<{
    parts: { id: string; type: string }[];
    nets: { name: string; pins: string[] }[];
  }>(page, 'circuit');
  expect(circuit.parts.map((p) => p.id).sort()).toEqual(['C1', 'GND', 'R1', 'V1']);
  expect(circuit.nets.find((n) => n.name === 'out')!.pins.sort()).toEqual(['C1.p1', 'R1.p2']);

  // Phase 7 experiment: vary R1, measure the time to 63.2 % of 5 V on node "out".
  await page.getByTestId('mode-research').click();
  await page.getByTestId('res-template').selectOption('blank');
  await page.getByTestId('res-new').click();
  await page.getByTestId('res-title').fill('Imported RC: R sweep');
  await page.getByTestId('res-title').blur();
  await page.getByTestId('res-var-target').selectOption('electrical.part.R1.resistanceOhm');
  await page.getByTestId('res-var-levels').fill('1000, 2200, 4700');
  await page.getByTestId('res-var-add').click();
  await page.getByText('Custom measurement').click();
  await page.getByTestId('res-meas-name').fill('tau');
  await page.getByTestId('res-meas-signal').selectOption('V(out)');
  await page.getByTestId('res-meas-reduction').selectOption('first-crossing');
  await page.getByPlaceholder('threshold').fill(String(5 * (1 - Math.exp(-1))));
  await page.getByTestId('res-meas-add').click();
  await page.getByTestId('res-duration').fill('0.03');
  await page.getByTestId('res-duration').blur();
  await page.getByTestId('res-rate').fill('100000');
  await page.getByTestId('res-rate').blur();
  await page.getByTestId('res-validate').click();
  await expect(page.getByTestId('res-validation-result')).toContainText('Valid:', { timeout: 30_000 });
  await page.getByTestId('res-launch').click();
  await expect
    .poll(
      async () => (await call<{ progress: { phase: string } | null }>(page, 'research')).progress?.phase,
      { timeout: 120_000 },
    )
    .toBe('completed');
  const r = await call<{
    experiments: {
      title: string;
      runs: { condition: string; state: string; outcomes: Record<string, number | null> }[];
    }[];
  }>(page, 'research');
  const runs = r.experiments.find((e) => e.title === 'Imported RC: R sweep')!.runs;
  expect(runs.length).toBeGreaterThanOrEqual(3);
  for (const run of runs) {
    expect(run.state).toBe('COMPLETED');
    const R = Number(/= (\d+)/.exec(run.condition)?.[1] ?? 1000);
    expect(Math.abs(run.outcomes.tau! - R * 1e-6) / (R * 1e-6)).toBeLessThan(0.01);
  }
  // Export the circuit as SPICE.
  await page.getByTestId('mode-cad').click();
  await openDialog(page);
  await page.getByTestId('interop-tab-export').click();
  await page.getByTestId('interop-export-format').selectOption('spice');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('interop-export').click()]);
  const text = await readFile((await dl.path())!, 'utf8');
  expect(text).toMatch(/^R1 in out 1000$/m);
  expect(text).toMatch(/^C1 out 0 0\.000001 IC=0$/m);
});

test('Phase 8 C: VEYRIS arm digital twin with synthetic telemetry (no hardware)', async ({ page }) => {
  test.setTimeout(240_000);
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-veyris-twin').click();
  await page.getByTestId('library-toggle').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const cad = await geometry(page);
  await page.getByTestId('mode-twin').click();
  // 1–2. Construct the twin: channel mappings validated against the project.
  await page.getByTestId('twin-create').click();
  let tw = await call<{
    twin: { channels: [string, string][] } | null;
    mappingIssues: unknown[];
    actuation: { implemented: boolean };
  }>(page, 'twin');
  expect(tw.twin!.channels).toEqual([
    ['d', 'measured'],
    ['a', 'commanded'],
  ]);
  expect(tw.mappingIssues).toEqual([]);
  expect(tw.actuation.implemented).toBe(false);
  await expect(page.getByTestId('twin-actuation')).toContainText('not available');
  await expect(page.getByTestId('twin-source')).toHaveText('VIRTUAL MODEL ONLY');
  // 3–5. Connect the synthetic adapter; timestamped observations drive the virtual wrist (commanded).
  await page.getByTestId('twin-adapter').selectOption('synthetic');
  await page.getByTestId('twin-connect').click();
  await expect(page.getByTestId('twin-source')).toHaveText('SYNTHETIC TELEMETRY');
  await expect(page.getByTestId('twin-link')).toHaveText('live', { timeout: 10_000 });
  await page.getByTestId('twin-record').click();
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('twin-pose')).toContainText('COMMANDED');
  tw = await call(page, 'twin');
  const t = tw as unknown as {
    device: { deviceId: string };
    samples: Record<string, number>;
    previewWristRad: number | null;
  };
  expect(t.device.deviceId).toBe('SYNTHETIC-ARM-01');
  expect(t.samples.d).toBeGreaterThan(40);
  expect(t.previewWristRad).not.toBeNull();
  await expect(page.getByTestId('twin-chart-d')).toBeVisible();
  // 7. Record.
  await page.getByTestId('twin-stop-record').click();
  await page.getByTestId('twin-disconnect').click();
  await expect(page.getByTestId('twin-link')).toHaveText('disconnected');
  await expect(page.getByTestId('twin-rec-0')).toContainText('SYNTHETIC');
  // 6. Stale and disconnected telemetry: the disconnect + stall scenario.
  await page.getByTestId('twin-synthetic').selectOption('disconnects');
  await page.getByTestId('twin-connect').click();
  await expect(page.getByTestId('twin-link')).toHaveText('live', { timeout: 10_000 });
  await expect(page.getByTestId('twin-link')).toHaveText(/stale|disconnected/, { timeout: 15_000 });
  await page.getByTestId('twin-disconnect').click();
  // 7. Replay (deterministic) and 8. comparison with the co-simulation.
  await page.getByTestId('twin-replay-0').click();
  await expect(page.getByTestId('twin-link')).toHaveText('replay');
  await page.getByTestId('twin-compare-0').click();
  await expect(page.getByTestId('twin-comparison')).toContainText('Observed distance vs simulated', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('twin-chart-residual')).toBeVisible();
  const cmp = (await call<{ comparison: { n: number; rmse: number } }>(page, 'twin')).comparison;
  expect(cmp.n).toBeGreaterThan(40);
  expect(Number.isFinite(cmp.rmse)).toBe(true);
  // 9. Research integration: the recording becomes a SYNTHETIC dataset.
  await page.getByTestId('twin-research-0').click();
  await expect(page.getByTestId('twin-message')).toContainText('SYNTHETIC');
  // Evidence: synthetic data never raises the designation.
  await expect(page.getByTestId('twin-designation-level')).toHaveText('simulated-system');
  // 10. CAD geometry preserved; 11. reload restores the twin configuration and recordings.
  expect(await geometry(page)).toBe(cad);
  await page.reload();
  await ready(page);
  await page.getByTestId('mode-twin').click();
  await expect(page.getByTestId('twin-panel')).toContainText('VEYRIS arm (UNO + HC-SR04 + wrist servo)');
  await expect(page.getByTestId('twin-rec-0')).toContainText('SYNTHETIC');
  expect(await geometry(page)).toBe(cad);
  // 12. No path to physical actuation.
  const policy = await page.evaluate(() => {
    const f = (window as unknown as { __forge: Record<string, unknown> }).__forge;
    return {
      keys: Object.keys(f).filter((k) => /actuat|command|write|send/i.test(k)),
      twin: (f.twin as () => { actuation: unknown })().actuation,
    };
  });
  expect(policy.keys).toEqual([]);
  expect(policy.twin).toMatchObject({ implemented: false });
});

test('Phase 8: URDF robot (with an STL mesh) becomes a simulatable FORGE assembly', async ({ page }) => {
  test.setTimeout(120_000);
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  const urdf = `<?xml version="1.0"?>
<robot name="two_link">
  <link name="base"><visual><geometry><box size="0.1 0.1 0.02"/></geometry></visual>
    <inertial><mass value="1"/><inertia ixx="0.001" iyy="0.001" izz="0.0017" ixy="0" ixz="0" iyz="0"/></inertial></link>
  <link name="arm"><visual><origin xyz="0 0 0.05"/><geometry><cylinder radius="0.01" length="0.1"/></geometry></visual>
    <inertial><origin xyz="0 0 0.05"/><mass value="0.1"/><inertia ixx="0.00009" iyy="0.00009" izz="0.000005" ixy="0" ixz="0" iyz="0"/></inertial></link>
  <link name="tool"><visual><geometry><mesh filename="package://two_link/meshes/tool.stl" scale="0.001 0.001 0.001"/></geometry></visual>
    <inertial><mass value="0.02"/><inertia ixx="1e-6" iyy="1e-6" izz="1e-6" ixy="0" ixz="0" iyz="0"/></inertial></link>
  <joint name="shoulder" type="revolute"><parent link="base"/><child link="arm"/><origin xyz="0 0 0.02"/><axis xyz="0 1 0"/><limit lower="-1.5" upper="1.5" effort="2" velocity="2"/></joint>
  <joint name="wrist" type="continuous"><parent link="arm"/><child link="tool"/><origin xyz="0 0 0.1"/><axis xyz="0 0 1"/><limit effort="0.5" velocity="4"/></joint>
</robot>`;
  // 10 × 10 × 10 mm binary STL cube for the tool mesh.
  const P = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [0, 10, 0],
    [0, 0, 10],
    [10, 0, 10],
    [10, 10, 10],
    [0, 10, 10],
  ];
  const tris = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ].flatMap(([a, b, c, d]) => [
    [a, b, c],
    [a, c, d],
  ]);
  const stl = Buffer.alloc(84 + tris.length * 50);
  stl.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) =>
    t.forEach((v, k) => P[v!]!.forEach((x, j) => stl.writeFloatLE(x, 84 + i * 50 + 12 + k * 12 + j * 4))),
  );
  await openDialog(page);
  await page.getByTestId('interop-file').setInputFiles([
    { name: 'two_link.urdf', mimeType: 'application/xml', buffer: Buffer.from(urdf) },
    { name: 'tool.stl', mimeType: 'model/stl', buffer: stl },
  ]);
  await expect(page.getByTestId('interop-class')).toContainText('3 links, 2 joints; 1 other file(s)');
  await expect(page.getByTestId('interop-dryrun')).toContainText('Ready');
  await page.getByTestId('interop-confirm').click();
  await expect(page.getByTestId('interop-message')).toContainText('inserted');
  const imp = (
    await call<{ format: string; referencedFiles: { name: string }[]; summary: Record<string, unknown> }[]>(
      page,
      'imports',
    )
  )[0]!;
  expect(imp.format).toBe('urdf');
  expect(imp.referencedFiles.map((f) => f.name)).toEqual(['tool.stl']);
  expect(imp.summary).toMatchObject({
    links: 3,
    'joints.revolute': 1,
    'joints.continuous': 1,
    meshes: 1,
    inertials: 3,
  });
  await page.getByTestId('interop-close').click();
  await page.getByTestId('mode-simulation').click();
  await expect(page.getByTestId('sim-state')).toHaveText('ready', { timeout: 30_000 });
});
