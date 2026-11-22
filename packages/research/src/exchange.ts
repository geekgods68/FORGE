import { z } from 'zod';
import { verifyIntegrity } from './engine';
import {
  DatasetSchema,
  ExperimentSchema,
  RunRecordSchema,
  CalibrationRecordSchema,
  ValidationRecordSchema,
  type ResearchDocument,
} from './schemas';
import { dataHash, decodeRunData, encodeRunData, type RunDataStore } from './store';

/**
 * Portable experiment export: protocol, run records (with configuration snapshots, seeds,
 * fingerprints and integrity hashes), datasets/calibrations/validations and — optionally — the
 * raw run data (base64 float64). Imports are untrusted: size limit, schema, record integrity and
 * data hashes are all checked; anything that fails is reported, not loaded.
 */
export const EXPORT_FORMAT = 'forge-research-export';
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

export async function exportExperiment(
  doc: ResearchDocument,
  experimentId: string,
  store: RunDataStore | null,
) {
  const e = doc.experiments.find((x) => x.id === experimentId);
  if (!e) throw new Error('No such experiment.');
  const runs = doc.runs.filter((r) => r.experimentId === experimentId);
  const data: Record<string, unknown> = {};
  const missing: string[] = [];
  if (store)
    for (const r of runs) {
      if (!r.data) continue;
      const d = await store.get(r.data.key);
      if (d) data[r.data.key] = encodeRunData(d);
      else missing.push(r.id);
    }
  const dsIds = new Set(
    [...doc.calibrations, ...doc.validations]
      .filter((x) => x.experimentId === experimentId)
      .map((x) => x.datasetId),
  );
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    experiment: e,
    runs,
    datasets: doc.datasets.filter((d) => dsIds.has(d.id)),
    calibrations: doc.calibrations.filter((x) => x.experimentId === experimentId),
    validations: doc.validations.filter((x) => x.experimentId === experimentId),
    data,
    missingData: missing,
  };
}

const ImportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(1),
  experiment: ExperimentSchema,
  runs: z.array(RunRecordSchema).max(100_000),
  datasets: z.array(DatasetSchema).max(1000),
  calibrations: z.array(CalibrationRecordSchema).max(1000),
  validations: z.array(ValidationRecordSchema).max(1000),
  data: z.record(z.string(), z.unknown()),
  missingData: z.array(z.string()),
});

export function parseExperimentExport(text: string) {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false as const, error: 'File too large.' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false as const, error: 'Not valid JSON.' };
  }
  const v = ImportSchema.safeParse(raw);
  if (!v.success)
    return {
      ok: false as const,
      error: v.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    };
  const bad = [...v.data.runs, ...v.data.calibrations, ...v.data.validations]
    .filter((r) => !verifyIntegrity(r))
    .map((r) => r.id);
  if (bad.length)
    return {
      ok: false as const,
      error: `Integrity check failed for ${bad.length} record(s): ${bad.slice(0, 5).join(', ')}.`,
    };
  const data = new Map<string, NonNullable<ReturnType<typeof decodeRunData>>>();
  const dataProblems: string[] = [];
  for (const r of v.data.runs) {
    if (!r.data) continue;
    const d = decodeRunData(v.data.data[r.data.key]);
    if (!d) {
      dataProblems.push(`${r.id}: raw data not included`);
      continue;
    }
    if (dataHash(d) !== r.data.hash) {
      dataProblems.push(`${r.id}: raw data hash mismatch`);
      continue;
    }
    data.set(r.data.key, d);
  }
  return { ok: true as const, bundle: v.data, data, dataProblems };
}
