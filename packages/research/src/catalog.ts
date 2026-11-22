import type { Project } from '@forge/engineering-core';
import { analogCircuitOf, CoSimulation, physicsPortOf } from '@forge/electronics';
import { PhysicsSession, type Rapier } from '@forge/physics';
import { electricalOfScene, simulationOfScene } from './params';
import type { ModelKind } from './schemas';

/**
 * Unified measurement catalogue: every signal a run of this model kind can record, with its
 * unit, domain and whether it is a sampled signal or an exact event (step) signal.
 *  - physics: Phase 5 telemetry channels (joint position/velocity/drift/target/effort, bodies…)
 *  - cosim:   physics channels + Phase 6 device channels + `logic:<net>` (exact transitions, 0/1)
 *  - circuit: `V(<net>)` and `I(<element>)` from transient analysis
 */
export interface SignalInfo {
  key: string;
  label: string;
  unit: string;
  domain: 'mechanical' | 'electrical' | 'sensor' | 'controller' | 'logic';
  kind: string;
  event: boolean;
}

export function signalCatalog(p: Project, kind: ModelKind, R: Rapier): SignalInfo[] {
  const out: SignalInfo[] = [];
  const sim = simulationOfScene(p.scene);
  const el = electricalOfScene(p.scene);
  if (kind === 'circuit') {
    if (!el) return out;
    const c = analogCircuitOf(el);
    for (const n of c.netlist.nets)
      if (n.pins.length > 1 && !n.isGround)
        out.push({
          key: `V(${n.name})`,
          label: `Voltage of ${n.name}`,
          unit: 'V',
          domain: 'electrical',
          kind: 'measured',
          event: false,
        });
    for (const e of c.elements)
      out.push({
        key: `I(${e.id})`,
        label: `Current through ${e.id}`,
        unit: 'A',
        domain: 'electrical',
        kind: 'measured',
        event: false,
      });
    return out;
  }
  const session = sim ? PhysicsSession.fromScene(R, p.scene, sim) : null;
  if (session) {
    for (const c of session.telemetry.channels)
      out.push({
        key: c.key,
        label: c.label,
        unit: c.unit === '0/1' ? '' : c.unit,
        domain: 'mechanical',
        kind: c.kind,
        event: false,
      });
  }
  if (kind === 'cosim' && el) {
    const cs = new CoSimulation(el, {
      physics: session ? physicsPortOf(session, p.scene) : null,
      scene: p.scene,
    });
    cs.start();
    for (const c of cs.recorder.channels)
      out.push({
        key: c.key,
        label: c.label,
        unit: c.unit,
        domain: /\.(pulse|target)$/.test(c.key)
          ? 'controller'
          : /\.(q)$/.test(c.key)
            ? 'mechanical'
            : /supply|vcc/.test(c.key)
              ? 'electrical'
              : 'sensor',
        kind: c.kind,
        event: false,
      });
    for (const n of cs.netlist.nets)
      if (cs.net.kind[n.index] !== 'analog' && n.pins.length > 1)
        out.push({
          key: `logic:${n.name}`,
          label: `Logic level of ${n.name} (exact transitions)`,
          unit: '',
          domain: 'logic',
          kind: 'measured',
          event: true,
        });
    cs.dispose();
  }
  session?.dispose();
  return out;
}
