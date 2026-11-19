import { CATALOG } from './catalog';
import { IDENTITY_ROTATION, SCHEMA_ID, SCHEMA_VERSION, type Transform, type WorkshopDocument } from './types';

/** Bench layout constants (metres, document frame). Proposal — owner comfort test pending. */
export const BENCH = {
  topHeight: 0.75, // seated-desk height
  width: 1.6,
  depth: 0.7,
  centerZ: -0.75, // front edge ≈ 0.4 m in front of the seated user's origin
};

export function partHome(): Transform {
  const h = CATALOG['generic.enclosure.v1']!.dimensionsM[1];
  return { position: [0, BENCH.topHeight + h / 2, BENCH.centerZ + 0.15], rotation: [...IDENTITY_ROTATION] };
}

/** The W0.1 starting project: one generic part on the bench. */
export function initialDocument(projectId = 'w01-foundation'): WorkshopDocument {
  return {
    schema: SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    projectId,
    revision: 0,
    units: { length: 'm' },
    entities: {
      'part-enclosure-1': {
        id: 'part-enclosure-1',
        kind: 'part',
        partDefId: 'generic.enclosure.v1',
        name: 'Generic enclosure',
        parentId: null,
        transform: partHome(),
        home: partHome(),
      },
    },
  };
}
