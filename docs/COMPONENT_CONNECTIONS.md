# Component connections

## Interface metadata

Each definition or generator declares interfaces in the component's local frame (metres). Every interface has:

- `id` (unique per component), `name`;
- `type`: `mechanical-mount`, `bolt-hole`, `shaft-coupling`, `revolute-joint`, `slider`, `electrical-terminal`, `gpio-pin`, `power-terminal`, `data-connector`, `fluid-port` or `optical-interface`;
- `position` and `direction` (an outward unit normal);
- `gender` (`male` / `female` / `neutral` / null);
- `compatibility` descriptors, for example `M3-clearance`, `M5-thread`, `shaft-8mm`, `2.54mm-header`, `servo-spline-25T`, `tslot-20`, `USB-B`, `ultrasonic-40khz`;
- an optional `signal` (for example `D13`, `5V`, `GND`, `PWM`) and `limits` specs.

Examples:

- **Arduino UNO R3:** 30 named header pins, USB-B, DC jack and 4 mounting holes.
- **Servos:** output spline, rotation axis, mounting tabs, and the 3-wire signal and power pins.
- **Generated parts:** bearing bore and housing, gear bore and mesh, T-slot slots and end bores, plate holes.

## Compatibility (foundation only)

`checkCompatibility(a, b)` decides only from declared metadata:

1. the type pairing is allowed (for example shaft-coupling with shaft-coupling or revolute-joint, gpio-pin with electrical-terminal);
2. the genders don't clash (male–male or female–female is refused; neutral or null passes);
3. at least one compatibility descriptor is shared;
4. power terminals don't pair GND or V− with a positive supply.

It returns `{ compatible, reasons, shared }`. **Proximity is never considered**: two parts touching in the scene are not "connected". `findCompatibleInterfaces(project, nodeId, interfaceId)` lists candidates across a project.

## In the app

In the component inspector, open **Connection interfaces** and click one. The panel lists every compatible interface in the project, and the viewport marks the source (cyan) and the candidates (green). This is inspection only: nothing is connected and nothing is solved.

## Not in Phase 3

- **Phase 4:** mating and constraint solving. Instances already carry a `connections` array (declared links) for Phase 4 to populate.
- **Phase 6:** circuit and electrical simulation.
- Mechanical limits such as torque or load ratings are left unknown unless cited.
