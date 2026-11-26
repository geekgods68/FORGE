import { z } from 'zod';
import { IdSchema } from '../schemas';
import { ImportRecordSchema } from '../interop/schemas';

/**
 * Phase 8 commands for import provenance. `interop.import.record` is issued as the LAST step
 * of an import batch, so the record and the imported nodes are created (and undone) together.
 * Records are never edited afterwards; `interop.import.forget` removes one explicitly.
 */
export const INTEROP_PAYLOAD_SCHEMAS = {
  'interop.import.record': z.object({ record: ImportRecordSchema }),
  'interop.import.forget': z.object({ importId: IdSchema }),
} as const;
export type InteropCommandType = keyof typeof INTEROP_PAYLOAD_SCHEMAS;
