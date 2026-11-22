# Physics architecture (Phase 5)

## Four separate kinds of state

| Kind                      | Where it lives                                                  | Persisted                      | Undoable                             |
| ------------------------- | --------------------------------------------------------------- | ------------------------------ | ------------------------------------ |
| **Engineering state**     | `ForgeEngine` scene graph (CAD, assemblies, mates, properties)  | project file                   | yes                                  |
| **Simulation definition** | root node `simulation` field (`SimulationDefinitionSchema`, v1) | project file (schema v5)       | yes (`physics.*` commands)           |
| **Simulation runtime**    | `PhysicsSession` (an isolated Rapier world)                     | never                          | no (it is not an engineering change) |
| **Simulation results**    | `TelemetryRecorder` (bounded) and its event list                | separate CSV/JSON exports only | no                                   |

A run **never writes to the engineering model**. The bridge reads the scene once; the desktop shows simulated poses by moving the rendered objects (display only) and restores the CAD poses when leaving Simulation mode. Tests check that a run, forces, motor commands and reset leave the project byte-identical and the undo history empty.

## Packages

```text
@forge/engineering-core   SimulationDefinitionSchema (Zod), physics.* setup commands (undoable)
        │
@forge/mechanics          mates, frames, solver (home pose), body geometry, mass data
        │
@forge/physics (new)      bridge.ts      CAD → PhysicsModel (pure data; no Rapier)
   (no React/three)       mass.ts        closed-form solid inertia, composition, principal axes
                          actuator.ts    generic servo model (pure function)
                          session.ts     PhysicsSession: Rapier world, fixed step, monitors
                          telemetry.ts   bounded recorder, CSV/JSON export
                          validation.ts  numerical reference cases
                          samples.ts     arm simulation setup, setup suggestion, SceneBuilder
        │
apps/desktop              features/simulation (controller, panel, plot), scenes/SimulationLayer
```

The domain packages import no React, three or DOM APIs (enforced by ESLint). Rapier (`@dimforge/rapier3d-compat` **0.19.2**, WASM embedded, no network) is loaded lazily by `loadRapier()` the first time Simulation mode is entered.

## Operations

The brief's operations map onto the code as follows. Setup changes are engine commands; runtime operations are session methods (no history entries).

| Brief                       | Implementation                                                                                        | Kind                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------- |
| `physics.createSimulation`  | `physics.simulation.create` (and `physics.simulation.delete`)                                         | engine command, undoable  |
| `physics.configure`         | `physics.configure`, `physics.body.set`, `physics.joint.set`, `physics.payload.set/delete`            | engine commands, undoable |
| `physics.initialize`        | `new PhysicsSession(R, buildPhysicsModel(scene, def))` / `PhysicsSession.fromScene`; `reinitialize()` | runtime                   |
| `physics.step`              | `session.step(n)` (bounded to 100,000), `session.runFor(seconds)`                                     | runtime                   |
| `physics.run` / `pause`     | `session.run()`, `session.pause()`; display loop `session.advance(realDt)`                            | runtime                   |
| `physics.reset`             | `session.reset()` (fresh world from the model: t = 0, new telemetry)                                  | runtime                   |
| `physics.applyForce/Torque` | `session.applyForce(nodeId, N, {pointM, durationS})`, `applyTorque(...)` (validated)                  | runtime                   |
| `physics.setMotorTarget`    | `session.setMotorTarget(MotorCommand)` — any source (UI, test, future electronics/Vey)                | runtime                   |
| `physics.getState`          | `session.getState()`, `jointStates()`, `bodyState(id)`, `bodyPose(id)`                                | query                     |
| `physics.getTelemetry`      | `session.getTelemetry()` → `series()`, `toCSV(meta)`, `toJSON(meta)`                                  | query                     |

## Time integration

- **Fixed step** (default 1/120 s) independent of the display: `advance(realDt)` accumulates real time × speed and runs whole steps only.
- **Sub-steps** (default 4): the Rapier world steps at Δt/4; actuators and passive joint efforts are recomputed every sub-step (480 Hz control by default, configurable down to a zero-order hold).
- **Solver iterations** (default 8). The 1/120 s × 4 × 8 default was chosen by measurement, not assumed: with 4 iterations the arm's light intermediate link did not converge (its reported velocity disagreed with its motion by > 10 rad/s), and with 1 sub-step the explicit 120 Hz servo control was unstable (PHYSICS_VALIDATION.md).
- **Length unit** 1 cm (Rapier `lengthUnit`): the allowed contact penetration scales with it (0.08 mm resting penetration instead of 1 mm with the 1 m default).
- **Catch-up control:** at most `maxCatchUpSteps` (16) steps AND a 12 ms wall-clock budget per displayed frame (at least one step). Excess time is dropped and counted (`stats.lagFrames`): a heavy scene runs slower than real time instead of freezing the display. Every step is the same fixed step, so results do not depend on the frame rate or on lag.
- **Speed** 0.1×–2× scales simulated time per real second only.
- **Sleeping** is off by default (`allowSleeping`): a sleeping pendulum froze at its turning point in testing.

## Safeguards

| Safeguard                 | Behaviour                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Invalid setup             | Zod schema on every setup command and on load; an invalid change is refused and nothing changes                                  |
| Invalid mass / inertia    | Unknown mass on a dynamic body is a bridge error (run refused); principal moments clamped ≥ 1e-12 kg·m²                          |
| NaN / Infinity / extremes | After every step: non-finite state, \|v\| > 1e3 m/s, \|ω\| > 1e5 rad/s or \|x\| > 1e4 m → session **faulted**, stopped, reported |
| Engine exceptions         | Any exception inside a step faults the session with its message; reset rebuilds a fresh world                                    |
| User loads                | Force ≤ 1e6 N, torque ≤ 1e5 N·m, finite, duration in (0, 3600] s, dynamic bodies only                                            |
| Solver convergence        | Each joint's measured rate is compared with its finite-difference motion; persistent disagreement → warning                      |
| Step budget               | `step(n)` ≤ 100,000; `runFor` step budget; frame budget above                                                                    |
| Isolation                 | The session never calls the engine; leaving Simulation mode discards it                                                          |

## Persistence

Project schema **v5** adds the optional `simulation` field on the root node (`schemaVersion: 1` inside). v1–v4 files load unchanged (no setup). The version bump makes a v4 build refuse a v5 file instead of silently dropping its setup. Transient frames are never stored in the project; recordings are separate exports (SIMULATION_TELEMETRY.md). Setup entries refer to nodes and mates by id; a dangling reference (e.g. a deleted body) is reported by the bridge and ignored, never fatal.

## Prepared for later phases (not implemented)

- **Electronics:** `MotorCommand` is independent of its source (`source: 'desktop-ui' | 'test' | 'api' | 'electronics' | 'vey'`); a future circuit simulation submits the same structure.
- **Experiments:** each run has a run id, engine version, solver settings, project id/revision, assumptions and status in its metadata; the definition is a reproducible input.
- **CAD interoperability:** imported meshes get no collider unless the user selects the bounding box; mass must be supplied — the hooks for validated collision meshes and units are the bridge's per-leaf geometry and mass sources.
- **Multiphysics:** the bridge's `PhysicsModel` (bodies, mass properties, joints, contacts via the session) is the boundary a structural/thermal solver would consume; nothing is solved now.
- **Multiplayer:** the definition is plain validated data and the runtime is deterministic for identical inputs (tested), which an authoritative shared session can build on.
- **Vey:** setup commands are ordinary engine commands, so the engine's command policy (Vey denied) applies; runtime operations are typed but not exposed to any client.
