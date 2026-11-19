/**
 * Canonical workshop project document (schema v1, W0.1 subset).
 *
 * Coordinate convention (see docs/ARCHITECTURE.md):
 *   - Metres. Right-handed, +Y up, -Z forward (same as WebXR).
 *   - The Babylon scene runs with useRightHandedSystem = true, so no axis
 *     conversion is applied between document and engine.
 *   - Origin = workshop origin. In XR it is aligned with the session's
 *     'local-floor' reference space at session start; it is NOT a persistent
 *     physical room anchor.
 *   - Transforms are relative to the parent entity (or the workshop origin).
 *   - Transforms have NO scale. Part size comes from the part definition's
 *     declared dimensions; magnifying the view is a view concern, never a
 *     document edit.
 */
export const SCHEMA_ID = 'mindspace.vr-workshop.project' as const;
export const SCHEMA_VERSION = 1 as const;

export type Vec3 = [number, number, number];
/** Unit quaternion [x, y, z, w]. */
export type Quat = [number, number, number, number];

export interface Transform {
  position: Vec3;
  rotation: Quat;
}

export interface Entity {
  id: string;
  kind: 'part';
  /** Reference into the part catalogue (src/model/catalog.ts). */
  partDefId: string;
  name: string;
  parentId: string | null;
  transform: Transform;
  /** Placement restored by the Reset intent. */
  home: Transform;
}

export interface WorkshopDocument {
  schema: typeof SCHEMA_ID;
  schemaVersion: typeof SCHEMA_VERSION;
  projectId: string;
  /** Monotonic: incremented by every applied change, including undo and redo. */
  revision: number;
  units: { length: 'm' };
  entities: Record<string, Entity>;
}

export const IDENTITY_ROTATION: Quat = [0, 0, 0, 1];
