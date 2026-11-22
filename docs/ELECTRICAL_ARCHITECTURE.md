# Electrical architecture (Phase 6)

FORGE's electronics subsystem connects circuits, firmware and sensors to the Phase 5 physical simulation. It follows the same separation as physics:

| Layer                    | Where                                                                                    | Persisted?                   |
| ------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------- |
| Facility / workspace     | `@forge/facility`, `WorkspaceEngine` (unchanged)                                         | Workspace layout only        |
| Engineering project data | `ElectricalDefinition` on the root node (project schema **v6**), `electrical.*` commands | Yes, validated, undoable     |
| Runtime simulation state | `@forge/electronics` (`CoSimulation`, `SignalNetwork`, `UnoRuntime`, device models)      | Never (exports are separate) |

A transient simulation can never overwrite a component definition, a pin mapping or CAD geometry: runtime objects only read the definition; the only runtime writes go to the physics session (motor commands, moving a fixed test target), which itself never writes the CAD model.

## Packages

| Package                    | Phase 6 content                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@forge/engineering-core`  | `electrical/schemas.ts` (definition, device models, wires, labels, groups, buses, firmware, settings), `electrical/devices.ts` (device pin tables), `electrical.*` command schemas and handlers, schema v6        |
| `@forge/components`        | `electrical-pins.ts`: electrical models for 21 catalogue families — default device parameters and first-class pin metadata (limits with sources, connectors, 3D positions); electrical compatibility              |
| `@forge/electronics` (new) | netlist compiler, design-rule checks, sparse MNA solver, digital engine, Arduino-subset interpreter + UNO runtime, sensor/actuator models, co-simulation coordinator, telemetry, interchange, samples, validation |
| `@forge/physics`           | Two additive runtime methods: `castRay` (exact, per collider) and `setBodyTranslation` (fixed/kinematic bodies)                                                                                                   |
| `apps/desktop`             | Electronics mode (parts, schematic, 3D wiring, checks, analysis, code editor); Simulation-mode runtime panel and instruments                                                                                      |

Domain packages import no UI code (ESLint-enforced).

## Persistent data model

`ElectricalDefinition` (`schemaVersion: 1`):

- **parts** — `id`, reference designator `label` (unique), `name`, `device` (one of 25 device models, below), `definitionId` (catalogue family or `null` for an ideal analysis element), `nodeId` (the placed 3D component, or `null` for schematic-only), schematic placement (grid units, rotation).
- **wires** — two pin references and an optional schematic route (intermediate points) and colour.
- **netLabels** — a named signal on a pin; all pins carrying the same name are one net.
- **groups** (hierarchical, organisation only), **buses** (named net sets for display).
- **firmware** — source text (≤ 64 KB), language `arduino-subset`, `revision` (incremented by every save).
- **settings** — Newton tolerances, junction gmin, transient method/step/stop, co-simulation op cost, ambient temperature, noise seed, recording limits.

Every `electrical.*` command validates the complete resulting definition (unknown pins, duplicate designators, invalid values, servo pulse ranges …); an invalid change is rejected and nothing changes. A device change that would orphan wired pins is refused. Removing a part removes its wires and labels in the same undoable step. Commands are batchable with node commands, so “place a component in 3D and add it to the circuit” is one atomic undo step. Older files (v1–v5) migrate unchanged; a v5 build refuses a v6 file.

### Device models

Ideal analysis elements: resistor, capacitor (optionally polarised), inductor, voltage source (DC/step/pulse/sine/PWL, series resistance, rated current for checks), current source, ground, junction, ideal switch, VCVS, VCCS. Semiconductors: diode, LED (Shockley), NPN (Ebers–Moll transport), N-MOSFET (square law). Modules: potentiometer (manual or joint-linked), Arduino UNO R3 (`mcu`), HC-SR04, servo, limit switch (manual or joint threshold), quadrature encoder (joint-linked), linear temperature sensor. Logic primitives: gates, D flip-flop, counter, clock/PWM source.

### Pins

`devicePins(device)` gives every pin: id, name, **model terminal** (pins sharing a terminal are one internal net — the UNO's three GND pins), role (ground, supply, analog input/output, digital input/output, GPIO, PWM, serial, motor output, sensor signal, passive), direction and domain. For catalogue parts, `electricalModelFor(definitionId)` adds voltage/current limits **with their source and data status** (e.g. “Arduino UNO R3 documentation: DC current per I/O pin 20 mA”), the connector interface and its mechanical mating descriptors, and the local 3D position from the generated geometry. Unknown ratings are `null` — never a guessed value.

**Mechanical mating ≠ electrical compatibility.** `checkCompatibility` (Phase 3) answers whether two connectors mate; `checkElectricalCompatibility` answers whether connecting the pins is electrically sound, and returns `unknown` (not `compatible`) when a rating is missing.

## Connectivity

`compileNetlist` builds nets with a union–find over **explicit** relations only: wires, net labels, ground symbols, junction parts and device-internal terminals. Positions — schematic or 3D — are never consulted, so moving a symbol or a component cannot connect or disconnect anything (tested). Net names: label name, `GND`, or `Net-(R1-p1)`. The reference node is the ground symbol's net; without one, the UNO's GND (or the first supply's negative terminal) is used **and reported**; with neither, analog analysis refuses (“missing reference”).

## Design-rule checks (`erc.ts`)

Structural (from topology and ratings): missing/implicit ground, unconnected power pins, floating digital inputs, supply shorts, supplies at different voltages tied together, voltage-domain violations against cited limits, unknown ratings (info), push-pull output contention, LEDs without series current limiting, incomplete ground between a controller and the devices it signals, unpowered controller, servos on the controller's 5 V rail, missing parameters/links, dangling 3D or joint links, supplies feeding loads of unknown current (“not electrically validated”).

Solved (from a DC operating point): overvoltage on rated pins, GPIO overcurrent (20 mA per pin), 3.3 V pin and USB 5 V budget, resistor dissipation vs rating, LED/diode current vs rating (unknown rating → explicit “cannot be checked”), polarised-capacitor reverse bias, servo/HC-SR04 supply range.

**Disclaimer shown with every check list:** passing these rules does not show that a circuit is safe, and FORGE does not certify electrical designs. Rules not covered include transient overvoltage, ESD, thermal limits, wire/trace current capacity, EMC, isolation and component ageing.

## User interface

- **Electronics mode** (top bar): the mechanical design is read-only; CAD shortcuts are disabled. Panel tabs: Parts (place catalogue parts in 3D + circuit atomically, add ideal elements, add already-placed components, pin inspector with roles, nets and cited limits), Wiring (wires, nets, net labels, bundle import/export, SPICE-style export), Checks, Analysis (DC voltmeter/ammeter tables with solved checks, transient plots and CSV, a no-firmware logic simulation with logic analyser), Code.
- **Schematic** (overlay): standard symbols, pan/zoom/fit, drag parts (snap to grid), rotate (R), wire tool, route editing (double-click adds a bend, drag bends), Delete removes a wire, net highlighting, labels, live net colouring in Simulation mode.
- **3D**: pin markers coloured by role at catalogue pin positions; wires drawn between 3D pins and following simulated poses; the wire tool works by clicking pins in 3D. Both views issue the same commands on the same definition.
- **Simulation mode**: the runtime panel (ELECTROMECHANICAL_COSIMULATION.md).

## Interchange

- FORGE electrical bundle (`forge-electrical-bundle` v1, JSON): untrusted import — 2 MB limit, JSON parse, schema validation with error details; links to 3D components are kept only if they resolve in the target project.
- SPICE-style netlist **export** of the analog subset (R, C, L, V, I, E, G, D, Q, M, potentiometer, closed switch); other devices are listed as comments. Labelled “not verified against a SPICE simulator”. No SPICE or KiCad import; no PCB outputs.

## Security

Imported projects, bundles and firmware are untrusted: schema validation on load and on every command, size limits (bundle 2 MB, firmware 64 KB, tokens, AST nodes, nesting depth, arrays ≤ 4,096 elements, SRAM estimate), execution limits (call depth 64, per-event progress guard, wall-clock budget per frame, bounded event queue runs), and no network, filesystem, DOM or host-object access from firmware (an interpreter over a closed builtin table — no `eval`, no `Function`). Nothing in FORGE controls real USB devices, motors or other hardware.
