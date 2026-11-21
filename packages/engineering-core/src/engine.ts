import { runBatch, runNodeCommand, type ComponentResolver, type HandlerContext } from './commands/handlers';
import type { AssemblySolveResult, MechanicsService } from './mechanics';
import {
  COMMAND_TYPES,
  CommandEnvelopeSchema,
  isCommandType,
  type Command,
  type CommandSource,
  type CommandType,
} from './commands/schemas';
import { decompose } from './math/mat4';
import { newId as defaultNewId } from './project/create';
import { validateProject } from './project/create';
import type { Project } from './project/schema';
import { flattenTree, isEffectivelyLocked, validateGraph, worldMatrix } from './scene/graph';
import { SceneNodeSchema, type NodeTransform, type SceneGraph, type SceneNode } from './scene/schemas';
import {
  applyOps,
  CommandError,
  GraphTransaction,
  type CommandErrorCode,
  type Op,
} from './scene/transaction';

/**
 * ForgeEngine — the single authoritative engineering state and the application API.
 *
 *   execute(command)   validated, atomic, undoable state change (the ONLY mutation path)
 *   undo() / redo()    replay recorded inverse/forward ops
 *   getProject() / queryScene() / getNode() / getWorldTransform() / getCapabilities()
 *   select() / getSelection()   ephemeral editor state (not persisted, not in history)
 *
 * The desktop UI, keyboard shortcuts, tests and (Phase 9) Vey all call this same
 * object, so every caller gets identical validation. Returned data is deeply frozen.
 *
 * Revision semantics: every applied change (execute, undo, redo) increments
 * `project.revision`. A command carrying `metadata.expectedRevision` is rejected
 * unless it matches, so undo can never make an old request valid again; undo/redo
 * replay stored ops and are not re-validated against the original request revision.
 */

export type CommandResult =
  | { ok: true; commandId: string; type: CommandType; revision: number; affectedIds: string[]; noop: boolean }
  | {
      ok: false;
      commandId: string | null;
      type: string | null;
      revision: number;
      error: { code: CommandErrorCode; message: string; issues?: { path: string; message: string }[] };
    };

export type HistoryResult =
  | { ok: true; revision: number; label: string; affectedIds: string[] }
  | { ok: false; revision: number; error: { code: 'empty-history' | 'integrity'; message: string } };

export interface HistoryEntry {
  commandId: string;
  type: CommandType;
  label: string;
  forward: Op[];
  inverse: Op[];
  affectedIds: string[];
}

export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  undoDepth: number;
  redoDepth: number;
  limit: number;
}

export type ChangeKind = 'command' | 'undo' | 'redo' | 'load' | 'selection';
export type EngineListener = (kind: ChangeKind) => void;

export interface CommandPolicy {
  /** Sources whose commands are refused. Default: 'vey' until Phase 9 adds a permission layer. */
  deniedSources: CommandSource[];
}

export interface EngineOptions {
  /** Component-library resolver (from @forge/components); required to create/edit catalogue components. */
  componentResolver?: ComponentResolver;
  /** Mechanical solver / geometry kernel (from @forge/mechanics); required for Phase 4 commands. */
  mechanics?: MechanicsService;
  historyLimit?: number;
  newId?: () => string;
  now?: () => Date;
  policy?: CommandPolicy;
}

export interface SceneOutlineNode {
  id: string;
  name: string;
  kind: SceneNode['kind'];
  parentId: string | null;
  childIds: readonly string[];
  depth: number;
  visible: boolean;
  locked: boolean;
  effectivelyLocked: boolean;
}

export interface SceneQueryResult {
  projectId: string;
  revision: number;
  rootId: string;
  nodes: SceneOutlineNode[];
}

export interface Capabilities {
  apiVersion: 1;
  commandContract: 'forge.command/v1';
  commands: { type: CommandType; status: 'implemented'; undoable: true; summary: string }[];
  queries: string[];
  ephemeral: string[];
  sources: { accepted: CommandSource[]; denied: CommandSource[] };
  future: { name: string; plannedPhase: number; status: 'planned' }[];
}

const SUMMARIES: Record<CommandType, string> = {
  'scene.node.create': 'Create a group, primitive, reference or component-library instance (conjure)',
  'scene.node.delete': 'Delete a node and its descendants',
  'scene.node.duplicate': 'Duplicate a node and its descendants with new ids',
  'scene.node.rename': 'Rename a node',
  'scene.node.transform': 'Set a node’s local position (m), rotation (unit quaternion) and/or scale',
  'scene.node.reparent': 'Move a node under another parent, optionally preserving its world transform',
  'scene.node.visibility': 'Show or hide a node',
  'scene.node.lock': 'Lock or unlock a node',
  'scene.node.group': 'Group sibling nodes under a new group',
  'scene.node.ungroup': 'Dissolve a group, preserving its children’s world transforms',
  'scene.component.configure': 'Change a component instance’s variant, parameters (dimensions) or material',
  'assembly.create': 'Create a mechanical assembly (hierarchy + mates) from nodes',
  'assembly.insertComponent': 'Move a body into an assembly, preserving its world placement',
  'assembly.removeComponent': 'Move an unconstrained body out of an assembly',
  'assembly.ground': 'Ground or unground a body (fixed reference for the solver)',
  'assembly.mate.create':
    'Create a mate (fixed, revolute, prismatic, cylindrical, ball, planar) and re-solve',
  'assembly.mate.update':
    'Edit a mate’s type (safe conversions), alignment, offset, limits, home or suppression and re-solve',
  'assembly.mate.delete': 'Delete a mate and re-solve',
  'assembly.joint.setPosition': 'Set a joint’s coordinates (within limits) and re-solve the assembly',
  'assembly.joint.home': 'Return every joint to its home coordinates',
  'assembly.constraint.add': 'Add a distance/angle/concentric/coincident/parallel/perpendicular constraint',
  'assembly.constraint.update':
    'Edit a constraint’s value, references or driving/check-only role and re-solve',
  'assembly.constraint.delete': 'Delete an assembly constraint and re-solve',
  'component.parameters.update': 'Change a component’s parameters/variant/material and re-solve its assembly',
  'sketch.create': 'Create a 2D sketch (optionally with entities and constraints)',
  'sketch.entity.add': 'Add points, lines, circles or arcs to a sketch (solved)',
  'sketch.constraint.add': 'Add a sketch constraint; conflicting constraints are rejected',
  'sketch.constraint.delete': 'Delete a sketch constraint',
  'part.create': 'Create a parametric part from an extruded profile or a sketch',
  'geometry.hole.create': 'Add a through or blind hole to a part',
  'geometry.cut.create': 'Add a through or blind cut to a part',
  'geometry.boolean.create': 'Union/difference/intersection of a part’s base profile with a profile',
  'geometry.pattern.create': 'Rectangular or circular pattern of a hole/cut feature',
  'geometry.mirror.create': 'Mirror a hole/cut feature about a profile axis',
  'geometry.feature.update': 'Edit a feature’s parameters (geometry regenerates; invalid edits rejected)',
  'geometry.feature.delete': 'Delete a feature that nothing depends on',
  'model.instance.create': 'Place an imported model (GLB/glTF) by its stored asset hash',
  'model.instance.interfaces.set':
    'Set the user-declared connection interfaces of an imported model instance',
  'scene.batch': 'Apply up to 10,000 node commands atomically as one undoable step',
};

const FUTURE = [
  { name: 'simulation.run', plannedPhase: 5 },
  { name: 'experiment.record', plannedPhase: 7 },
  { name: 'vey.session', plannedPhase: 9 },
];

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export class ForgeEngine {
  private project: Project;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private selection: readonly string[] = Object.freeze([]);
  private readonly listeners = new Set<EngineListener>();
  private readonly historyLimit: number;
  private readonly ctx: HandlerContext;
  private readonly now: () => Date;
  private readonly policy: CommandPolicy;

  constructor(project: Project, options: EngineOptions = {}) {
    const v = validateProject(project);
    if (!v.ok) throw new Error(`Invalid initial project: ${v.errors.slice(0, 3).join('; ')}`);
    this.project = deepFreeze(structuredCloneJson(v.project));
    this.historyLimit = Math.max(1, options.historyLimit ?? 200);
    this.ctx = {
      newId: options.newId ?? defaultNewId,
      ...(options.componentResolver ? { resolver: options.componentResolver } : {}),
      ...(options.mechanics ? { mechanics: options.mechanics } : {}),
    };
    this.now = options.now ?? (() => new Date());
    this.policy = options.policy ?? { deniedSources: ['vey'] };
  }

  // ---------------------------------------------------------------- commands

  execute(input: unknown): CommandResult {
    return this.executeInternal(input, false);
  }

  /**
   * Dry run: validates and runs the command exactly as `execute` would, but commits
   * nothing (no revision, history or listener change). On success `scene` is the graph
   * the command would produce — used for previews (e.g. a mate before it is confirmed).
   */
  preview(input: unknown): { result: CommandResult; scene: SceneGraph | null } {
    this.lastPreview = null;
    const result = this.executeInternal(input, true);
    const scene = result.ok ? (this.lastPreview ?? this.project.scene) : null;
    this.lastPreview = null;
    return { result, scene };
  }

  private lastPreview: SceneGraph | null = null;

  private executeInternal(input: unknown, dryRun: boolean): CommandResult {
    const rev = this.project.revision;
    const fail = (
      code: CommandErrorCode,
      message: string,
      commandId: string | null = null,
      type: string | null = null,
      issues?: { path: string; message: string }[],
    ): CommandResult => ({
      ok: false,
      commandId,
      type,
      revision: rev,
      error: { code, message, ...(issues ? { issues } : {}) },
    });

    const raw = (typeof input === 'object' && input !== null ? input : {}) as {
      type?: unknown;
      commandId?: unknown;
    };
    const rawId = typeof raw.commandId === 'string' ? raw.commandId : null;
    if (!isCommandType(raw.type))
      return fail(
        'unknown-command',
        `Unknown command type "${String(raw.type)}".`,
        rawId,
        typeof raw.type === 'string' ? raw.type : null,
      );

    const parsed = CommandEnvelopeSchema.safeParse(input);
    if (!parsed.success)
      return fail(
        'invalid-command',
        'Command failed validation.',
        rawId,
        raw.type,
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    const cmd: Command = parsed.data;
    if (this.policy.deniedSources.includes(cmd.metadata.source))
      return fail(
        'permission-denied',
        `Commands from source "${cmd.metadata.source}" are not permitted.`,
        cmd.commandId,
        cmd.type,
      );
    if (cmd.metadata.expectedRevision !== undefined && cmd.metadata.expectedRevision !== rev)
      return fail(
        'stale-revision',
        `Expected revision ${cmd.metadata.expectedRevision}, current is ${rev}.`,
        cmd.commandId,
        cmd.type,
      );

    const tx = new GraphTransaction(this.project.scene);
    let affectedIds: string[];
    try {
      affectedIds = this.run(cmd, tx);
    } catch (e) {
      if (e instanceof CommandError) return fail(e.code, e.message, cmd.commandId, cmd.type);
      throw e; // programming error: surface it, state is untouched
    }
    const forward = tx.forward;
    if (forward.length === 0)
      return { ok: true, commandId: cmd.commandId, type: cmd.type, revision: rev, affectedIds, noop: true };

    const integrity = this.checkIntegrity(tx, forward);
    if (integrity) return fail('integrity', integrity, cmd.commandId, cmd.type);

    if (dryRun) {
      this.lastPreview = tx.graph;
      return { ok: true, commandId: cmd.commandId, type: cmd.type, revision: rev, affectedIds, noop: false };
    }
    this.commitScene(tx.graph);
    this.undoStack.push({
      commandId: cmd.commandId,
      type: cmd.type,
      label: cmd.metadata.label ?? defaultLabel(cmd.type),
      forward,
      inverse: tx.inverse,
      affectedIds,
    });
    if (this.undoStack.length > this.historyLimit)
      this.undoStack.splice(0, this.undoStack.length - this.historyLimit);
    this.redoStack = [];
    this.pruneSelection();
    this.emit('command');
    return {
      ok: true,
      commandId: cmd.commandId,
      type: cmd.type,
      revision: this.project.revision,
      affectedIds,
      noop: false,
    };
  }

  undo(): HistoryResult {
    return this.replay('undo');
  }

  redo(): HistoryResult {
    return this.replay('redo');
  }

  // ----------------------------------------------------------------- queries

  getProject(): Project {
    return this.project;
  }

  getNode(id: string): SceneNode | null {
    return this.project.scene.nodes[id] ?? null;
  }

  /** World transform of a node (composed down the hierarchy); `exact` is false if it contains shear. */
  getWorldTransform(id: string): (NodeTransform & { exact: boolean }) | null {
    if (!this.project.scene.nodes[id]) return null;
    const { trs, exact } = decompose(worldMatrix(this.project.scene, id));
    return { ...trs, exact };
  }

  queryScene(): SceneQueryResult {
    const g = this.project.scene;
    return {
      projectId: this.project.id,
      revision: this.project.revision,
      rootId: g.rootId,
      nodes: flattenTree(g).map(({ id, depth }) => {
        const n = g.nodes[id]!;
        return {
          id,
          name: n.name,
          kind: n.kind,
          parentId: n.parentId,
          childIds: n.childIds,
          depth,
          visible: n.visible,
          locked: n.locked,
          effectivelyLocked: isEffectivelyLocked(g, id),
        };
      }),
    };
  }

  getHistory(): HistoryInfo {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.at(-1)?.label ?? null,
      redoLabel: this.redoStack.at(-1)?.label ?? null,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      limit: this.historyLimit,
    };
  }

  /**
   * Read-only mechanical analysis of an assembly (DOF, residuals, status) without changing
   * anything. Returns null when no mechanics service is configured.
   */
  analyzeAssembly(assemblyId: string): AssemblySolveResult | null {
    const n = this.project.scene.nodes[assemblyId];
    if (!this.ctx.mechanics || n?.kind !== 'assembly') return null;
    return this.ctx.mechanics.solveAssembly(
      this.project.scene,
      assemblyId,
      n.mechanical.mates.map((m) => m.id),
    );
  }

  getCapabilities(): Capabilities {
    return {
      apiVersion: 1,
      commandContract: 'forge.command/v1',
      commands: COMMAND_TYPES.map((type) => ({
        type,
        status: 'implemented',
        undoable: true,
        summary: SUMMARIES[type],
      })),
      queries: [
        'getProject',
        'queryScene',
        'getNode',
        'getWorldTransform',
        'getSelection',
        'getHistory',
        'getCapabilities',
      ],
      ephemeral: ['select'],
      sources: {
        accepted: (['desktop-ui', 'keyboard', 'api', 'test', 'vey'] as CommandSource[]).filter(
          (s) => !this.policy.deniedSources.includes(s),
        ),
        denied: [...this.policy.deniedSources],
      },
      future: FUTURE.map((f) => ({ ...f, status: 'planned' })),
    };
  }

  // --------------------------------------------------------------- selection

  /** Ephemeral selection (array for future multi-select). Unknown ids are rejected. */
  select(
    ids: readonly string[],
  ): { ok: true; selection: readonly string[] } | { ok: false; message: string } {
    const missing = ids.filter((id) => !this.project.scene.nodes[id]);
    if (missing.length) return { ok: false, message: `Unknown node(s): ${missing.join(', ')}` };
    const next = Object.freeze([...new Set(ids)]);
    if (next.length !== this.selection.length || next.some((id, i) => id !== this.selection[i])) {
      this.selection = next;
      this.emit('selection');
    }
    return { ok: true, selection: this.selection };
  }

  getSelection(): readonly string[] {
    return this.selection;
  }

  // ------------------------------------------------------------- lifecycle

  /** Replace the whole project (new/open/import). Validated first; clears history. */
  replaceProject(project: unknown): { ok: true } | { ok: false; errors: string[] } {
    const v = validateProject(project);
    if (!v.ok) return { ok: false, errors: v.errors };
    this.project = deepFreeze(structuredCloneJson(v.project));
    this.undoStack = [];
    this.redoStack = [];
    this.selection = Object.freeze([]);
    this.emit('load');
    return { ok: true };
  }

  /** Change project-level fields that are not part of the scene graph (e.g. timestamps on save). */
  touchSaved(): Project {
    this.project = deepFreeze({ ...this.project, updatedAt: this.now().toISOString() });
    return this.project;
  }

  subscribe(fn: EngineListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------------------------------------------------------------- internals

  private run(cmd: Command, tx: GraphTransaction): string[] {
    if (cmd.type === 'scene.batch') return runBatch(tx, cmd.payload.commands, this.ctx);
    return runNodeCommand(tx, cmd, this.ctx);
  }

  /** Validate every node the transaction touched plus whole-graph structure. */
  private checkIntegrity(tx: GraphTransaction, forward: readonly Op[]): string | null {
    for (const o of forward) {
      if (o.op === 'put') {
        const r = SceneNodeSchema.safeParse(o.node);
        if (!r.success) return `Resulting node "${o.node.id}" is invalid: ${r.error.issues[0]?.message}`;
      }
    }
    const issues = validateGraph(tx.graph);
    return issues.length
      ? `Resulting scene graph is invalid: ${issues[0]!.path}: ${issues[0]!.message}`
      : null;
  }

  private commitScene(scene: Project['scene']) {
    this.project = deepFreeze({
      ...this.project,
      scene,
      revision: this.project.revision + 1,
      updatedAt: this.now().toISOString(),
    });
  }

  private replay(kind: 'undo' | 'redo'): HistoryResult {
    const from = kind === 'undo' ? this.undoStack : this.redoStack;
    const to = kind === 'undo' ? this.redoStack : this.undoStack;
    const entry = from.at(-1);
    if (!entry)
      return {
        ok: false,
        revision: this.project.revision,
        error: { code: 'empty-history', message: `Nothing to ${kind}.` },
      };
    const next = applyOps(this.project.scene, kind === 'undo' ? entry.inverse : entry.forward);
    const issues = validateGraph(next);
    if (issues.length)
      return {
        ok: false,
        revision: this.project.revision,
        error: { code: 'integrity', message: `${issues[0]!.path}: ${issues[0]!.message}` },
      };
    this.commitScene(next);
    to.push(from.pop()!);
    this.pruneSelection();
    this.emit(kind);
    return { ok: true, revision: this.project.revision, label: entry.label, affectedIds: entry.affectedIds };
  }

  private pruneSelection() {
    const kept = this.selection.filter((id) => this.project.scene.nodes[id]);
    if (kept.length !== this.selection.length) this.selection = Object.freeze(kept);
  }

  private emit(kind: ChangeKind) {
    for (const l of this.listeners) l(kind);
  }
}

function defaultLabel(type: CommandType): string {
  const verb = type.split('.').at(-1)!;
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}

/** Deep copy of plain JSON data (avoids relying on structuredClone typings in a DOM-free package). */
function structuredCloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export type { Command, CommandSource, CommandType };
