import { beforeAll, describe, expect, it } from 'vitest';
import { loadRapier, VALIDATION_CASES, type Rapier } from '../index';

/** Numerical reference cases (docs/PHYSICS_VALIDATION.md): each must meet its stated tolerances. */
let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

describe('physics numerical validation', () => {
  for (const c of VALIDATION_CASES)
    it(c.name, () => {
      const r = c(R);
      const failed = r.metrics
        .filter((m) => !m.pass)
        .map(
          (m) =>
            `${m.name}: measured ${m.measured}, reference ${m.reference}, error ${m.error} > ${m.tolerance}`,
        );
      expect(failed).toEqual([]);
      expect(r.pass).toBe(true);
    });
});

/** FORGE_VALIDATION_OUT=1 writes the full results (conditions, references, errors) to docs/archive. */
describe.skipIf(process.env.FORGE_VALIDATION_OUT !== '1')('validation record', () => {
  it('writes docs/archive/phase5-validation.json', async () => {
    const { writeFileSync } = await import('node:fs');
    const results = VALIDATION_CASES.map((c) => c(R));
    writeFileSync(
      new URL('../../../../docs/archive/phase5-validation.json', import.meta.url),
      JSON.stringify(
        { engine: `rapier3d-compat ${R.version()}`, when: new Date().toISOString(), results },
        null,
        2,
      ) + '\n',
    );
    expect(results.every((r) => r.pass)).toBe(true);
  });
});
