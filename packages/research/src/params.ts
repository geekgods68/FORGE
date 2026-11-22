import { getDefinition } from '@forge/components';
import type {
  Device,
  ElectricalDefinition,
  Project,
  SceneGraph,
  SimulationDefinition,
} from '@forge/engineering-core';
import { SceneBuilder } from '@forge/physics';
import { hashOfValue } from './hash';
import type { ModelKind, ParamValue } from './schemas';
import { conversion } from './units';

/**
 * Parameter targets: the model parameters an experiment may vary. Every target is discovered
 * from the actual project (payloads, actuated joints, circuit parts, firmware constants …), and
 * values are APPLIED to a copy of the project through the ordinary validated engine commands —
 * so a variable can never be a label that looks editable but changes nothing, and an invalid
 * value is refused exactly as the editor would refuse it. The original project is never touched.
 */
export interface ParamTarget {
  id: string;
  label: string;
  group: 'physics' | 'solver' | 'electrical' | 'firmware' | 'component' | 'runtime';
  unit: string;
  valueType: 'number' | 'integer' | 'boolean' | 'enum' | 'vector';
  options: { value: string; label: string }[];
  min: number | null;
  max: number | null;
  current: ParamValue;
  /** Model kinds whose runs use this parameter. */
  kinds: ModelKind[];
  note: string;
}

export interface RuntimeAction {
  kind: 'move-z';
  nodeId: string;
  value: number;
}

const rootOf = (scene: SceneGraph) => {
  const r = scene.nodes[scene.rootId];
  return r?.kind === 'root' ? r : null;
};
export const simulationOfScene = (scene: SceneGraph): SimulationDefinition | null =>
  rootOf(scene)?.simulation ?? null;
export const electricalOfScene = (scene: SceneGraph): ElectricalDefinition | null =>
  rootOf(scene)?.electrical ?? null;

/** Fingerprint of the engineering model (scene graph + embedded definitions/materials). */
export function modelFingerprint(p: Project): string {
  return hashOfValue({ scene: p.scene, definitions: p.definitions, materials: p.materials, units: p.units });
}

/** Firmware constants (`const <type> NAME = <number>;`) — the controller parameters of a sketch. */
const CONST_RE =
  /const\s+((?:unsigned\s+)?(?:int|long|float|double|byte|bool|boolean|uint8_t|uint16_t|int16_t|uint32_t|int32_t))\s+([A-Za-z_]\w*)\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*;/g;
export function firmwareConstants(source: string): { name: string; type: string; value: number }[] {
  return [...source.matchAll(CONST_RE)].map((m) => ({ name: m[2]!, type: m[1]!, value: Number(m[3]) }));
}

const DEVICE_UNITS: Record<string, string> = {
  resistanceOhm: 'Ω',
  capacitanceF: 'F',
  inductanceH: 'H',
  seriesResistanceOhm: 'Ω',
  onResistanceOhm: 'Ω',
  noiseStdM: 'm',
  minRangeM: 'm',
  maxRangeM: 'm',
  temperatureC: '°C',
  frequencyHz: 'Hz',
  duty: '',
  logicV: 'V',
  delayNs: 'ns',
  pulseMinUs: 'µs',
  pulseMaxUs: 'µs',
  deadbandUs: 'µs',
  jointCentreRad: 'rad',
  position: '',
  thresholdV: 'V',
  transconductanceAPerV2: '',
  betaF: '',
  gain: '',
  minSupplyV: 'V',
  maxSupplyV: 'V',
  beamHalfAngleRad: 'rad',
};

export function listTargets(p: Project): ParamTarget[] {
  const out: ParamTarget[] = [];
  const scene = p.scene;
  const sim = simulationOfScene(scene);
  const el = electricalOfScene(scene);
  const phys: ModelKind[] = ['physics', 'cosim'];
  const num = (
    id: string,
    label: string,
    group: ParamTarget['group'],
    unit: string,
    current: number,
    kinds: ModelKind[],
    min: number | null = null,
    max: number | null = null,
    note = '',
    valueType: ParamTarget['valueType'] = 'number',
  ): ParamTarget => ({
    id,
    label,
    group,
    unit,
    valueType,
    options: [],
    min,
    max,
    current,
    kinds,
    note,
  });
  if (sim) {
    out.push(
      num(
        'physics.gravity.y',
        'Gravity (vertical component)',
        'physics',
        'm/s²',
        sim.gravity[1],
        phys,
        -1000,
        1000,
      ),
    );
    out.push(
      num(
        'physics.solver.timestepS',
        'Physics timestep',
        'solver',
        's',
        sim.solver.timestepS,
        phys,
        1 / 2000,
        1 / 30,
        'Numerical parameter (verification), not a physical one.',
      ),
    );
    out.push(
      num(
        'physics.solver.substeps',
        'Physics sub-steps',
        'solver',
        '',
        sim.solver.substeps,
        phys,
        1,
        16,
        '',
        'integer',
      ),
    );
    out.push(
      num(
        'physics.solver.solverIterations',
        'Solver iterations',
        'solver',
        '',
        sim.solver.solverIterations,
        phys,
        1,
        32,
        '',
        'integer',
      ),
    );
    for (const pl of sim.payloads)
      out.push(
        num(`physics.payload.${pl.id}.massKg`, `${pl.name} mass`, 'physics', 'kg', pl.massKg, phys, 0, 1e5),
      );
    for (const j of sim.joints) {
      const mate = findMate(scene, j.mateId);
      const name = mate?.name ?? j.mateId;
      const unit = mate?.type === 'prismatic' ? 'm' : 'rad';
      const eff = mate?.type === 'prismatic' ? 'N' : 'N·m';
      out.push(
        num(
          `physics.joint.${j.mateId}.damping`,
          `${name} damping`,
          'physics',
          mate?.type === 'prismatic' ? 'N·s/m' : 'N·m·s/rad',
          j.damping,
          phys,
          0,
          1e6,
        ),
      );
      out.push(
        num(
          `physics.joint.${j.mateId}.friction`,
          `${name} Coulomb friction`,
          'physics',
          eff,
          j.friction,
          phys,
          0,
          1e6,
        ),
      );
      if (j.actuator) {
        out.push(
          num(
            `physics.joint.${j.mateId}.target`,
            `${name} target`,
            'physics',
            unit,
            j.actuator.target,
            ['physics'],
            null,
            null,
            'Position target at t = 0 (in co-simulation the controller sets targets).',
          ),
        );
        out.push(
          num(
            `physics.joint.${j.mateId}.effortLimit`,
            `${name} effort limit`,
            'physics',
            eff,
            j.actuator.effortLimit,
            phys,
            1e-9,
            1e6,
          ),
        );
        out.push(
          num(
            `physics.joint.${j.mateId}.speedLimit`,
            `${name} speed limit`,
            'physics',
            `${unit}/s`,
            j.actuator.speedLimit,
            phys,
            1e-9,
            1e4,
          ),
        );
        if (j.actuator.gains.mode === 'auto')
          out.push(
            num(
              `physics.joint.${j.mateId}.bandwidthHz`,
              `${name} controller bandwidth (gain)`,
              'physics',
              'Hz',
              j.actuator.gains.bandwidthHz,
              phys,
              1e-3,
              200,
            ),
          );
      }
    }
    for (const b of sim.bodies)
      out.push(
        num(
          `physics.body.${b.nodeId}.friction`,
          `${scene.nodes[b.nodeId]?.name ?? b.nodeId} friction`,
          'physics',
          '',
          b.friction,
          phys,
          0,
          10,
        ),
      );
  }
  // Catalogue components: material and variant (they change geometry and mass).
  for (const n of Object.values(scene.nodes)) {
    if (n.kind !== 'component-instance' || !n.component) continue;
    const def = getDefinition(n.definitionId);
    if (!def) continue;
    if (def.allowedMaterialIds.length > 1)
      out.push({
        id: `component.${n.id}.materialId`,
        label: `${n.name} material`,
        group: 'component',
        unit: '',
        valueType: 'enum',
        options: def.allowedMaterialIds.map((m) => ({ value: m, label: m })),
        min: null,
        max: null,
        current: n.component.materialId ?? def.materialId ?? '',
        kinds: phys,
        note: 'Changes mass properties (geometry × density).',
      });
    if (def.variants.length > 1)
      out.push({
        id: `component.${n.id}.variantId`,
        label: `${n.name} variant`,
        group: 'component',
        unit: '',
        valueType: 'enum',
        options: def.variants.map((v) => ({ value: v.id, label: v.name })),
        min: null,
        max: null,
        current: n.component.variantId ?? '',
        kinds: phys,
        note: 'Changes dimensions (e.g. link length); mates re-solve.',
      });
  }
  if (el) {
    const elec: ModelKind[] = ['cosim', 'circuit'];
    for (const part of el.parts) {
      const d = part.device as Record<string, unknown> & Device;
      for (const [k, v] of Object.entries(d))
        if (typeof v === 'number' && k in DEVICE_UNITS)
          out.push(
            num(
              `electrical.part.${part.id}.${k}`,
              `${part.label} ${k}`,
              'electrical',
              DEVICE_UNITS[k]!,
              v,
              elec,
            ),
          );
      if (d.type === 'vsource' && d.waveform.kind === 'dc')
        out.push(
          num(
            `electrical.part.${part.id}.voltage`,
            `${part.label} voltage`,
            'electrical',
            'V',
            d.waveform.value,
            elec,
          ),
        );
      if (d.type === 'mcu')
        out.push({
          id: `electrical.part.${part.id}.firmwareId`,
          label: `${part.label} firmware (controller configuration)`,
          group: 'firmware',
          unit: '',
          valueType: 'enum',
          options: el.firmware.map((f) => ({ value: f.id, label: f.name })),
          min: null,
          max: null,
          current: d.firmwareId ?? '',
          kinds: ['cosim'],
          note: '',
        });
    }
    for (const f of el.firmware)
      for (const c of firmwareConstants(f.source))
        out.push(
          num(
            `firmware.${f.id}.const.${c.name}`,
            `${f.name}: ${c.name}`,
            'firmware',
            '',
            c.value,
            ['cosim'],
            null,
            null,
            `Source constant (${c.type}); the sketch is edited in the run's copy only.`,
            /int|long|byte|uint|int\d/.test(c.type) && !/float|double/.test(c.type) ? 'integer' : 'number',
          ),
        );
    out.push(
      num(
        'electrical.cosim.ambientC',
        'Ambient temperature',
        'electrical',
        '°C',
        el.settings.cosim.ambientC,
        ['cosim'],
        -40,
        85,
        'Offset unit: only °C is accepted.',
      ),
    );
    out.push(
      num(
        'electrical.transient.stepS',
        'Transient step',
        'solver',
        's',
        el.settings.transient.stepS,
        ['circuit'],
        1e-12,
        10,
        'Numerical parameter.',
      ),
    );
  }
  // Runtime experiment inputs: position of fixed bodies (test targets) at t = 0.
  if (sim)
    for (const n of Object.values(scene.nodes))
      if (n.kind === 'primitive' && n.parentId === scene.rootId)
        out.push(
          num(
            `runtime.position.${n.id}.z`,
            `${n.name} position z`,
            'runtime',
            'm',
            n.transform.position[2],
            phys,
            -100,
            100,
            'Moved in the run (fixed bodies only); the project is unchanged.',
          ),
        );
  return out;
}

function findMate(scene: SceneGraph, mateId: string) {
  for (const n of Object.values(scene.nodes))
    if (n.kind === 'assembly') for (const m of n.mechanical.mates) if (m.id === mateId) return m;
  return null;
}

export interface ApplyResult {
  ok: boolean;
  project: Project;
  applied: { target: string; value: ParamValue; unit: string }[];
  runtime: RuntimeAction[];
  errors: string[];
}

/**
 * Apply variable values (in the variable's unit) to a COPY of the project. Unit conversion
 * requires matching dimensions; every change goes through a validated engine command.
 */
export function applyValues(
  p: Project,
  values: { target: string; value: ParamValue; unit: string }[],
): ApplyResult {
  const targets = new Map(listTargets(p).map((t) => [t.id, t]));
  const b = new SceneBuilder(JSON.parse(JSON.stringify(p)) as Project);
  const applied: ApplyResult['applied'] = [];
  const runtime: RuntimeAction[] = [];
  const errors: string[] = [];
  for (const { target, value, unit } of values) {
    const t = targets.get(target);
    if (!t) {
      errors.push(`"${target}" is not a parameter of this model.`);
      continue;
    }
    let v: ParamValue = value;
    if (typeof value === 'number' && t.valueType !== 'enum' && t.valueType !== 'boolean') {
      if (unit !== t.unit) {
        {
          const f = conversion(unit, t.unit);
          if (f === null) {
            errors.push(`${t.label}: unit "${unit}" is not compatible with "${t.unit}".`);
            continue;
          }
          v = value * f;
        }
      }
      if (t.valueType === 'integer' && !Number.isInteger(v as number)) {
        errors.push(`${t.label} must be an integer (got ${v}).`);
        continue;
      }
      if ((t.min !== null && (v as number) < t.min) || (t.max !== null && (v as number) > t.max)) {
        errors.push(
          `${t.label} = ${v} ${t.unit} is outside the supported range [${t.min ?? '−∞'}, ${t.max ?? '∞'}].`,
        );
        continue;
      }
    }
    if (t.valueType === 'enum' && !t.options.some((o) => o.value === v)) {
      errors.push(`${t.label}: "${String(v)}" is not one of ${t.options.map((o) => o.value).join(', ')}.`);
      continue;
    }
    try {
      applyOne(b, target, v, runtime);
      applied.push({ target, value: v, unit: t.unit });
    } catch (e) {
      errors.push(`${t.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: errors.length === 0, project: b.engine.getProject(), applied, runtime, errors };
}

function applyOne(b: SceneBuilder, target: string, v: ParamValue, runtime: RuntimeAction[]) {
  const parts = target.split('.');
  const scene = b.graph;
  const sim = simulationOfScene(scene);
  const el = electricalOfScene(scene);
  const n = v as number;
  if (target === 'physics.gravity.y')
    return b.run('physics.configure', { patch: { gravity: [sim!.gravity[0], n, sim!.gravity[2]] } });
  if (parts[0] === 'physics' && parts[1] === 'solver')
    return b.run('physics.configure', { patch: { solver: { [parts[2]!]: n } } });
  if (parts[0] === 'physics' && parts[1] === 'payload') {
    const pl = sim!.payloads.find((x) => x.id === parts[2])!;
    return b.run('physics.payload.set', { payload: { ...pl, massKg: n } });
  }
  if (parts[0] === 'physics' && parts[1] === 'joint') {
    const mateId = parts.slice(2, -1).join('.');
    const field = parts[parts.length - 1]!;
    if (field === 'damping' || field === 'friction')
      return b.run('physics.joint.set', { mateId, settings: { [field]: n } });
    if (field === 'bandwidthHz')
      return b.run('physics.joint.set', {
        mateId,
        settings: { actuator: { gains: { mode: 'auto', bandwidthHz: n } } },
      });
    return b.run('physics.joint.set', { mateId, settings: { actuator: { [field]: n } } });
  }
  if (parts[0] === 'physics' && parts[1] === 'body')
    return b.run('physics.body.set', {
      nodeId: parts.slice(2, -1).join('.'),
      settings: { [parts[parts.length - 1]!]: n },
    });
  if (parts[0] === 'component')
    return b.run('scene.component.configure', {
      nodeId: parts.slice(1, -1).join('.'),
      [parts[parts.length - 1]!]: v,
    });
  if (parts[0] === 'electrical' && parts[1] === 'part') {
    const partId = parts.slice(2, -1).join('.');
    const field = parts[parts.length - 1]!;
    const part = el!.parts.find((x) => x.id === partId)!;
    const d = part.device as Record<string, unknown>;
    const device = field === 'voltage' ? { ...d, waveform: { kind: 'dc', value: n } } : { ...d, [field]: v };
    return b.run('electrical.part.update', { partId, patch: { device } });
  }
  if (parts[0] === 'firmware') {
    const fwId = parts[1]!;
    const name = parts[3]!;
    const fw = el!.firmware.find((f) => f.id === fwId)!;
    let hit = false;
    const source = fw.source.replace(CONST_RE, (m, type: string, nm: string) => {
      if (nm !== name) return m;
      hit = true;
      return `const ${type} ${nm} = ${String(v)};`;
    });
    if (!hit) throw new Error(`constant ${name} not found`);
    return b.run('electrical.firmware.set', {
      firmware: { id: fw.id, name: fw.name, language: fw.language, source },
    });
  }
  if (target === 'electrical.cosim.ambientC')
    return b.run('electrical.configure', { patch: { cosim: { ambientC: n } } });
  if (target === 'electrical.transient.stepS')
    return b.run('electrical.configure', { patch: { transient: { stepS: n } } });
  if (parts[0] === 'runtime' && parts[1] === 'position') {
    runtime.push({ kind: 'move-z', nodeId: parts.slice(2, -1).join('.'), value: n });
    return;
  }
  throw new Error(`no applier for ${target}`);
}
