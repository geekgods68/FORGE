import type { Feature, NodeTransform, SceneGraph, SketchConstraint, SketchEntity } from './scene/schemas';

/**
 * Contracts for mechanical services injected into the engine (implemented by
 * @forge/mechanics). The core stays free of solver code; every persistent mechanical
 * change still flows through validated, undoable engine commands.
 */
export type AssemblyStatus =
  'fully-constrained' | 'under-constrained' | 'over-constrained' | 'conflicting' | 'empty';

export interface RelationshipReport {
  id: string;
  kind: 'mate' | 'constraint';
  type: string;
  /** Idealised relative DOF of this joint type in isolation (6 − equations). */
  jointDof: number | null;
  /** Spanning-tree joint (drives placement) or loop-closure / driving residual. */
  role: 'tree' | 'closure' | 'driving' | 'check';
  /** Max |residual| (m or rad); 0 for tree joints by construction. */
  residual: number;
  satisfied: boolean;
  /** Per joint coordinate: still free in the solved configuration (in the Jacobian null space). */
  freeCoordinates: boolean[];
}

export interface AssemblyReport {
  assemblyId: string;
  status: AssemblyStatus;
  /** Global mobility of the solved configuration (Jacobian rank analysis, ground excluded). */
  mobility: number;
  /** Independent equations minus rank: > 0 means redundant (over-constrained) relationships. */
  redundancy: number;
  maxResidual: number;
  grounded: string[];
  /** True when no body is grounded: the first related body is used as the reference. */
  implicitGround: boolean;
  /** Bodies with no relationships (each keeps 6 free DOF). */
  freeBodies: string[];
  relationships: RelationshipReport[];
  /** Human-readable problems (unsupported references, conflicts). */
  messages: string[];
  iterations: number;
}

export type AssemblySolveResult =
  | {
      ok: true;
      transforms: Record<string, NodeTransform>;
      coordinates: Record<string, number[]>;
      report: AssemblyReport;
    }
  | {
      ok: false;
      code: 'constraint-conflict' | 'invalid-reference' | 'unsupported';
      message: string;
      report?: AssemblyReport;
    };

export interface PartCheck {
  ok: boolean;
  message?: string;
}

export interface SketchSolveResult {
  ok: boolean;
  entities: SketchEntity[];
  status: 'fully-constrained' | 'under-constrained' | 'over-constrained' | 'conflicting';
  dof: number;
  message?: string;
}

export interface MechanicsService {
  /**
   * Solve one assembly. `held` lists mates whose current coordinates must not change
   * (e.g. the joint the user just set); other coordinates may move to satisfy closures.
   */
  solveAssembly(graph: SceneGraph, assemblyId: string, held?: readonly string[]): AssemblySolveResult;
  /** Validate a part's feature list (degenerate / self-intersecting / unsupported topology). */
  checkPart(features: readonly Feature[]): PartCheck;
  /** Solve a sketch's geometric constraints (numerically), returning updated entities. */
  solveSketch(entities: readonly SketchEntity[], constraints: readonly SketchConstraint[]): SketchSolveResult;
}

/**
 * Read-only query: is `nodeId` a body placed by its parent assembly's mates/constraints
 * (so direct transform edits are refused)? Grounded bodies are not driven.
 */
export function isMateDriven(graph: SceneGraph, nodeId: string): boolean {
  const n = graph.nodes[nodeId];
  const parent = n?.parentId ? graph.nodes[n.parentId] : undefined;
  if (!n || parent?.kind !== 'assembly') return false;
  if (parent.mechanical.grounded.includes(nodeId)) return false;
  return [...parent.mechanical.mates, ...parent.mechanical.constraints].some(
    (r) => r.a.nodeId === nodeId || r.b.nodeId === nodeId,
  );
}
