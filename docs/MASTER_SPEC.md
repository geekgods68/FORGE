# FORGE: master specification

## What FORGE is

FORGE is an interactive 3D engineering research laboratory inside Project VEYRIS. Its infrastructure and workflows are inspired by university research facilities (Stanford, MIT, NTU).

Users will:

- Select components from a scrollable catalogue and **conjure** them into a virtual workshop.
- Then position, rotate, configure, connect, assemble, simulate and save them.

The visual direction is an advanced holographic engineering interface. It must be original; no copyrighted film assets will be used.

## Intended users

- The owner, as an engineering researcher and student, first.
- Later, Vey, the central intelligence of VEYRIS, operating supported functions through a structured, permissioned API.

## Long-term capability areas

| Discipline                   | Planned capabilities                      |
| ---------------------------- | ----------------------------------------- |
| Mechanical                   | Design, CAD-style assembly, manufacturing |
| Electrical                   | Electronics, embedded systems             |
| Robotics and mechatronics    | Robots, autonomous systems                |
| AI                           | Computer vision                           |
| Materials                    | Testing                                   |
| Physics and multiphysics     | Simulation                                |
| Aerospace, fluids and optics | Domain-specific test environments         |
| Research practice            | Reproducible experimentation              |

The facility layout is in FACILITY_LAYOUT.md (5 wings, 22 labs, 6 environments; built in Phase 2). The component library is in COMPONENT_CATALOG.md (28 categories, 401 families; Phase 3), with schema, geometry, conjuring and connection details in COMPONENT_SCHEMA.md, PARAMETRIC_GEOMETRY.md, CONJURING_WORKFLOW.md and COMPONENT_CONNECTIONS.md. Mechanical assembly, constraints, CAD, measurement and imported models are in MECHANICAL_ASSEMBLY.md, CONSTRAINT_SOLVER.md, PARAMETRIC_CAD.md, GEOMETRY_OPERATIONS.md and ASSET_IMPORT.md (Phase 4). Physics simulation, robotics dynamics and their validation are in PHYSICS_ARCHITECTURE.md, CAD_PHYSICS_BRIDGE.md, ROBOTICS_DYNAMICS.md, ACTUATOR_MODELS.md, PHYSICS_VALIDATION.md and SIMULATION_TELEMETRY.md (Phase 5). Electronics, circuit simulation, the embedded runtime, sensors and electromechanical co-simulation are in ELECTRICAL_ARCHITECTURE.md, CIRCUIT_SOLVER.md, DIGITAL_SIMULATION.md, EMBEDDED_RUNTIME.md, SENSOR_MODELS.md, ELECTROMECHANICAL_COSIMULATION.md and ELECTRICAL_VALIDATION.md (Phase 6).

## Interfaces and their distinctions

| Concern                | Meaning                                                                                        | Status                                                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop application    | Primary interface: React + React Three Fiber in a browser, served locally                      | Engineering editor (Phase 1), research facility (Phase 2), component library and conjuring (Phase 3), mechanical assemblies, constraint solver and prismatic CAD (Phase 4), physics simulation (Phase 5), electronics and embedded systems (Phase 6)                           |
| VR (Meta Quest 2)      | The same domain model through WebXR. VR is a rendering and input layer, not a separate product | Future                                                                                                                                                                                                                                                                         |
| Engineering simulation | Models with an explicit validity status (SIMULATION_VALIDITY.md). Rendering ≠ simulation       | Phase 5: rigid-body dynamics, joints, generic actuators, telemetry and threshold warnings. Phase 6: circuit solver (DC/transient), digital logic, Level 2 Arduino UNO runtime, sensor/servo models and electromechanical co-simulation (approximate; ELECTRICAL_VALIDATION.md) |
| Vey integration        | Typed, validated, permissioned commands (VEY_INTEGRATION.md). No LLM inside FORGE              | The engine command/query API that Vey will use exists (Phase 1); the Vey permission layer and exposure are Phase 9                                                                                                                                                             |

## Principles

- **Local-first:** no cloud backend, accounts or telemetry.
- **Explicit units.** Imported geometry is never trusted to have correct dimensions until it is validated.
- **Definitions are separate from instances.**
- **Domain logic is independent of the UI and the renderer.**
- **The engineering scene graph is the single source of truth.** The 3D view renders it, and every change is a validated, undoable command.
- **No simulation claims more validity than its evidence supports.**
