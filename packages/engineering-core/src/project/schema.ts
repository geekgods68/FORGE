import { z } from 'zod';
import {
  ComponentDefinitionSchema,
  EngineeringUnitsSchema,
  IdSchema,
  MaterialDefinitionSchema,
} from '../schemas';
import { validateGraph } from '../scene/graph';
import { SceneGraphSchema } from '../scene/schemas';

/**
 * FORGE project document, schema version 2 (Phase 1).
 * v1 (Phase 0) documents are migrated on load — see ./migrate.ts.
 */
export const PROJECT_SCHEMA_VERSION = 2 as const;
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const;

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    id: IdSchema,
    name: z.string().trim().min(1).max(200),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** Monotonic counter: +1 for every applied change, including undo and redo. */
    revision: z.number().int().min(0),
    units: EngineeringUnitsSchema,
    materials: z.array(MaterialDefinitionSchema),
    definitions: z.array(ComponentDefinitionSchema),
    scene: SceneGraphSchema,
  })
  .superRefine((p, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const unique = (ids: string[], path: string) => {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) issue([path], `duplicate id "${id}"`);
        seen.add(id);
      }
    };
    unique(
      p.materials.map((m) => m.id),
      'materials',
    );
    unique(
      p.definitions.map((d) => d.id),
      'definitions',
    );
    const materialIds = new Set(p.materials.map((m) => m.id));
    const definitionIds = new Set(p.definitions.map((d) => d.id));
    p.definitions.forEach((d, i) => {
      if (d.materialId && !materialIds.has(d.materialId))
        issue(['definitions', i, 'materialId'], `unknown material "${d.materialId}"`);
    });
    for (const g of validateGraph(p.scene)) issue(['scene', ...g.path.split('.')], g.message);
    for (const n of Object.values(p.scene.nodes)) {
      if (n.kind === 'component-instance' && !definitionIds.has(n.definitionId))
        issue(['scene', 'nodes', n.id, 'definitionId'], `unknown component definition "${n.definitionId}"`);
    }
  });

export type Project = z.infer<typeof ProjectSchema>;
