import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 7 browser acceptance workflow (brief §29).
 *  A — robotic-arm payload experiment built step by step in Research mode, run, analysed,
 *      reported, exported, reloaded and reopened; the CAD design is unchanged throughout.
 *  B — the core workflow repeated on an electronics experiment (RC charging circuit sweep).
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
  projectId: string;
  experiments: {
    id: string;
    title: string;
    revision: number;
    variables: number;
    measurements: number;
    notes: number;
    runs: { id: string; state: string; condition: string; outcomes: Record<string, number | null> }[];
  }[];
  selected: string | null;
  progress: { phase: string; total: number; done: number; completed: number; failed: number } | null;
  persistent: boolean;
  integrity: { id: string; kind: string }[];
};
const research = (page: Page) => call<Research>(page, 'research');
/** Engineering geometry: every scene node except the root (setups are data, not geometry). */
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
const cad = async (page: Page) => {
  const p = await call<{ scene: { rootId: string; nodes: Record<string, unknown> } }>(page, 'project');
  return JSON.stringify(
    canon(Object.fromEntries(Object.entries(p.scene.nodes).filter(([k]) => k !== p.scene.rootId))),
  );
};
async function pickOption(page: Page, testId: string, contains: string) {
  const labels = await page.getByTestId(testId).locator('option').allTextContents();
  const label = labels.find((l) => l.includes(contains));
  expect(label, `option containing “${contains}” in ${testId}`).toBeTruthy();
  await page.getByTestId(testId).selectOption({ label: label! });
}
async function commit(page: Page, testId: string, value: string) {
  const el = page.getByTestId(testId);
  await el.fill(value);
  await el.blur();
}

test('Phase 7 A: robotic-arm payload experiment — design, run, analyse, report, export, reload', async ({
  page,
}) => {
  test.setTimeout(300_000);
  page.on('dialog', (d) => d.accept());
  // 1–2. Launch and open the VEYRIS robotic-arm project.
  await page.goto('/');
  await ready(page);
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-sample').click();
  await expect(page.getByTestId('status')).toContainText('robotic-arm sample');
  await page.getByTestId('library-toggle').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const cadBefore = await cad(page);
  const revisionBefore = (await call<{ revision: number }>(page, 'project')).revision;

  // 3–4. Research mode; a new (blank) experiment.
  await page.getByTestId('mode-research').click();
  await expect(page.getByTestId('research-panel')).toBeVisible();
  await page.getByTestId('res-template').selectOption('blank');
  await page.getByTestId('res-new').click();
  await expect(page.getByTestId('research-workspace')).toBeVisible();

  // 5–6. Research question and hypothesis.
  await commit(page, 'res-title', 'Payload vs joint error');
  await commit(
    page,
    'res-question',
    'How does end-effector payload mass affect shoulder tracking error and motor effort?',
  );
  await commit(page, 'res-hypothesis', 'Shoulder tracking error increases with payload mass.');

  // 7. Payload mass as the independent variable with three conditions.
  await page.getByTestId('res-var-target').selectOption('physics.payload.payload-ee.massKg');
  await page.getByTestId('res-var-levels').fill('0.05, 0.15, 0.3');
  await page.getByTestId('res-var-add').click();
  await expect(page.getByTestId('res-variables')).toContainText('physics.payload.payload-ee.massKg');

  // 8. Joint error and motor effort measurements (presets derived from the model's signals).
  await expect(page.getByTestId('res-meas-preset').locator('option')).not.toHaveCount(1, { timeout: 30_000 });
  await pickOption(page, 'res-meas-preset', 'shoulder tracking error');
  await page.getByTestId('res-meas-preset-add').click();
  await pickOption(page, 'res-meas-preset', 'shoulder RMS effort');
  await page.getByTestId('res-meas-preset-add').click();
  await expect(page.getByTestId('res-measurements')).toContainText('tracking error');
  await expect(page.getByTestId('res-measurements')).toContainText('RMS effort');
  await page.getByTestId('res-relationship').selectOption('increase');
  await pickOption(page, 'res-hyp-var', 'ayload');
  await pickOption(page, 'res-hyp-outcome', 'tracking error');

  // 9. Run duration.
  await commit(page, 'res-duration', '1');
  let r = await research(page);
  const exp = r.experiments.find((e) => e.title === 'Payload vs joint error')!;
  expect(exp.variables).toBe(1);
  expect(exp.measurements).toBe(2);

  // 10. Validate the design.
  await page.getByTestId('res-validate').click();
  await expect(page.getByTestId('res-validation-result')).toContainText('Valid:', { timeout: 30_000 });

  // 11–12. Launch and observe progress.
  await page.getByTestId('res-launch').click();
  await page.getByTestId('res-tab-runs').click();
  await expect(page.getByTestId('res-progress-text')).toBeVisible();
  await expect
    .poll(async () => (await research(page)).progress?.phase, { timeout: 240_000 })
    .toBe('completed');
  r = await research(page);
  const runs = r.experiments.find((e) => e.id === exp.id)!.runs;
  expect(runs.length).toBeGreaterThanOrEqual(3);
  expect(runs.every((x) => x.state === 'COMPLETED')).toBe(true);
  expect(r.integrity).toEqual([]);
  // The servo holds its target, so the payload shows up in effort: RMS shoulder effort rises
  // monotonically with payload mass across the three payload conditions.
  const effortKey = Object.keys(runs[0]!.outcomes).find((k) => k.includes('effort-rms'))!;
  const byMass = runs
    .map((x) => ({ m: /payload mass = ([\d.]+)/.exec(x.condition), e: x.outcomes[effortKey]! }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]));
  expect(byMass.length).toBe(3);
  expect(byMass[0]!.e).toBeLessThan(byMass[1]!.e);
  expect(byMass[1]!.e).toBeLessThan(byMass[2]!.e);

  // 13. Open an individual result: run detail with integrity and a quantitative trace.
  await page.getByTestId('res-run-row-0').click();
  await expect(page.getByTestId('res-run-integrity')).toHaveText('integrity verified');
  await expect(page.getByTestId('res-run-chart')).toBeVisible({ timeout: 30_000 });

  // 14–15. Compare conditions; quantitative charts.
  await page.getByTestId('res-tab-results').click();
  await expect(page.getByTestId('res-summary')).toContainText('payload mass = 0.3');
  await expect(page.getByTestId('res-chart-response')).toBeVisible();
  await expect(page.getByTestId('res-chart-box')).toBeVisible();
  await page.getByTestId('res-tab-analysis').click();
  const conds = await page.getByTestId('res-compare-a').locator('option').allTextContents();
  expect(conds.length).toBeGreaterThanOrEqual(3);
  await page.getByTestId('res-compare-b').selectOption({ index: conds.length - 1 });
  await expect(page.getByTestId('res-compare-result')).toContainText('Difference of means');
  await expect(page.getByTestId('res-config-diff')).toContainText('payload');

  // 16. Warnings and assumptions: deterministic replicates are flagged, and the validation status
  //     states that no empirical comparison exists.
  await page.getByTestId('res-tab-validation').click();
  await expect(page.getByTestId('res-validation-status')).toContainText('Validation status');

  // Notebook entry (interpretation stays separate from records).
  await page.getByTestId('res-tab-notebook').click();
  await page.getByTestId('res-note-text').fill('Observation: error grows with payload in this model.');
  await page.getByTestId('res-note-save').click();
  await expect(page.getByTestId('res-note')).toHaveCount(1);

  // 17. Research summary.
  await page.getByTestId('res-tab-report').click();
  await page.getByTestId('res-report-generate').click();
  const report = page.getByTestId('res-report');
  await expect(report).toContainText('1. Research question');
  await expect(report).toContainText('4. Assumptions');
  await expect(report).toContainText('11. Validation status');
  await expect(report).toContainText('12. Limitations');

  // 18. Export the experiment with its raw data.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('res-export').click()]);
  const bundle = JSON.parse(await readFile((await dl.path())!, 'utf8')) as {
    experiment: { id: string };
    runs: unknown[];
  };
  expect(bundle.experiment.id).toBe(exp.id);
  expect(bundle.runs.length).toBe(runs.length);
  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('res-export-csv').click(),
  ]);
  expect((await readFile((await csv.path())!, 'utf8')).split('\n').length).toBeGreaterThan(runs.length);

  // 19–21. Reload, reopen the experiment: protocol and results intact.
  await page.reload();
  await ready(page);
  await page.getByTestId('mode-research').click();
  await page.getByTestId(`res-exp-${exp.id}`).click();
  await expect(page.getByTestId('res-question')).toHaveValue(/payload mass/);
  await expect(page.getByTestId('res-hypothesis')).toHaveValue(/increases with payload/);
  const after = (await research(page)).experiments.find((e) => e.id === exp.id)!;
  expect(after.runs).toEqual(runs);
  expect(after.notes).toBe(1);
  await page.getByTestId('res-tab-runs').click();
  await page.getByTestId('res-run-row-0').click();
  await expect(page.getByTestId('res-run-integrity')).toHaveText('integrity verified');
  if ((await research(page)).persistent)
    await expect(page.getByTestId('res-run-chart')).toBeVisible({ timeout: 30_000 });

  // 22. The CAD design is unchanged and no engineering command was recorded by research.
  expect(await cad(page)).toBe(cadBefore);
  expect((await call<{ revision: number }>(page, 'project')).revision).toBe(revisionBefore);
});

test('Phase 7 B: electronics experiment — RC charging sweep end to end', async ({ page }) => {
  test.setTimeout(240_000);
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await ready(page);
  await page.getByTestId('library-toggle').click();
  await page.getByTestId('library-open-rc-study').click();
  await expect(page.getByTestId('status')).toContainText('RC charging');
  await page.getByTestId('library-toggle').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const cadBefore = await cad(page);

  await page.getByTestId('mode-research').click();
  await pickOption(page, 'res-template', 'RC sweep');
  await page.getByTestId('res-new').click();
  await expect(page.getByTestId('res-question')).not.toHaveValue('');
  await expect(page.getByTestId('res-model-kind')).toHaveValue('circuit');

  await page.getByTestId('res-validate').click();
  await expect(page.getByTestId('res-validation-result')).toContainText('Valid:', { timeout: 30_000 });
  await page.getByTestId('res-launch').click();
  await expect
    .poll(async () => (await research(page)).progress?.phase, { timeout: 180_000 })
    .toBe('completed');
  const r = await research(page);
  const exp = r.experiments.find((e) => e.id === 'exp-d-rc')!;
  expect(exp.runs.length).toBe(9);
  expect(exp.runs.every((x) => x.state === 'COMPLETED')).toBe(true);
  // Time constant tracks R·C within 1 % for every condition (unit: s).
  for (const run of exp.runs) {
    const m = /Resistance = (\d+).*Capacitance = ([\d.]+)/.exec(run.condition);
    expect(m, run.condition).toBeTruthy();
    const expected = Number(m![1]) * Number(m![2]) * 1e-6;
    expect(Math.abs(run.outcomes.tau! - expected) / expected).toBeLessThan(0.01);
  }

  await page.getByTestId('res-tab-results').click();
  await expect(page.getByTestId('res-summary')).toBeVisible();
  await expect(page.getByTestId('res-chart-heatmap')).toBeVisible();
  await page.getByTestId('res-tab-report').click();
  await page.getByTestId('res-report-generate').click();
  await expect(page.getByTestId('res-report')).toContainText('8. Results');

  await page.reload();
  await ready(page);
  await page.getByTestId('mode-research').click();
  await page.getByTestId('res-exp-exp-d-rc').click();
  expect((await research(page)).experiments.find((e) => e.id === 'exp-d-rc')!.runs).toEqual(exp.runs);
  expect(await cad(page)).toBe(cadBefore);
});
