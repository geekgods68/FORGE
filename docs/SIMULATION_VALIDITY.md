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
