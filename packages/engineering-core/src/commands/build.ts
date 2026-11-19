import { newId } from '../project/create';
import type { CommandMetadata, CommandSource, CommandType, PayloadInput } from './schemas';

/** Convenience builder for a command envelope (callers may also build envelopes by hand). */
export function makeCommand<T extends CommandType>(
  type: T,
  payload: PayloadInput<T>,
  source: CommandSource,
  extra: Omit<Partial<CommandMetadata>, 'source' | 'timestamp'> = {},
) {
  return {
    commandId: newId(),
    type,
    payload,
    metadata: { source, timestamp: new Date().toISOString(), ...extra },
  };
}
