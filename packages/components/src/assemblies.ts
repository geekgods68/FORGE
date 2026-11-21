import {
  ComponentParamValueSchema,
  QuatSchema,
  type BatchSubCommand,
  type Project,
} from '@forge/engineering-core';
import { z } from 'zod';
import { checkCompatibility } from './connections';
import { getDefinition } from './catalog';
import { evaluate } from './evaluate';

/**
 * Reusable assemblies (user-saved). A template captures a group's subtree — sub-groups
 * and component-library instances with their configuration and transforms RELATIVE to
 * the group — and re-creates it as ONE atomic batch command. Templates are local user
 * data (not project data); inserting one creates ordinary project nodes.
 * Phase 4 will add mates between members; Phase 3 stores none.
 */
const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const AssemblyMemberSchema = z.object({
  kind: z.enum(['group', 'component']),
  name: z.string().min(1).max(200),
  /** Index of the parent member; -1 = the template's top-level group. */
  parent: z.number().int().min(-1),
  position: Vec3,
  rotation: QuatSchema,
  definitionId: z.string().optional(),
  variantId: z.string().nullable().optional(),
  parameters: z.record(z.string(), ComponentParamValueSchema).optional(),
  materialId: z.string().nullable().optional(),
});
export const AssemblyTemplateSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(200),
  savedAt: z.iso.datetime(),
  members: z.array(AssemblyMemberSchema).min(1).max(2000),
});
export type AssemblyTemplate = z.infer<typeof AssemblyTemplateSchema>;

export type TemplateResult = { ok: true; template: AssemblyTemplate } | { ok: false; message: string };

/** Capture a group's subtree. Only groups and catalogue components are supported members. */
export function templateFromGroup(
  project: Project,
  groupId: string,
  id: string,
  now = new Date(),
): TemplateResult {
  const nodes = project.scene.nodes;
  const top = nodes[groupId];
  if (!top || (top.kind !== 'group' && top.kind !== 'assembly'))
    return { ok: false, message: 'Select a group to save it as an assembly.' };
  const members: AssemblyTemplate['members'] = [];
  const unsupported: string[] = [];
  const walk = (parentId: string, parentIndex: number) => {
    for (const cid of nodes[parentId]!.childIds) {
      const n = nodes[cid]!;
      const base = {
        name: n.name,
        parent: parentIndex,
        position: n.transform.position,
        rotation: n.transform.rotation,
      };
      if (n.kind === 'group' || n.kind === 'assembly') {
        if (n.transform.scale.some((v) => v !== 1)) unsupported.push(`${n.name} (scaled group)`);
        members.push({ ...base, kind: 'group' });
        walk(cid, members.length - 1);
      } else if (n.kind === 'component-instance' && n.component) {
        members.push({
          ...base,
          kind: 'component',
          definitionId: n.definitionId,
          variantId: n.component.variantId,
          parameters: n.component.parameters,
          materialId: n.component.materialId,
        });
      } else unsupported.push(`${n.name} (${n.kind})`);
    }
  };
  walk(groupId, -1);
  if (unsupported.length)
    return {
      ok: false,
      message: `Only groups and library components can be saved in an assembly: ${unsupported.slice(0, 4).join(', ')}.`,
    };
  if (members.length === 0) return { ok: false, message: 'The group is empty.' };
  return { ok: true, template: { version: 1, id, name: top.name, savedAt: now.toISOString(), members } };
}

/** Batch sub-commands that recreate a template under `parentId` at `position` (new ids from `newId`). */
export function assemblyCommands(
  t: AssemblyTemplate,
  parentId: string,
  position: [number, number, number],
  newId: () => string,
): { rootId: string; commands: BatchSubCommand[] } {
  const rootId = newId();
  const ids = t.members.map(() => newId());
  const commands: BatchSubCommand[] = [
    {
      type: 'scene.node.create',
      payload: { node: { kind: 'group', id: rootId, name: t.name, parentId, transform: { position } } },
    },
  ];
  t.members.forEach((m, i) => {
    const parent = m.parent === -1 ? rootId : ids[m.parent]!;
    const transform = { position: m.position, rotation: m.rotation };
    commands.push(
      m.kind === 'group'
        ? {
            type: 'scene.node.create',
            payload: { node: { kind: 'group', id: ids[i]!, name: m.name, parentId: parent, transform } },
          }
        : ({
            type: 'scene.node.create',
            payload: {
              node: {
                kind: 'component-instance',
                id: ids[i]!,
                name: m.name,
                parentId: parent,
                definitionId: m.definitionId!,
                variantId: m.variantId ?? null,
                parameters: m.parameters ?? {},
                ...(m.materialId !== undefined ? { materialId: m.materialId } : {}),
                transform,
              },
            },
          } as BatchSubCommand),
    );
  });
  return { rootId, commands };
}

export interface CompatibleTarget {
  nodeId: string;
  nodeName: string;
  interfaceId: string;
  interfaceName: string;
  shared: string[];
}

/**
 * Interfaces on OTHER components in the project whose declared metadata is compatible
 * with one interface. Metadata only — proximity is never considered, and a match is a
 * candidate, not a validated mate (Phase 4).
 */
export function findCompatibleInterfaces(
  project: Project,
  nodeId: string,
  interfaceId: string,
): CompatibleTarget[] {
  const evalNode = (id: string) => {
    const n = project.scene.nodes[id];
    if (!n || n.kind !== 'component-instance' || !n.component) return null;
    const def = getDefinition(n.definitionId);
    return def
      ? { node: n, interfaces: evaluate(def, n.component.parameters, n.component.materialId).interfaces }
      : null;
  };
  const src = evalNode(nodeId);
  const a = src?.interfaces.find((i) => i.id === interfaceId);
  if (!src || !a) return [];
  const out: CompatibleTarget[] = [];
  for (const id of Object.keys(project.scene.nodes)) {
    if (id === nodeId) continue;
    const t = evalNode(id);
    if (!t) continue;
    for (const b of t.interfaces) {
      const c = checkCompatibility(a, b);
      if (c.compatible)
        out.push({
          nodeId: id,
          nodeName: t.node.name,
          interfaceId: b.id,
          interfaceName: b.name,
          shared: c.shared,
        });
    }
  }
  return out;
}
