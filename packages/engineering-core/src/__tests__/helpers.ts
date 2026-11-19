import type { CommandType, PayloadInput } from '../commands/schemas';
import { ForgeEngine, type CommandResult, type EngineOptions } from '../engine';
import { createProject } from '../project/create';
import { canonicalStringify } from '../project/file';
import type { Project } from '../project/schema';

/** Deterministic engine: sequential ids, fixed clock. */
export function makeEngine(opts: EngineOptions & { project?: Project } = {}) {
  let n = 0;
  const project = opts.project ?? createProject('Test', new Date('2026-11-20T10:00:00.000Z'));
  const engine = new ForgeEngine(project, {
    newId: () => `id-${++n}`,
    now: () => new Date('2026-11-20T10:00:00.000Z'),
    ...opts,
  });
  const rootId = project.scene.rootId;
  const cubeId = project.scene.nodes[rootId]!.childIds[0]!;
  let c = 0;
  const run = <T extends CommandType>(
    type: T,
    payload: PayloadInput<T>,
    extra: Record<string, unknown> = {},
  ): CommandResult =>
    engine.execute({
      commandId: `cmd-${++c}`,
      type,
      payload,
      metadata: { source: 'test', timestamp: '2026-11-20T10:00:00.000Z', ...extra },
    });
  const box = (id: string, parentId?: string, position: [number, number, number] = [0, 0, 0]) =>
    run('scene.node.create', {
      node: {
        kind: 'primitive',
        id,
        ...(parentId ? { parentId } : {}),
        geometry: { shape: 'box', width: 0.1, height: 0.1, depth: 0.1 },
        transform: { position },
      },
    });
  const group = (id: string, parentId?: string, transform?: Record<string, unknown>) =>
    run('scene.node.create', {
      node: { kind: 'group', id, ...(parentId ? { parentId } : {}), ...(transform ? { transform } : {}) },
    });
  /** Serialized engineering state, for exact before/after comparisons. */
  const state = () => canonicalStringify(engine.getProject().scene);
  return { engine, run, box, group, rootId, cubeId, state };
}

export const expectOk = (r: CommandResult) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
};

export const close = (a: readonly number[], b: readonly number[], eps = 1e-9) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= eps);
