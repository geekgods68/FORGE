import type { Entity, Transform } from '../model/types';
import { isNonEmptyString, ValidationError } from '../model/validate';

/**
 * Workshop command contract, version 1. This is a NEW contract for the VR
 * workshop; it does not reuse or modify the 2D Mindspace action schema.
 *
 * An envelope carries one or more commands that are applied as ONE atomic
 * transaction and become ONE undo step.
 */
export const COMMAND_CONTRACT = 'mindspace.vr-workshop.command/v1' as const;

export type Command =
  | { type: 'entity.create'; entity: Entity }
  | { type: 'entity.delete'; id: string; cascade?: boolean }
  | { type: 'entity.setTransform'; id: string; transform: Transform }
  | { type: 'entity.setParent'; id: string; parentId: string | null };

export type CommandSource = 'desktop' | 'xr' | 'ui' | 'script';

export interface CommandEnvelope {
  contract: typeof COMMAND_CONTRACT;
  commandId: string;
  label: string;
  commands: Command[];
  /** Must equal the document's current revision, or the envelope is rejected as stale. */
  expectedRevision: number;
  /** Local actor identifier. Metadata only — NOT proof of identity or authorization. */
  requestedBy: string;
  source: CommandSource;
  timestamp: string;
}

export const MAX_COMMANDS_PER_ENVELOPE = 500;
const SOURCES: CommandSource[] = ['desktop', 'xr', 'ui', 'script'];
const TYPES = ['entity.create', 'entity.delete', 'entity.setTransform', 'entity.setParent'];

/** Layer 1: shape validation only. State validation happens during application. */
export function checkEnvelopeShape(e: unknown): asserts e is CommandEnvelope {
  const bad = (m: string) => new ValidationError('malformed', m);
  if (typeof e !== 'object' || e === null) throw bad('envelope must be an object');
  const env = e as Record<string, unknown>;
  if (env.contract !== COMMAND_CONTRACT) throw bad(`unsupported contract "${String(env.contract)}"`);
  if (!isNonEmptyString(env.commandId)) throw bad('commandId required');
  if (typeof env.label !== 'string' || env.label.length > 200) throw bad('label must be a string ≤ 200 chars');
  if (!Number.isSafeInteger(env.expectedRevision)) throw bad('expectedRevision must be an integer');
  if (!isNonEmptyString(env.requestedBy)) throw bad('requestedBy required');
  if (!SOURCES.includes(env.source as CommandSource)) throw bad(`unknown source "${String(env.source)}"`);
  if (!isNonEmptyString(env.timestamp, 64) || Number.isNaN(Date.parse(env.timestamp))) throw bad('timestamp must be ISO 8601');
  if (!Array.isArray(env.commands) || env.commands.length === 0) throw bad('commands must be a non-empty array');
  if (env.commands.length > MAX_COMMANDS_PER_ENVELOPE) throw bad(`at most ${MAX_COMMANDS_PER_ENVELOPE} commands per envelope`);
  for (const c of env.commands) {
    if (typeof c !== 'object' || c === null || !TYPES.includes((c as { type?: string }).type ?? '')) throw bad(`unknown command type "${String((c as { type?: unknown })?.type)}"`);
  }
}

export function makeEnvelope(
  commands: Command[],
  opts: { label: string; expectedRevision: number; source: CommandSource; requestedBy: string },
): CommandEnvelope {
  return {
    contract: COMMAND_CONTRACT,
    commandId: crypto.randomUUID(),
    label: opts.label,
    commands,
    expectedRevision: opts.expectedRevision,
    requestedBy: opts.requestedBy,
    source: opts.source,
    timestamp: new Date().toISOString(),
  };
}
