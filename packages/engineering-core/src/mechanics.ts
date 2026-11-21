import {
  MATE_COORDINATES,
  type AssemblyConstraint,
  type Mechanical,
  type Feature,
  type Mate,
  type NodeTransform,
  type SceneGraph,
  type SketchConstraint,
  type SketchEntity,
} from './scene/schemas';

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
 * (so direct transform edits are refused)? Grounded bodies are not driven, and neither
 * suppressed mates nor check-only constraints position anything (the solver ignores them).
 */
export function isMateDriven(graph: SceneGraph, nodeId: string): boolean {
  const n = graph.nodes[nodeId];
  const parent = n?.parentId ? graph.nodes[n.parentId] : undefined;
  if (!n || parent?.kind !== 'assembly') return false;
  if (parent.mechanical.grounded.includes(nodeId)) return false;
  return drivingRelations(parent.mechanical).some((r) => r.a.nodeId === nodeId || r.b.nodeId === nodeId);
}

/** Relationships the solver actually uses: unsuppressed mates and driving constraints. */
export function drivingRelations(m: Mechanical): (Mate | AssemblyConstraint)[] {
  return [...m.mates.filter((x) => !x.suppressed), ...m.constraints.filter((c) => c.driving)];
}

/**
 * Safe mate-type conversions (Phase 4.1). A conversion is offered only between the
 * single-axis family {fixed, revolute, prismatic, cylindrical}, which share one frame
 * convention (mate axis = interface +Z): every coordinate of the new type is carried over
 * from a coordinate of the same kind (angle → angle, length → length) together with its
 * limit and home value, and new coordinates start at 0 with no limit. Ball and planar
 * joints use different coordinate meanings (rotation vector; in-plane translation), so
 * converting to or from them is refused rather than guessed.
 */
const CONVERTIBLE = new Set<Mate['type']>(['fixed', 'revolute', 'prismatic', 'cylindrical']);

export function canConvertMate(from: Mate['type'], to: Mate['type']): boolean {
  return from === to || (CONVERTIBLE.has(from) && CONVERTIBLE.has(to));
}

/** Coordinates/home/limits of `m` re-expressed for `type` (see canConvertMate), or an error. */
export function convertMate(
  m: Pick<Mate, 'type' | 'coordinates' | 'home' | 'limits'>,
  type: Mate['type'],
):
  | { ok: true; coordinates: number[]; home: number[]; limits: Mate['limits'] }
  | { ok: false; message: string } {
  if (m.type === type)
    return { ok: true, coordinates: [...m.coordinates], home: [...m.home], limits: [...m.limits] };
  if (!canConvertMate(m.type, type))
    return {
      ok: false,
      message: `A ${m.type} mate cannot be converted to ${type} safely (different joint coordinates); delete it and create a new mate.`,
    };
  const from = MATE_COORDINATES[m.type];
  const coordinates: number[] = [];
  const home: number[] = [];
  const limits: Mate['limits'] = [];
  for (const kind of MATE_COORDINATES[type]) {
    const i = from.indexOf(kind);
    coordinates.push(i >= 0 ? m.coordinates[i]! : 0);
    home.push(i >= 0 ? m.home[i]! : 0);
    limits.push(i >= 0 ? (m.limits[i] ?? null) : null);
  }
  return { ok: true, coordinates, home, limits };
}
