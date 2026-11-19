import { makeCommand } from '../commands/build';
import type { CommandSource } from '../commands/schemas';
import type { CommandResult, ForgeEngine } from '../engine';
import { NodeTransformSchema, type NodeTransform } from '../scene/schemas';

/**
 * One continuous manipulation (e.g. a gizmo drag). Intermediate poses are previews
 * held here and in the renderer only; they never touch engineering state. `commit`
 * submits ONE `scene.node.transform` command (one history entry), pinned to the
 * revision at which the drag started. `cancel` discards everything.
 */
export class TransformSession {
  readonly start: NodeTransform;
  private current: NodeTransform;
  private readonly startRevision: number;
  private done = false;

  constructor(
    private readonly engine: ForgeEngine,
    readonly nodeId: string,
  ) {
    const node = engine.getNode(nodeId);
    if (!node) throw new Error(`TransformSession: unknown node ${nodeId}`);
    this.start = node.transform;
    this.current = node.transform;
    this.startRevision = engine.getProject().revision;
  }

  /** Record a preview pose. Invalid samples (NaN, zero scale…) are ignored. */
  preview(t: NodeTransform): boolean {
    if (this.done || !NodeTransformSchema.safeParse(t).success) return false;
    this.current = t;
    return true;
  }

  get previewTransform(): NodeTransform {
    return this.current;
  }

  /** Commit the final pose as a single command. Returns null if nothing changed. */
  commit(source: CommandSource = 'desktop-ui'): CommandResult | null {
    if (this.done) return null;
    this.done = true;
    if (JSON.stringify(this.current) === JSON.stringify(this.start)) return null;
    return this.engine.execute(
      makeCommand('scene.node.transform', { nodeId: this.nodeId, ...this.current }, source, {
        expectedRevision: this.startRevision,
        label: 'Move/rotate/scale',
      }),
    );
  }

  cancel(): void {
    this.done = true;
    this.current = this.start;
  }
}
