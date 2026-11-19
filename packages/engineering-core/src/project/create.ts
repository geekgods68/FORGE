import type { NodeTransform, PrimitiveGeometry, SceneGraph, SceneNode } from '../scene/schemas';
import { IDENTITY_QUAT, type Vec3 } from '../transform';
import { SI_UNITS } from '../units';
import { PROJECT_SCHEMA_VERSION, ProjectSchema, type Project } from './schema';

declare const crypto: { randomUUID(): string };

/** Stable, globally unique identifier for persisted entities. */
export const newId = (): string => crypto.randomUUID();

export const identityNodeTransform = (position: Vec3 = [0, 0, 0]): NodeTransform => ({
  position: [...position],
  rotation: [...IDENTITY_QUAT],
  scale: [1, 1, 1],
});

/** Default dimensions (metres) offered when conjuring each primitive. */
export const DEFAULT_PRIMITIVE_GEOMETRY: {
  [K in PrimitiveGeometry['shape']]: Extract<PrimitiveGeometry, { shape: K }>;
} = {
  box: { shape: 'box', width: 0.1, height: 0.1, depth: 0.1 },
  sphere: { shape: 'sphere', radius: 0.05 },
  cylinder: { shape: 'cylinder', radius: 0.05, height: 0.1 },
  cone: { shape: 'cone', radius: 0.05, height: 0.1 },
  plane: { shape: 'plane', width: 0.2, length: 0.2 },
  torus: { shape: 'torus', majorRadius: 0.06, tubeRadius: 0.015 },
};

/** Height of a primitive's lowest point below its origin (to rest it on the ground plane). */
export function primitiveHalfHeight(g: PrimitiveGeometry): number {
  switch (g.shape) {
    case 'box':
      return g.height / 2;
    case 'sphere':
      return g.radius;
    case 'cylinder':
    case 'cone':
      return g.height / 2;
    case 'plane':
      return 0;
    case 'torus':
      return g.tubeRadius; // torus lies flat (axis = +Y)
  }
}

export function createSceneGraph(rootId = newId()): SceneGraph {
  const root: SceneNode = {
    id: rootId,
    kind: 'root',
    name: 'Scene',
    parentId: null,
    childIds: [],
    transform: identityNodeTransform(),
    visible: true,
    locked: false,
    metadata: {},
  };
  return { rootId, nodes: { [rootId]: root } };
}

/** A new project: a scene root containing the 300 mm reference cube resting on the ground. */
export function createProject(name = 'Untitled project', now = new Date()): Project {
  const scene = createSceneGraph();
  const cubeId = newId();
  scene.nodes[cubeId] = {
    id: cubeId,
    kind: 'primitive',
    name: 'Reference Cube',
    parentId: scene.rootId,
    childIds: [],
    transform: identityNodeTransform([0, 0.15, 0]),
    visible: true,
    locked: false,
    metadata: { purpose: 'reference' },
    geometry: { shape: 'box', width: 0.3, height: 0.3, depth: 0.3 },
    color: '#8a93a3',
  };
  scene.nodes[scene.rootId]!.childIds.push(cubeId);
  const ts = now.toISOString();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: newId(),
    name,
    createdAt: ts,
    updatedAt: ts,
    revision: 0,
    units: { ...SI_UNITS },
    materials: [],
    definitions: [],
    scene,
  };
}

export type ValidationResult = { ok: true; project: Project } | { ok: false; errors: string[] };

/** Validate unknown data as a current-version project; readable "path: message" errors. */
export function validateProject(data: unknown): ValidationResult {
  const r = ProjectSchema.safeParse(data);
  if (r.success) return { ok: true, project: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`),
  };
}
