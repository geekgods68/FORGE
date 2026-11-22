import { MATE_COORDINATES, type Mate, type SceneNode } from '../scene/schemas';
import { CommandError, type GraphTransaction } from '../scene/transaction';
import {
  bodySettingsFor,
  defaultSimulationDefinition,
  SimulationDefinitionSchema,
  type Actuator,
  type JointSettings,
  type SimulationDefinition,
} from '../simulation/schemas';
import type { HandlerContext } from './handlers';
import type { PhysicsCommandType } from './physics-schemas';
import type { PayloadOf } from './schemas';

/**
 * Handlers for the persisted simulation definition (stored on the root node). Each one
 * validates the complete resulting definition with SimulationDefinitionSchema, so an
 * invalid setting is rejected and nothing changes. CAD state is never touched.
 */
type PHandler<K extends PhysicsCommandType> = (
  tx: GraphTransaction,
  payload: PayloadOf<K>,
  ctx: HandlerContext,
) => string[];

type RootNode = Extract<SceneNode, { kind: 'root' }>;
const SIM_BODY_KINDS = new Set([
  'component-instance',
  'part',
  'model-instance',
  'primitive',
  'assembly',
  'group',
]);

function root(tx: GraphTransaction): RootNode {
  const r = tx.get(tx.rootId);
  if (r.kind !== 'root') throw new CommandError('integrity', 'Scene root is not a root node.');
  return r;
}

function current(tx: GraphTransaction): SimulationDefinition {
  const d = root(tx).simulation;
  if (!d)
    throw new CommandError('invalid-operation', 'This project has no simulation setup; create one first.');
  return d;
}

function write(tx: GraphTransaction, next: SimulationDefinition | undefined): string[] {
  const r = root(tx);
  if (next === undefined) {
    const { simulation: _drop, ...rest } = r;
    tx.put(rest as RootNode);
    return [r.id];
  }
  const v = SimulationDefinitionSchema.safeParse(next);
  if (!v.success)
    throw new CommandError(
      'invalid-parameters',
      v.error.issues.map((i) => `${i.path.join('.') || 'simulation'}: ${i.message}`).join('; '),
    );
  tx.put({ ...r, simulation: v.data });
  return [r.id];
}

function findMate(tx: GraphTransaction, mateId: string): Mate {
  for (const n of Object.values(tx.graph.nodes))
    if (n.kind === 'assembly') {
      const m = n.mechanical.mates.find((x) => x.id === mateId);
      if (m) return m;
    }
  throw new CommandError('not-found', `Mate "${mateId}" does not exist.`);
}

function requireBody(tx: GraphTransaction, nodeId: string): SceneNode {
  const n = tx.get(nodeId);
  if (!SIM_BODY_KINDS.has(n.kind))
    throw new CommandError('invalid-operation', `"${n.name}" (${n.kind}) cannot be a physical body.`);
  return n;
}

export const DEFAULT_ACTUATOR: Actuator = {
  enabled: true,
  mode: 'position',
  target: 0,
  targetVelocity: 0,
  targetEffort: 0,
  effortLimit: 1,
  speedLimit: 6,
  ratedEffort: null,
  gains: { mode: 'auto', bandwidthHz: 4 },
  controlRateHz: 480,
  source: 'generic',
  sourceNote: 'Generic actuator defaults (not a specific product).',
};

export const PHYSICS_HANDLERS: { [K in PhysicsCommandType]: PHandler<K> } = {
  'physics.simulation.create'(tx, { definition }) {
    if (root(tx).simulation)
      throw new CommandError('invalid-operation', 'This project already has a simulation setup.');
    return write(tx, definition ?? defaultSimulationDefinition());
  },

  'physics.simulation.delete'(tx) {
    current(tx);
    return write(tx, undefined);
  },

  'physics.configure'(tx, { patch }) {
    const d = current(tx);
    return write(tx, {
      ...d,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.gravityEnabled !== undefined ? { gravityEnabled: patch.gravityEnabled } : {}),
      ...(patch.gravity ? { gravity: patch.gravity } : {}),
      ...(patch.selfCollision !== undefined ? { selfCollision: patch.selfCollision } : {}),
      ...(patch.allowSleeping !== undefined ? { allowSleeping: patch.allowSleeping } : {}),
      ...(patch.initialPose ? { initialPose: patch.initialPose } : {}),
      solver: { ...d.solver, ...patch.solver },
      ground: { ...d.ground, ...patch.ground },
      thresholds: { ...d.thresholds, ...patch.thresholds },
      recording: { ...d.recording, ...patch.recording },
      approvals: { ...d.approvals, ...patch.approvals },
    });
  },

  'physics.body.set'(tx, { nodeId, settings }) {
    const d = current(tx);
    requireBody(tx, nodeId);
    const others = d.bodies.filter((b) => b.nodeId !== nodeId);
    if (settings === null) return write(tx, { ...d, bodies: others });
    return write(tx, { ...d, bodies: [...others, { ...bodySettingsFor(d, nodeId), ...settings, nodeId }] });
  },

  'physics.joint.set'(tx, { mateId, settings }) {
    const d = current(tx);
    const mate = findMate(tx, mateId);
    const others = d.joints.filter((j) => j.mateId !== mateId);
    if (settings === null) return write(tx, { ...d, joints: others });
    const prev: JointSettings = d.joints.find((j) => j.mateId === mateId) ?? {
      mateId,
      damping: 0,
      friction: 0,
      actuator: null,
    };
    let actuator = prev.actuator;
    if (settings.actuator === null) actuator = null;
    else if (settings.actuator) {
      if (MATE_COORDINATES[mate.type].length !== 1 || mate.type === 'cylindrical')
        throw new CommandError(
          'unsupported',
          `Actuators are supported on revolute and prismatic joints only ("${mate.name}" is ${mate.type}).`,
        );
      actuator = { ...(prev.actuator ?? DEFAULT_ACTUATOR), ...settings.actuator };
    }
    const { actuator: _a, ...rest } = settings;
    return write(tx, { ...d, joints: [...others, { ...prev, ...rest, mateId, actuator }] });
  },

  'physics.payload.set'(tx, { payload }) {
    const d = current(tx);
    requireBody(tx, payload.nodeId);
    const i = d.payloads.findIndex((p) => p.id === payload.id);
    const payloads = [...d.payloads];
    if (i >= 0) payloads[i] = payload;
    else payloads.push(payload);
    return write(tx, { ...d, payloads });
  },

  'physics.payload.delete'(tx, { payloadId }) {
    const d = current(tx);
    if (!d.payloads.some((p) => p.id === payloadId))
      throw new CommandError('not-found', `Payload "${payloadId}" does not exist.`);
    return write(tx, { ...d, payloads: d.payloads.filter((p) => p.id !== payloadId) });
  },
};
