import {
  invert,
  multiply,
  transformPoint,
  worldMatrix,
  type Mat4,
  type SceneGraph,
} from '@forge/engineering-core';
import type { MotorCommand, PhysicsSession } from '@forge/physics';

type V3 = [number, number, number];

/**
 * What the electronics co-simulation may ask of the physical world. Implemented over a Phase 5
 * PhysicsSession; tests may supply a stub. Sensors READ the world (poses, rays, joint
 * coordinates); actuators only send motor commands — the physics engine decides the motion.
 */
export interface PhysicsPort {
  /** Fixed physics step (s). */
  readonly stepS: number;
  /** Advance one fixed step; false if the physics run is faulted. */
  step(): boolean;
  setMotorTarget(cmd: MotorCommand): { ok: boolean; error?: string };
  jointQ(mateId: string): number | null;
  /** World matrix of a scene node: simulated if it moves with a body, otherwise its CAD pose. */
  nodeMatrix(nodeId: string): Mat4 | null;
  castRay(
    origin: V3,
    dir: V3,
    max: number,
    excludeNodes: string[],
  ): { distance: number; bodyId: string } | null;
  /** Move a fixed/kinematic body carrying this node (runtime experiment input). */
  moveNode(nodeId: string, position: V3): { ok: boolean; error?: string };
}

export function physicsPortOf(session: PhysicsSession, scene: SceneGraph): PhysicsPort {
  const cad = new Map<string, Mat4>();
  const cadOf = (id: string) => {
    let m = cad.get(id);
    if (!m) {
      m = worldMatrix(scene, id);
      cad.set(id, m);
    }
    return m;
  };
  const unitOf = (nodeId: string): string | null => {
    const bid = session.model.bodyOfNode[nodeId];
    const b = bid ? session.model.bodies.find((x) => x.id === bid) : undefined;
    if (!b) return null;
    let id: string | null = nodeId;
    while (id) {
      if (b.unitIds.includes(id)) return id;
      id = scene.nodes[id]?.parentId ?? null;
    }
    return null;
  };
  return {
    get stepS() {
      return session.definition.solver.timestepS;
    },
    step: () => session.step(1) === 1,
    setMotorTarget: (cmd) => session.setMotorTarget(cmd),
    jointQ: (mateId) => session.jointStates().find((j) => j.mateId === mateId)?.q ?? null,
    nodeMatrix(nodeId) {
      if (!scene.nodes[nodeId]) return null;
      const u = unitOf(nodeId);
      if (!u) return cadOf(nodeId);
      const sim = session.unitWorldMatrix(u);
      const inv = invert(cadOf(u));
      if (!sim || !inv) return cadOf(nodeId);
      return multiply(sim, multiply(inv, cadOf(nodeId)));
    },
    castRay(origin, dir, max, excludeNodes) {
      const bodies = excludeNodes.map((n) => session.model.bodyOfNode[n]).filter((b): b is string => !!b);
      return session.castRay(origin, dir, max, bodies);
    },
    moveNode(nodeId, position) {
      const bid = session.model.bodyOfNode[nodeId];
      if (!bid) return { ok: false, error: 'This component is not a body in the physics setup.' };
      // The body origin and the node may differ: shift the body by the node's displacement.
      const m = this.nodeMatrix(nodeId);
      const pose = session.bodyPose(bid);
      if (!m || !pose) return { ok: false, error: 'No pose.' };
      const cur = transformPoint(m, [0, 0, 0]);
      return session.setBodyTranslation(bid, [
        pose.p[0] + position[0] - cur[0],
        pose.p[1] + position[1] - cur[1],
        pose.p[2] + position[2] - cur[2],
      ]);
    },
  };
}
