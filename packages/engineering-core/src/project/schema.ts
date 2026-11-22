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
 * FORGE project document, schema version 5 (Phase 5: simulation definition).
 * v1 (Phase 0), v2 (Phases 1–2), v3 (Phase 3) and v4 (Phase 4) documents are migrated on load.
 * v3 added the optional `component` reference; v4 added `mechanical` on assembly nodes
 * (defaulted when absent) and the `sketch`, `part` and `model-instance` node kinds; v5 adds
 * the optional `simulation` definition on the root node (absent in older files = none).
 * The version is bumped so that a v4 build refuses a v5 file instead of silently dropping
 * its simulation setup.
 */
export const PROJECT_SCHEMA_VERSION = 5 as const;
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3, 4, 5] as const;

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
      if (n.kind !== 'component-instance') continue;
      if (!n.component) {
        // Legacy (Phase 0) instance: its definition must be embedded in the project.
        if (!definitionIds.has(n.definitionId))
          issue(['scene', 'nodes', n.id, 'definitionId'], `unknown component definition "${n.definitionId}"`);
        continue;
      }
      // Catalogue instance: definitions live in the component library (checked on load with
      // warnings, never silently substituted). Structural rules are enforced here.
      if (n.transform.scale.some((v) => Math.abs(v - 1) > 1e-12))
        issue(
          ['scene', 'nodes', n.id, 'transform', 'scale'],
          'catalogue components must have unit scale (dimensions are parameters)',
        );
      n.component.connections.forEach((c, i) => {
        if (!c) return;
        const t = p.scene.nodes[c.targetNodeId];
        if (!t || t.kind !== 'component-instance')
          issue(
            ['scene', 'nodes', n.id, 'component', 'connections', i],
            `connection target "${c.targetNodeId}" is not a component`,
          );
      });
    }
    // Mechanical relationships: every reference must be a body directly inside the assembly
    // (component, part, model or rigid subassembly); ids unique; grounded bodies valid.
    const nodes = p.scene.nodes;
    const bodyKinds = new Set([
      'component-instance',
      'part',
      'model-instance',
      'primitive',
      'assembly',
      'group',
    ]);
    const relIds = new Set<string>();
    for (const a of Object.values(nodes)) {
      if (a.kind !== 'assembly') continue;
      const m = a.mechanical;
      const isBody = (id: string) => nodes[id]?.parentId === a.id && bodyKinds.has(nodes[id]!.kind);
      m.grounded.forEach((g, i) => {
        if (!isBody(g))
          issue(
            ['scene', 'nodes', a.id, 'mechanical', 'grounded', i],
            `grounded "${g}" is not a body of this assembly`,
          );
      });
      [...m.mates, ...m.constraints].forEach((r) => {
        if (relIds.has(r.id))
          issue(['scene', 'nodes', a.id, 'mechanical'], `duplicate relationship id "${r.id}"`);
        relIds.add(r.id);
        for (const end of [r.a, r.b])
          if (!isBody(end.nodeId))
            issue(
              ['scene', 'nodes', a.id, 'mechanical', r.id],
              `"${end.nodeId}" is not a body of assembly "${a.name}"`,
            );
      });
    }
  });

export type Project = z.infer<typeof ProjectSchema>;
