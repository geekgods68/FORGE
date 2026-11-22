# Simulation validity

Every simulation capability in FORGE carries exactly one status. It is stored in data (`SimulationCapability.status`, `MaterialDefinition.status`) and shown to users.

| Status           | Meaning                                                                                                                                                           | Minimum evidence                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Verified**     | Results agree with recorded reference data (physical measurement, analytical solution or an established solver) within stated tolerances, under stated conditions | Reference data, method, tolerance and conditions recorded with the model version |
| **Approximate**  | A recognised engineering model with known simplifications, suitable for estimates                                                                                 | Model or formula named, assumptions and omissions listed, valid range stated     |
| **Illustrative** | Conveys a concept or sequence; outputs are not quantitative predictions                                                                                           | Labelled as illustrative wherever its output appears                             |
| **Unsupported**  | No model exists for this domain on this component                                                                                                                 | —                                                                                |

## Rules

1. A plausible-looking 3D animation is **not** evidence of validity. Rendering quality never raises a status.
2. A result is only as valid as its _least_ valid input model; mixed results report the weakest status.
3. Statuses are tied to a model version. Changing the model resets the evidence requirement.
4. Game-physics output (e.g. Rapier rigid bodies) is at most **approximate**, and only for stated rigid-body questions. It does not predict structural safety, fatigue, payload limits or human safety.
5. Nothing in FORGE actuates real hardware. Any later read-only telemetry is labelled as measured data with its source.

## Phase 0 state

- Rapier is installed and initialises with a paused world containing one static collider. There is **no simulation**.
- The demo cube declares `rigid-body: unsupported`, and its material is `illustrative`.

## Phase 3 state

- **Component simulation:** all 401 component families declare every simulation domain as `unsupported` (model `none`), and catalogue validation enforces it. Recognisable geometry, datasheet-cited specs and "compatible interface" results are not simulation evidence.
- **Mass:**
  - `geometry-density` is volume × typical density for exact Tier A geometry;
  - `geometry-density-approximate` is the same for simplified profiles;
  - `specified` is a cited published value;
  - otherwise `unknown`. Densities are `approximate` handbook values.
- **Materials:** the 29 library materials carry `approximate` (typical handbook values) or `unsupported` (unspecified material). No value is certified.
- **Connections:** compatibility is metadata-only, so it doesn't establish a working joint or circuit (mating is Phase 4, circuits Phase 6).
- **Robotic-arm sample:** manually positioned. No actuation, wiring or joint constraint is simulated or claimed. _(Superseded in Phase 4: see below.)_

## Phase 4 state

| Capability                               | Status           | Basis / limits                                                                                             |
| ---------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Assembly kinematic positioning (mates)   | **verified**     | Ideal rigid joints; analytic FK agreement to 1e-12 m; residual tolerance 1e-7 m/rad. No forces or dynamics |
| DOF / redundancy reporting               | **verified**     | Rank of the constraint Jacobian; tested per mate type, loops and conflicts                                 |
| Sketch constraint solving                | **verified**     | Residual 1e-9; DOF from rank                                                                               |
| Part volume (prismatic kernel)           | **verified**     | Closed-form agreement for every feature type                                                               |
| Part / assembly mass, centre of mass     | **approximate**  | Exact volume × typical handbook density; unknown for envelope models and imported meshes                   |
| Interference: exact box solids           | **verified**     | Separating-axis test on oriented boxes                                                                     |
| Interference: curved / holed / envelope  | **approximate**  | Reported as "possible" (bounding-volume overlap)                                                           |
| Clearance                                | **approximate**  | Bounding-box gap: a conservative lower bound                                                               |
| Fastener compatibility                   | **approximate**  | Dimensional/designation checks only; **no** strength, preload, torque or fatigue                           |
| Exploded view                            | **illustrative** | Display only; the model is never changed                                                                   |
| Joint motion, servo behaviour, actuation | **unsupported**  | Kinematic poses only in Phase 4 — superseded in Phase 5 (below)                                            |
| Imported GLB models                      | **unsupported**  | Visual geometry only; no mass, material or interfaces inferred                                             |

The robotic-arm reference assembly is now constrained by four revolute joints with limits. It reports **kinematic** configurations only; it does not predict reach under load, servo torque or speed.

## Phase 5 state

Rigid-body dynamics with Rapier 0.19.2 (PHYSICS_ARCHITECTURE.md). Validation evidence: PHYSICS_VALIDATION.md.

| Capability                                                                              | Status                     | Basis / limits                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rigid-body dynamics (gravity, forces, torques, inertia)                                 | **approximate**            | Agrees with analytical references (free fall 1.3 mm/4.9 m, torque 1.4e-5, pendulum period 2.6e-6) for the tested conditions; single precision; game-physics solver (Rule 4)           |
| Joint constraints (revolute, prismatic; ball/cylindrical/planar without limits)         | **approximate**            | Measured drift ≤ 0.5 µm (pendulum), ~8 µm (arm); iterative solver; convergence monitored                                                                                              |
| Contact, friction, restitution                                                          | **approximate**            | Resting/sliding/collision references pass; per-collider primitive/convex contact, not surface mechanics; contact force uses an empirical N/(N+1) correction validated in statics only |
| Mass properties for simulation                                                          | **approximate**            | Closed-form inertia of modelled solids × handbook densities, cited or user masses; nothing inferred from appearance                                                                   |
| Generic servo actuator                                                                  | **approximate**            | Generic PID + torque–speed envelope; cited stall torque/speed used as limits (not validated); not a product model                                                                     |
| Overload / threshold warnings                                                           | **approximate**            | Threshold checks on simulated quantities (effort, limits, speed, contact force, ratings). **Not** material failure                                                                    |
| Robotic-arm payload capacity, accuracy, real servo dynamics                             | **unsupported**            | Requires calibration against the physical robot                                                                                                                                       |
| Fracture, plastic deformation, buckling, fatigue, fastener failure, stress distribution | **unsupported**            | Reserved for Phase 9 (structural FEA); never animated or claimed                                                                                                                      |
| Imported GLB physics                                                                    | **unsupported** by default | No collider or mass unless the user selects a bounding box and supplies a mass (then approximate)                                                                                     |

A run's overall status is the weakest of its inputs: every telemetry export is labelled `approximate` and carries its assumptions.

## Phase 6 state

Electronics, embedded runtime and electromechanical co-simulation (ELECTRICAL_ARCHITECTURE.md). Validation evidence: ELECTRICAL_VALIDATION.md (24 reference cases).

| Capability                                                                                                           | Status           | Basis / limits                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linear DC analysis (R, sources, controlled sources)                                                                  | **verified**     | Agreement with closed-form references to 1e-9 V / 1e-12 A (divider, ladder, controlled sources) and KCL residual 5e-17 A on a 1,740-resistor mesh, for ideal elements              |
| Linear transient (RC, RL, RLC, switched)                                                                             | **verified**     | Analytical responses within 0.25 mV / 5 µA at the tested steps; second-order convergence measured. For ideal elements and the stated step sizes only                               |
| Nonlinear DC (diode, LED, NPN, NMOS)                                                                                 | **approximate**  | Solver verified against closed forms for its models (Lambert W, square law, Ebers–Moll KCL); the device models themselves are generic and not fitted to real parts                 |
| Digital logic (gates, flip-flops, counters, PWM, contention)                                                         | **verified**     | Exact against Boolean definitions and scheduled timing (1 ns resolution) for the ideal logic model; no setup/hold, metastability or analog edge shapes                             |
| Analog↔digital boundary (thresholds, drivers, ADC)                                                                   | **approximate**  | Quasi-static (DC) at events; datasheet thresholds for the ATmega328P, assumed TTL thresholds for module inputs                                                                     |
| Arduino UNO runtime (Level 2)                                                                                        | **approximate**  | API behaviour modelled; C/AVR arithmetic exact for the subset; timing from an operation-cost model (not cycle-accurate); not firmware-compatible; no Level 3 emulation             |
| HC-SR04 model                                                                                                        | **approximate**  | Echo = 2d/c on ray geometry (exact for the model); generic module, no acoustics (reflection, multipath, surface angle); range/angle cited, no-echo width unverified                |
| Servo electronics → actuator                                                                                         | **approximate**  | Pulse decoding exact for the model; motion is the Phase 5 generic actuator (approximate); pulse–angle mapping assumed; motor current, back-EMF, losses and heating **unsupported** |
| Encoder, joint potentiometer, limit switch                                                                           | **approximate**  | Derived from simulated joint coordinates per physics step (time-quantised to the step)                                                                                             |
| Temperature sensor                                                                                                   | **illustrative** | Reads the configured ambient temperature; there is no thermal simulation                                                                                                           |
| Design-rule checks                                                                                                   | **approximate**  | Only the listed rules with known ratings; unknown ratings stay unknown; **no** electrical safety certification                                                                     |
| Supply current, voltage drop, battery capacity, power dissipation in devices                                         | **unsupported**  | Sources are ideal unless given a series resistance; servo/motor currents unknown                                                                                                   |
| IMU, camera, LiDAR, force sensors; ESP32/Pico/STM32; SPI/I²C/UART peripherals beyond Serial; PCB, SPICE/KiCad import | **unsupported**  | Not implemented; nothing is faked                                                                                                                                                  |

A co-simulation result is only as valid as its weakest input: electrical telemetry exports carry their assumptions, and any run that moves a joint inherits the Phase 5 **approximate** status.

## Phase 7 state

Experiments add no new physical model: every result inherits the validity of the Phase 5/6 model it ran (above). Phase 7 adds evidence **about** models, kept in separate categories (VALIDATION_FRAMEWORK.md):

| Capability                                                                            | Status                    | Basis / limits                                                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Reproducible runs (seeds, configuration hashes, model fingerprints, integrity hashes) | **verified**              | Same build and environment: identical outcomes and data hashes on replay (tests). Cross-platform bitwise identity not claimed |
| Measurement reductions and derived quantities                                         | **verified**              | Against hand-computed signals in tests; dimension checking of expressions; missing ≠ zero                                     |
| Descriptive and inferential statistics                                                | **verified**              | Against R reference outputs (Welch, paired t, OLS, quantiles)                                                                 |
| Sensitivity (OAT, regression), Monte Carlo uncertainty                                | **approximate**           | Describe the model under assumed input ranges/distributions; local, linear or sampling limits stated with each result         |
| Numerical convergence studies                                                         | **verified (method)**     | Arm timestep refinement converging (4.2e-3 → 5.1e-5 rad RMS); RC τ within 1.3e-5 of RC                                        |
| Calibration                                                                           | **approximate**           | Local bounded least squares; identifiability warnings; never written back to the model                                        |
| Empirical validation of any shipped model                                             | **unsupported (no data)** | No measured laboratory datasets ship with FORGE; every demonstration experiment reports "Not empirically validated"           |
