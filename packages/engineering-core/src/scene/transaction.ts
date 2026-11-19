import type { SceneGraph, SceneNode } from './schemas';

/**
 * Primitive, invertible state operations on the scene graph. Every command is
 * recorded as a list of these (forward) plus their inverses, so undo/redo replays
 * exact node states instead of storing whole-project snapshots.
 */
export type Op = { op: 'put'; node: SceneNode } | { op: 'remove'; id: string };

export type CommandErrorCode =
  | 'invalid-command'
  | 'unknown-command'
  | 'not-found'
  | 'locked'
  | 'protected'
  | 'cycle'
  | 'duplicate-id'
  | 'invalid-transform'
  | 'invalid-operation'
  | 'unrepresentable-transform'
  | 'stale-revision'
  | 'permission-denied'
  | 'integrity';

export class CommandError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const copyNode = (n: SceneNode): SceneNode => JSON.parse(JSON.stringify(n)) as SceneNode;

/**
 * Copy-on-write working set for one command. Nothing outside the transaction sees
 * its changes until the engine commits; discarding it leaves state untouched.
 */
export class GraphTransaction {
  private readonly nodes: Record<string, SceneNode>;
  readonly forward: Op[] = [];
  private readonly inverseOps: Op[] = [];

  constructor(private readonly base: SceneGraph) {
    this.nodes = { ...base.nodes };
  }

  get graph(): SceneGraph {
    return { rootId: this.base.rootId, nodes: this.nodes };
  }

  get rootId(): string {
    return this.base.rootId;
  }

  find(id: string): SceneNode | undefined {
    return this.nodes[id];
  }

  get(id: string): SceneNode {
    const n = this.nodes[id];
    if (!n) throw new CommandError('not-found', `Node "${id}" does not exist.`);
    return n;
  }

  put(node: SceneNode): void {
    const prev = this.nodes[node.id];
    const next = copyNode(node);
    this.forward.push({ op: 'put', node: next });
    this.inverseOps.push(prev ? { op: 'put', node: prev } : { op: 'remove', id: node.id });
    this.nodes[node.id] = next;
  }

  remove(id: string): void {
    const prev = this.get(id);
    this.forward.push({ op: 'remove', id });
    this.inverseOps.push({ op: 'put', node: prev });
    delete this.nodes[id];
  }

  /** Inverse ops in the order they must be applied (reverse of recording). */
  get inverse(): Op[] {
    return [...this.inverseOps].reverse();
  }
}

export function applyOps(graph: SceneGraph, ops: readonly Op[]): SceneGraph {
  const nodes = { ...graph.nodes };
  for (const o of ops) {
    if (o.op === 'put') nodes[o.node.id] = o.node;
    else delete nodes[o.id];
  }
  return { rootId: graph.rootId, nodes };
}
