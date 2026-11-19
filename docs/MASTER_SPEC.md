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

The planned facility layout is in FACILITY_LAYOUT.md (5 wings, 22 labs, 6 environments). The component library is in COMPONENT_CATALOG.md (28 categories).

## Interfaces and their distinctions

| Concern                | Meaning                                                                                        | Status                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Desktop application    | Primary interface: React + React Three Fiber in a browser, served locally                      | Phase 0 demo scene only                             |
| VR (Meta Quest 2)      | The same domain model through WebXR. VR is a rendering and input layer, not a separate product | Future                                              |
| Engineering simulation | Models with an explicit validity status (SIMULATION_VALIDITY.md). Rendering ≠ simulation       | Future; physics engine installed, no simulation yet |
| Vey integration        | Typed, validated, permissioned commands (VEY_INTEGRATION.md). No LLM inside FORGE              | Contracts proposed only                             |

## Principles

- **Local-first:** no cloud backend, accounts or telemetry.
- **Explicit units.** Imported geometry is never trusted to have correct dimensions until it is validated.
- **Definitions are separate from instances.**
- **Domain logic is independent of the UI and the renderer.**
- **No simulation claims more validity than its evidence supports.**
