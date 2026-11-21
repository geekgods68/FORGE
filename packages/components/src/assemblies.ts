import {
  AssemblyConstraintSchema,
  ComponentParamValueSchema,
  FeatureSchema,
  MateSchema,
  ModelRefSchema,
  QuatSchema,
  type BatchSubCommand,
  type Project,
} from '@forge/engineering-core';
import { z } from 'zod';
import { checkCompatibility } from './connections';
import { getDefinition } from './catalog';
import { evaluate } from './evaluate';

/**
 * Reusable assemblies (user-saved). A template captures a group's or assembly's subtree —
 * sub-groups, sub-assemblies, catalogue components, feature parts and imported model
 * instances, with transforms RELATIVE to the top node — and (v2) every assembly's
 * grounding, mates and constraints, with body references stored as member indices
 * (`#<index>`). Inserting re-creates it as ONE atomic batch command with fresh ids, so a
 * template can be inserted any number of times without id conflicts. Templates are local
 * user data (not project data); inserting one creates ordinary project nodes.
 */
const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const AssemblyMemberSchema = z.object({
  kind: z.enum(['group', 'assembly', 'component', 'part', 'model']),
  name: z.string().min(1).max(200),
  /** Index of the parent member; -1 = the template's top-level node. */
  parent: z.number().int().min(-1),
  position: Vec3,
  rotation: QuatSchema,
  definitionId: z.string().optional(),
  variantId: z.string().nullable().optional(),
  parameters: z.record(z.string(), ComponentParamValueSchema).optional(),
  materialId: z.string().nullable().optional(),
  features: z.array(FeatureSchema).max(4000).optional(),
  model: ModelRefSchema.optional(),
});
/** Mechanical relationships of one assembly in the template (owner −1 = the top node). */
export const TemplateMechanicsSchema = z.object({
  owner: z.number().int().min(-1),
  grounded: z.array(z.number().int().min(0)),
  mates: z.array(MateSchema).max(2000),
  constraints: z.array(AssemblyConstraintSchema).max(2000),
});
export const AssemblyTemplateSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    id: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(200),
    savedAt: z.iso.datetime(),
    topKind: z.enum(['group', 'assembly']).default('group'),
    members: z.array(AssemblyMemberSchema).min(1).max(2000),
    mechanics: z.array(TemplateMechanicsSchema).max(500).default([]),
  })
  .superRefine((t, ctx) => {
    const n = t.members.length;
    t.members.forEach((m, i) => {
      if (m.parent >= i)
        ctx.addIssue({
          code: 'custom',
          path: ['members', i, 'parent'],
          message: 'parent must precede the member',
        });
      if (m.kind === 'component' && !m.definitionId)
        ctx.addIssue({
          code: 'custom',
          path: ['members', i],
          message: 'component members need a definitionId',
        });
      if (m.kind === 'part' && !m.features?.some((f) => f.type === 'extrude'))
        ctx.addIssue({ code: 'custom', path: ['members', i], message: 'part members need a base extrude' });
      if (m.kind === 'model' && !m.model)
        ctx.addIssue({
          code: 'custom',
          path: ['members', i],
          message: 'model members need a model reference',
        });
    });
    const ref = (s: string) => {
      const k = /^#(\d+)$/.exec(s);
      return k ? Number(k[1]) : -1;
    };
    t.mechanics.forEach((mech, j) => {
      const ownerOk =
        mech.owner === -1 ? t.topKind === 'assembly' : t.members[mech.owner]?.kind === 'assembly';
      if (!ownerOk)
        ctx.addIssue({
          code: 'custom',
          path: ['mechanics', j, 'owner'],
          message: 'owner must be an assembly',
        });
      const isChild = (i: number) => i >= 0 && i < n && t.members[i]!.parent === mech.owner;
      for (const g of mech.grounded)
        if (!isChild(g))
          ctx.addIssue({
            code: 'custom',
            path: ['mechanics', j, 'grounded'],
            message: 'grounded member is not a child of its assembly',
          });
      for (const r of [...mech.mates, ...mech.constraints])
        for (const end of [r.a, r.b])
          if (!isChild(ref(end.nodeId)))
            ctx.addIssue({
              code: 'custom',
              path: ['mechanics', j],
              message: `relationship ${r.name} references an invalid member`,
            });
    });
  });
export type AssemblyTemplate = z.infer<typeof AssemblyTemplateSchema>;
export type AssemblyTemplateInput = z.input<typeof AssemblyTemplateSchema>;

export type TemplateResult = { ok: true; template: AssemblyTemplate } | { ok: false; message: string };

/** Capture a group's or assembly's subtree, including its mechanical relationships. */
export function templateFromGroup(
  project: Project,
  groupId: string,
  id: string,
  now = new Date(),
): TemplateResult {
  const nodes = project.scene.nodes;
  const top = nodes[groupId];
  if (!top || (top.kind !== 'group' && top.kind !== 'assembly'))
    return { ok: false, message: 'Select a group or assembly to save it as a reusable assembly.' };
  const members: AssemblyTemplate['members'] = [];
  const index = new Map<string, number>([[groupId, -1]]);
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
        members.push({ ...base, kind: n.kind });
        index.set(cid, members.length - 1);
        walk(cid, members.length - 1);
        continue;
      }
      if (n.kind === 'component-instance' && n.component)
        members.push({
          ...base,
          kind: 'component',
          definitionId: n.definitionId,
          variantId: n.component.variantId,
          parameters: n.component.parameters,
          materialId: n.component.materialId,
        });
      else if (n.kind === 'part')
        members.push({ ...base, kind: 'part', features: n.features, materialId: n.materialId });
      else if (n.kind === 'model-instance') members.push({ ...base, kind: 'model', model: n.model });
      else {
        unsupported.push(`${n.name} (${n.kind})`);
        continue;
      }
      index.set(cid, members.length - 1);
    }
  };
  walk(groupId, -1);
  if (unsupported.length)
    return {
      ok: false,
      message: `Only groups, assemblies, library components, feature parts and imported models can be saved: ${unsupported.slice(0, 4).join(', ')}.`,
    };
  if (members.length === 0) return { ok: false, message: 'The group is empty.' };
  const mechanics: AssemblyTemplate['mechanics'] = [];
  for (const [nodeId, owner] of index) {
    const a = nodes[nodeId]!;
    if (a.kind !== 'assembly') continue;
    const m = a.mechanical;
    if (!m.grounded.length && !m.mates.length && !m.constraints.length) continue;
    const ref = (id: string) => `#${index.get(id)!}`;
    mechanics.push({
      owner,
      grounded: m.grounded.map((g) => index.get(g)!),
      mates: m.mates.map((x) => ({
        ...x,
        a: { ...x.a, nodeId: ref(x.a.nodeId) },
        b: { ...x.b, nodeId: ref(x.b.nodeId) },
      })),
      constraints: m.constraints.map((x) => ({
        ...x,
        a: { ...x.a, nodeId: ref(x.a.nodeId) },
        b: { ...x.b, nodeId: ref(x.b.nodeId) },
      })),
    });
  }
  return {
    ok: true,
    template: {
      version: 2,
      id,
      name: top.name,
      savedAt: now.toISOString(),
      topKind: top.kind,
      members,
      mechanics,
    },
  };
}

/** Model asset hashes a template needs (to bundle or to check before inserting). */
export const templateAssetHashes = (t: AssemblyTemplate) => [
  ...new Set(t.members.flatMap((m) => (m.model ? [m.model.assetHash] : []))),
];

/** Batch sub-commands that recreate a template under `parentId` at `position` (new ids from `newId`). */
export function assemblyCommands(
  t: AssemblyTemplate,
  parentId: string,
  position: [number, number, number],
  newId: () => string,
): { rootId: string; commands: BatchSubCommand[] } {
  const rootId = newId();
  const ids = t.members.map(() => newId());
  const container = (
    kind: 'group' | 'assembly',
    id: string,
    name: string,
    parent: string,
    transform: object,
  ) =>
    (kind === 'assembly'
      ? { type: 'assembly.create', payload: { id, name, parentId: parent, transform, nodeIds: [] } }
      : {
          type: 'scene.node.create',
          payload: { node: { kind: 'group', id, name, parentId: parent, transform } },
        }) as BatchSubCommand;
  const commands: BatchSubCommand[] = [container(t.topKind, rootId, t.name, parentId, { position })];
  t.members.forEach((m, i) => {
    const parent = m.parent === -1 ? rootId : ids[m.parent]!;
    const transform = { position: m.position, rotation: m.rotation };
    const id = ids[i]!;
    if (m.kind === 'group' || m.kind === 'assembly') {
      commands.push(container(m.kind, id, m.name, parent, transform));
      return;
    }
    if (m.kind === 'component') {
      commands.push({
        type: 'scene.node.create',
        payload: {
          node: {
            kind: 'component-instance',
            id,
            name: m.name,
            parentId: parent,
            definitionId: m.definitionId!,
            variantId: m.variantId ?? null,
            parameters: m.parameters ?? {},
            ...(m.materialId !== undefined ? { materialId: m.materialId } : {}),
            transform,
          },
        },
      } as BatchSubCommand);
      return;
    }
    if (m.kind === 'model') {
      commands.push({
        type: 'model.instance.create',
        payload: { id, name: m.name, parentId: parent, transform, model: m.model! },
      } as BatchSubCommand);
      return;
    }
    // Feature part: base extrude, then every feature in order with its original id
    // (feature ids are scoped to their part, so patterns/mirrors keep their targets).
    const features = m.features!;
    const baseF = features.find((f) => f.type === 'extrude')!;
    if (baseF.type !== 'extrude') return;
    commands.push({
      type: 'part.create',
      payload: {
        id,
        name: m.name,
        parentId: parent,
        transform,
        materialId: m.materialId ?? null,
        profile: baseF.profile,
        depth: baseF.depth,
      },
    } as BatchSubCommand);
    for (const f of features) {
      if (f === baseF) continue;
      const fp = { partId: id, id: f.id };
      const sub =
        f.type === 'hole'
          ? {
              type: 'geometry.hole.create',
              payload: { ...fp, center: f.center, diameter: f.diameter, depth: f.depth },
            }
          : f.type === 'cut'
            ? { type: 'geometry.cut.create', payload: { ...fp, profile: f.profile, depth: f.depth } }
            : f.type === 'boolean'
              ? { type: 'geometry.boolean.create', payload: { ...fp, op: f.op, profile: f.profile } }
              : f.type === 'pattern-rect'
                ? {
                    type: 'geometry.pattern.create',
                    payload: {
                      ...fp,
                      kind: 'rect',
                      target: f.target,
                      countU: f.countU,
                      countV: f.countV,
                      spacingU: f.spacingU,
                      spacingV: f.spacingV,
                    },
                  }
                : f.type === 'pattern-circ'
                  ? {
                      type: 'geometry.pattern.create',
                      payload: {
                        ...fp,
                        kind: 'circ',
                        target: f.target,
                        count: f.count,
                        center: f.center,
                        totalAngle: f.totalAngle,
                      },
                    }
                  : f.type === 'mirror'
                    ? {
                        type: 'geometry.mirror.create',
                        payload: { ...fp, target: f.target, axis: f.axis, offset: f.offset },
                      }
                    : null;
      if (sub) commands.push(sub as BatchSubCommand);
    }
  });
  // Mechanical relationships last: every body exists; grounding before mates.
  const member = (s: string) => ids[Number(s.slice(1))]!;
  for (const mech of t.mechanics) {
    const assemblyId = mech.owner === -1 ? rootId : ids[mech.owner]!;
    for (const g of mech.grounded)
      commands.push({
        type: 'assembly.ground',
        payload: { assemblyId, nodeId: ids[g]!, grounded: true },
      } as BatchSubCommand);
    for (const m of mech.mates) {
      const mateId = newId();
      commands.push({
        type: 'assembly.mate.create',
        payload: {
          assemblyId,
          mate: {
            id: mateId,
            name: m.name,
            type: m.type,
            a: { ...m.a, nodeId: member(m.a.nodeId) },
            b: { ...m.b, nodeId: member(m.b.nodeId) },
            alignment: m.alignment,
            offsetRad: m.offsetRad,
            coordinates: m.coordinates,
            home: m.home,
            limits: m.limits,
          },
        },
      } as BatchSubCommand);
      if (m.suppressed)
        commands.push({
          type: 'assembly.mate.update',
          payload: { assemblyId, mateId, patch: { suppressed: true } },
        } as BatchSubCommand);
    }
    for (const c of mech.constraints)
      commands.push({
        type: 'assembly.constraint.add',
        payload: {
          assemblyId,
          constraint: {
            id: newId(),
            name: c.name,
            type: c.type,
            a: { ...c.a, nodeId: member(c.a.nodeId) },
            b: { ...c.b, nodeId: member(c.b.nodeId) },
            value: c.value,
            driving: c.driving,
          },
        },
      } as BatchSubCommand);
  }
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
