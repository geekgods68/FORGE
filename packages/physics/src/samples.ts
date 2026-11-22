import { createCatalogResolver, getDefinition } from '@forge/components';
import {
  DEFAULT_ACTUATOR,
  defaultSimulationDefinition,
  ForgeEngine,
  makeCommand,
  type Actuator,
  type BatchSubCommand,
  type CommandInput,
  type Project,
  type SceneGraph,
  type SimulationDefinition,
} from '@forge/engineering-core';
import {
  ARM_ASSEMBLY_ID,
  ARM_JOINTS,
  createMechanicsService,
  createRoboticArmSample,
} from '@forge/mechanics';

const KGF_CM = 0.0980665; // N·m per kgf·cm

/**
 * Actuator effort/speed limits from a component's CITED datasheet values (stall torque,
 * no-load operating speed), or null when the catalogue has none. The values are
 * "datasheet-cited, not validated by FORGE"; the dynamics remain the generic model.
 */
export function datasheetActuatorLimits(
  definitionId: string,
): Pick<Actuator, 'effortLimit' | 'speedLimit' | 'source' | 'sourceNote'> | null {
  const def = getDefinition(definitionId);
  if (!def) return null;
  const specs = Object.values(def.specs ?? {}).flat() as {
    key: string;
    value: unknown;
    unit: string;
    label: string;
  }[];
  const torque = specs.find(
    (s) => /^stall-torque(-4-8)?$/.test(s.key) && typeof s.value === 'number' && s.unit === 'kgf·cm',
  );
  const speed = specs.find(
    (s) => /^speed(-4-8)?$/.test(s.key) && typeof s.value === 'number' && s.unit === 's / 60°',
  );
  if (!torque || !speed) return null;
  const effortLimit = (torque.value as number) * KGF_CM;
  const speedLimit = Math.PI / 3 / (speed.value as number);
  return {
    effortLimit,
    speedLimit,
    source: 'datasheet-cited',
    sourceNote: `${def.name}: ${torque.label} ${torque.value as number} kgf·cm (≈ ${effortLimit.toFixed(3)} N·m, used as the stall-effort limit) and ${speed.label} ${speed.value as number} s/60° (≈ ${speedLimit.toFixed(2)} rad/s no-load speed) — datasheet-cited, not validated; the servo dynamics are FORGE's generic model, not this product's.`,
  };
}

/**
 * A starting setup for any project: defaults, plus one actuator per revolute/prismatic
 * joint whose driving body declares cited actuator limits (e.g. a catalogue servo). No
 * mass is invented: bodies with unknown mass are reported by the bridge for the user.
 */
export function suggestSimulationDefinition(graph: SceneGraph): SimulationDefinition {
  if (graph.nodes[ARM_ASSEMBLY_ID]?.kind === 'assembly' && graph.nodes['gripper'])
    return armSimulationDefinition(graph);
  const d = defaultSimulationDefinition();
  for (const n of Object.values(graph.nodes)) {
    if (n.kind !== 'assembly') continue;
    for (const m of n.mechanical.mates) {
      if (m.suppressed || (m.type !== 'revolute' && m.type !== 'prismatic')) continue;
      const a = graph.nodes[m.a.nodeId];
      const limits = a?.kind === 'component-instance' ? datasheetActuatorLimits(a.definitionId) : null;
      if (limits && m.type === 'revolute')
        d.joints.push({
          mateId: m.id,
          damping: 0,
          friction: 0,
          actuator: { ...DEFAULT_ACTUATOR, ...limits, target: m.coordinates[0] ?? 0 },
        });
    }
  }
  return d;
}

/** Name of the generic, explicitly labelled placeholder values used by the arm demonstration. */
export const ARM_GENERIC_NOTE =
  'generic simulation parameter for the demonstration — not measured; replace with a measured mass';

/**
 * Simulation setup for the VEYRIS robotic-arm sample:
 *  - base plate grounded (fixed); every other arm body dynamic, welded by its fixed mates;
 *  - masses from the model (geometry × handbook density, or cited published masses), except
 *    the gripper and the 608 bearing, whose masses are UNKNOWN in the catalogue: they get
 *    explicitly labelled generic placeholder values (never inferred from appearance);
 *  - one actuator per revolute joint, effort/speed limits from the servo's cited datasheet
 *    values (MG996R base/shoulder/elbow, SG90 wrist), generic dynamics, position control
 *    holding the CAD pose;
 *  - a 0 kg end-effector payload on the gripper (the user changes it).
 */
export function armSimulationDefinition(graph: SceneGraph): SimulationDefinition {
  const d = defaultSimulationDefinition('Robotic arm dynamics');
  d.bodies.push(
    { ...bodyDefaults('gripper'), mass: { source: 'user', massKg: 0.03, note: ARM_GENERIC_NOTE } },
    { ...bodyDefaults('shoulder-bearing'), mass: { source: 'user', massKg: 0.012, note: ARM_GENERIC_NOTE } },
  );
  const arm = graph.nodes[ARM_ASSEMBLY_ID];
  if (arm?.kind === 'assembly')
    for (const id of Object.values(ARM_JOINTS)) {
      const m = arm.mechanical.mates.find((x) => x.id === id);
      if (!m) continue;
      const servo = graph.nodes[m.a.nodeId];
      const limits =
        servo?.kind === 'component-instance' ? datasheetActuatorLimits(servo.definitionId) : null;
      d.joints.push({
        mateId: id,
        damping: 0.002,
        friction: 0,
        actuator: { ...DEFAULT_ACTUATOR, ...(limits ?? {}), target: m.coordinates[0] ?? 0 },
      });
    }
  d.payloads.push({
    id: 'payload-ee',
    name: 'End-effector payload',
    nodeId: 'gripper',
    massKg: 0,
    offsetM: [0, 0, 0],
  });
  d.thresholds.maxAngularSpeed = 20;
  return d;
}

function bodyDefaults(nodeId: string): SimulationDefinition['bodies'][number] {
  return {
    nodeId,
    mode: 'auto',
    mass: { source: 'model' },
    collider: 'auto',
    friction: 0.5,
    restitution: 0.1,
    linearDamping: 0,
    angularDamping: 0,
    ccd: false,
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    contactLoadRatingN: null,
  };
}

/** The robotic-arm sample (Phase 4, unchanged) plus its simulation setup, created by an engine command. */
export function createRoboticArmSimulationSample(now = new Date()): Project {
  const p = createRoboticArmSample(now);
  const engine = new ForgeEngine(p, {
    componentResolver: createCatalogResolver(),
    mechanics: createMechanicsService(),
    now: () => now,
  });
  const r = engine.execute(
    makeCommand('physics.simulation.create', { definition: armSimulationDefinition(p.scene) }, 'desktop-ui', {
      label: 'Create simulation setup',
    }) as CommandInput,
  );
  if (!r.ok) throw new Error(`Arm simulation setup failed: ${r.error.message}`);
  return { ...engine.getProject(), revision: 0 };
}

/** Small typed helper for building experiment scenes through validated engine commands. */
export class SceneBuilder {
  readonly engine: ForgeEngine;
  constructor(project: Project) {
    this.engine = new ForgeEngine(project, {
      componentResolver: createCatalogResolver(),
      mechanics: createMechanicsService(),
    });
  }
  run(type: string, payload: unknown): void {
    const r = this.engine.execute(makeCommand(type as never, payload as never, 'test') as CommandInput);
    if (!r.ok) throw new Error(`${type}: ${r.error.message}`);
  }
  batch(commands: BatchSubCommand[]): void {
    this.run('scene.batch', { commands });
  }
  get graph(): SceneGraph {
    return this.engine.getProject().scene;
  }
  get definition(): SimulationDefinition {
    const d = simulationOf(this.graph);
    if (!d) throw new Error('no simulation setup');
    return d;
  }
}

/** The simulation definition stored on a scene's root node, if any. */
export function simulationOf(graph: SceneGraph): SimulationDefinition | null {
  const r = graph.nodes[graph.rootId];
  return r?.kind === 'root' ? (r.simulation ?? null) : null;
}
