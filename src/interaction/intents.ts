import type { Transform } from '../model/types';

/**
 * Common interaction-intent boundary. Input adapters (desktop, XR controllers,
 * later bare hands / gloves) translate raw input into these intents. Adapters
 * never mutate the document; only the InteractionController issues commands.
 */
export type SourceType = 'desktop-mouse' | 'desktop-keyboard' | 'xr-controller' | 'in-world-ui';
export type Handedness = 'left' | 'right' | 'none';

export interface InputSourceInfo {
  /** Stable for the lifetime of the physical/logical source. */
  id: string;
  type: SourceType;
  handedness: Handedness;
}

interface Base {
  source: InputSourceInfo;
  /** performance.now() at the time the adapter observed the input. */
  time: number;
}

export type Intent =
  | (Base & { kind: 'hover'; entityId: string | null })
  | (Base & { kind: 'select'; entityId: string | null })
  | (Base & { kind: 'grab-start'; entityId: string })
  /** Candidate pose for the grabbed entity, parent-local, computed by the adapter. */
  | (Base & { kind: 'grab-move'; transform: Transform })
  | (Base & { kind: 'grab-end' })
  | (Base & { kind: 'cancel'; reason: string })
  /** The source disappeared (controller disconnected, session ended, window blurred). */
  | (Base & { kind: 'source-lost'; reason: string })
  | (Base & { kind: 'rotate-step'; radians: number })
  | (Base & { kind: 'undo' })
  | (Base & { kind: 'redo' })
  | (Base & { kind: 'reset' });
