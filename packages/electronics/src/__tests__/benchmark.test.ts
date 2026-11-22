import { writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { loadRapier, PhysicsSession, simulationOf } from '@forge/physics';
import type { Project } from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { analogCircuitOf } from '../analog/build';
import { CircuitBuilder } from '../builder';
import { CoSimulation } from '../cosim/coordinator';
import { physicsPortOf } from '../cosim/physics';
import { createDigitalSim } from '../digital/sim';
import { BLINK_SKETCH } from '../samples/firmware';
import { createArmElectronicsSample, createUltrasonicServoSample } from '../samples/projects';

/**
 * Electronics performance benchmark (opt-in: FORGE_BENCH=1; docs/PERFORMANCE_BASELINE.md).
 * Short runs (seconds) on purpose: the development machine is memory- and disk-constrained.
 */
const RUN = process.env.FORGE_BENCH === '1';
const at = new Date('2026-11-22T00:00:00Z');
const now = () => performance.now();
const mem = () => {
  const m = process.memoryUsage();
  return {
    heapMB: +(m.heapUsed / 1048576).toFixed(1),
    arrayBuffersMB: +(m.arrayBuffers / 1048576).toFixed(1),
    rssMB: +(m.rss / 1048576).toFixed(1),
  };
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** A resistor mesh (+ capacitors every 4th element) with about `n` passive components. */
function mesh(n: number, withCaps = true) {
  const b = new CircuitBuilder(`mesh ${n}`);
  const v = b.dcSource(5);
  const g = b.ground();
  b.wire(`${v}.neg`, `${g}.gnd`);
  // A side × side grid has 2·side·(side − 1) edges: the smallest grid holding n elements.
  const side = Math.max(2, Math.ceil((1 + Math.sqrt(1 + 2 * n)) / 2));
  const name = (i: number, j: number) => `N${i}_${j}`;
  let count = 0;
  for (let i = 0; i < side && count < n; i++)
    for (let j = 0; j < side && count < n; j++)
      for (const [di, dj] of [
        [1, 0],
        [0, 1],
      ] as const) {
        if (i + di >= side || j + dj >= side || count >= n) continue;
        const id = withCaps && count % 4 === 3 ? b.capacitor(1e-6) : b.resistor(100 + (count % 7) * 50);
        b.label(name(i, j), `${id}.p1`).label(name(i + di, j + dj), `${id}.p2`);
        count++;
      }
  b.label(name(0, 0), `${v}.pos`).label(name(side - 1, side - 1), `${g}.gnd`);
  return { def: b.build(), components: count };
}

describe.skipIf(!RUN)('electronics performance benchmark', () => {
  it('measures solver, digital, firmware and co-simulation costs', async () => {
    const results: Record<string, unknown> = {
      when: new Date().toISOString(),
      machine: {
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        memGB: +(totalmem() / 2 ** 30).toFixed(1),
      },
      note: 'Single short runs; wall-clock medians where repeated. Indicative, not a performance guarantee.',
    };
    // 1. DC solve time vs size.
    results.dc = [10, 100, 500, 1000].map((n) => {
      const t0 = now();
      const { def, components } = mesh(n);
      const c = analogCircuitOf(def);
      const buildMs = now() - t0;
      const times: number[] = [];
      let op = c.dc();
      for (let k = 0; k < (n >= 500 ? 3 : 7); k++) {
        const t = now();
        op = c.dc();
        times.push(now() - t);
      }
      expect(op.ok).toBe(true);
      return {
        components,
        nets: c.netlist.nets.length,
        buildMs: +buildMs.toFixed(2),
        dcSolveMedianMs: +median(times).toFixed(3),
      };
    });
    // 2. Transient throughput (linear: one LU factorisation per step size, re-used).
    results.transient = [100, 1000].map((n) => {
      const { def, components } = mesh(n);
      const c = analogCircuitOf(def);
      const t = now();
      const r = c.transient(1e-3, 1e-6, { maxPoints: 100 });
      const ms = now() - t;
      expect(r.ok).toBe(true);
      const steps = r.ok ? r.steps : 0;
      return { components, steps, wallMs: +ms.toFixed(1), stepsPerSecond: Math.round((steps / ms) * 1000) };
    });
    // 3. Nonlinear DC: 50 LED + resistor branches.
    {
      const b = new CircuitBuilder();
      const v = b.dcSource(5);
      const g = b.ground();
      b.wire(`${v}.neg`, `${g}.gnd`);
      for (let i = 0; i < 50; i++) {
        const r = b.resistor(220 + i);
        const d = b.add({
          type: 'led',
          model: { saturationCurrentA: 1e-19, emissionCoefficient: 1.8, seriesResistanceOhm: 2 },
          color: 'red',
          maxForwardCurrentA: null,
          maxReverseVoltageV: null,
          preset: 'b',
        });
        b.wire(`${v}.pos`, `${r}.p1`).wire(`${r}.p2`, `${d}.a`).wire(`${d}.k`, `${g}.gnd`);
      }
      const c = analogCircuitOf(b.build());
      const times = Array.from({ length: 5 }, () => {
        const t = now();
        const op = c.dc();
        expect(op.ok).toBe(true);
        return now() - t;
      });
      results.nonlinearDc = {
        leds: 50,
        dcSolveMedianMs: +median(times).toFixed(2),
        iterations: (c.dc() as { iterations: number }).iterations,
      };
    }
    // 4. Digital event throughput: 1 MHz clock through a 200-gate buffer chain for 2 ms.
    {
      const b = new CircuitBuilder();
      const clk = b.add({ type: 'clock', frequencyHz: 1e6, duty: 0.5, logicV: 5 });
      let prev = `${clk}.out`;
      for (let i = 0; i < 200; i++) {
        const x = b.add({
          type: 'logic-gate',
          op: i % 2 ? 'not' : 'buffer',
          inputs: 1,
          delayNs: 1,
          logicV: 5,
        });
        b.wire(prev, `${x}.in1`);
        prev = `${x}.out`;
      }
      const sim = createDigitalSim(b.build(), { maxTransitions: 50_000 });
      const t = now();
      sim.runTo(2e6);
      const ms = now() - t;
      results.digital = {
        gates: 200,
        simulatedMs: 2,
        events: sim.sched.executed,
        wallMs: +ms.toFixed(1),
        eventsPerSecond: Math.round((sim.sched.executed / ms) * 1000),
        transitionLogBytes: sim.net.log.bytes,
      };
    }
    // 5. Co-simulation cost: ultrasonic demo and the four-joint arm, 5 simulated seconds each.
    const R = await loadRapier();
    const cosimOf = (p: Project) => {
      const r = p.scene.nodes[p.scene.rootId]!;
      if (r.kind !== 'root' || !r.electrical) throw new Error('no circuit');
      const s = PhysicsSession.fromScene(R, p.scene, simulationOf(p.scene)!);
      const cs = new CoSimulation(r.electrical, {
        physics: physicsPortOf(s, p.scene),
        scene: p.scene,
        now: () => at,
      });
      cs.start();
      return { s, cs };
    };
    const cosimRun = (label: string, p: Project) => {
      const { s, cs } = cosimOf(p);
      const t = now();
      cs.advanceTo(5e9);
      const ms = now() - t;
      const physicsMs = s.stats.meanStepMs * cs.k;
      const out = {
        label,
        simulatedS: 5,
        wallMs: +ms.toFixed(0),
        realTimeFactor: +(5000 / ms).toFixed(1),
        physicsSteps: cs.k,
        physicsShareOfWall: +(physicsMs / ms).toFixed(2),
        perPhysicsStepMs: +(ms / cs.k).toFixed(3),
        events: cs.sched.executed,
        analogSolves: cs.net.analogSolves,
        firmwareOps: cs.mcus.reduce(
          (n, m) => n + ((m as unknown as { interp?: { ops: number } }).interp?.ops ?? 0),
          0,
        ),
        telemetryBytes: cs.recorder.bytes + cs.net.log.bytes,
      };
      cs.dispose();
      s.dispose();
      return out;
    };
    results.cosim = [
      cosimRun('Arduino–HC-SR04–servo demo', createUltrasonicServoSample(at)),
      cosimRun('Four-joint arm control', createArmElectronicsSample(at)),
    ];
    // 6. Resource cleanup: build / 0.5 s run / dispose cycles of the demo, sampled at 10, 30, 60.
    {
      const gc = (globalThis as { gc?: () => void }).gc;
      gc?.();
      const samples: Record<string, ReturnType<typeof mem>> = { '0': mem() };
      for (let i = 1; i <= 60; i++) {
        const { s, cs } = cosimOf(createUltrasonicServoSample(at));
        cs.advanceTo(5e8);
        cs.dispose();
        s.dispose();
        if (i === 10 || i === 30 || i === 60) {
          gc?.();
          samples[String(i)] = mem();
        }
      }
      results.cleanup = {
        gcForced: !!gc,
        samples,
        note: 'Each cycle builds a new Rapier world (WebAssembly). WebAssembly memory grows to a high-water mark and is never returned to the OS, so ArrayBuffer size can step up early and then stays flat; a leak would keep growing.',
      };
    }
    // 7. Telemetry buffers are fixed-capacity: a 120 s blink run fills and then wraps.
    {
      const b = new CircuitBuilder();
      b.add(
        { type: 'mcu', board: 'arduino-uno-r3', power: 'usb', firmwareId: 'fw' },
        { definitionId: 'arduino-uno-r3' },
      );
      b.firmware('fw', 'blink', BLINK_SKETCH);
      const cs = new CoSimulation(b.build(), { physics: null, scene: null });
      cs.start();
      const bytes0 = cs.recorder.bytes + cs.net.log.bytes;
      const t = now();
      cs.advanceTo(120e9);
      results.telemetryGrowth = {
        simulatedS: 120,
        wallMs: +(now() - t).toFixed(0),
        bufferBytesStart: bytes0,
        bufferBytesEnd: cs.recorder.bytes + cs.net.log.bytes,
        samples: cs.recorder.size,
        samplesDropped: cs.recorder.dropped,
        transitions: cs.net.log.size,
      };
      cs.dispose();
    }
    writeFileSync(
      new URL('../../../../docs/archive/phase6-electronics-benchmarks.json', import.meta.url),
      JSON.stringify(results, null, 2) + '\n',
    );
    console.log(JSON.stringify(results, null, 2));
  }, 600_000);
});
