import type { CalibrationRecord, Dataset, ValidationRecord } from '@forge/research';
import type { Recording } from './recording';
import type { Twin } from './schemas';

/**
 * What a twin may be CALLED, from the evidence actually present (each level requires all
 * lower ones). Synthetic data never counts as evidence about the physical system.
 *
 *  virtual-model           a FORGE engineering model exists
 *  simulated-system        it has a simulation or circuit setup
 *  telemetry-connected     channels are mapped and a NON-synthetic recording exists
 *  synchronised            …and that recording has a clock fit with p95 latency ≤ 50 ms
 *                          and ≤ 1 % missing messages
 *  calibrated              …and a Phase 7 calibration used a non-synthetic twin dataset
 *  empirically-validated   …and a validation record "agrees" on an INDEPENDENT
 *                          (not used for calibration), non-synthetic dataset
 */
export const DESIGNATIONS = [
  'virtual-model',
  'simulated-system',
  'telemetry-connected',
  'synchronised',
  'calibrated',
  'empirically-validated',
] as const;
export type Designation = (typeof DESIGNATIONS)[number];

export interface EvidenceInput {
  hasModel: boolean;
  hasSimulation: boolean;
  twin: Twin;
  recordings: Recording[];
  /** Pipeline diagnostics per recording id (from replay). */
  sync: Record<string, { latencyP95Ms: number; missingFraction: number }>;
  datasets: Dataset[];
  calibrations: CalibrationRecord[];
  validations: ValidationRecord[];
}

export function designate(e: EvidenceInput): { level: Designation; evidence: string[]; missing: string[] } {
  const evidence: string[] = [];
  const missing: string[] = [];
  let level: Designation = 'virtual-model';
  const step = (ok: boolean, next: Designation, have: string, need: string) => {
    if (ok && DESIGNATIONS.indexOf(level) === DESIGNATIONS.indexOf(next) - 1) {
      level = next;
      evidence.push(have);
      return true;
    }
    if (!ok) missing.push(need);
    return false;
  };
  if (!e.hasModel) return { level, evidence, missing: ['an engineering model'] };
  evidence.push('FORGE engineering model');
  if (!step(e.hasSimulation, 'simulated-system', 'simulation/circuit setup', 'a simulation or circuit setup'))
    return { level, evidence, missing };
  const real = e.recordings.filter((r) => !r.synthetic && e.twin.evidence.recordings.includes(r.id));
  const synthetic = e.recordings.filter((r) => r.synthetic).length;
  if (synthetic)
    evidence.push(
      `${synthetic} synthetic recording(s) — software verification only, not evidence about the device`,
    );
  if (
    !step(
      e.twin.channels.length > 0 && real.length > 0,
      'telemetry-connected',
      `${real.length} physical recording(s) with mapped channels`,
      'a recording from the physical device (synthetic data does not count)',
    )
  )
    return { level, evidence, missing };
  const synced = real.filter((r) => {
    const s = e.sync[r.id];
    return s && s.latencyP95Ms <= 50 && s.missingFraction <= 0.01;
  });
  if (
    !step(
      synced.length > 0,
      'synchronised',
      'clock fit with p95 latency ≤ 50 ms and ≤ 1 % missing messages',
      'a recording meeting the synchronisation criteria (p95 latency ≤ 50 ms, ≤ 1 % missing)',
    )
  )
    return { level, evidence, missing };
  const realDatasets = new Set(
    e.datasets
      .filter((d) => !d.provenance.synthetic && real.some((r) => d.provenance.origin.includes(r.id)))
      .map((d) => d.id),
  );
  const cal = e.calibrations.filter((c) => realDatasets.has(c.datasetId));
  if (
    !step(
      cal.length > 0,
      'calibrated',
      `${cal.length} calibration(s) against physical recordings`,
      'a Phase 7 calibration against a physical recording',
    )
  )
    return { level, evidence, missing };
  const usedForCal = new Set(cal.map((c) => c.datasetId));
  const val = e.validations.filter(
    (v) => v.status === 'agrees' && realDatasets.has(v.datasetId) && !usedForCal.has(v.datasetId),
  );
  step(
    val.length > 0,
    'empirically-validated',
    `${val.length} agreeing validation(s) on independent physical data`,
    'agreement with an independent physical dataset not used for calibration',
  );
  return { level, evidence, missing };
}
