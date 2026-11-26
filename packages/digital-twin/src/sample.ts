import { createArmElectronicsSample } from '@forge/electronics';
import type { Project } from '@forge/engineering-core';
import { SceneBuilder } from '@forge/physics';
import { TELEMETRY_SKETCH } from './firmware';
import type { Twin } from './schemas';

/**
 * VEYRIS robotic-arm digital-twin reference: the Phase 6 four-joint arm with its UNO,
 * HC-SR04 and servos, running the FORGE telemetry firmware (TRIG D7, ECHO D8, wrist servo
 * SV4 on D9 — the same wiring as the bench hardware). The default twin maps:
 *   d (measured, mm)  → range sensor US1 distance (simulation: US1.reported, m)
 *   a (commanded, deg)→ wrist joint j-wrist command (simulation: SV4.target, rad);
 *                        90° = the joint's centre. COMMANDED, not measured: the servo has
 *                        no position feedback.
 */
export const VEYRIS_TWIN_PROJECT_NAME = 'Sample — VEYRIS arm digital twin';
export const TELEMETRY_FIRMWARE_ID = 'fw-telemetry';

export function createVeyrisTwinProject(now = new Date()): Project {
  const b = new SceneBuilder({ ...createArmElectronicsSample(now), name: VEYRIS_TWIN_PROJECT_NAME });
  b.run('electrical.firmware.set', {
    firmware: {
      id: TELEMETRY_FIRMWARE_ID,
      name: 'FORGE telemetry v1 (HC-SR04 + wrist servo)',
      language: 'arduino-subset',
      source: TELEMETRY_SKETCH,
    },
  });
  const root = b.graph.nodes[b.graph.rootId]!;
  const u1 = root.kind === 'root' ? root.electrical!.parts.find((x) => x.id === 'U1')! : null;
  if (u1 && u1.device.type === 'mcu')
    b.run('electrical.part.update', {
      partId: 'U1',
      patch: { device: { ...u1.device, firmwareId: TELEMETRY_FIRMWARE_ID } },
    });
  return { ...b.engine.getProject(), revision: 0 };
}

export function veyrisArmTwin(project: Project, now = new Date()): Twin {
  const root = project.scene.nodes[project.scene.rootId];
  const sv4 = root?.kind === 'root' ? root.electrical?.parts.find((p) => p.id === 'SV4') : undefined;
  const servo = sv4?.device.type === 'servo' ? sv4.device : null;
  // Phase 6 servo model: joint = centre + direction · (command − range/2).
  const centre = servo?.jointCentreRad ?? 0;
  const dir = servo?.direction ?? 1;
  const half = ((servo?.angleRangeDeg ?? 180) / 2) * (Math.PI / 180);
  const iso = now.toISOString();
  return {
    id: 'twin-veyris-arm',
    name: 'VEYRIS arm (UNO + HC-SR04 + wrist servo)',
    projectId: project.id,
    device: {
      deviceId: 'VEYRIS-ARM-01',
      hardware: 'Arduino UNO R3, HC-SR04, SG90 wrist servo',
      firmware: 'forge-ultrasonic-servo',
      firmwareVersion: '1.0.0',
      transport: 'web-serial',
      baud: 115200,
    },
    components: ['US1', 'SV4', 'j-wrist', 'range-sensor', 'wrist-servo'],
    channels: [
      {
        channel: 'd',
        kind: 'measured',
        deviceUnit: 'mm',
        target: { kind: 'sensor', partId: 'US1', quantity: 'distance' },
        modelUnit: 'm',
        simulationSignal: 'US1.reported',
        calibration: { gain: 1, offset: 0, source: 'none', recordId: null },
        interpolation: 'linear',
        maxGapS: 0.2,
      },
      {
        channel: 'a',
        kind: 'commanded',
        deviceUnit: 'deg',
        target: { kind: 'joint', mateId: 'j-wrist' },
        modelUnit: 'rad',
        simulationSignal: 'SV4.target',
        calibration: { gain: dir, offset: centre - dir * half, source: 'manual', recordId: null },
        interpolation: 'hold',
        maxGapS: 0.2,
      },
    ],
    frames: [
      {
        channel: 'd',
        nodeId: 'range-sensor',
        offsetM: [0, 0, 0],
        note: 'Distance measured from the HC-SR04 transducer midpoint along the board +Z axis (Phase 6 sensor model).',
      },
    ],
    staleAfterMs: 500,
    assumptions: [
      'The wrist angle is the COMMANDED servo position; no sensor measures the angle reached.',
      'The servo maps 0–180° linearly onto the joint around its centre (generic pulse model, Phase 6).',
      'Distance uses 343 m/s (20 °C) in the firmware; temperature is not measured.',
    ],
    uncertainties: [
      {
        channel: 'd',
        sd: 3,
        unit: 'mm',
        basis: 'HC-SR04 vendor accuracy claim (±3 mm); not verified by FORGE',
      },
    ],
    evidence: { recordings: [], calibrations: [], validations: [] },
    revision: 1,
    createdAt: iso,
    updatedAt: iso,
  };
}
