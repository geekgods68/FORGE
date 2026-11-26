import { compose, makeCommand, type CommandInput } from '@forge/engineering-core';
import { buildPhysicsModel, loadRapier, PhysicsSession, SceneBuilder, simulationOf } from '@forge/physics';
import { describe, expect, it } from 'vitest';
import { writeStl } from '../formats/stl';
import { forwardKinematics, parseUrdf, planUrdfImport, type UrdfImportOptions } from '../formats/urdf';
import { parseXml } from '../formats/xml';
import { mul, type Mat4 } from '../mesh';
import { importOf, importStatus } from '../provenance';
import { AT, boxSoup, emptyProject } from './fixtures';

const enc = new TextEncoder();
const inertia = (m: number, x: number, y: number, z: number) =>
  `ixx="${(m * (y * y + z * z)) / 12}" iyy="${(m * (x * x + z * z)) / 12}" izz="${(m * (x * x + y * y)) / 12}" ixy="0" ixz="0" iyz="0"`;

/** Representative multi-joint arm: 3 revolute, 1 continuous, 1 fixed, 1 prismatic joint. */
export const ARM_URDF = `<?xml version="1.0"?>
<!-- FORGE test arm (REP-103 frame: z up) -->
<robot name="test_arm">
  <material name="grey"><color rgba="0.5 0.5 0.5 1"/></material>
  <link name="base_link">
    <visual><origin xyz="0 0 0.02"/><geometry><box size="0.1 0.1 0.04"/></geometry><material name="grey"/></visual>
    <collision><origin xyz="0 0 0.02"/><geometry><box size="0.1 0.1 0.04"/></geometry></collision>
    <inertial><origin xyz="0 0 0.02"/><mass value="1.0"/><inertia ${inertia(1, 0.1, 0.1, 0.04)}/></inertial>
  </link>
  <link name="turntable">
    <visual><origin xyz="0 0 0.01"/><geometry><cylinder radius="0.04" length="0.02"/></geometry></visual>
    <inertial><origin xyz="0 0 0.01"/><mass value="0.2"/><inertia ixx="0.0000867" iyy="0.0000867" izz="0.00016" ixy="0" ixz="0" iyz="0"/></inertial>
  </link>
  <link name="upper_arm">
    <visual><origin xyz="0 0 0.075"/><geometry><box size="0.03 0.03 0.15"/></geometry><material name="red"><color rgba="0.8 0.1 0.1 1"/></material></visual>
    <inertial><origin xyz="0 0 0.075" rpy="0 0 0.5"/><mass value="0.15"/><inertia ${inertia(0.15, 0.03, 0.03, 0.15)}/></inertial>
  </link>
  <link name="forearm">
    <visual><origin xyz="0 0 0.06"/><geometry><cylinder radius="0.012" length="0.12"/></geometry></visual>
    <inertial><origin xyz="0 0 0.06"/><mass value="0.1"/><inertia ${inertia(0.1, 0.024, 0.024, 0.12)}/></inertial>
  </link>
  <link name="wrist">
    <visual><origin xyz="0 0 0"/><geometry><mesh filename="package://test_arm/meshes/wrist.stl" scale="0.001 0.001 0.001"/></geometry></visual>
    <inertial><origin xyz="0.01 0.01 0.015"/><mass value="0.05"/><inertia ${inertia(0.05, 0.02, 0.02, 0.03)}/></inertial>
  </link>
  <link name="tool">
    <visual><geometry><sphere radius="0.01"/></geometry></visual>
    <inertial><mass value="0.02"/><inertia ixx="8e-7" iyy="8e-7" izz="8e-7" ixy="0" ixz="0" iyz="0"/></inertial>
  </link>
  <link name="finger">
    <visual><geometry><box size="0.01 0.004 0.02"/></geometry></visual>
    <inertial><mass value="0.01"/><inertia ${inertia(0.01, 0.01, 0.004, 0.02)}/></inertial>
  </link>
  <joint name="base_yaw" type="revolute"><parent link="base_link"/><child link="turntable"/><origin xyz="0 0 0.04"/><axis xyz="0 0 1"/><limit lower="-2.6" upper="2.6" effort="1" velocity="3"/><dynamics damping="0.01" friction="0.001"/></joint>
  <joint name="shoulder" type="revolute"><parent link="turntable"/><child link="upper_arm"/><origin xyz="0 0 0.02"/><axis xyz="0 1 0"/><limit lower="-1.5" upper="1.5" effort="2" velocity="2"/></joint>
  <joint name="elbow" type="revolute"><parent link="upper_arm"/><child link="forearm"/><origin xyz="0 0 0.15" rpy="0 0.3 0"/><axis xyz="0 1 0"/><limit lower="-2" upper="2" effort="1" velocity="2"/></joint>
  <joint name="wrist_roll" type="continuous"><parent link="forearm"/><child link="wrist"/><origin xyz="0 0 0.12"/><axis xyz="0 0 1"/><limit effort="0.5" velocity="4"/></joint>
  <joint name="tool_mount" type="fixed"><parent link="wrist"/><child link="tool"/><origin xyz="0 0 0.03" rpy="0.1 0.2 0.3"/></joint>
  <joint name="slide" type="prismatic"><parent link="tool"/><child link="finger"/><origin xyz="0 0 0.01"/><axis xyz="1 0 0"/><limit lower="-0.01" upper="0.02" effort="5" velocity="0.1"/><mimic joint="elbow"/></joint>
  <transmission name="t1"><type>transmission_interface/SimpleTransmission</type></transmission>
  <gazebo reference="tool"><material>Gazebo/Red</material></gazebo>
</robot>
`;
const WRIST_STL = { name: 'meshes/wrist.stl', bytes: writeStl(boxSoup([20, 20, 30])) };
const opts = (o: Partial<UrdfImportOptions> = {}): UrdfImportOptions => ({
  files: [WRIST_STL],
  createSimulation: true,
  actuators: 'none',
  importId: 'imp-urdf',
  idPrefix: 'arm',
  now: AT,
  ...o,
});
function importArm(o: Partial<UrdfImportOptions> = {}) {
  const b = new SceneBuilder(emptyProject());
  const plan = planUrdfImport(
    { name: 'test_arm.urdf', bytes: enc.encode(ARM_URDF) },
    opts(o),
    b.engine.getProject(),
  );
  expect(plan.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  b.batch(plan.commands);
  return { b, plan };
}
const ASM: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]; // −90° about X (z-up → y-up)
const worldOf = (b: SceneBuilder, id: string) => compose(b.engine.getWorldTransform(id)!);

describe('URDF parsing', () => {
  it('reads links, joints, limits, inertials and reports ROS-specific elements', () => {
    const r = parseUrdf(enc.encode(ARM_URDF));
    expect(r.robot!.links).toHaveLength(7);
    expect(r.robot!.joints.map((j) => j.type)).toEqual([
      'revolute',
      'revolute',
      'revolute',
      'continuous',
      'fixed',
      'prismatic',
    ]);
    expect(r.robot!.root).toBe('base_link');
    expect(r.robot!.joints[0]!.limit).toEqual({ lower: -2.6, upper: 2.6, effort: 1, velocity: 3 });
    expect(r.robot!.unsupported.join(' ')).toMatch(
      /mimic.*transmission.*gazebo|mimic[\s\S]*transmission[\s\S]*gazebo/,
    );
  });
  it('refuses malformed robots: cycles, two roots, missing links, missing limits, DOCTYPE', () => {
    const bad = (body: string) => parseUrdf(enc.encode(`<robot name="r">${body}</robot>`));
    expect(
      bad('<link name="a"/><link name="b"/>').diagnostics.some((d) => /exactly one root/.test(d.message)),
    ).toBe(true);
    expect(
      bad(
        '<link name="a"/><link name="b"/><joint name="j" type="fixed"><parent link="a"/><child link="c"/></joint>',
      ).robot,
    ).toBeNull();
    expect(
      bad(
        '<link name="a"/><link name="b"/><joint name="j" type="revolute"><parent link="a"/><child link="b"/><axis xyz="0 0 1"/></joint>',
      ).diagnostics.some((d) => /requires <limit>/.test(d.message)),
    ).toBe(true);
    const cyc = bad(
      '<link name="a"/><link name="b"/><joint name="j1" type="fixed"><parent link="a"/><child link="b"/></joint><joint name="j2" type="fixed"><parent link="b"/><child link="a"/></joint>',
    );
    expect(cyc.robot).toBeNull();
    expect(() => parseXml('<!DOCTYPE r [<!ENTITY x "y">]><robot>&x;</robot>')).toThrow(/DOCTYPE/);
    expect(parseUrdf(enc.encode('<robot name="r"><link name="a">')).diagnostics[0]!.code).toBe('urdf-xml');
  });
});

describe('URDF → FORGE assembly', () => {
  it('builds an inspectable assembly whose link frames equal URDF forward kinematics', () => {
    const { b, plan } = importArm();
    const g = b.engine.getProject().scene;
    const asm = g.nodes['arm.robot']!;
    expect(asm.kind).toBe('assembly');
    if (asm.kind !== 'assembly') return;
    expect(asm.mechanical.mates.map((m) => m.type)).toEqual([
      'revolute',
      'revolute',
      'revolute',
      'revolute',
      'fixed',
      'prismatic',
    ]);
    expect(asm.mechanical.grounded).toEqual(['arm.link.base_link']);
    expect(asm.mechanical.mates.find((m) => m.name === 'slide')!.limits[0]).toEqual({
      min: -0.01,
      max: 0.02,
    });
    expect(asm.mechanical.mates.find((m) => m.name === 'wrist_roll')!.limits[0]).toBeNull();
    const fk = forwardKinematics(parseUrdf(enc.encode(ARM_URDF)).robot!);
    for (const [link, nodeId] of Object.entries(plan.linkNodes)) {
      const want = mul(ASM, fk.get(link)!);
      const got = worldOf(b, nodeId);
      for (let k = 0; k < 16; k++) expect(Math.abs(got[k]! - want[k]!)).toBeLessThan(1e-9);
    }
    // Cylinders: URDF +Z axis → FORGE primitive +Y axis rotated back onto the link's +Z.
    const cyl = g.nodes['arm.link.forearm.v1']!;
    expect(cyl.kind === 'primitive' && cyl.geometry).toMatchObject({
      shape: 'cylinder',
      radius: 0.012,
      height: 0.12,
    });
    const cw = worldOf(b, 'arm.link.forearm.v1');
    const fw = worldOf(b, 'arm.link.forearm');
    const yAxis = [cw[4]!, cw[5]!, cw[6]!];
    const zAxis = [fw[8]!, fw[9]!, fw[10]!];
    expect(yAxis[0]! * zAxis[0]! + yAxis[1]! * zAxis[1]! + yAxis[2]! * zAxis[2]!).toBeCloseTo(1, 12);
    // The STL mesh (mm with scale 0.001) is a model instance of 20 × 20 × 30 mm.
    const wrist = g.nodes['arm.link.wrist.v1']!;
    expect(wrist.kind).toBe('model-instance');
    if (wrist.kind === 'model-instance') {
      expect(wrist.model.unitScale).toBe(0.001);
      expect(wrist.model.boundsM.map((x) => Number(x.toFixed(6)))).toEqual([0.02, 0.02, 0.03]);
    }
    const rec = importOf(g, 'arm.robot')!;
    expect(rec.format).toBe('urdf');
    expect(rec.referencedFiles.map((f) => f.name)).toEqual(['meshes/wrist.stl']);
    expect(importStatus(rec, g)).toBe('unmodified');
    expect(rec.unsupported.join(' ')).toMatch(/transmission/);
  });

  it('matches URDF joint semantics when joints move (sign and axis of every joint type)', () => {
    const { b, plan } = importArm();
    const q = { base_yaw: 0.7, shoulder: -0.4, elbow: 1.1, wrist_roll: 2.5, slide: 0.015 };
    for (const [j, v] of Object.entries(q))
      b.run('assembly.joint.setPosition', {
        assemblyId: 'arm.robot',
        mateId: plan.jointMates[j]!,
        coordinates: [v],
      });
    const fk = forwardKinematics(parseUrdf(enc.encode(ARM_URDF)).robot!, q);
    for (const [link, nodeId] of Object.entries(plan.linkNodes)) {
      const want = mul(ASM, fk.get(link)!);
      const got = worldOf(b, nodeId);
      for (let k = 12; k < 15; k++) expect(Math.abs(got[k]! - want[k]!)).toBeLessThan(1e-7);
      for (let k = 0; k < 11; k++) expect(Math.abs(got[k]! - want[k]!)).toBeLessThan(1e-7);
    }
    // Limits are enforced by the engine.
    const r = b.engine.execute(
      makeCommand(
        'assembly.joint.setPosition',
        { assemblyId: 'arm.robot', mateId: plan.jointMates.shoulder!, coordinates: [2] },
        'test',
      ) as CommandInput,
    );
    expect(r.ok).toBe(false);
  });

  it('participates in the existing mechanical simulation with the URDF inertials', async () => {
    const { b } = importArm({ actuators: 'hold-initial' });
    const def = simulationOf(b.graph)!;
    const m = buildPhysicsModel(b.graph, def);
    expect(m.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // 7 links; wrist + tool are welded by the fixed joint into one rigid body (the project's
    // default cube is a separate, unrelated body).
    expect(m.bodies.filter((x) => x.assemblyId === 'arm.robot')).toHaveLength(6);
    expect(m.joints).toHaveLength(5);
    const upper = m.bodies.find((x) => x.unitIds.includes('arm.link.upper_arm'))!;
    expect(upper.mass!.massKg).toBe(0.15);
    expect(upper.massSources[0]!.source).toBe('inertial');
    const welded = m.bodies.find((x) => x.unitIds.includes('arm.link.wrist'))!;
    expect(welded.mass!.massKg).toBeCloseTo(0.07, 12);
    const R = await loadRapier();
    const s = PhysicsSession.fromScene(R, b.graph, def);
    expect(s.ok).toBe(true);
    s.step(240); // 2 s at 120 Hz
    const js = s.jointStates();
    // Actuators hold the initial pose against gravity (within a few degrees).
    for (const j of js.filter((x) => x.unit === 'rad')) expect(Math.abs(j.q)).toBeLessThan(0.1);
    s.dispose?.();
    // Without actuators the arm falls under gravity: the shoulder leaves its initial angle.
    const free = importArm({ actuators: 'none' });
    const s2 = PhysicsSession.fromScene(R, free.b.graph, simulationOf(free.b.graph)!);
    s2.step(120);
    const sh = s2.jointStates().find((j) => j.name === 'shoulder')!;
    expect(Math.abs(sh.q)).toBeGreaterThan(0.01);
    s2.dispose?.();
  });

  it('never reads unselected or network meshes; unresolved visuals are omitted and reported', () => {
    const net = ARM_URDF.replace('package://test_arm/meshes/wrist.stl', 'https://example.com/wrist.stl');
    const p1 = planUrdfImport({ name: 'a.urdf', bytes: enc.encode(net) }, opts(), emptyProject());
    expect(p1.ok).toBe(true);
    expect(p1.diagnostics.find((d) => d.code === 'urdf-mesh')!.message).toMatch(
      /network URL \(never fetched\)/,
    );
    const p2 = planUrdfImport(
      { name: 'a.urdf', bytes: enc.encode(ARM_URDF) },
      opts({ files: [] }),
      emptyProject(),
    );
    expect(p2.diagnostics.find((d) => d.code === 'urdf-mesh')!.message).toMatch(
      /not among the selected files/,
    );
    expect(p2.summary.meshes).toBe(0);
    const dae = ARM_URDF.replace('wrist.stl', 'wrist.dae');
    const p3 = planUrdfImport(
      { name: 'a.urdf', bytes: enc.encode(dae) },
      opts({ files: [{ name: 'wrist.dae', bytes: enc.encode('<COLLADA/>') }] }),
      emptyProject(),
    );
    expect(p3.diagnostics.some((d) => d.code === 'urdf-mesh-format')).toBe(true);
  });
});
