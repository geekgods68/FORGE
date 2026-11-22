# Experiment design (Phase 7)

## Experiment

An experiment has a title, research question, mode (`hypothesis` or `exploratory`), optional hypothesis, variables, measurements, protocol, design, success criteria, limitations and a notebook. It is versioned (`revision` increments on every protocol change; every run records the revision it used).

### Hypothesis

`statement`, `relationship` (increase, decrease, difference, no-difference, exploratory), `independentVariable`, `outcome`, optional reference/comparison conditions and criterion. The report assesses it conservatively (see RESEARCH_REPORTING.md); a hypothesis is never "proven".

### Variables

Types: continuous, integer, angle, boolean, categorical, material, variant, controller, firmware-constant, initial-condition. Roles: independent, dependent, controlled, nuisance, random, derived.

Each variable binds to a **parameter target discovered from the project** (`listTargets`), e.g.

| Target                                                                                      | Meaning                                             |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `physics.payload.<id>.massKg`                                                               | payload mass                                        |
| `physics.joint.<mate>.damping / friction / target / effortLimit / speedLimit / bandwidthHz` | joint and actuator                                  |
| `physics.gravity.y`, `physics.solver.timestepS / substeps / solverIterations`               | world and solver                                    |
| `physics.body.<node>.friction`, `component.<node>.materialId / variantId`                   | bodies and components                               |
| `electrical.part.<id>.<field>`, `electrical.part.<id>.firmwareId`                           | circuit parts, firmware choice                      |
| `firmware.<fw>.const.<NAME>`                                                                | declared firmware constants                         |
| `electrical.cosim.ambientC`, `electrical.transient.stepS`                                   | co-simulation / transient settings                  |
| `runtime.position.<node>.z`                                                                 | runtime initial position (not written to the model) |

A target that the model does not use is not offered. Values are converted from the variable's unit to the target's unit (`units.ts`); incompatible units are rejected.

Uncertainty distributions: fixed, uniform, normal, bounded normal, empirical.

### Measurements

Signal or derived source, a reduction, an analysis window and parameters — see SCIENTIFIC_MEASUREMENTS.md.

### Protocol

Model kind (`physics`, `cosim`, `circuit`), project id/name and **model fingerprint** (hash of the model-relevant parts of the project), duration, warm-up, sampling rate (≤ 1 MHz), stop conditions, recorded signals, analysis plan, randomisation plan.

## Designs

| Design        | Conditions                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `single`      | the defaults                                                                                                               |
| `replicates`  | the defaults × N replicates                                                                                                |
| `oat`         | baseline + each independent variable's levels, one at a time                                                               |
| `grid`        | full factorial of the independent variables' levels                                                                        |
| `random`      | `samples` independent uniform draws over each bounded numeric variable's `[min, max]` (otherwise a random level)           |
| `lhs`         | Latin hypercube over each bounded numeric variable's `[min, max]` (other variables stay at their defaults, with a warning) |
| `paired`      | each level of the independent variable × replicates, with the **same seed per replicate across conditions**                |
| `monte-carlo` | `samples` draws from the variables' declared **distributions** (requires at least one non-fixed distribution)              |

## Budgets (pre-enumeration)

The run count is computed before any condition is enumerated, so an oversized grid is refused without allocating it. Defaults (`DEFAULT_BUDGET`): 200 runs, 200,000 steps per run, 50,000 samples per run, 120 s wall per run, 64 MB stored raw data, 1 concurrent run, and an 8 GiB free-disk floor where the platform reports free space. Plans report estimated steps and bytes; warnings flag replicated deterministic conditions (identical replicates do not estimate real-world spread).

## Templates (demonstrations)

| Id                   | Project                    | Study                                                                       |
| -------------------- | -------------------------- | --------------------------------------------------------------------------- |
| `exp-a-payload`      | robotic-arm sample         | payload mass → shoulder error, effort, settling (OAT)                       |
| `exp-b-sensor-noise` | ultrasonic threshold study | ultrasonic noise → distance error, servo switching (replicated, stochastic) |
| `exp-c-controllers`  | ultrasonic threshold study | responsive vs conservative threshold firmware (paired seeds)                |
| `exp-d-rc`           | RC charging study          | R × C grid → time to 63.2 % vs analytical τ = RC                            |
| `exp-e-convergence`  | robotic-arm sample         | physics timestep refinement                                                 |

Templates are offered only when the open project has the parameters they vary.
