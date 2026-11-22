# Development roadmap

Each phase ends at an owner review. A later phase starts only with explicit approval.

| Phase | Scope                                                                                                                                                                                                    | Status                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0     | Foundation reset and initialisation: monorepo, stack, conventions, data model, local persistence, docs, tests                                                                                            | **Complete** (merged to `main`, `c8dc95e`)                                                                             |
| 1     | Engineering core: scene graph, validated commands, undo/redo, selection and manipulation, precision transforms and snapping, primitives, `.forge.json` import/export with v1 migration, programmatic API | **Complete** (merged to `main`, `ab74488`)                                                                             |
| 2     | Complete laboratory environment: 5 wings, 22 labs, visual direction                                                                                                                                      | **Complete:** accepted and merged to `main` (`fffe281`)                                                                |
| **3** | Component conjuring library: catalogue UI, 28 categories, GLB import with dimensional validation                                                                                                         | **Complete** (fast-forwarded into `main`, `7af7260`, at the start of Phase 4)                                          |
| **4** | Mechanical assembly and CAD: interfaces, mates, assemblies                                                                                                                                               | **Complete** (Phase 4 + 4.1 fast-forwarded into `main`, `1000918`, at the start of Phase 5; PHASE_4_REPORT.md)         |
| **5** | Physical simulation and robotics: Rapier rigid bodies, joints, actuators, telemetry, overload warnings                                                                                                   | **Complete** (fast-forwarded into `main`, `67604b0`, at the start of Phase 6; PHASE_5_REPORT.md)                       |
| **6** | Electronics, circuit simulation and embedded systems: netlists, MNA solver, digital logic, Level 2 UNO runtime, sensors, servo electronics, co-simulation                                                | **Complete** (fast-forwarded into `main`, `878142b`, at the start of Phase 7; PHASE_6_REPORT.md)                       |
| **7** | Research experimentation: experiments, results, provenance                                                                                                                                               | **Implemented on `phase-7/scientific-experiments`, pending owner acceptance** (PHASE_7_REPORT.md). Phase 8 not started |
| 8     | Specialised research facilities: the 6 configurable environments                                                                                                                                         | Not started                                                                                                            |
| 9     | Vey integration: permission layer, audit log, exposing the engine API                                                                                                                                    | Not started                                                                                                            |
| 10    | Optimisation and release, including WebXR/Quest 2 hardening                                                                                                                                              | Not started                                                                                                            |

## Carried forward from Phase 1

These are deferred, not forgotten:

- Multi-selection: the API accepts arrays; the UI selects one node.
- Drag-and-drop reparenting: an explicit parent picker exists today.
- Editing primitive dimensions after creation: needs a `scene.node.geometry` command.
- A desktop filesystem adapter (overwrite-in-place save).

## Later phases as numbered in the Phase 5 brief

The Phase 5 brief describes the following later phases; the table rows above 5 reflect the earlier plan and are kept until the owner confirms the renumbering:

| Phase | Scope (Phase 5 brief)                                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **6** | Electronics, circuit simulation and embedded systems: netlists, MNA solver, digital logic, Level 2 UNO runtime, sensors, servo electronics, co-simulation | **Complete** (fast-forwarded into `main`, `878142b`, at the start of Phase 7; PHASE_6_REPORT.md)  |
| 7     | Scientific experimentation (experiments, comparisons, provenance)                                                                                         | **Implemented on `phase-7/scientific-experiments`, pending owner acceptance** (PHASE_7_REPORT.md) |
| 8     | CAD interoperability (STEP etc., validated units, collision meshes, materials)                                                                            |
| 9     | Advanced multiphysics (structural FEA, thermal, fluids, coupling; material failure)                                                                       |
| 10    | Multiplayer (authoritative shared sessions)                                                                                                               |
| 11    | Vey integration (permissioned AI-controlled simulations)                                                                                                  |
