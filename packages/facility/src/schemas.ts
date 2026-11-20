import { IdSchema } from '@forge/engineering-core';
import { z } from 'zod';

/**
 * Facility (read-only architecture) and workspace (editable layout) schemas.
 * Ownership:
 *   - FacilityDefinition: shipped with FORGE (versioned data in this package). No
 *     command can modify it; users never persist it.
 *   - WorkspaceLayout: user-owned, edited only through WorkspaceEngine commands,
 *     persisted separately from engineering projects.
 *   - Engineering projects: unchanged Phase 1 format; linked to benches only by
 *     reference (WorkspaceItem.mountedProjectId), never embedded.
 */
const n = z.number();
const Vec3 = z.tuple([n, n, n]);
const Vec2 = z.tuple([n, n]);

export const FloorPoseSchema = z.object({ position: Vec3, yaw: n.min(-Math.PI).max(Math.PI) });

/** Axis-aligned rectangle on the floor plane (x/z) in the owning frame. */
export const FloorRectSchema = z
  .object({ min: Vec2, max: Vec2 })
  .refine((r) => r.min[0] < r.max[0] && r.min[1] < r.max[1], { message: 'rect min must be < max' });

export const ZoneKindSchema = z.enum(['laboratory', 'environment', 'corridor']);
export const ZoneStatusSchema = z.enum(['implemented', 'planned']);
export const EquipmentCategorySchema = z.enum(['workbench', 'storage', 'instrument', 'fixture']);

export const PortalSchema = z.object({
  id: IdSchema,
  /** Zone on the other side. */
  toZoneId: IdSchema,
  /** Opening centre in the zone frame, floor level. */
  position: Vec3,
  widthM: n.positive(),
  heightM: n.positive(),
  /** Planned portals are drawn closed. */
  open: z.boolean(),
});

export const PlacementAreaSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  /** Floor rectangle in the zone frame that equipment footprints must stay inside. */
  rect: FloorRectSchema,
  allowedCategories: z.array(EquipmentCategorySchema).min(1),
});

export const ZoneSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  kind: ZoneKindSchema,
  /** 1–22 for laboratories (master facility plan numbering); null otherwise. */
  labNumber: z.number().int().min(1).max(22).nullable(),
  wingId: IdSchema,
  status: ZoneStatusSchema,
  /** Zone frame in the facility frame. */
  pose: FloorPoseSchema,
  /** Reserved floor footprint in the ZONE frame (also the room interior for implemented zones). */
  footprint: FloorRectSchema,
  ceilingHeightM: n.positive(),
  portals: z.array(PortalSchema),
  placementAreas: z.array(PlacementAreaSchema),
  /** Lazy-loadable visual module key (implemented zones only). */
  moduleKey: z.string().nullable(),
  summary: z.string(),
});

export const WingSchema = z.object({
  id: IdSchema,
  letter: z.enum(['A', 'B', 'C', 'D', 'E']),
  name: z.string().min(1),
});

export const EquipmentSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  category: EquipmentCategorySchema,
  /** [width (local x), height (y), depth (local z)] in metres. Origin: footprint centre on the floor. */
  sizeM: Vec3,
  /** Work-surface mount (benches only): frame M in the item frame, where mounted projects live. */
  mount: FloorPoseSchema.nullable(),
  /** Usable work-surface size (x, z) for mounted projects. */
  workSurfaceM: Vec2.nullable(),
  visual: z.enum(['bench-standard', 'bench-heavy', 'cabinet', 'rack', 'pedestal']),
});

export const FacilitySchema = z.object({
  facilitySchemaVersion: z.literal(1),
  /** Content revision of the shipped facility data. */
  revision: z.number().int().positive(),
  wings: z.array(WingSchema).length(5),
  zones: z.array(ZoneSchema),
  equipment: z.array(EquipmentSchema),
});

export const WorkspaceItemSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  equipmentId: IdSchema,
  zoneId: IdSchema,
  areaId: IdSchema,
  /** Item frame in the zone frame (floor-level; y must be 0). */
  pose: FloorPoseSchema,
  /** Reference to an engineering project mounted on this workbench (by id only). */
  mountedProjectId: IdSchema.nullable(),
  locked: z.boolean(),
});

export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export const WorkspaceLayoutSchema = z.object({
  workspaceSchemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  id: IdSchema,
  name: z.string().trim().min(1).max(200),
  /** Facility content revision the layout was authored against. */
  facilityRevision: z.number().int().positive(),
  revision: z.number().int().min(0),
  updatedAt: z.iso.datetime(),
  items: z.record(IdSchema, WorkspaceItemSchema),
});

export type FloorRect = z.infer<typeof FloorRectSchema>;
export type Portal = z.infer<typeof PortalSchema>;
export type PlacementArea = z.infer<typeof PlacementAreaSchema>;
export type Zone = z.infer<typeof ZoneSchema>;
export type Wing = z.infer<typeof WingSchema>;
export type Equipment = z.infer<typeof EquipmentSchema>;
export type EquipmentCategory = z.infer<typeof EquipmentCategorySchema>;
export type Facility = z.infer<typeof FacilitySchema>;
export type WorkspaceItem = z.infer<typeof WorkspaceItemSchema>;
export type WorkspaceLayout = z.infer<typeof WorkspaceLayoutSchema>;
