import { devicePins } from '../electrical/devices';
import {
  defaultElectricalDefinition,
  ElectricalDefinitionSchema,
  type ElectricalDefinition,
  type PinRef,
} from '../electrical/schemas';
import type { SceneNode } from '../scene/schemas';
import { CommandError, type GraphTransaction } from '../scene/transaction';
import type { ElectricalCommandType } from './electrical-schemas';
import type { HandlerContext } from './handlers';
import type { PayloadOf } from './schemas';

/**
 * Handlers for the persisted electrical definition (stored on the root node). Every handler
 * validates the complete resulting definition with ElectricalDefinitionSchema, so an
 * invalid circuit is rejected and nothing changes. CAD geometry is never touched.
 */
type EHandler<K extends ElectricalCommandType> = (
  tx: GraphTransaction,
  payload: PayloadOf<K>,
  ctx: HandlerContext,
) => string[];

type RootNode = Extract<SceneNode, { kind: 'root' }>;

function root(tx: GraphTransaction): RootNode {
  const r = tx.get(tx.rootId);
  if (r.kind !== 'root') throw new CommandError('integrity', 'Scene root is not a root node.');
  return r;
}

function current(tx: GraphTransaction): ElectricalDefinition {
  const d = root(tx).electrical;
  if (!d) throw new CommandError('invalid-operation', 'This project has no circuit; create one first.');
  return d;
}

function write(tx: GraphTransaction, next: ElectricalDefinition | undefined): string[] {
  const r = root(tx);
  if (next === undefined) {
    const { electrical: _drop, ...rest } = r;
    tx.put(rest as RootNode);
    return [r.id];
  }
  const v = ElectricalDefinitionSchema.safeParse(next);
  if (!v.success)
    throw new CommandError(
      'invalid-parameters',
      v.error.issues.map((i) => `${i.path.join('.') || 'circuit'}: ${i.message}`).join('; '),
    );
  tx.put({ ...r, electrical: v.data });
  return [r.id];
}

const touches = (r: PinRef, partId: string) => r.partId === partId;

function requireLinkable(tx: GraphTransaction, nodeId: string | null, definitionId: string | null) {
  if (!nodeId) return;
  const n = tx.graph.nodes[nodeId];
  if (!n) throw new CommandError('not-found', `Node "${nodeId}" does not exist.`);
  if (n.kind !== 'component-instance')
    throw new CommandError('invalid-operation', `"${n.name}" is not a placed component.`);
  if (definitionId && n.definitionId !== definitionId)
    throw new CommandError(
      'invalid-operation',
      `"${n.name}" is a ${n.definitionId}, not a ${definitionId}: a part may only be linked to a placed component of its own definition.`,
    );
}

export const ELECTRICAL_HANDLERS: { [K in ElectricalCommandType]: EHandler<K> } = {
  'electrical.circuit.create'(tx, { definition }) {
    if (root(tx).electrical)
      throw new CommandError('invalid-operation', 'This project already has a circuit.');
    const d = definition ?? defaultElectricalDefinition();
    for (const part of d.parts) requireLinkable(tx, part.nodeId, part.definitionId);
    return write(tx, d);
  },

  'electrical.circuit.delete'(tx) {
    current(tx);
    return write(tx, undefined);
  },

  'electrical.circuit.import'(tx, { definition }) {
    // Links to 3D components are kept only if they resolve in THIS project.
    const parts = definition.parts.map((p) => {
      if (!p.nodeId) return p;
      const n = tx.graph.nodes[p.nodeId];
      const ok = n?.kind === 'component-instance' && (!p.definitionId || n.definitionId === p.definitionId);
      return ok ? p : { ...p, nodeId: null };
    });
    return write(tx, { ...definition, parts });
  },

  'electrical.configure'(tx, { patch }) {
    const d = current(tx);
    return write(tx, {
      ...d,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      settings: {
        solver: { ...d.settings.solver, ...patch.solver },
        transient: { ...d.settings.transient, ...patch.transient },
        cosim: {
          ...d.settings.cosim,
          ...patch.cosim,
          recording: { ...d.settings.cosim.recording, ...patch.cosim?.recording },
        },
      },
    });
  },

  'electrical.part.add'(tx, { part }) {
    const d = current(tx);
    if (d.parts.some((p) => p.id === part.id))
      throw new CommandError('invalid-operation', `Part "${part.id}" already exists.`);
    if (d.parts.some((p) => p.label === part.label))
      throw new CommandError('invalid-operation', `Reference designator "${part.label}" is already used.`);
    requireLinkable(tx, part.nodeId, part.definitionId);
    return write(tx, { ...d, parts: [...d.parts, part] });
  },

  'electrical.part.update'(tx, { partId, patch }) {
    const d = current(tx);
    const i = d.parts.findIndex((p) => p.id === partId);
    if (i < 0) throw new CommandError('not-found', `Part "${partId}" does not exist.`);
    const prev = d.parts[i]!;
    const next = { ...prev, ...patch };
    if (patch.device) {
      // Wires/labels must still land on existing pins (e.g. a gate's input count change).
      const pins = new Set(devicePins(patch.device).map((x) => x.id));
      const dangling = [...d.wires.flatMap((w) => [w.a, w.b]), ...d.netLabels.map((l) => l.pin)].filter(
        (r) => r.partId === partId && !pins.has(r.pin),
      );
      if (dangling.length)
        throw new CommandError(
          'invalid-operation',
          `Pin${dangling.length > 1 ? 's' : ''} ${[...new Set(dangling.map((r) => r.pin))].join(', ')} of ${prev.label} would no longer exist; remove their wires first.`,
        );
    }
    if (patch.nodeId !== undefined) requireLinkable(tx, patch.nodeId, next.definitionId);
    const parts = [...d.parts];
    parts[i] = next;
    return write(tx, { ...d, parts });
  },

  'electrical.part.remove'(tx, { partId }) {
    const d = current(tx);
    if (!d.parts.some((p) => p.id === partId))
      throw new CommandError('not-found', `Part "${partId}" does not exist.`);
    return write(tx, {
      ...d,
      parts: d.parts.filter((p) => p.id !== partId),
      wires: d.wires.filter((w) => !touches(w.a, partId) && !touches(w.b, partId)),
      netLabels: d.netLabels.filter((l) => !touches(l.pin, partId)),
      groups: d.groups.map((g) => ({ ...g, partIds: g.partIds.filter((x) => x !== partId) })),
    });
  },

  'electrical.wire.add'(tx, { wire }) {
    const d = current(tx);
    if (d.wires.some((w) => w.id === wire.id))
      throw new CommandError('invalid-operation', `Wire "${wire.id}" already exists.`);
    const same = (x: PinRef, y: PinRef) => x.partId === y.partId && x.pin === y.pin;
    if (
      d.wires.some(
        (w) => (same(w.a, wire.a) && same(w.b, wire.b)) || (same(w.a, wire.b) && same(w.b, wire.a)),
      )
    )
      throw new CommandError('invalid-operation', 'These two pins are already wired together.');
    return write(tx, { ...d, wires: [...d.wires, wire] });
  },

  'electrical.wire.update'(tx, { wireId, patch }) {
    const d = current(tx);
    const i = d.wires.findIndex((w) => w.id === wireId);
    if (i < 0) throw new CommandError('not-found', `Wire "${wireId}" does not exist.`);
    const wires = [...d.wires];
    wires[i] = { ...wires[i]!, ...patch };
    return write(tx, { ...d, wires });
  },

  'electrical.wire.remove'(tx, { wireId }) {
    const d = current(tx);
    if (!d.wires.some((w) => w.id === wireId))
      throw new CommandError('not-found', `Wire "${wireId}" does not exist.`);
    return write(tx, { ...d, wires: d.wires.filter((w) => w.id !== wireId) });
  },

  'electrical.net.label'(tx, { label }) {
    const d = current(tx);
    return write(tx, { ...d, netLabels: [...d.netLabels.filter((l) => l.id !== label.id), label] });
  },

  'electrical.net.unlabel'(tx, { labelId }) {
    const d = current(tx);
    if (!d.netLabels.some((l) => l.id === labelId))
      throw new CommandError('not-found', `Net label "${labelId}" does not exist.`);
    return write(tx, { ...d, netLabels: d.netLabels.filter((l) => l.id !== labelId) });
  },

  'electrical.group.set'(tx, { group }) {
    const d = current(tx);
    return write(tx, { ...d, groups: [...d.groups.filter((g) => g.id !== group.id), group] });
  },

  'electrical.group.delete'(tx, { groupId }) {
    const d = current(tx);
    if (!d.groups.some((g) => g.id === groupId))
      throw new CommandError('not-found', `Group "${groupId}" does not exist.`);
    return write(tx, {
      ...d,
      groups: d.groups
        .filter((g) => g.id !== groupId)
        .map((g) => (g.parentId === groupId ? { ...g, parentId: null } : g)),
    });
  },

  'electrical.firmware.set'(tx, { firmware }) {
    const d = current(tx);
    const prev = d.firmware.find((f) => f.id === firmware.id);
    const next = { ...firmware, revision: (prev?.revision ?? 0) + 1 };
    return write(tx, { ...d, firmware: [...d.firmware.filter((f) => f.id !== firmware.id), next] });
  },

  'electrical.firmware.delete'(tx, { firmwareId }) {
    const d = current(tx);
    if (!d.firmware.some((f) => f.id === firmwareId))
      throw new CommandError('not-found', `Firmware "${firmwareId}" does not exist.`);
    return write(tx, {
      ...d,
      firmware: d.firmware.filter((f) => f.id !== firmwareId),
      parts: d.parts.map((p) =>
        p.device.type === 'mcu' && p.device.firmwareId === firmwareId
          ? { ...p, device: { ...p.device, firmwareId: null } }
          : p,
      ),
    });
  },
};
