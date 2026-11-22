import { createArmElectronicsSample, createUltrasonicServoSample } from '@forge/electronics';
import { createRoboticArmSimulationSample } from '@forge/physics';
import { describe, expect, it } from 'vitest';
import { ResearchEngine, parseResearch, serializeResearch, integrityOf } from '../engine';
import { ExprError, parseExpr } from '../expr';
import { sha256 } from '../hash';
import { applyValues, firmwareConstants, listTargets, modelFingerprint } from '../params';
import { deriveSeed, mulberry32 } from '../random';
import { ExperimentSchema, type Experiment } from '../schemas';
import { conversion, parseUnit } from '../units';

const at = new Date('2026-11-22T00:00:00Z');
export function baseExperiment(
  projectId = 'p1',
): Omit<Experiment, 'createdAt' | 'updatedAt' | 'revision' | 'schemaVersion'> {
  return {
    id: 'e1',
    title: 'Payload study',
    description: '',
    researchQuestion: 'How does payload affect tracking?',
    mode: 'hypothesis',
    hypothesis: null,
    variables: [],
    measurements: [],
    protocol: {
      model: { kind: 'physics', projectId, projectName: 'Arm', fingerprint: '' },
      durationS: 2,
      warmupS: 0,
      sampleRateHz: 60,
      stopConditions: [],
      recordSignals: [],
      analysisPlan: '',
      randomizationPlan: '',
      notes: '',
    },
    design: {
      kind: 'oat',
      replicates: 1,
      samples: 10,
      baseSeed: 1,
      pairedSeeds: true,
      randomizeOrder: false,
    },
    successCriteria: [],
    limitations: [],
    notebook: [],
  };
}

describe('hashing and seeds', () => {
  it('SHA-256 matches the FIPS test vectors', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
  it('seeded streams are reproducible and independent', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(deriveSeed(1, 'c1', 0)).toBe(deriveSeed(1, 'c1', 0));
    expect(deriveSeed(1, 'c1', 0)).not.toBe(deriveSeed(1, 'c2', 0));
  });
});

describe('units and derived expressions', () => {
  it('parses compound units and converts only between equal dimensions', () => {
    expect(parseUnit('N·m')!.dims).toEqual([2, 1, -2, 0, 0, 0]);
    expect(parseUnit('rad/s')!.dims).toEqual([0, 0, -1, 0, 0, 1]);
    expect(parseUnit('m/s²')!.dims).toEqual([1, 0, -2, 0, 0, 0]);
    expect(conversion('deg', 'rad')).toBeCloseTo(Math.PI / 180, 15);
    expect(conversion('µs', 's')).toBe(1e-6);
    expect(conversion('V', 'A')).toBeNull();
  });
  it('rejects dimensionally invalid expressions and accepts valid ones', () => {
    const u = { q: 'rad', target: 'rad', effort: 'N·m', w: 'rad/s' };
    expect(parseExpr('abs(q - target)', u).dims).toEqual([0, 0, 0, 0, 0, 1]);
    // Torque × angular speed: W in SI; FORGE keeps rad as a tracked dimension (documented).
    expect(parseExpr('effort * w', u).dims).toEqual([2, 1, -3, 0, 0, 1]);
    expect(() => parseExpr('q + effort', u)).toThrow(ExprError);
    expect(() => parseExpr('sqrt(q)', u)).toThrow(/no valid unit/);
    expect(() => parseExpr('alert(1)', u)).toThrow(/Unknown function/);
    expect(() => parseExpr('q; process', u)).toThrow(ExprError);
    expect(() => parseExpr('undefinedSignal', u)).toThrow(/Unknown signal/);
  });
});

describe('parameter targets (real model parameters only)', () => {
  it('discovers payload, actuator, solver, firmware and circuit parameters from the actual projects', () => {
    const arm = listTargets(createRoboticArmSimulationSample(at)).map((t) => t.id);
    expect(arm).toContain('physics.payload.payload-ee.massKg');
    expect(arm).toContain('physics.joint.j-shoulder.effortLimit');
    expect(arm).toContain('physics.solver.timestepS');
    expect(arm).toContain('component.upper-link.variantId'); // link length
    const us = listTargets(createUltrasonicServoSample(at)).map((t) => t.id);
    expect(us).toContain('electrical.part.US1.noiseStdM');
    expect(us).toContain('firmware.fw-gauge.const.FAR_CM');
    expect(us).toContain('runtime.position.obstacle.z');
    expect(firmwareConstants('const int A = 3;\nconst float B=2.5;')).toEqual([
      { name: 'A', type: 'int', value: 3 },
      { name: 'B', type: 'float', value: 2.5 },
    ]);
  });

  it('applies values to a copy through validated commands; the original and its fingerprint are unchanged', () => {
    const p = createRoboticArmSimulationSample(at);
    const fp = modelFingerprint(p);
    const r = applyValues(p, [
      { target: 'physics.payload.payload-ee.massKg', value: 500, unit: 'g' },
      { target: 'physics.joint.j-shoulder.target', value: 30, unit: 'deg' },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.applied[0]).toMatchObject({ value: 0.5, unit: 'kg' });
    expect(r.applied[1]!.value).toBeCloseTo(Math.PI / 6, 12);
    expect(modelFingerprint(p)).toBe(fp);
    expect(modelFingerprint(r.project)).not.toBe(fp);
    // Unknown targets, incompatible units, out-of-range and invalid values are refused.
    expect(
      applyValues(p, [{ target: 'physics.joint.nope.target', value: 1, unit: 'rad' }]).errors[0],
    ).toMatch(/not a parameter/);
    expect(
      applyValues(p, [{ target: 'physics.payload.payload-ee.massKg', value: 1, unit: 'V' }]).errors[0],
    ).toMatch(/not compatible/);
    expect(
      applyValues(p, [{ target: 'physics.payload.payload-ee.massKg', value: -1, unit: 'kg' }]).errors[0],
    ).toMatch(/outside/);
    expect(applyValues(p, [{ target: 'physics.solver.substeps', value: 2.5, unit: '' }]).errors[0]).toMatch(
      /integer/,
    );
  });

  it('edits a firmware constant in the copy only', () => {
    const p = createArmElectronicsSample(at);
    void p;
    const u = createUltrasonicServoSample(at);
    const r = applyValues(u, [{ target: 'firmware.fw-gauge.const.FAR_CM', value: 80, unit: '' }]);
    expect(r.errors).toEqual([]);
    const fw = (proj: typeof u) => {
      const root = proj.scene.nodes[proj.scene.rootId]!;
      return root.kind === 'root' ? root.electrical!.firmware[0]!.source : '';
    };
    expect(fw(r.project)).toContain('const float FAR_CM = 80;');
    expect(fw(u)).toContain('const float FAR_CM = 50.0;');
  });
});

describe('research engine', () => {
  it('validated, undoable protocol commands; revision increments; invalid changes are refused', () => {
    const eng = ResearchEngine.empty('p1', () => at);
    expect(eng.execute({ type: 'experiment.create', payload: { experiment: baseExperiment() } }).ok).toBe(
      true,
    );
    const v = {
      id: 'mass',
      name: 'Payload mass',
      type: 'continuous' as const,
      role: 'independent' as const,
      unit: 'kg',
      target: 'physics.payload.payload-ee.massKg',
      min: 0,
      max: 2,
      default: 0,
      levels: [0, 0.5, 1],
      distribution: null,
      description: '',
      constraints: '',
    };
    expect(
      eng.execute({ type: 'experiment.defineVariable', payload: { experimentId: 'e1', variable: v } }).ok,
    ).toBe(true);
    expect(eng.experiment('e1')!.revision).toBe(2);
    // A level outside [min, max] is rejected and nothing changes.
    expect(
      eng.execute({
        type: 'experiment.defineVariable',
        payload: { experimentId: 'e1', variable: { ...v, levels: [5] } },
      }).ok,
    ).toBe(false);
    expect(eng.experiment('e1')!.variables[0]!.levels).toEqual([0, 0.5, 1]);
    expect(eng.undo()).toBe(true);
    expect(eng.experiment('e1')!.variables).toEqual([]);
    expect(eng.redo()).toBe(true);
    expect(ExperimentSchema.safeParse(eng.experiment('e1')).success).toBe(true);
  });

  it('run records are append-only and integrity-checked; the document round-trips', () => {
    const eng = ResearchEngine.empty('p1', () => at);
    eng.execute({ type: 'experiment.create', payload: { experiment: baseExperiment() } });
    const rec = {
      id: 'r1',
      experimentId: 'e1',
      experimentRevision: 1,
      conditionId: 'c0',
      conditionLabel: 'baseline',
      replicate: 0,
      state: 'COMPLETED' as const,
      history: [
        { state: 'CREATED' as const, at: at.toISOString(), note: '' },
        { state: 'VALIDATED' as const, at: at.toISOString(), note: '' },
        { state: 'QUEUED' as const, at: at.toISOString(), note: '' },
        { state: 'RUNNING' as const, at: at.toISOString(), note: '' },
        { state: 'COMPLETED' as const, at: at.toISOString(), note: '' },
      ],
      config: {
        variables: {},
        applied: [],
        durationS: 1,
        warmupS: 0,
        sampleRateHz: 60,
        seed: 1,
        rng: 'mulberry32 v1',
        measurements: [],
        solver: {},
      },
      configHash: 'a'.repeat(64),
      model: {
        kind: 'physics' as const,
        projectId: 'p1',
        projectRevision: 0,
        fingerprint: 'b'.repeat(64),
        runModelFingerprint: 'c'.repeat(64),
        firmware: [],
      },
      versions: {},
      startedAt: at.toISOString(),
      completedAt: at.toISOString(),
      wallMs: 1,
      simulatedS: 1,
      steps: 120,
      outcomes: {},
      warnings: [],
      error: null,
      data: null,
      retryOf: null,
      integrityHash: '',
    };
    rec.integrityHash = integrityOf(rec);
    expect(eng.recordRun(rec).ok).toBe(true);
    expect(eng.recordRun(rec).ok).toBe(false); // immutable: no overwrite
    expect(eng.recordRun({ ...rec, id: 'r2', steps: 1 }).ok).toBe(false); // hash mismatch
    const bad = { ...rec, id: 'r3', history: [rec.history[0]!, rec.history[4]!] };
    bad.integrityHash = integrityOf(bad);
    expect(eng.recordRun(bad).ok).toBe(false); // CREATED → COMPLETED is not a valid transition
    // Undo never removes results.
    eng.undo();
    expect(eng.document.runs).toHaveLength(1);
    const back = parseResearch(serializeResearch(eng.document));
    expect(back.ok && back.doc).toEqual(eng.document);
    expect(parseResearch(JSON.stringify({ ...eng.document, schemaVersion: 2 })).ok).toBe(false);
    expect(new ResearchEngine(eng.document).integrityReport()).toEqual([]);
  });
});
