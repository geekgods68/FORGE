# Parametric geometry

Generators live in `packages/components/src/geometry/generators.ts`. They are pure and deterministic: the same parameters always produce identical output, and a test checks this.

## Conventions

- **Units:** metres internally. Parameters declare a display unit (mm) that applies only in the UI. A 300 mm part occupies 0.3 m.
- **Frame:** the origin is the centre of the footprint on the base, so bounds have min y = 0 (validated for every family and variant). +Y is up and the long axis runs along +X.
- **Output:** solids (`box`, `cylinder`, `tube`, `prism` extruded from a 2D outline with holes, `sphere`), each tagged with an appearance. Generators also return parameter-dependent connection interfaces.
- **Validation:** per-parameter type and range checks, plus generator cross-parameter rules (for example "wall thickness must be less than half the outer diameter" or "bore too large for this module and tooth count").
- **Bounds and volume:** exact for the modelled solids. Prism holes are cut from the volume; circular holes are 24-gons.

## Representation and mass

| Representation | Meaning                                                                                                       | Mass                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `exact`        | Solids represent the full material                                                                            | Volume × typical density: `geometry-density`                                                     |
| `approximate`  | Simplified profile (T-slot cavities, trapezoidal gear teeth, unthreaded fasteners, ring-approximated springs) | Labelled `geometry-density-approximate`, an estimate                                             |
| `envelope`     | Outer shape only (motors, boards, sensors, bearings)                                                          | Not computed. A cited published mass is shown as `specified` when available, otherwise `unknown` |

## Rendering

The desktop app converts solids to three.js geometry and merges all solids of one appearance into one buffer. Each configuration (definition + parameters) is built once and reference-counted across every instance that uses it, then disposed when the last instance unmounts. The library previews are SVG top and front sketches, so the catalogue never creates WebGL meshes. A test builds every one of the 401 families and checks its GPU bounds against the domain evaluation.

## Generators (40)

| Generator         | Description                                                                                                            | Families using it |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `plate`           | Rectangular plate/sheet/block with optional corner clearance holes (holes are cut from the volume).                    | 48                |
| `rod`             | Solid round bar/rod/shaft lying along X.                                                                               | 9                 |
| `tube`            | Round tube/pipe (outer diameter, wall) lying along X.                                                                  | 5                 |
| `rect-tube`       | Rectangular/square hollow section along X (four non-overlapping walls).                                                | 2                 |
| `section`         | Structural section (I-beam, channel, angle, T) extruded along X.                                                       | 1                 |
| `tslot`           | T-slot aluminium extrusion (simplified profile: slot notches and centre bores; internal cavities omitted).             | 1                 |
| `bracket-l`       | L-bracket: base leg and upright leg (non-overlapping), with clearance holes.                                           | 5                 |
| `gear`            | Spur gear / pulley / sprocket disc with simplified trapezoidal teeth and a bore (axis vertical).                       | 4                 |
| `screw`           | Metric screw/bolt (head per ISO 4762 / 7045 / 10642 / 4017; thread not modelled), standing on its tip.                 | 3                 |
| `nut`             | Hex nut per ISO 4032 (thread not modelled).                                                                            | 1                 |
| `washer`          | Plain washer per ISO 7089.                                                                                             | 1                 |
| `ring`            | Annular part (retaining ring, shaft collar, spacer, insert, bushing) — axis vertical.                                  | 9                 |
| `bearing`         | Deep-groove ball bearing envelope (ISO 15 boundary dimensions; balls/cage not modelled).                               | 1                 |
| `linear-rail`     | Linear guide rail with carriage (envelope).                                                                            | 2                 |
| `screw-drive`     | Lead/ball screw with nut block (thread not modelled), along X.                                                         | 3                 |
| `belt`            | Closed-loop belt/chain envelope (pitch length, width) shown as a flat loop.                                            | 2                 |
| `coupling`        | Shaft coupling / collar body (cylinder with bore), axis along X.                                                       | 2                 |
| `spring`          | Helical spring envelope: coils shown as stacked rings (helix not modelled; volume is approximate).                     | 1                 |
| `arm-link`        | Flat robot link with rounded ends and end holes (holes cut from the volume).                                           | 3                 |
| `gripper`         | Two-finger parallel gripper (palm, rails, fingers) — illustrative mechanism envelope.                                  | 1                 |
| `wheel`           | Wheel/roller (tyre + hub), axle along Z, resting on the base plane.                                                    | 3                 |
| `motor-can`       | Round motor envelope (can + shaft), shaft along +X. Windings/magnets not modelled.                                     | 11                |
| `stepper`         | NEMA-frame stepper motor envelope (face size and hole pattern per NEMA ICS 16), shaft +Y.                              | 1                 |
| `servo`           | Hobby RC servo envelope: case, mounting flange with tabs, top boss and output spline; 3-wire lead.                     | 6                 |
| `linear-actuator` | Linear actuator / cylinder envelope (body + rod at the given extension), along X.                                      | 6                 |
| `board`           | Electronics board: PCB substrate, major components and headers from a layout (or a generic module).                    | 81                |
| `ultrasonic`      | Ultrasonic ranging module: PCB, two transducer cans (front, +Z), crystal, 4-pin header.                                | 1                 |
| `ic-package`      | Integrated-circuit / discrete package body with leads (DIP, SOIC, QFP, TO-220, TO-92, SOT-23).                         | 36                |
| `breadboard`      | Solderless breadboard (generic): body with tie-point field and power rails.                                            | 1                 |
| `wire`            | Wire / cable / jumper lead lying along X with optional end housings.                                                   | 7                 |
| `cell`            | Battery cell (cylindrical designations per IEC/industry, prismatic/pouch, coin), lying along X.                        | 4                 |
| `cell-pack`       | Battery pack or holder: an S×P arrangement of cylindrical cells in a tray, with leads.                                 | 2                 |
| `enclosure`       | Open-top box enclosure (floor + four walls, non-overlapping) with an optional lid.                                     | 7                 |
| `heatsink`        | Finned heat sink (base + rectangular fins).                                                                            | 1                 |
| `fan`             | Axial fan (square frame, hub) — standard frame sizes; blades not modelled.                                             | 1                 |
| `propeller`       | Two/three-blade propeller envelope (diameter; pitch is metadata, blade twist not modelled).                            | 1                 |
| `lens`            | Round optical element (lens/mirror/filter/window) with optical axis along +Z, standing upright.                        | 8                 |
| `specimen`        | Flat dog-bone tensile specimen (overall length, grip and gauge widths, gauge length, thickness).                       | 2                 |
| `shape`           | Basic shape (box, cylinder or sphere) — custom parametric geometry and test objects.                                   | 14                |
| `generic-package` | Generic labelled block for catalogue entries awaiting a specialised model (honest placeholder, not a product replica). | 104               |

## Material library

The values are **typical handbook figures** for the named grade, rounded and `approximate`. They are not certified, and real lots vary. A property that is process- or direction-dependent or undefined is `null`.

| Material                                        | Id                 | Density (kg/m³) | E (GPa) | Yield (MPa) | Status      |
| ----------------------------------------------- | ------------------ | --------------- | ------- | ----------- | ----------- |
| Aluminium 6061-T6                               | `al-6061-t6`       | 2700            | 68.9    | 276         | approximate |
| Aluminium 6063-T5 (extrusion alloy)             | `al-6063-t5`       | 2700            | 68.9    | 145         | approximate |
| Aluminium 7075-T6                               | `al-7075-t6`       | 2810            | 71.7    | 503         | approximate |
| Carbon steel AISI 1018 (cold drawn)             | `steel-1018`       | 7870            | 205.0   | 370         | approximate |
| Alloy steel, property class 12.9 (fasteners)    | `steel-alloy-12-9` | 7850            | 205.0   | 1080        | approximate |
| Stainless steel 304                             | `ss-304`           | 8000            | 193.0   | 215         | approximate |
| Stainless steel 316                             | `ss-316`           | 8000            | 193.0   | 205         | approximate |
| Brass C360 (free-cutting)                       | `brass-c360`       | 8500            | 97.0    | 310         | approximate |
| Copper C110 (ETP)                               | `copper-c110`      | 8890            | 115.0   | 69          | approximate |
| Titanium Ti-6Al-4V (Grade 5)                    | `ti-6al-4v`        | 4430            | 113.8   | 880         | approximate |
| PLA (FDM filament)                              | `pla`              | 1240            | 3.5     | unknown     | approximate |
| PETG (FDM filament)                             | `petg`             | 1270            | 2.1     | 50          | approximate |
| ABS                                             | `abs`              | 1050            | 2.3     | 40          | approximate |
| Nylon PA6 (dry as moulded)                      | `pa6`              | 1140            | 2.9     | 80          | approximate |
| Polycarbonate                                   | `pc`               | 1200            | 2.4     | 62          | approximate |
| Acrylic (PMMA)                                  | `pmma`             | 1180            | 3.1     | unknown     | approximate |
| Acetal (POM homopolymer)                        | `pom`              | 1420            | 3.1     | 69          | approximate |
| PTFE                                            | `ptfe`             | 2200            | 0.5     | unknown     | approximate |
| TPU 95A (FDM filament)                          | `tpu-95a`          | 1210            | unknown | unknown     | approximate |
| Silicone rubber (Shore A 20–40)                 | `silicone-shore-a` | 1100            | unknown | unknown     | approximate |
| Nitrile rubber (NBR, O-rings)                   | `nbr`              | 1000            | unknown | unknown     | approximate |
| Carbon fibre / epoxy (quasi-isotropic laminate) | `cfrp-quasi-iso`   | 1550            | 50.0    | unknown     | approximate |
| FR-4 glass/epoxy laminate                       | `fr4`              | 1850            | 22.0    | unknown     | approximate |
| Fibreglass / polyester (GFRP)                   | `gfrp`             | 1800            | unknown | unknown     | approximate |
| Birch plywood                                   | `birch-plywood`    | 680             | unknown | unknown     | approximate |
| Alumina ceramic (96 %)                          | `alumina-96`       | 3720            | 300.0   | unknown     | approximate |
| Borosilicate glass                              | `borosilicate`     | 2230            | 64.0    | unknown     | approximate |
| Monocrystalline silicon                         | `silicon`          | 2329            | unknown | unknown     | approximate |
| Unspecified material                            | `unspecified`      | unknown         | unknown | unknown     | unsupported |

## External models (GLB / glTF 2.0)

`checkModelBytes` validates the container: magic, version, chunk structure, JSON, the 2.0 asset version, presence of meshes and no external URIs. The size limit is 16 MiB.

The library's **Inspect an external 3D model** panel parses the file with three's bundled GLTFLoader (a lazy chunk, nothing downloaded). It measures the bounding box in the unit and up-axis the user confirms (`modelSizeToMetres`), reports a SHA-256 content hash as the stable asset reference, and disposes every resource afterwards.

Imported models never acquire mass, material properties or interfaces. Saving them as library components and placing them is **not implemented** (it's planned with the CAD-interoperability phase), and there is no STEP or IGES support.
