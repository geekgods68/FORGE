/**
 * Forge ↔ Vey command contracts — PROPOSED, NOT IMPLEMENTED.
 *
 * This package defines the shape of a future structured interface through which
 * Vey (or any authorised client) may inspect and operate FORGE. In Phase 0 there is
 * deliberately NO executor: nothing here performs an action, and no command may be
 * advertised as available until it has an implementation and tests.
 * See docs/VEY_INTEGRATION.md.
 */

export type ExecutionStatus =
  'accepted' | 'rejected' | 'awaiting-confirmation' | 'running' | 'succeeded' | 'failed';

/**
 * read        – inspects state only
 * write       – changes the open project (reversible via history once implemented)
 * destructive – may discard or overwrite user data
 * compute     – starts potentially long-running simulation work
 */
export type PermissionLevel = 'read' | 'write' | 'destructive' | 'compute';

export interface CommandEnvelope<TName extends string = string, TInput = unknown> {
  /** Unique per request; used for idempotency and audit. */
  commandId: string;
  command: TName;
  input: TInput;
  /** Caller identity as metadata. NOT authentication. */
  requestedBy: string;
  /** Project revision the caller based the request on; stale requests will be rejected. */
  expectedRevision?: number;
  issuedAt: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface CommandResult<TOutput = unknown> {
  commandId: string;
  status: ExecutionStatus;
  output?: TOutput;
  validationErrors?: ValidationIssue[];
  /** Human-readable reason for rejection/failure. */
  message?: string;
}

export interface CommandContract {
  name: string;
  summary: string;
  permission: PermissionLevel;
  /** Requires explicit user confirmation before execution. */
  requiresConfirmation: boolean;
  /** Additional safety checks required before execution. */
  safetyChecks: string[];
  /** Only 'implemented' contracts may ever be exposed to a client. */
  implementationStatus: 'proposed' | 'implemented';
  plannedPhase: number;
}

const c = (x: CommandContract) => x;

export const COMMAND_CONTRACTS = [
  c({
    name: 'project.create',
    summary: 'Create a new empty project.',
    permission: 'write',
    requiresConfirmation: false,
    safetyChecks: ['Unsaved changes in the open project are not discarded silently'],
    implementationStatus: 'proposed',
    plannedPhase: 9,
  }),
  c({
    name: 'project.open',
    summary: 'Open a saved project by id.',
    permission: 'write',
    requiresConfirmation: true,
    safetyChecks: [
      'Confirm if the open project has unsaved changes',
      'Validate before replacing the open project',
    ],
    implementationStatus: 'proposed',
    plannedPhase: 9,
  }),
  c({
    name: 'project.save',
    summary: 'Persist the open project.',
    permission: 'destructive',
    requiresConfirmation: true,
    safetyChecks: ['Overwrites the stored copy — confirm target', 'Validate before writing'],
    implementationStatus: 'proposed',
    plannedPhase: 9,
  }),
  c({
    name: 'scene.inspect',
    summary: 'Read the active scene: instances, transforms, assemblies.',
    permission: 'read',
    requiresConfirmation: false,
    safetyChecks: ['Return project data only; no host filesystem access'],
    implementationStatus: 'proposed',
    plannedPhase: 9,
  }),
  c({
    name: 'component.search',
    summary: 'Search the component catalogue.',
    permission: 'read',
    requiresConfirmation: false,
    safetyChecks: [],
    implementationStatus: 'proposed',
    plannedPhase: 9,
  }),
  c({
    name: 'component.conjure',
    summary: 'Place a new instance of a catalogue definition.',
    permission: 'write',
    requiresConfirmation: false,
    safetyChecks: ['Definition must exist', 'Transform must be finite and in bounds', 'Undoable'],
    implementationStatus: 'proposed',
    plannedPhase: 9,
  }),
  c({
    name: 'component.transform',
    summary: 'Move/rotate an existing instance.',
    permission: 'write',
    requiresConfirmation: false,
    safetyChecks: ['Reject stale expectedRevision', 'Undoable'],
    implementationStatus: 'proposed',
    plannedPhase: 9,
  }),
  c({
    name: 'assembly.create',
    summary: 'Group instances into a named assembly.',
    permission: 'write',
    requiresConfirmation: false,
    safetyChecks: ['All members exist', 'No cyclic membership', 'Undoable'],
    implementationStatus: 'proposed',
    plannedPhase: 9,
  }),
  c({
    name: 'simulation.run',
    summary: 'Run a supported simulation on a scene or assembly.',
    permission: 'compute',
    requiresConfirmation: true,
    safetyChecks: [
      'Report validity status of every model used',
      'Bounded run time and resources',
      'Never actuates real hardware',
    ],
    implementationStatus: 'proposed',
    plannedPhase: 9,
  }),
  c({
    name: 'experiment.results',
    summary: 'Read recorded experiment results with provenance.',
    permission: 'read',
    requiresConfirmation: false,
    safetyChecks: ['Include validity status and assumptions'],
    implementationStatus: 'proposed',
    plannedPhase: 9,
  }),
] as const satisfies readonly CommandContract[];

export type ProposedCommandName = (typeof COMMAND_CONTRACTS)[number]['name'];

/** Commands a client may actually call. Empty in Phase 0 — by design. */
export const AVAILABLE_COMMANDS: readonly CommandContract[] = COMMAND_CONTRACTS.filter(
  (x: CommandContract) => x.implementationStatus === 'implemented',
);
