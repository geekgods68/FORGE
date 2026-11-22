# Experiment architecture (Phase 7)

Package: `@forge/research` (domain package: no DOM, no Node APIs, no network). Desktop UI: `apps/desktop/src/features/research/`.

## Data ownership

| Data                                                                                       | Where                                                                        | Mutability                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Engineering project (CAD, mechanics, simulation setup, circuit, firmware)                  | project document (`@forge/persistence`)                                      | Edited only in CAD/Electronics/Simulation modes. **Research never writes it.** |
| Research document (experiments, run records, datasets, calibration and validation records) | `${namespace}:research:${projectId}` in browser storage, schema v1           | Protocol: undoable commands. Results: append-only.                             |
| Raw run data (time series) and imported datasets                                           | `RunDataStore`: IndexedDB in the browser (`IdbRunDataStore`), memory in Node | Write-once, referenced by key **and** SHA-256 hash from the run record         |

A project and its research document are linked by project id; the research document is not part of the project file, so research never bloats the project or its undo history.

## Layers

```
schemas.ts   Zod schemas (experiment, protocol, variable, measurement, run, dataset, calibration, validation)
engine.ts    ResearchEngine: validated commands, protocol undo/redo, append-only results, integrity hashes
params.ts    Parameter targets discovered from the project + applyValues() via engineering commands on a COPY
design.ts    Plan generation (single, replicates, OAT, grid, random, LHS, paired, Monte Carlo) with budgets
runner.ts    executeRun(): one run over the existing PhysicsSession / CoSimulation / analog transient
scheduler.ts Campaign: sequential execution, progress, cancel/pause, retry, duplicate reuse, disk floor
measure.ts   Signals → outcomes (reductions, derived expressions with unit checking)
stats.ts / analysis.ts      Descriptive and inferential statistics, comparisons, sensitivity, uncertainty
verification.ts             Convergence, reference comparison, replay, datasets, validation, calibration
report.ts / exchange.ts     Reports (Markdown + JSON), CSV, experiment export/import
api.ts       ResearchApi: programmatic surface prepared for Vey (no LLM involvement in Phase 7)
```

## Execution path

1. `validateExperiment` checks the protocol against the project: every variable target must exist in the model, units must convert to the target's unit, measurements must reference signals the model actually records (`signalCatalog`), and the plan must fit the budget.
2. `Campaign` snapshots the project and the experiment (deep copies) at launch; later edits do not affect a running campaign.
3. For each planned run, `applyValues` copies the project and applies the condition through the same validated engineering commands the editor uses (`SceneBuilder`), so a value the editor would reject is rejected here too. Runtime-only values (e.g. initial joint positions) are passed to the simulator, not written to the model.
4. The run executes on the existing simulators — Phase 5 `PhysicsSession` (fixed step), Phase 6 `CoSimulation` (event-driven firmware + physics) or the Phase 6 analog transient. No new clock or solver is introduced; the display loop plays no part.
5. Signals are resampled onto the protocol's sampling grid (hold signals such as logic levels and servo targets use zero-order hold), outcomes are computed, raw data is stored and hashed, and the run record is appended with its state history and an integrity hash.

## Run lifecycle

`CREATED → VALIDATED → QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED | INTERRUPTED`; `INVALID` from CREATED/VALIDATED. Terminal states are final: a retry is a **new** record with `retryOf` pointing at the old one. Transitions are checked when records are appended and again on load.

## Safety boundaries

- Experiments cannot run arbitrary JavaScript: derived measurements use a small expression language (`expr.ts`: + − × ÷, integer powers ≤ 4, abs, sqrt, sq, min, max) parsed and dimension-checked up front.
- Firmware runs only in the Phase 6 Arduino-subset interpreter; experiments can change its declared constants, not inject code.
- No hardware, network, file-system or LLM access. Dataset import is an explicit user file pick, size-limited (5 MB datasets, 32 MB experiment bundles).
