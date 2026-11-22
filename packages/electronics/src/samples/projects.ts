import { electricalModelFor } from '@forge/components';
import {
  createProject,
  defaultElectricalDefinition,
  type BatchSubCommand,
  type ElectricalDefinition,
  type ElectricalPart,
  type FrameRef,
  type Project,
} from '@forge/engineering-core';
import { ARM_ASSEMBLY_ID, ARM_JOINTS } from '@forge/mechanics';
import {
  createRoboticArmSimulationSample,
  datasheetActuatorLimits,
  SceneBuilder,
  suggestSimulationDefinition,
} from '@forge/physics';
import { ARM_CONTROL_SKETCH, ULTRASONIC_SERVO_SKETCH } from './firmware';

/**
 * Electronics sample projects. Everything is created through validated engine commands; the
 * circuits are ordinary editable data and the firmware is ordinary editable source.
 */
type V = [number, number, number];
const F = (origin: V, axis: V, xRef: V): FrameRef => ({ kind: 'frame', origin, axis, xRef });
const I = (interfaceId: string): FrameRef => ({ kind: 'interface', interfaceId });
const UP: V = [0, 1, 0];
const X: V = [1, 0, 0];
const DOWN: V = [0, -1, 0];
const deg = (d: number) => (d * Math.PI) / 180;

const RED = '#dc2626';
const BLACK = '#111827';
const YELLOW = '#eab308';
const ORANGE = '#f97316';

/** Catalogue part, linked to a placed node, with its catalogue device model (optionally patched). */
function catalogPart(
  id: string,
  label: string,
  name: string,
  definitionId: string,
  nodeId: string | null,
  schematic: [number, number],
  patch: Record<string, unknown> = {},
  values: Record<string, string | number | boolean> = {},
  variantId: string | null = null,
): ElectricalPart {
  const m = electricalModelFor(definitionId, values, variantId);
  if (!m) throw new Error(`No electrical model for ${definitionId}`);
  return {
    id,
    label,
    name,
    device: { ...m.device, ...patch } as ElectricalPart['device'],
    definitionId,
    nodeId,
    schematic: { x: schematic[0], y: schematic[1], rotation: 0 },
    note: '',
  };
}

const wire = (id: string, a: string, b: string, color: string) => {
  const [ap, ...apin] = a.split('.');
  const [bp, ...bpin] = b.split('.');
  return {
    id,
    a: { partId: ap!, pin: apin.join('.') },
    b: { partId: bp!, pin: bpin.join('.') },
    route: [] as [number, number][],
    color,
  };
};

export const ULTRASONIC_SAMPLE_NAME = 'Sample — Arduino ultrasonic servo gauge';
export const GAUGE_JOINT = 'j-gauge';
export const OBSTACLE_NODE = 'obstacle';

/**
 * Arduino UNO + HC-SR04 + SG90: the controller measures the distance to a movable obstacle and
 * turns a servo-driven pointer accordingly. The pointer is a dynamic body on a revolute joint
 * driven by the Phase 5 actuator; the servo only receives control pulses.
 */
export function createUltrasonicServoSample(now = new Date()): Project {
  const base = createProject(ULTRASONIC_SAMPLE_NAME, now);
  const b = new SceneBuilder(base);
  const root = base.scene.rootId;
  const cube = base.scene.nodes[root]!.childIds[0]!;
  const comp = (
    id: string,
    definitionId: string,
    name: string,
    parentId: string,
    position: V,
    extra: Record<string, unknown> = {},
  ): BatchSubCommand =>
    ({
      type: 'scene.node.create',
      payload: {
        node: {
          kind: 'component-instance',
          id,
          name,
          parentId,
          definitionId,
          transform: { position },
          ...extra,
        },
      },
    }) as BatchSubCommand;
  const box = (id: string, name: string, size: V, position: V): BatchSubCommand =>
    ({
      type: 'scene.node.create',
      payload: {
        node: {
          kind: 'primitive',
          id,
          name,
          parentId: root,
          geometry: { shape: 'box', width: size[0], height: size[1], depth: size[2] },
          transform: { position },
        },
      },
    }) as BatchSubCommand;
  const SG90_OUTPUT_X = -0.0222 / 2 + 0.0118 / 2;
  b.batch([
    { type: 'scene.node.delete', payload: { nodeId: cube } } as BatchSubCommand,
    {
      type: 'assembly.create',
      payload: { id: 'grp-gauge', name: 'Servo gauge', parentId: root, nodeIds: [] },
    } as BatchSubCommand,
    comp('gauge-base', 'arm-base-plate', 'Gauge base plate', 'grp-gauge', [0, 0, 0], {
      parameters: { length: 0.08, width: 0.06, thickness: 0.004, holes: 'M4' },
    }),
    comp('gauge-servo', 'towerpro-sg90', 'Gauge servo (SG90)', 'grp-gauge', [0, 0.004, 0]),
    comp('pointer', 'arm-link', 'Pointer (80 mm link)', 'grp-gauge', [0, 0.03, 0], { variantId: '80' }),
    {
      type: 'assembly.ground',
      payload: { assemblyId: 'grp-gauge', nodeId: 'gauge-base', grounded: true },
    } as BatchSubCommand,
    {
      type: 'assembly.mate.create',
      payload: {
        assemblyId: 'grp-gauge',
        mate: {
          id: 'm-gauge-servo',
          name: 'Servo on base',
          type: 'fixed',
          a: { nodeId: 'gauge-base', ref: F([0, 0.004, 0], UP, X) },
          b: { nodeId: 'gauge-servo', ref: F([SG90_OUTPUT_X, 0, 0], DOWN, X) },
        },
      },
    } as BatchSubCommand,
    {
      type: 'assembly.mate.create',
      payload: {
        assemblyId: 'grp-gauge',
        mate: {
          id: GAUGE_JOINT,
          name: 'Gauge pointer joint',
          type: 'revolute',
          a: { nodeId: 'gauge-servo', ref: I('output') },
          b: { nodeId: 'pointer', ref: I('joint-a') },
          limits: [{ min: deg(-90), max: deg(90) }],
        },
      },
    } as BatchSubCommand,
    comp('uno', 'arduino-uno-r3', 'Arduino UNO R3', root, [-0.16, 0, -0.06]),
    box('sonar-stand', 'Sensor stand', [0.03, 0.07, 0.02], [0.14, 0.035, -0.012]),
    comp('sonar', 'hc-sr04', 'Ultrasonic sensor (HC-SR04)', root, [0.14, 0.07, 0]),
    box(OBSTACLE_NODE, 'Obstacle (movable target)', [0.14, 0.14, 0.02], [0.14, 0.08, 0.25]),
  ]);
  const sim = suggestSimulationDefinition(b.graph);
  const limits = datasheetActuatorLimits('towerpro-sg90');
  const j = sim.joints.find((x) => x.mateId === GAUGE_JOINT);
  if (j?.actuator && limits) Object.assign(j.actuator, limits);
  j!.damping = 0.0005;
  sim.name = 'Ultrasonic servo gauge';
  b.run('physics.simulation.create', { definition: sim });

  const def: ElectricalDefinition = defaultElectricalDefinition('Ultrasonic servo gauge');
  def.firmware.push({
    id: 'fw-gauge',
    name: 'Ultrasonic servo gauge',
    language: 'arduino-subset',
    source: ULTRASONIC_SERVO_SKETCH,
    revision: 1,
  });
  def.parts.push(
    catalogPart('U1', 'U1', 'Arduino UNO R3', 'arduino-uno-r3', 'uno', [0, 0], { firmwareId: 'fw-gauge' }),
    catalogPart('US1', 'US1', 'HC-SR04 ultrasonic sensor', 'hc-sr04', 'sonar', [34, -10]),
    catalogPart('SV1', 'SV1', 'SG90 gauge servo', 'towerpro-sg90', 'gauge-servo', [34, 10], {
      mateId: GAUGE_JOINT,
    }),
  );
  def.wires.push(
    wire('w-5v-us', 'U1.5V', 'US1.vcc', RED),
    wire('w-gnd-us', 'U1.GND.1', 'US1.gnd', BLACK),
    wire('w-trig', 'U1.D7', 'US1.trig', YELLOW),
    wire('w-echo', 'US1.echo', 'U1.D8', ORANGE),
    wire('w-sig', 'U1.D9', 'SV1.signal', YELLOW),
    wire('w-5v-sv', 'U1.5V', 'SV1.vplus', RED),
    wire('w-gnd-sv', 'U1.GND.2', 'SV1.gnd', BLACK),
  );
  def.netLabels.push(
    { id: 'l-trig', name: 'TRIG', pin: { partId: 'US1', pin: 'trig' } },
    { id: 'l-echo', name: 'ECHO', pin: { partId: 'US1', pin: 'echo' } },
    { id: 'l-pwm', name: 'SERVO_PWM', pin: { partId: 'SV1', pin: 'signal' } },
    { id: 'l-5v', name: '+5V', pin: { partId: 'U1', pin: '5V' } },
  );
  b.run('electrical.circuit.create', { definition: def });
  return { ...b.engine.getProject(), revision: 0 };
}

export const ARM_ELECTRONICS_SAMPLE_NAME = 'Sample — Robotic arm with electronics';
export const ARM_OBSTACLE_NODE = 'arm-obstacle';

/**
 * The Phase 4/5 robotic arm, unchanged mechanically, with an electrical control configuration:
 * an UNO on USB power drives four servos whose motor supply is a separate 6 V battery domain
 * with a shared ground; the plate-mounted HC-SR04 gives basic range feedback.
 */
export function createArmElectronicsSample(now = new Date()): Project {
  const p0 = createRoboticArmSimulationSample(now);
  const b = new SceneBuilder({ ...p0, name: ARM_ELECTRONICS_SAMPLE_NAME });
  b.run('scene.node.create', {
    node: {
      kind: 'primitive',
      id: ARM_OBSTACLE_NODE,
      name: 'Obstacle in front of the range sensor',
      parentId: b.graph.rootId,
      geometry: { shape: 'box', width: 0.12, height: 0.06, depth: 0.02 },
      transform: { position: [0, 0.03, 0.4] },
    },
  });
  const arm = b.graph.nodes[ARM_ASSEMBLY_ID];
  const centre = (mateId: string) =>
    arm?.kind === 'assembly' ? (arm.mechanical.mates.find((m) => m.id === mateId)?.coordinates[0] ?? 0) : 0;
  const def: ElectricalDefinition = defaultElectricalDefinition('Arm controller');
  def.firmware.push({
    id: 'fw-arm',
    name: 'Four-joint arm control',
    language: 'arduino-subset',
    source: ARM_CONTROL_SKETCH,
    revision: 1,
  });
  const servo = (id: string, name: string, definitionId: string, nodeId: string, mateId: string, y: number) =>
    catalogPart(id, id, name, definitionId, nodeId, [40, y], { mateId, jointCentreRad: centre(mateId) });
  def.parts.push(
    catalogPart('U1', 'U1', 'Arduino UNO R3 (USB)', 'arduino-uno-r3', 'arduino', [0, 0], {
      firmwareId: 'fw-arm',
    }),
    catalogPart(
      'BT1',
      'BT1',
      'Servo supply 4 × AA (6 V)',
      'battery-pack',
      'battery',
      [70, 4],
      {},
      {},
      '4xaa',
    ),
    servo('SV1', 'Base yaw servo', 'towerpro-mg996r', 'base-servo', ARM_JOINTS.yaw, -18),
    servo('SV2', 'Shoulder servo', 'towerpro-mg996r', 'shoulder-servo', ARM_JOINTS.shoulder, -6),
    servo('SV3', 'Elbow servo', 'towerpro-mg996r', 'elbow-servo', ARM_JOINTS.elbow, 6),
    servo('SV4', 'Wrist servo', 'towerpro-sg90', 'wrist-servo', ARM_JOINTS.wrist, 18),
    // Central ray only: the plate-level sensor would otherwise see the bench within its cone.
    catalogPart('US1', 'US1', 'Range sensor (HC-SR04)', 'hc-sr04', 'range-sensor', [34, -34], { rays: 1 }),
    {
      id: 'GND1',
      label: 'GND1',
      name: 'Ground',
      device: { type: 'ground' },
      definitionId: null,
      nodeId: null,
      schematic: { x: 70, y: 22, rotation: 0 },
      note: '',
    },
  );
  const pins: Record<string, string> = { SV1: 'D3', SV2: 'D5', SV3: 'D6', SV4: 'D9' };
  for (const [sv, pin] of Object.entries(pins))
    def.wires.push(
      wire(`w-${sv}-sig`, `U1.${pin}`, `${sv}.signal`, YELLOW),
      wire(`w-${sv}-v`, 'BT1.pos', `${sv}.vplus`, RED),
      wire(`w-${sv}-g`, 'BT1.neg', `${sv}.gnd`, BLACK),
    );
  def.wires.push(
    wire('w-shared-gnd', 'BT1.neg', 'U1.GND.1', BLACK),
    wire('w-gnd-sym', 'BT1.neg', 'GND1.gnd', BLACK),
    wire('w-us-5v', 'U1.5V', 'US1.vcc', RED),
    wire('w-us-gnd', 'U1.GND.2', 'US1.gnd', BLACK),
    wire('w-us-trig', 'U1.D7', 'US1.trig', YELLOW),
    wire('w-us-echo', 'US1.echo', 'U1.D8', ORANGE),
  );
  def.netLabels.push(
    { id: 'l-vservo', name: 'V_SERVO', pin: { partId: 'BT1', pin: 'pos' } },
    { id: 'l-5v', name: '+5V', pin: { partId: 'U1', pin: '5V' } },
  );
  def.groups.push(
    { id: 'g-ctrl', name: 'Controller (USB 5 V domain)', parentId: null, partIds: ['U1', 'US1'] },
    {
      id: 'g-servo',
      name: 'Servo power domain (6 V)',
      parentId: null,
      partIds: ['BT1', 'SV1', 'SV2', 'SV3', 'SV4'],
    },
  );
  b.run('electrical.circuit.create', { definition: def });
  // The obstacle is a fixed body (an experiment target the user can move while simulating).
  b.run('physics.body.set', { nodeId: ARM_OBSTACLE_NODE, settings: { mode: 'fixed' } });
  return { ...b.engine.getProject(), revision: 0 };
}
