import { writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import {
  createProject,
  defaultSimulationDefinition,
  type BatchSubCommand,
  type BodySettings,
} from '@forge/engineering-core';
import { ARM_JOINTS } from '@forge/mechanics';
import { describe, expect, it } from 'vitest';
import {
  buildPhysicsModel,
  createRoboticArmSimulationSample,
  loadRapier,
  PhysicsSession,
  SceneBuilder,
  simulationOf,
} from '../index';

/**
 * Physics performance benchmark (opt-in: FORGE_BENCH=1; docs/PERFORMANCE_BASELINE.md).
 * Short runs only (seconds), so it stays within the machine's resource limits.
 */
const RUN = process.env.FORGE_BENCH === '1';
const at = new Date('2026-11-22T00:00:00Z');
const mem = () => {
  const m = process.memoryUsage();
  return {
    heapMB: +(m.heapUsed / 1048576).toFixed(1),
    arrayBuffersMB: +(m.arrayBuffers / 1048576).toFixed(1),
    rssMB: +(m.rss / 1048576).toFixed(1),
  };
};
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    meanMs: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3),
    p95Ms: +s[Math.floor(s.length * 0.95)]!.toFixed(3),
    maxMs: +s[s.length - 1]!.toFixed(3),
  };
};

function boxes(n: number) {
  const b = new SceneBuilder(createProject('Bench', at));
  for (const c of b.graph.nodes[b.graph.rootId]!.childIds) b.run('scene.node.delete', { nodeId: c });
  const side = Math.ceil(Math.sqrt(Math.min(n, 100)));
  const cmds: BatchSubCommand[] = [];
  const bodies: BodySettings[] = [];
  for (let i = 0; i < n; i++) {
    const layer = Math.floor(i / (side * side));
    const k = i % (side * side);
    const id = `b${i}`;
    cmds.push({
      type: 'scene.node.create',
      payload: {
        node: {
          kind: 'primitive',
          id,
          name: id,
          geometry: { shape: 'box', width: 0.05, height: 0.05, depth: 0.05 },
          transform: {
            position: [
              ((k % side) - side / 2) * 0.07,
              0.05 + layer * 0.07,
              (Math.floor(k / side) - side / 2) * 0.07,
            ],
          },
        },
      },
    });
    bodies.push({
      nodeId: id,
      mode: 'dynamic',
      mass: { source: 'user', massKg: 1, note: 'bench' },
      collider: 'auto',
      friction: 0.5,
      restitution: 0.1,
      linearDamping: 0,
      angularDamping: 0,
      ccd: false,
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      contactLoadRatingN: null,
    });
  }
  b.batch(cmds);
  b.run('physics.simulation.create', { definition: { ...defaultSimulationDefinition('Bench'), bodies } });
  return b;
}

describe.skipIf(!RUN)('physics performance benchmark', () => {
  it('rigid bodies, robotic arm, reset cycles', async () => {
    const R = await loadRapier();
    const results: Record<string, unknown> = {
      when: new Date().toISOString(),
      machine: {
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        memoryGB: +(totalmem() / 2 ** 30).toFixed(1),
        node: process.version,
      },
      engine: `rapier3d-compat ${R.version()}`,
      solver: defaultSimulationDefinition().solver,
      note: 'Node.js (no rendering). Fixed step = 4 sub-steps × 8 iterations. Boxes 50 mm, falling in layers onto the work surface and settling (contact-heavy). Single run per case.',
    };
    const scenes: unknown[] = [];
    for (const n of [10, 100, 500, 1000]) {
      const b = boxes(n);
      const before = mem();
      const t0 = performance.now();
      const s = PhysicsSession.fromScene(R, b.graph, b.definition);
      const buildMs = performance.now() - t0;
      const times: number[] = [];
      for (let i = 0; i < 240; i++) {
        s.step();
        times.push(s.stats.lastStepMs);
      }
      const after = mem();
      scenes.push({
        bodies: n,
        buildMs: +buildMs.toFixed(1),
        step: stats(times),
        realTimeFactor: +(1000 / 120 / (times.reduce((a, x) => a + x, 0) / times.length)).toFixed(2),
        contactPairs: s.stats.contactPairs,
        telemetryKiB: +(s.telemetry.bytes / 1024).toFixed(0),
        telemetryChannels: s.telemetry.channels.length,
        memory: { before, after },
        faulted: s.state === 'faulted',
      });
      s.dispose();
    }
    results.rigidBodies = scenes;

    // Robotic arm under motor control and gravity.
    const p = createRoboticArmSimulationSample(at);
    const d = simulationOf(p.scene)!;
    const s = new PhysicsSession(R, buildPhysicsModel(p.scene, d));
    s.setMotorTarget({ mateId: ARM_JOINTS.shoulder, target: 0.8, source: 'test' });
    s.setMotorTarget({ mateId: ARM_JOINTS.yaw, target: 1.2, source: 'test' });
    const armTimes: number[] = [];
    for (let i = 0; i < 600; i++) {
      s.step();
      armTimes.push(s.stats.lastStepMs);
    }
    results.arm = {
      bodies: s.model.bodies.length,
      joints: s.model.joints.length,
      step: stats(armTimes),
      telemetryKiB: +(s.telemetry.bytes / 1024).toFixed(0),
      telemetryChannels: s.telemetry.channels.length,
      maxSamples: d.recording.maxSamples,
    };

    // Repeated start/pause/reset cycles: memory must not grow without bound.
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const m0 = mem();
    for (let i = 0; i < 200; i++) {
      s.run();
      s.runFor(0.25);
      s.pause();
      s.reset();
    }
    gc?.();
    const m1 = mem();
    results.resetCycles = {
      cycles: 200,
      gcForced: !!gc,
      before: m0,
      after: m1,
      arrayBuffersGrowthMB: +(m1.arrayBuffersMB - m0.arrayBuffersMB).toFixed(1),
    };
    s.dispose();
    writeFileSync(
      new URL('../../../../docs/archive/phase5-physics-benchmarks.json', import.meta.url),
      JSON.stringify(results, null, 2) + '\n',
    );
    console.log(JSON.stringify(results, null, 2));
    expect(scenes.every((x) => !(x as { faulted: boolean }).faulted)).toBe(true);
  }, 300_000);
});
