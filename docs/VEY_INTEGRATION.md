# Forge ↔ Vey integration boundary (proposed)

**Nothing in this document is operational in Phase 0.**

- `@forge/vey-api` contains type definitions and a registry in which every command is `implementationStatus: 'proposed'`.
- `AVAILABLE_COMMANDS` is empty, and a test enforces that.
- No LLM is integrated, and there is no network endpoint.

## Envelope

| Field              | Purpose                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `commandId`        | Unique per request: idempotency and audit                                        |
| `command`          | Contract name, e.g. `component.transform`                                        |
| `input`            | Payload, validated against the contract's Zod schema (to be written per command) |
| `requestedBy`      | Caller identity as **metadata, not authentication**                              |
| `expectedRevision` | Project revision the caller based its request on; stale requests are rejected    |
| `issuedAt`         | ISO 8601                                                                         |

The result carries `commandId`, `status` (`accepted` · `rejected` · `awaiting-confirmation` · `running` · `succeeded` · `failed`), `output`, `validationErrors[] {path, message}` and `message`.

## Proposed contracts

| Command               | Permission  | Confirmation | Key safety checks                                                                |
| --------------------- | ----------- | ------------ | -------------------------------------------------------------------------------- |
| `project.create`      | write       | no           | Unsaved work is not discarded silently                                           |
| `project.open`        | write       | **yes**      | Confirm if there are unsaved changes; validate before replacing the open project |
| `project.save`        | destructive | **yes**      | Overwrites the stored copy; validate before writing                              |
| `scene.inspect`       | read        | no           | Project data only; no host filesystem access                                     |
| `component.search`    | read        | no           | —                                                                                |
| `component.conjure`   | write       | no           | Definition exists; finite, in-bounds transform; undoable                         |
| `component.transform` | write       | no           | Reject stale revision; undoable                                                  |
| `assembly.create`     | write       | no           | Members exist; no cyclic membership; undoable                                    |
| `simulation.run`      | compute     | **yes**      | Report every model's validity status; bounded run time; never actuates hardware  |
| `experiment.results`  | read        | no           | Include validity status and assumptions                                          |

## Requirements before any contract becomes `implemented` (Phase 9)

1. Phase 1 adds the validated command dispatcher with undo history. Vey commands must use the **same** dispatcher as the UI; there is no separate mutation path.
2. Each contract has an input schema, implementation and tests, including the rejection paths.
3. A permission and confirmation layer exists. The user approves destructive and compute operations.
4. An audit log records `commandId`, caller, inputs, outcome and timestamp, kept locally.
5. Vey can never execute arbitrary code, access the host filesystem, or reach the network through FORGE.
