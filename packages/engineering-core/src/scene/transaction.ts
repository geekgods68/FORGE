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
  | 'unknown-component'
  | 'invalid-parameters'
  | 'constraint-conflict'
  | 'out-of-limits'
  | 'invalid-geometry'
  | 'unsupported'
  | 'integrity';

export class CommandError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Copy-on-write working set for one command (or one batch). Nothing outside the
 * transaction sees its changes until the engine commits; discarding it leaves state
 * untouched.
 *
 * Writes are COALESCED: each node's state is captured at its first touch, and the
 * forward/inverse op lists are derived once from (first state → final state); nodes
 * whose final value equals their first value produce no op. A batch
 * that updates the same parent thousands of times therefore records one op for it,
 * not thousands of deep copies. Node objects are treated as immutable values
 * (handlers always build new objects); the engine deep-freezes them on commit.
 */
export class GraphTransaction {
  private readonly nodes: Record<string, SceneNode>;
  /** Node state before this transaction first touched it (undefined = did not exist). Insertion-ordered. */
  private readonly before = new Map<string, SceneNode | undefined>();

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
    if (!this.before.has(node.id)) this.before.set(node.id, this.nodes[node.id]);
    this.nodes[node.id] = node;
  }

  remove(id: string): void {
    const prev = this.get(id);
    if (!this.before.has(id)) this.before.set(id, prev);
    delete this.nodes[id];
  }

  /** Net changes (first state → final state); untouched or round-tripped nodes are omitted. */
  get forward(): Op[] {
    const ops: Op[] = [];
    for (const [id, prev] of this.before) {
      const now = this.nodes[id];
      if (sameNode(now, prev)) continue;
      if (now) ops.push({ op: 'put', node: now });
      else if (prev) ops.push({ op: 'remove', id });
    }
    return ops;
  }

  /** Ops restoring every touched node to its state before the transaction. */
  get inverse(): Op[] {
    const ops: Op[] = [];
    for (const [id, prev] of [...this.before].reverse()) {
      const now = this.nodes[id];
      if (sameNode(now, prev)) continue;
      if (prev) ops.push({ op: 'put', node: prev });
      else if (now) ops.push({ op: 'remove', id });
    }
    return ops;
  }
}

/** Value equality for touched nodes (cheap: runs once per touched node per transaction). */
function sameNode(a: SceneNode | undefined, b: SceneNode | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function applyOps(graph: SceneGraph, ops: readonly Op[]): SceneGraph {
  const nodes = { ...graph.nodes };
  for (const o of ops) {
    if (o.op === 'put') nodes[o.node.id] = o.node;
    else delete nodes[o.id];
  }
  return { rootId: graph.rootId, nodes };
}
