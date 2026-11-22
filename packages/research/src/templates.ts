import { createProject, type Project } from '@forge/engineering-core';
import { CircuitBuilder, createUltrasonicServoSample } from '@forge/electronics';
import { ARM_JOINTS } from '@forge/mechanics';
import { SceneBuilder } from '@forge/physics';
import { modelFingerprint } from './params';
import type { Experiment, Measurement, Variable } from './schemas';

/**
 * Research templates: sample projects for studies that need them, and the five structured
 * benchmark experiments (A–E). Templates are ordinary experiments — every field is editable,
 * and their variables resolve to real parameters of the selected project.
 */
export type ExperimentDraft = Omit<Experiment, 'createdAt' | 'updatedAt' | 'revision' | 'schemaVersion'>;

export const v = (p: Partial<Variable> & Pick<Variable, 'id' | 'name' | 'target'>): Variable => ({
  type: 'continuous',
  role: 'independent',
  unit: '',
  min: null,
  max: null,
  default: 0,
  levels: [],
  distribution: null,
  description: '',
  constraints: '',
  ...p,
});
export const m = (
  p: Partial<Measurement> & Pick<Measurement, 'id' | 'name' | 'source' | 'reduction'>,
): Measurement => ({
  window: { fromS: 0, toS: null },
  params: {},
  required: true,
  description: '',
  ...p,
});
const sig = (signal: string) => ({ kind: 'signal' as const, signal });

function draft(
  p: Project,
  kind: Experiment['protocol']['model']['kind'],
  d: Partial<ExperimentDraft> & Pick<ExperimentDraft, 'id' | 'title' | 'researchQuestion'>,
): ExperimentDraft {
  return {
    description: '',
    mode: 'hypothesis',
    hypothesis: null,
    variables: [],
    measurements: [],
    protocol: {
      model: { kind, projectId: p.id, projectName: p.name, fingerprint: modelFingerprint(p) },
      durationS: 2,
      warmupS: 0,
      sampleRateHz: 120,
      stopConditions: [],
      recordSignals: [],
      analysisPlan: '',
      randomizationPlan:
        'Not randomised: the models are deterministic, so execution order cannot bias results.',
      notes: '',
    },
    design: {
      kind: 'oat',
      replicates: 1,
      samples: 20,
      baseSeed: 1,
      pairedSeeds: true,
      randomizeOrder: false,
    },
    successCriteria: [],
    limitations: [],
    notebook: [],
    ...d,
  };
}

// -- A: robotic-arm payload study ---------------------------------------------------------------
export function armPayloadExperiment(p: Project): ExperimentDraft {
  const sh = ARM_JOINTS.shoulder;
  return draft(p, 'physics', {
    id: 'exp-a-payload',
    title: 'A — Robotic-arm payload study',
    researchQuestion: "How does payload mass affect the simulated arm's shoulder tracking and effort demand?",
    hypothesis: {
      statement:
        "Increasing payload mass increases the shoulder actuator's required effort and reduces tracking accuracy once the actuator approaches its configured effort limit.",
      relationship: 'increase',
      independentVariable: 'mass',
      outcome: 'effortRms',
      referenceCondition: '0 kg payload',
      comparisonCondition: 'heavier payloads',
      criterion: 'RMS effort rises with payload; tracking error grows when the effort saturates.',
    },
    variables: [
      v({
        id: 'mass',
        name: 'Payload mass',
        unit: 'kg',
        target: 'physics.payload.payload-ee.massKg',
        min: 0,
        max: 1,
        default: 0,
        levels: [0, 0.1, 0.2, 0.3, 0.5],
      }),
      v({
        id: 'target',
        name: 'Shoulder target',
        type: 'angle',
        unit: 'deg',
        target: `physics.joint.${sh}.target`,
        min: -60,
        max: 60,
        default: 30,
        levels: [15, 30, 45],
      }),
      v({
        id: 'limit',
        name: 'Shoulder effort limit',
        unit: 'N·m',
        target: `physics.joint.${sh}.effortLimit`,
        min: 0.1,
        max: 3,
        default: 0.92183,
        levels: [0.6, 0.92183, 1.2],
      }),
    ],
    measurements: [
      m({ id: 'effortRms', name: 'RMS shoulder effort', source: sig(`${sh}.effort`), reduction: 'rms' }),
      m({
        id: 'effortPeak',
        name: 'Peak shoulder effort',
        source: sig(`${sh}.effort`),
        reduction: 'peak-abs',
      }),
      m({
        id: 'errFinal',
        name: 'Final tracking error',
        source: {
          kind: 'derived',
          expression: 'abs(q - target)',
          aliases: { q: `${sh}.q`, target: `${sh}.target` },
        },
        reduction: 'final',
      }),
      m({
        id: 'iae',
        name: 'Integrated absolute tracking error',
        source: {
          kind: 'derived',
          expression: 'abs(q - target)',
          aliases: { q: `${sh}.q`, target: `${sh}.target` },
        },
        reduction: 'iae',
      }),
      m({
        id: 'settle',
        name: 'Settling time (2 %)',
        source: sig(`${sh}.q`),
        reduction: 'settling-time',
        required: false,
      }),
      m({
        id: 'saturated',
        name: 'Time at the effort limit',
        source: sig(`${sh}.sat`),
        reduction: 'time-above',
        params: { threshold: 0.5 },
      }),
    ],
    protocol: {
      ...draft(p, 'physics', { id: '', title: '', researchQuestion: '' }).protocol,
      durationS: 2.5,
      sampleRateHz: 120,
      analysisPlan:
        'Compare each payload with 0 kg (OAT). Deterministic model: report exact differences, not significance tests.',
    },
    limitations: [
      'Generic servo dynamics with datasheet-cited stall torque and speed; not a model of the physical servo.',
      'No payload capacity of the physical robot is inferred from these results.',
      'Rigid bodies, no structural failure.',
    ],
  });
}

// -- B/C: ultrasonic threshold controller -------------------------------------------------------
export const THRESHOLD_SKETCH = (
  hysteresisCm: number,
  confirm: number,
) => `// Threshold controller: servo to 150 deg when an object is near, 30 deg otherwise.
#include <Servo.h>

const int TRIG_PIN = 7;
const int ECHO_PIN = 8;
const float THRESHOLD_CM = 25.0;   // switching distance
const float HYSTERESIS_CM = ${hysteresisCm.toFixed(1)};   // band around the threshold
const int CONFIRM_READINGS = ${confirm};    // readings that must agree before switching
const int LOOP_MS = 60;

Servo gauge;
bool near = false;
int agree = 0;

float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long us = pulseIn(ECHO_PIN, HIGH, 30000);
  if (us == 0) return -1.0;
  return us * 0.0343 / 2.0;
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  gauge.attach(9);
  gauge.write(30);
}

void loop() {
  float d = readDistanceCm();
  if (d > 0) {
    bool wantNear = near ? (d < THRESHOLD_CM + HYSTERESIS_CM) : (d < THRESHOLD_CM - HYSTERESIS_CM);
    if (wantNear != near) {
      agree++;
      if (agree >= CONFIRM_READINGS) {
        near = wantNear;
        agree = 0;
      }
    } else {
      agree = 0;
    }
  }
  gauge.write(near ? 150 : 30);
  delay(LOOP_MS);
}
`;

export const ULTRASONIC_STUDY_NAME = 'Sample — Ultrasonic threshold controller study';
/** The Phase 6 gauge sample plus two editable threshold controllers (responsive / conservative). */
export function createUltrasonicStudyProject(now = new Date()): Project {
  const b = new SceneBuilder({ ...createUltrasonicServoSample(now), name: ULTRASONIC_STUDY_NAME });
  b.run('electrical.firmware.set', {
    firmware: {
      id: 'fw-responsive',
      name: 'Responsive threshold controller',
      language: 'arduino-subset',
      source: THRESHOLD_SKETCH(0, 1),
    },
  });
  b.run('electrical.firmware.set', {
    firmware: {
      id: 'fw-conservative',
      name: 'Conservative threshold controller',
      language: 'arduino-subset',
      source: THRESHOLD_SKETCH(3, 3),
    },
  });
  const root = b.graph.nodes[b.graph.rootId]!;
  const u1 = root.kind === 'root' ? root.electrical!.parts.find((x) => x.id === 'U1')! : null;
  if (u1 && u1.device.type === 'mcu')
    b.run('electrical.part.update', {
      partId: 'U1',
      patch: { device: { ...u1.device, firmwareId: 'fw-responsive' } },
    });
  return { ...b.engine.getProject(), revision: 0 };
}

const sensorMeasurements = () => [
  m({
    id: 'distErr',
    name: 'Distance error (reported − geometric)',
    source: { kind: 'derived', expression: 'abs(r - g)', aliases: { r: 'US1.reported', g: 'US1.geometric' } },
    reduction: 'mean',
  }),
  m({
    id: 'switches',
    name: 'Servo target changes (false switching when the target is still)',
    source: sig('SV1.target'),
    reduction: 'change-count',
  }),
  m({
    id: 'qStd',
    name: 'Pointer angle variation (stability)',
    source: sig('SV1.q'),
    reduction: 'std',
    window: { fromS: 1, toS: null },
  }),
  m({ id: 'distSd', name: 'Reported distance spread', source: sig('US1.reported'), reduction: 'std' }),
];

export function sensorNoiseExperiment(p: Project): ExperimentDraft {
  return draft(p, 'cosim', {
    id: 'exp-b-sensor-noise',
    title: 'B — Sensor uncertainty in the ultrasonic control loop',
    researchQuestion:
      'How does HC-SR04 measurement noise affect the Arduino–HC-SR04–servo control loop near its switching threshold?',
    hypothesis: {
      statement:
        'More sensor noise increases distance error and false threshold crossings when the target sits near the threshold.',
      relationship: 'increase',
      independentVariable: 'noise',
      outcome: 'switches',
      referenceCondition: 'no noise',
      comparisonCondition: 'σ = 5 and 15 mm',
      criterion: 'More servo target changes with more noise; none without noise.',
    },
    variables: [
      v({
        id: 'noise',
        name: 'Sensor noise σ',
        unit: 'mm',
        target: 'electrical.part.US1.noiseStdM',
        min: 0,
        max: 50,
        default: 0,
        levels: [0, 5, 15],
      }),
      v({
        id: 'distance',
        name: 'Target distance',
        role: 'controlled',
        unit: 'm',
        target: 'runtime.position.obstacle.z',
        min: 0.05,
        max: 1,
        default: 0.27,
      }),
      v({
        id: 'threshold',
        name: 'Controller threshold',
        role: 'controlled',
        type: 'controller',
        unit: '',
        target: 'firmware.fw-responsive.const.THRESHOLD_CM',
        default: 25,
      }),
    ],
    measurements: sensorMeasurements(),
    protocol: {
      ...draft(p, 'cosim', { id: '', title: '', researchQuestion: '' }).protocol,
      durationS: 4,
      sampleRateHz: 60,
      analysisPlan:
        'Three replicates per noise level with independent seeds; compare means and variability of switch counts.',
    },
    design: {
      kind: 'oat',
      replicates: 3,
      samples: 1,
      baseSeed: 11,
      pairedSeeds: false,
      randomizeOrder: false,
    },
    limitations: [
      'Gaussian range noise is a model choice; real HC-SR04 errors include multipath and surface effects that are not modelled.',
      'Level 2 microcontroller runtime: loop timing is approximate.',
    ],
  });
}

export function controllerComparisonExperiment(p: Project): ExperimentDraft {
  return draft(p, 'cosim', {
    id: 'exp-c-controllers',
    title: 'C — Responsive vs conservative threshold controller',
    researchQuestion:
      'Does a conservative threshold controller (hysteresis and confirmation readings) reduce false switching compared with a responsive one, under the same sensor noise?',
    hypothesis: {
      statement:
        'The conservative controller switches less often than the responsive one when the target sits near the threshold.',
      relationship: 'decrease',
      independentVariable: 'controller',
      outcome: 'switches',
      referenceCondition: 'Responsive',
      comparisonCondition: 'Conservative',
      criterion: 'Fewer servo target changes, paired by seed.',
    },
    variables: [
      v({
        id: 'controller',
        name: 'Controller configuration',
        type: 'categorical',
        unit: '',
        target: 'electrical.part.U1.firmwareId',
        default: 'fw-responsive',
        levels: ['fw-responsive', 'fw-conservative'],
      }),
      v({
        id: 'noise',
        name: 'Sensor noise σ',
        role: 'controlled',
        unit: 'mm',
        target: 'electrical.part.US1.noiseStdM',
        min: 0,
        max: 50,
        default: 10,
      }),
      v({
        id: 'distance',
        name: 'Target distance',
        role: 'controlled',
        unit: 'm',
        target: 'runtime.position.obstacle.z',
        min: 0.05,
        max: 1,
        default: 0.27,
      }),
    ],
    measurements: sensorMeasurements(),
    protocol: {
      ...draft(p, 'cosim', { id: '', title: '', researchQuestion: '' }).protocol,
      durationS: 4,
      sampleRateHz: 60,
      analysisPlan:
        'Paired comparison (same seed per replicate in both controllers): paired differences of switch counts; report mean, variability and a paired test only as descriptive evidence about the model.',
    },
    design: {
      kind: 'paired',
      replicates: 5,
      samples: 1,
      baseSeed: 21,
      pairedSeeds: true,
      randomizeOrder: false,
    },
    limitations: [
      'Both controllers run in the same simulated world with the same noise sequence per pair; real-world switching also depends on unmodelled acoustics.',
    ],
  });
}

// -- D: RC circuit sweep ------------------------------------------------------------------------
export const RC_STUDY_NAME = 'Sample — RC charging study';
export function createRcStudyProject(now = new Date()): Project {
  const p = createProject(RC_STUDY_NAME, now);
  const b = new SceneBuilder(p);
  for (const c of b.graph.nodes[b.graph.rootId]!.childIds) b.run('scene.node.delete', { nodeId: c });
  const cb = new CircuitBuilder('RC charging');
  const vs = cb.dcSource(5, { id: 'V1', label: 'V1' });
  const g = cb.ground();
  const r = cb.resistor(1000, { id: 'R1', label: 'R1' });
  const c = cb.capacitor(1e-6, 0, { id: 'C1', label: 'C1' });
  cb.wire(`${vs}.neg`, `${g}.gnd`)
    .wire(`${vs}.pos`, `${r}.p1`)
    .wire(`${r}.p2`, `${c}.p1`)
    .label('VC', `${c}.p1`)
    .wire(`${c}.p2`, `${g}.gnd`);
  const def = cb.build();
  def.settings.transient.stepS = 2e-6;
  b.run('electrical.circuit.create', { definition: def });
  return { ...b.engine.getProject(), revision: 0 };
}

export function rcSweepExperiment(p: Project): ExperimentDraft {
  return draft(p, 'circuit', {
    id: 'exp-d-rc',
    title: 'D — RC charging time: resistor × capacitor sweep',
    researchQuestion:
      'How do R and C determine the charging time of an RC circuit, and does the numerical solution reproduce the analytical time constant τ = RC?',
    mode: 'exploratory',
    variables: [
      v({
        id: 'R',
        name: 'Resistance',
        unit: 'Ω',
        target: 'electrical.part.R1.resistanceOhm',
        min: 10,
        max: 1e6,
        default: 1000,
        levels: [1000, 2200, 4700],
      }),
      v({
        id: 'C',
        name: 'Capacitance',
        unit: 'µF',
        target: 'electrical.part.C1.capacitanceF',
        min: 0.01,
        max: 100,
        default: 1,
        levels: [0.47, 1, 2.2],
      }),
    ],
    measurements: [
      m({
        id: 'tau',
        name: 'Time to 63.2 % (≈ τ)',
        source: sig('V(VC)'),
        reduction: 'first-crossing',
        params: { threshold: 5 * (1 - Math.exp(-1)) },
      }),
      m({ id: 'vEnd', name: 'Final capacitor voltage', source: sig('V(VC)'), reduction: 'final' }),
    ],
    protocol: {
      ...draft(p, 'circuit', { id: '', title: '', researchQuestion: '' }).protocol,
      durationS: 0.06,
      sampleRateHz: 100_000,
      analysisPlan:
        'Grid over R and C; compare the measured time to 63.2 % with the analytical τ = RC (numerical verification, not empirical validation).',
    },
    design: {
      kind: 'grid',
      replicates: 1,
      samples: 1,
      baseSeed: 1,
      pairedSeeds: true,
      randomizeOrder: false,
    },
    limitations: [
      'Ideal R and C; the comparison verifies the solver, it does not validate a physical circuit.',
    ],
  });
}

// -- E: joint dynamics under timestep refinement -------------------------------------------------
export function convergenceExperiment(p: Project): ExperimentDraft {
  const sh = ARM_JOINTS.shoulder;
  return draft(p, 'physics', {
    id: 'exp-e-convergence',
    title: 'E — Arm joint dynamics under timestep refinement',
    researchQuestion:
      'Does the simulated shoulder trajectory converge as the physics timestep is refined, and at what cost?',
    mode: 'exploratory',
    variables: [
      v({
        id: 'dt',
        name: 'Physics timestep',
        unit: 'ms',
        target: 'physics.solver.timestepS',
        min: 0.5,
        max: 33,
        default: 1000 / 120,
        levels: [1000 / 60, 1000 / 120, 1000 / 240, 1000 / 480],
      }),
      v({
        id: 'target',
        name: 'Shoulder target',
        role: 'controlled',
        type: 'angle',
        unit: 'deg',
        target: `physics.joint.${sh}.target`,
        default: 30,
      }),
      v({
        id: 'mass',
        name: 'Payload mass',
        role: 'controlled',
        unit: 'kg',
        target: 'physics.payload.payload-ee.massKg',
        min: 0,
        max: 1,
        default: 0.1,
      }),
    ],
    measurements: [
      m({ id: 'qFinal', name: 'Final shoulder angle', source: sig(`${sh}.q`), reduction: 'final' }),
      m({ id: 'qMax', name: 'Peak shoulder angle', source: sig(`${sh}.q`), reduction: 'max' }),
      m({ id: 'drift', name: 'Peak constraint drift', source: sig(`${sh}.drift`), reduction: 'peak-abs' }),
    ],
    protocol: {
      ...draft(p, 'physics', { id: '', title: '', researchQuestion: '' }).protocol,
      durationS: 1.5,
      sampleRateHz: 60,
      recordSignals: [`${sh}.q`],
      analysisPlan:
        'Successive-refinement differences of the shoulder trajectory, observed order, constraint drift and run time.',
    },
    design: { kind: 'oat', replicates: 1, samples: 1, baseSeed: 1, pairedSeeds: true, randomizeOrder: false },
    limitations: [
      'Rapier is iterative and single precision: refinement can stall at solver tolerance rather than converge to zero.',
    ],
  });
}
