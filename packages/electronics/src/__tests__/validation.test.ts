import { loadRapier, type Rapier } from '@forge/physics';
import { beforeAll, describe, expect, it } from 'vitest';
import { ANALOG_VALIDATION_CASES } from '../validation/analog';
import { COSIM_PHYSICS_VALIDATION_CASES, COSIM_VALIDATION_CASES } from '../validation/cosim';
import { DIGITAL_VALIDATION_CASES } from '../validation/digital';
import type { ElectricalValidationResult } from '../validation/record';

/** Embedded, sensor and actuator reference cases (docs/ELECTRICAL_VALIDATION.md). */
let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});
const failures = (r: ElectricalValidationResult) =>
  r.metrics
    .filter((m) => !m.pass)
    .map(
      (m) => `${m.name}: measured ${m.measured}, reference ${m.reference}, error ${m.error} > ${m.tolerance}`,
    );

describe('embedded / sensor / actuator validation', () => {
  for (const c of COSIM_VALIDATION_CASES)
    it(c.name, () => {
      expect(failures(c())).toEqual([]);
    });
  for (const c of COSIM_PHYSICS_VALIDATION_CASES)
    it(c.name, () => {
      expect(failures(c(R))).toEqual([]);
    });
});

/** FORGE_VALIDATION_OUT=1 writes every Phase 6 reference case to docs/archive. */
describe.skipIf(process.env.FORGE_VALIDATION_OUT !== '1')('validation record', () => {
  it('writes docs/archive/phase6-validation.json', async () => {
    const { writeFileSync } = await import('node:fs');
    const results = [
      ...ANALOG_VALIDATION_CASES.map((c) => c()),
      ...DIGITAL_VALIDATION_CASES.map((c) => c()),
      ...COSIM_VALIDATION_CASES.map((c) => c()),
      ...COSIM_PHYSICS_VALIDATION_CASES.map((c) => c(R)),
    ];
    writeFileSync(
      new URL('../../../../docs/archive/phase6-validation.json', import.meta.url),
      JSON.stringify(
        { engine: `forge-cosim 1; rapier3d-compat ${R.version()}`, when: new Date().toISOString(), results },
        null,
        2,
      ) + '\n',
    );
    expect(results.every((r) => r.pass)).toBe(true);
  });
});
