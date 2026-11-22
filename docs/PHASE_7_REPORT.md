# Phase 7 report: scientific experimentation, research automation and validation

**Branch:** `phase-7/scientific-experiments` (from `main` = `878142b`, Phase 6 fast-forwarded at the start of this phase). Not merged, not pushed.

**Status: COMPLETE, with stated partials** (see "Acceptance criteria" and §19). Every result below comes from FORGE's simulation models. None is empirically validated: FORGE ships no measured laboratory data, and every demonstration experiment reports "Not empirically validated".

## Milestones

| Milestone                          | Commit       | Content                                                                                                                                                                |
| ---------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — experiment infrastructure      | `37c431b`    | `@forge/research`: schemas, ResearchEngine (protocol undo/redo, append-only results, integrity hashes), parameter targets, units, hashing, seeds, research persistence |
| B — automated execution            | `8c08471`    | Plans and budgets, `executeRun` over the Phase 5/6 simulators, Campaign scheduler (progress, cancel, retry, reuse, disk floor), run-data store                         |
| C — measurements                   | `e458aa6`    | Signal catalogue, 20 reductions, dimension-checked derived expressions, missing-data rules                                                                             |
| D — statistical analysis           | `53dee18`    | Descriptive/inferential statistics (verified against R), comparisons, sensitivity, uncertainty                                                                         |
| E — validation and calibration     | `4aa2aa3`    | Convergence, reference comparison, replay, dataset import, validation records, LM calibration                                                                          |
| F — research workspace             | `c984595`    | Research mode UI, notebook, reports, exports, research samples, browser workflows                                                                                      |
| G — benchmarks, docs, final checks | final commit | Node and browser benchmarks, 10 new documents, hypothesis-assessment fix                                                                                               |

## 1. Experiment architecture

A separate **research document** per project (schema v1, `<ns>:research:<projectId>`) holds experiments, run records, datasets, calibration and validation records. It is not part of the project file and never enters the engineering undo history. Protocol edits are validated, undoable `experiment.*` commands. Results are append-only and integrity-hashed. Raw time series live in a write-once `RunDataStore` (IndexedDB in the browser, memory in Node), referenced by key and SHA-256 hash. Each run applies its condition to a **copy** of the project through the engineering commands the editor uses. It then executes on the existing Phase 5 `PhysicsSession`, the Phase 6 `CoSimulation` or the analog transient; no new solver or clock was added. Details: EXPERIMENT_ARCHITECTURE.md.

## 2. Supported variable types

continuous, integer, angle, boolean, categorical, material, variant, controller, firmware-constant, initial-condition; roles independent, dependent, controlled, nuisance, random, derived. Variables bind to parameter targets **discovered from the project**: gravity, solver settings, payload mass, joint damping/friction/target/effort and speed limits/bandwidth, body friction, component material/variant, circuit part fields, firmware choice and declared constants, co-simulation ambient temperature, transient step and runtime initial positions. Units are converted and checked. Uncertainty distributions: fixed, uniform, normal, bounded normal, empirical.

## 3. Experiment design methods

single, replicates, one-at-a-time, full grid, random (uniform over bounds), Latin hypercube, paired (shared seeds per replicate) and Monte Carlo (declared distributions). Budgets are checked **before** enumeration (defaults: 200 runs, 200k steps and 50k samples per run, 120 s wall per run, 64 MB raw data, 1 concurrent run, 8 GiB disk floor where measurable). Plans report estimated steps and bytes and warn when replicated deterministic conditions would give identical runs.

## 4. Run scheduler and recovery

Sequential `Campaign`: it snapshots the project and protocol at launch, yields between runs and simulation chunks, and records the lifecycle `CREATED → VALIDATED → QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED | INTERRUPTED` (or INVALID). Transitions are checked on append and on load. Cancel stops between chunks; completed runs are untouched. Retry creates a new record linked by `retryOf`. Relaunch reuses completed runs after verifying their configuration and data hashes (100 runs re-verified in 34 ms, no re-simulation). A required measurement that is unavailable fails the run instead of recording an empty success.

## 5. Reproducibility mechanisms

Per run: experiment revision, configuration hash (canonical JSON SHA-256), model fingerprint, software versions, RNG id (`mulberry32 v1`), SHA-256-derived seeds written into the co-simulation settings, state history, data hash and an integrity hash over the record. Replays in the same build reproduce outcomes and data hashes (tested). Export/import re-verifies all hashes. Bitwise identity across platforms or engine versions is **not** claimed. Details: REPRODUCIBILITY.md.

## 6. Measurement capabilities

Mechanical (joint position, velocity, drift, target, setpoint, command, effort, saturation; body kinematics; payload mass), electrical (node voltages, branch currents), sensor/controller (ultrasonic reported and geometric distance, servo targets and angles, logic levels). Twenty reductions, including settling time, overshoot, IAE, crossings, change count, frequency, duty cycle, pulse width and first crossing. Derived expressions are dimension-checked, and radians are tracked as a dimension. Missing samples are excluded, never zeroed, and counted, as are interpolated values. Details: SCIENTIFIC_MEASUREMENTS.md.

## 7. Statistical analysis methods

Descriptive statistics (type-7 quantiles), Student-t CI, Welch and paired t-tests, Cohen's d and Hedges' g, a seeded permutation test (4,999 permutations), a seeded percentile bootstrap, Pearson/Spearman, OLS with standard errors and R², and Wilson intervals. Verified against R (Welch t 1.8608, df 17.776, p 0.07939; paired t 4.0621, p 0.002833; Anscombe slope 0.5001, R² 0.6665). A run is the unit of observation. Deterministic conditions get no test, with an explanation, and fewer than two runs per condition get no interval. No automatic multiple-comparison correction. Details: STATISTICAL_ANALYSIS.md.

## 8. Sensitivity and uncertainty analysis

One-at-a-time sensitivity (local derivative, elasticity, normalised swing), interaction grids, standardised regression coefficients (flagged when R² < 0.7), and Monte Carlo propagation (quantiles, histogram, half-to-full sample stability). Each result states that it describes model outputs under assumed inputs, not measured real-world uncertainty. Details: SENSITIVITY_UNCERTAINTY.md.

## 9. Numerical verification

- Arm timestep refinement (1/60 → 1/480 s): RMS shoulder-angle differences 4.2e-3 → 1.0e-4 → 5.1e-5 rad, observed orders 5.4 and 0.97, verdict "converging" at 1e-3 rad. Wall time per run rose from 26 to 115 ms.
- RC τ = RC: maximum relative error 1.3e-5 in package tests; within 1 % for all nine conditions in the browser test.
- Replay consistency: identical outcomes for records sharing a configuration hash.

This is verification of the solvers, not validation of the models.

## 10. Calibration and validation

Calibration uses bounded Levenberg–Marquardt with full simulation runs per evaluation. It reports fitted ± standard error, residuals and identifiability warnings, and **never modifies the project**. Validation records report MAE, RMSE, max error, bias and uncertainty coverage, with status `agrees`, `disagrees`, `not-assessed`, `not-independent` (data used for calibration) or `synthetic-only`. Only `agrees` on independent, non-synthetic data counts toward an experiment's validation status. Dataset import handles CSV/JSON with units, missing values and provenance, including a synthetic flag. Tested in the package on synthetic data that is labelled synthetic. **No real measured dataset was available; no shipped model is validated.** Details: MODEL_CALIBRATION.md, VALIDATION_FRAMEWORK.md.

## 11. Research dashboard and reporting

Research is the fourth work mode. The side panel lists experiments and templates (offered only when the project has the parameters they vary) and holds protocol undo/redo. The workspace has seven tabs:

- **Protocol:** question, hypothesis, model, settings, variables from discovered targets, preset and custom measurements, design, validation, launch.
- **Runs:** progress, cancel, retry or resume, per-run detail with an integrity check, applied parameters and recorded traces.
- **Results:** summary table, response curve, box plot, grid heat map, time-series overlay.
- **Analysis:** comparison with configuration diff, sensitivity, uncertainty, convergence.
- **Validation:** dataset import, comparison records, calibration.
- **Notebook:** typed notes, separate from records.
- **Report:** 15-section Markdown/JSON report, outcomes CSV, experiment export/import with raw data.

The report never writes conclusions (only researcher notes), lists failed runs, flags mixed revisions or fingerprints, and is marked **Incomplete** when raw data is missing. Details: RESEARCH_REPORTING.md.

## 12. Robotic-arm experiment results (template A, model only)

OAT, 9 runs, 2.5 s each, generic servo model (Phase 5, approximate):

| Payload (kg)                 |      0 |    0.1 |    0.2 |    0.3 |       0.5 |
| ---------------------------- | -----: | -----: | -----: | -----: | --------: |
| RMS shoulder effort (N·m)    |  0.164 |  0.336 |  0.504 |  0.647 |     0.908 |
| Peak effort (N·m)            |  0.867 |  0.922 |  0.922 |  0.922 |     0.922 |
| Time at the effort limit (s) |  0.083 |  0.142 |  0.292 |  0.425 |     2.483 |
| Final tracking error (rad)   | 1.4e-6 | 6.7e-7 | 3.3e-7 | 8.3e-8 | **0.384** |
| Integrated error (rad·s)     |  0.033 |  0.039 |  0.071 |  0.122 |     0.941 |

From 0.1 kg the peak effort sits at the configured limit (0.92183 N·m). At 0.5 kg the actuator stays saturated for almost the whole run and the joint does not reach its target (0.38 rad final error). Below that, final error stays at numerical-noise level (< 2e-6 rad) because the servo holds position. The hypothesis assessment reads "consistent with the predicted increase" (RMS effort). This holds for the model only; the actuator parameters are generic and unvalidated. Deterministic model: one run per condition, no inferential test. The browser workflow reproduces the same pattern with its own conditions (0.05/0.15/0.3 kg: RMS effort rising monotonically).

## 13. Electronics experiment results (model only)

- **D — RC sweep (3 × 3 grid, circuit transient):** time to 63.2 % = R·C to 4 significant figures for every condition (0.47 ms … 10.34 ms). Final voltage 5 V, except 4.985 V for 4.7 kΩ × 2.2 µF, which has not fully charged at 60 ms (as expected: 5.8 τ). The solver keeps every 5th of 30,000 steps (stated as a warning).
- **B — ultrasonic sensor noise (co-simulation, 3 replicates):** mean distance error 0 / 3.8 / 11.2 mm and servo target changes 1 / 27 / 31 for σ = 0 / 5 / 15 mm. The noiseless replicates are identical and flagged. Welch t for 15 mm vs none: difference 30 changes, 95 % CI [20.1, 39.9], p = 0.0059; permutation p = 0.10 (n = 3 per group: imprecise, stated).
- **C — responsive vs conservative threshold firmware (paired seeds, 5 replicates):** 29 ± 2.6 vs 0 target changes. Paired t: −29, CI [−32.2, −25.8], p = 1.4e-5; permutation p = 0.0072. The distance error is identical across firmware, as it should be: same seeds, same sensor.

## 14. Unit/integration tests

`pnpm test`: **403 passed, 5 skipped (opt-in benchmarks), 50 files, exit 0**. Phase 7 adds 7 research test files: foundation, execution, measurements, analysis (R references), verification, workflow (ResearchApi, reports, CSV, export round trip, hypothesis assessment) and the opt-in benchmark. It also adds a persistence test for the research repository. Shared fixtures moved to `fixtures.ts`; previously, importing them re-registered the execution tests in two other files (14 duplicate executions removed).

## 15. Browser tests

`pnpm test:e2e`: **67 passed, exit 0** (64 earlier tests plus 3 new). Phase 7 adds:

- `research.spec.ts` A: the complete §29 arm workflow (blank experiment → question → hypothesis → payload variable with 3 levels → error and effort measurements → duration → validate → launch → progress → run detail with integrity and trace → summary, response curve, box plot → comparison and configuration diff → validation status → notebook → report → export bundle and CSV → reload → reopen → protocol, run records and notes identical → CAD geometry and project revision unchanged).
- `research.spec.ts` B: the RC experiment end to end, with τ within 1 % of RC for all 9 conditions and records identical after reload.
- `research-performance.spec.ts`: responsiveness benchmark.

Not exercised in the browser: dataset import, validation records and calibration through the UI (covered by package tests only).

## 16. Performance benchmarks

Apple M3, 8 GB; records in `docs/archive/phase7-*.json`; details in PERFORMANCE_BASELINE.md.

- RC campaigns of 10 / 50 / 100 runs: 115 / 451 / 876 ms (87–114 runs/s), linear scaling. Plan generation 0.1–0.6 ms. Scheduling overhead 0.5–2.4 ms per run (1–11 % of wall time).
- Two-variable 5 × 5 grid: 695 ms. Paired co-simulation study (10 × 4 s): 887 ms. Arm payload study (9 × 2.5 s): 607 ms. The same with 64 recorded signals: 2,350 ms.
- Analysis of a campaign: ≤ 3.6 ms. Integrity check of 100 records: 10 ms.
- Browser: 9-run arm and RC campaigns in 646 / 304 ms, no long tasks, worst frame interval 33 ms (software WebGL).

## 17. Storage and memory usage

Raw data (encoded) per run: 8.7 kB (RC, 20 kHz, 20 ms), 26 kB (arm, few signals), 416 kB (arm, 64 signals), 128 kB (RC, 100 kHz, 60 ms). The research document is about 3 kB per run record. JS heap change across campaigns (with forced GC) was between −3.4 and +3.5 MB; no growth was attributable to campaigns at these sizes. Raw data stays out of the research document. Free disk throughout: 9.8 GiB (above the 8 GB floor); no large campaigns were attempted.

## 18. Git branch and final commit

`phase-7/scientific-experiments`, commits A–F above plus the final commit `feat(forge): implement phase 7 scientific experiments and validation`. No merge into `main`, no push, no history rewrite.

## 19. Known limitations

- **No empirical validation.** There are no measured datasets; all models stay approximate (Phase 5/6 status) and every experiment reports "Not empirically validated".
- **One run at a time on the main thread** (yielding between chunks). No Web Workers and no concurrency.
- **Browser disk floor:** browsers expose no free-disk figure. The 8 GiB floor is enforced only where the platform reports free space (Node); the browser relies on the 64 MB raw-data budget and the storage quota.
- **Pause** exists in the scheduler API, but the UI offers cancel and retry/resume only.
- **UI coverage:** dataset import, validation and calibration are tested in the package, not through the browser.
- **Statistics:** no multiple-comparison correction, no Bayesian or mixed-effects models; inference is limited to two-condition comparisons and OLS.
- **Sensitivity:** OAT is local and regression is linear; no variance-based (Sobol) indices.
- **Calibration:** local optimiser, few parameters, no posterior.
- **Physics telemetry** is sampled once per physics step, so higher requested rates add no samples (by design; stated as a warning). At most 64 recorded signals per protocol.
- **Fixed during this phase:** hypothesis assessment mixed other variables' OAT conditions into the trend and could not assess categorical variables. Both are fixed, with a regression test.

## 20. Readiness for Phase 8

Ready for owner review. Phase 8 has not been started. Research depends only on public APIs of the Phase 5/6 packages, so new physics domains or facilities can add parameter targets and signals to `params.ts` / `catalog.ts` without changing the experiment schema. `ResearchApi` is prepared for the later permissioned Vey integration, with no LLM involvement now.

## Acceptance criteria (§33)

|   # | Criterion                                     | Status                             | Evidence                                                |
| --: | --------------------------------------------- | ---------------------------------- | ------------------------------------------------------- |
|   1 | First-class versioned experiments             | Met                                | Schema v1, revisions, runs record revision              |
|   2 | Hypotheses, variables, controls, measurements | Met                                | Protocol tab; engine commands                           |
|   3 | Real supported model parameters               | Met                                | `listTargets` from the project; unknown targets refused |
|   4 | Immutable run configurations                  | Met                                | Campaign snapshots; config hash; integrity hash         |
|   5 | Single and batch runs                         | Met                                | All designs; campaigns up to 100 runs benchmarked       |
|   6 | Parameter sweeps                              | Met                                | OAT, grid (5 × 5), random, LHS                          |
|   7 | Traceable seeds                               | Met                                | SHA-256-derived seeds in records and co-sim settings    |
|   8 | Failure/cancel without loss                   | Met                                | Terminal states, retryOf, reuse; tests                  |
|   9 | Mechanical and electrical telemetry           | Met                                | Physics, co-sim and circuit signals                     |
|  10 | Correct units for derived measurements        | Met                                | Dimension-checked expressions                           |
|  11 | Condition comparison                          | Met                                | `compareConditions`, configuration diff, UI             |
|  12 | Descriptive statistics                        | Met                                | Verified against R                                      |
|  13 | Correct inference                             | Met (scope stated)                 | Welch, paired t, permutation, OLS vs R                  |
|  14 | Sensitivity analysis                          | Met (local/linear)                 | OAT, regression, interaction grid                       |
|  15 | Uncertainty propagation                       | Met (Monte Carlo)                  | `uncertaintySummary`                                    |
|  16 | Convergence experiments                       | Met                                | Template E; verdicts                                    |
|  17 | Calibration separate from validation          | Met                                | `not-independent` status; project never changed         |
|  18 | Dataset import and comparison                 | Met (package-tested; no real data) | CSV/JSON import, validation records                     |
|  19 | Reports from real records                     | Met                                | Report built only from stored records                   |
|  20 | Traceability to model and solver              | Met                                | Fingerprint, versions, applied solver settings          |
|  21 | Save, reload, export, inspect                 | Met                                | Browser test A/B; export round trip                     |
|  22 | Arm experiment end to end                     | Met                                | Browser test A                                          |
|  23 | Electronics experiment end to end             | Met                                | Browser test B                                          |
|  24 | Existing functionality intact                 | Met                                | Full unit and browser suites pass                       |
|  25 | Automated and browser tests pass              | Met                                | Final checks below                                      |
|  26 | Resource usage documented                     | Met                                | PERFORMANCE_BASELINE.md, archive records                |
|  27 | No unsupported conclusions as facts           | Met                                | Restrained assessment, validation status, limitations   |

## Final checks

| Command                          |                      Exit |
| -------------------------------- | ------------------------: |
| `pnpm install --frozen-lockfile` |                         0 |
| `pnpm lint`                      |                         0 |
| `pnpm typecheck`                 |                         0 |
| `pnpm format:check`              |                         0 |
| `pnpm test`                      | 0 (403 passed, 5 skipped) |
| `pnpm build`                     |                         0 |
| `pnpm test:e2e`                  |             0 (67 passed) |
