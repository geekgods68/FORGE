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
