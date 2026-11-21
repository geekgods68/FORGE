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
- **Robotic-arm sample:** manually positioned. No actuation, wiring or joint constraint is simulated or claimed.
