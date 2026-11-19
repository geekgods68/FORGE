import {
  ProjectSchema,
  PROJECT_SCHEMA_VERSION,
  type ComponentDefinition,
  type MaterialDefinition,
  type Project,
} from './schemas';
import { identityTransform } from './transform';
import { SI_UNITS } from './units';

declare const crypto: { randomUUID(): string };

/** Stable, globally unique identifier for persisted entities. */
export const newId = (): string => crypto.randomUUID();

/** Phase 0 demonstration material. Display-only; not a characterised physical material. */
export const DEMO_MATERIAL: MaterialDefinition = {
  id: 'forge.material.demo-neutral',
  name: 'Demo neutral (display only)',
  renderColor: '#8a93a3',
  source: 'Authored for the Phase 0 scene; no physical properties declared.',
  status: 'illustrative',
};

/** Phase 0 demonstration component: a 0.3 m reference cube. Not a real catalogue part. */
export const DEMO_CUBE_DEFINITION: ComponentDefinition = {
  id: 'forge.demo.reference-cube',
  revision: 1,
  name: 'Reference cube 300 mm',
  categoryId: 'experimental-environments-test-objects',
  description: 'Temporary Phase 0 test object used to verify rendering, transforms and persistence.',
  geometry: { kind: 'box', sizeM: [0.3, 0.3, 0.3] },
  materialId: DEMO_MATERIAL.id,
  interfaces: [],
  capabilities: [
    { domain: 'rigid-body', status: 'unsupported', model: 'none', assumptions: ['No simulation in Phase 0'] },
  ],
  provenance: 'FORGE Phase 0 placeholder',
};

/** A new project: one scene containing one instance of the demo cube resting on the ground plane. */
export function createProject(name = 'Untitled project', now = new Date()): Project {
  const sceneId = newId();
  const timestamp = now.toISOString();
  const cubeHalf = 0.15;
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: newId(),
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    units: { ...SI_UNITS },
    materials: [{ ...DEMO_MATERIAL }],
    definitions: [JSON.parse(JSON.stringify(DEMO_CUBE_DEFINITION)) as ComponentDefinition],
    scenes: [
      {
        id: sceneId,
        name: 'Main scene',
        instances: [
          {
            id: newId(),
            definitionId: DEMO_CUBE_DEFINITION.id,
            name: 'Reference cube',
            transform: identityTransform([0, cubeHalf, 0]),
            configuration: {},
          },
        ],
        assemblies: [],
      },
    ],
    activeSceneId: sceneId,
  };
}

export type ValidationResult = { ok: true; project: Project } | { ok: false; errors: string[] };

/** Validate unknown data as a project; returns readable "path: message" errors. */
export function validateProject(data: unknown): ValidationResult {
  const r = ProjectSchema.safeParse(data);
  if (r.success) return { ok: true, project: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`),
  };
}

export function activeScene(p: Project) {
  return p.scenes.find((s) => s.id === p.activeSceneId) ?? p.scenes[0]!;
}
