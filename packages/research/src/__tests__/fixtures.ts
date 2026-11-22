import type { Project } from '@forge/engineering-core';
import { modelFingerprint } from '../params';
import type { Experiment, Measurement, Variable } from '../schemas';

/** Shared test fixtures (kept out of *.test.ts so importing them does not re-register tests). */
export const variable = (p: Partial<Variable> & Pick<Variable, 'id' | 'target'>): Variable => ({
  name: p.id,
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
export const measurement = (
  p: Partial<Measurement> & Pick<Measurement, 'id' | 'source' | 'reduction'>,
): Measurement => ({
  name: p.id,
  window: { fromS: 0, toS: null },
  params: {},
  required: true,
  description: '',
  ...p,
});

export function armExperiment(p: Project, patch: Partial<Experiment> = {}) {
  return {
    id: 'payload',
    title: 'Payload study',
    description: '',
    researchQuestion: 'How does payload mass affect shoulder tracking and effort?',
    mode: 'hypothesis' as const,
    hypothesis: null,
    variables: [
      variable({
        id: 'mass',
        name: 'Payload mass',
        unit: 'kg',
        target: 'physics.payload.payload-ee.massKg',
        min: 0,
        max: 2,
        default: 0,
        levels: [0, 0.3, 0.6],
      }),
      variable({
        id: 'target',
        name: 'Shoulder target',
        role: 'controlled',
        type: 'angle',
        unit: 'deg',
        target: 'physics.joint.j-shoulder.target',
        default: 30,
      }),
    ],
    measurements: [
      measurement({
        id: 'effort',
        source: { kind: 'signal', signal: 'j-shoulder.effort' },
        reduction: 'peak-abs',
      }),
      measurement({
        id: 'effortRms',
        source: { kind: 'signal', signal: 'j-shoulder.effort' },
        reduction: 'rms',
      }),
      measurement({
        id: 'err',
        source: {
          kind: 'derived',
          expression: 'abs(q - target)',
          aliases: { q: 'j-shoulder.q', target: 'j-shoulder.target' },
        },
        reduction: 'final',
      }),
      measurement({
        id: 'settle',
        source: { kind: 'signal', signal: 'j-shoulder.q' },
        reduction: 'settling-time',
        required: false,
      }),
    ],
    protocol: {
      model: {
        kind: 'physics' as const,
        projectId: p.id,
        projectName: p.name,
        fingerprint: modelFingerprint(p),
      },
      durationS: 1.5,
      warmupS: 0,
      sampleRateHz: 60,
      stopConditions: [],
      recordSignals: [],
      analysisPlan: '',
      randomizationPlan: '',
      notes: '',
    },
    design: {
      kind: 'oat' as const,
      replicates: 1,
      samples: 10,
      baseSeed: 7,
      pairedSeeds: true,
      randomizeOrder: false,
    },
    successCriteria: [],
    limitations: [],
    notebook: [],
    ...patch,
  };
}
