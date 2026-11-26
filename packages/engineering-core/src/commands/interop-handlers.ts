import { CIRCUIT_IMPORT_FORMATS, circuitFingerprint, importFingerprint } from '../interop/schemas';
import type { SceneNode } from '../scene/schemas';
import { CommandError, type GraphTransaction } from '../scene/transaction';
import type { HandlerContext } from './handlers';
import type { InteropCommandType } from './interop-schemas';
import type { PayloadOf } from './schemas';

type RootNode = Extract<SceneNode, { kind: 'root' }>;
type IHandler<K extends InteropCommandType> = (
  tx: GraphTransaction,
  payload: PayloadOf<K>,
  ctx: HandlerContext,
) => string[];

function root(tx: GraphTransaction): RootNode {
  const r = tx.get(tx.rootId);
  if (r.kind !== 'root') throw new CommandError('integrity', 'Scene root is not a root node.');
  return r;
}

export const INTEROP_HANDLERS: { [K in InteropCommandType]: IHandler<K> } = {
  'interop.import.record'(tx, { record }) {
    const r = root(tx);
    const list = r.imports ?? [];
    if (list.some((x) => x.id === record.id))
      throw new CommandError('invalid-operation', `Import record "${record.id}" already exists.`);
    // A record may only describe nodes that exist (it is written after them in the same batch).
    const nodes = record.nodeIds.map((id) => {
      const n = tx.graph.nodes[id];
      if (!n) throw new CommandError('not-found', `Import record lists node "${id}", which does not exist.`);
      return n;
    });
    // The fingerprint is computed here, from the nodes as created, never taken from the caller.
    const fingerprint = CIRCUIT_IMPORT_FORMATS.includes(record.format)
      ? circuitFingerprint(r.electrical ?? null)
      : importFingerprint(nodes);
    tx.put({ ...r, imports: [...list, { ...record, nodesFingerprint: fingerprint }] });
    return [r.id];
  },
  'interop.import.forget'(tx, { importId }) {
    const r = root(tx);
    const list = r.imports ?? [];
    if (!list.some((x) => x.id === importId))
      throw new CommandError('not-found', `Import record "${importId}" does not exist.`);
    tx.put({ ...r, imports: list.filter((x) => x.id !== importId) });
    return [r.id];
  },
};
