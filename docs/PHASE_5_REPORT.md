# Phase 5 report: physics simulation, robotics dynamics and mechanical-failure foundations

**Status: COMPLETE against the brief's completion criteria (§21), with the resource blocker and limitations below.** Implemented on `phase-5/physics-robotics`; not merged into `main`, not pushed. Phase 6 not started.

## 1. Initialisation

- Phase 4.1 (`1000918`) was committed with a clean tree; `main` (`7af7260`) was its ancestor and was **fast-forwarded** to `1000918` as the brief instructed. `phase-5/physics-robotics` was created from it. No remote exists; nothing was pushed.
- Baseline unit/integration suite: passing (257 tests at Phase 4.1; 51 browser tests passing at its commit).
- Rapier: `@dimforge/rapier3d-compat` 0.19.2 was already in the lockfile (via `@react-three/rapier` 2.2.0) and is used directly by the new package — **no download** (`pnpm install --offline`).
- The project folder was renamed during the session (from `VEYRIS_DEVELOPMENT` to `FORGE`, outside this session); the repository and work were unaffected.

## 2. Infrastructure gate (storage) — blocker recorded

- Free disk: **7.7 GB** at the start, **7.8 GB** at the end (target 15 GB; minimum 8 GB for resource-intensive work). Swap in use: 5.4 GB of 6 GB at the start.
- The repository is ~0.5 GB, so no cleanup inside it can reach the target; freeing space requires the owner's action outside the repository (not authorised, not done).
- Consequence: only **short** benchmarks were run (seconds each; no prolonged suites), nothing was downloaded, and no assets were generated. The benchmark data are single runs.

## 3. Physics architecture

Separate engineering state (engine), simulation definition (Zod-validated, on the root node, undoable `physics.*` commands, project schema v5), runtime (`PhysicsSession`, never persisted or in history) and results (bounded telemetry, separate exports). Details: PHYSICS_ARCHITECTURE.md. New package `@forge/physics` (no React/three). Desktop: a CAD/Simulation mode switch, Simulation panel, display-only pose driver.

## 4. Supported body types

Dynamic, fixed, kinematic (prescribed velocity), excluded; welded rigid bodies from fixed mates; loose bodies as obstacles; a static work surface. Mass from geometry × handbook density, published (cited) masses, user values or a selected material — unknown masses are **errors** (CAD_PHYSICS_BRIDGE.md). Colliders: box, cylinder, sphere, convex hull, bounding box (approximations listed); imported meshes get no collider by default. CCD per body; sleeping opt-in.

## 5. Supported joint types

Revolute and prismatic (with limits, actuators, damping, friction); ball, cylindrical, planar (no limits — refused unless the user approves dropping them); fixed (welded). Driving constraints refused unless approved as ignored. Joint coordinates, rates and constraint drift are measured from the bodies; the sign convention matches Phase 4 (gripper within 1e-7 m of the kinematic solver).

## 6. Actuator models

One generic servo: PID position control with a speed-limited setpoint, velocity and effort modes, a linear torque–speed envelope, hard effort saturation, anti-windup, control rate, enable/disable, emergency stop, passive damping and smoothed Coulomb friction. Limits generic, user or datasheet-cited (MG996R 0.922 N·m / 6.16 rad/s; SG90 0.177 N·m / 10.47 rad/s). Not a reproduction of any product (ACTUATOR_MODELS.md). Motor commands are source-independent (prepared for Phase 6).

## 7. Contact and friction

Rapier contact with per-body friction/restitution (averaged), collision filtering (welds, jointed neighbours, optional self-collision with initial-overlap exclusion), contact-event reporting, contact points and collision shapes visualisable. Validated: resting block (0.28 mm penetration, normal force = m·g after a documented N/(N+1) correction of Rapier's reported impulse), sliding friction (stopping distance within 0.02 %), collisions (momentum within 1e-6). Contact is per-collider primitive/convex contact, not surface mechanics.

## 8. Numerical validation (PHYSICS_VALIDATION.md; all 9 cases pass, run in every `pnpm test`)

Free fall 1.3 mm over 4.9 m; torque/inertia 1.4e-5; pendulum period 2.6e-6; revolute drift ≤ 0.5 µm and energy −0.13 % in 5 s; collision momentum ≤ 1.1e-6; resting and sliding contact; arm vs Phase 4 solver ≤ 1e-7 m; arm speed limit, joint limit and effort saturation. Five measured findings changed the defaults: 8 solver iterations (4 did not converge on the arm), 4 sub-steps, sleeping off, 1 cm length unit, and the contact-force correction.

## 9. Robotic-arm simulation results (ROBOTICS_DYNAMICS.md)

The arm holds its CAD pose under gravity (drift ~8 µm), moves time-dependently within its speed limit, needs more effort with a payload, saturates and stalls with a 1 kg payload at 60° (warning raised), respects joint limits, falls under gravity on emergency stop, resets exactly, and never changes the CAD model. No payload capacity of the physical robot is claimed.

## 10. Telemetry

Bounded ring buffer (arm: 86 channels, 4.1 MB), each channel marked measured / commanded / applied / configured; events; canvas plot; CSV and JSON export with run id, engine version, solver settings, project revision, assumptions and status (SIMULATION_TELEMETRY.md).

## 11. Failure and overload modelling

Threshold warnings only: actuator effort saturation, rated-effort exceedance, joint at limit / limit violation, excessive angular velocity, contact force above a threshold, user-defined contact load rating, solver non-convergence, numerical faults. Labelled "not a failure prediction". **No** fracture, deformation, buckling, fatigue or fastener failure is modelled or animated; breakable joints were **not** implemented (Rapier 0.19's JS API exposes no joint reaction forces, so a threshold on them cannot be measured honestly). Structural failure is Phase 9.

## 12. Simulation performance (PERFORMANCE_BASELINE.md)

Physics step (Node): 0.15 ms (arm), 0.79 ms (100 boxes), 3.8 ms (500), 9.0 ms (1,000 boxes, 4,781 contact pairs; 0.92× real time). Browser: arm and 100 boxes at 60 fps in real time (software and GPU); 1,000 boxes at 60 fps on the GPU / 30 fps in software with the simulation lagging real time (0.74× / 0.52×) and no long tasks after adding a per-frame physics budget. 200 run/reset cycles: no JS heap or ArrayBuffer growth.

## 13. Tests

All commands exited **0** (final run on `phase-5/physics-robotics`):

| Command                                    | Result                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --offline` | 0                                                                                                         |
| `pnpm lint`                                | 0                                                                                                         |
| `pnpm typecheck`                           | 0                                                                                                         |
| `pnpm format:check`                        | 0                                                                                                         |
| `pnpm test`                                | 0 — **300 passed**, 2 skipped (opt-in benchmark and validation-record writers), 34 files (Phase 4.1: 257) |
| `pnpm build`                               | 0                                                                                                         |
| `pnpm test:e2e`                            | 0 — **56 passed** in 3.4 min (Phase 4.1: 51)                                                              |

New tests: mass properties, CAD bridge, session runtime, numerical validation (9 cases), engine setup commands, browser workflow (2: the brief's 15-step arm workflow plus effort saturation; an open-ended steel-block drop), browser physics benchmarks (3). Updated: the existing assertions of the current project schema version (4 → 5, in 9 test files' assertions; the "newer than supported" check now uses 6). Two bugs found by tests were fixed: telemetry sampling broke after a live setup change (regression test added), and exceptions inside a step could escape the display loop (now a safe fault, tested).

## 14. Known limitations

- Storage below the brief's thresholds (§2); benchmarks are single short runs.
- Rapier is single-precision and iterative: constraints drift slightly (measured), and the contact-force correction is validated for static contact only.
- Effective inertia for automatic gains is estimated at the initial pose; gains do not adapt to configuration.
- No joint reaction forces (not exposed by Rapier 0.19 JS) → no joint-load warnings or breakable joints.
- Ball, cylindrical and planar joints cannot enforce limits; driving constraints have no dynamic equivalent.
- Tubes collide as solid cylinders and holed/concave profiles as convex hulls; imported meshes need an explicit bounding box.
- Physics runs on the main thread (a 12 ms budget per frame keeps the UI responsive; heavy scenes run slower than real time).
- Simulation is browser-tested in the project view; the facility view renders the same project but is not separately tested in Simulation mode.
- The UI edits body settings, world settings, actuator commands and payloads; joint damping/friction, actuator limits/gains and thresholds are editable through commands but have no form yet.
- Roadmap numbering: the Phase 5 brief's later phases (6 electronics … 11 Vey) differ from the earlier roadmap table; both are recorded in DEVELOPMENT_ROADMAP.md for the owner to confirm.

## 15. Readiness for Phase 6

Ready on the physics side: actuator commands are source-independent (`MotorCommand.source: 'electronics'` reserved), effort and speed limits are explicit, telemetry records commanded vs applied effort. Not started: no electrical model, circuit simulation or firmware.
