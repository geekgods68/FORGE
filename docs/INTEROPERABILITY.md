# Engineering data exchange (Phase 8)

Package: `@forge/interop` (pure TypeScript; no DOM, no network, no file-system access). Desktop: `apps/desktop/src/features/interop/` (Data exchange dialog, STEP worker, provenance section).

## Pipeline

1. **Selection** — the user picks files (several at once for a URDF and its meshes). Bytes are read locally; nothing is uploaded or fetched.
2. **Detection** (`detectFormat`) — from content first (magic numbers, `ISO-10303-21`, `(kicad_pcb …)`, `<robot>`, SPICE cards); the extension only breaks ties and a mismatch is reported.
3. **Validation and parsing** — per-format size limits are checked before parsing; parsers never execute anything (glTF external URIs refused, XML DOCTYPE/entities refused, KiCad S-expressions depth/size-bounded, SPICE `.include` never followed).
4. **Normalisation** — the source unit, up axis and handedness are explicit (`Frame`); the FORGE frame is metres, +Y up, right-handed. STL has no units: the user confirms them (default mm, +Z up).
5. **Conversion** — into existing FORGE representations: `model-instance` nodes (GLB assets in the content-addressed asset store), primitives, assemblies with mates, explicit mass properties, the electrical definition.
6. **Compatibility** — the plan is a list of validated engine commands; the dialog runs it as an engine **dry run** before confirmation.
7. **Preview** — geometry class, FORGE-frame dimensions, triangle count, closure, volume, area, components, hierarchy, warnings and unsupported data.
8. **Confirmation** — nothing changes until "Insert into project".
9. **Insertion** — derived assets are stored (SHA-256 re-verified), then ONE `scene.batch` applies everything **atomically** (one undo step; a failing step changes nothing).
10. **Provenance** — the last step of the batch is `interop.import.record`: format and version, file name, SHA-256 of the exact bytes, referenced files, units, axes, handedness, geometry class, created nodes, derived assets, summary, conversion history, unsupported attributes, warnings and a fingerprint computed by the command from the nodes as created. The Inspector shows **native** or **imported** origin and whether the import has since been **modified**.

Exports never change the project.

## Geometry classes (always shown)

| Class                   | Meaning                                                  |
| ----------------------- | -------------------------------------------------------- |
| parametric              | FORGE parts with editable features (native only)         |
| brep                    | exact boundary representation — not stored by FORGE      |
| tessellated-brep        | triangles from a STEP B-rep at a stated tolerance (OCCT) |
| mesh                    | triangles as supplied (STL, glTF)                        |
| primitive               | analytic box/cylinder/sphere (URDF primitives)           |
| visual-only / collision | display or contact only                                  |

Importing a mesh never recovers a feature tree; tessellating STEP never keeps an editable B-rep. Mass, density, inertia and collision are **never inferred**: the user supplies a mass and chooses the (approximate) bounding-box collider, or a URDF supplies `<inertial>` explicitly.

## Capability matrix

Single source: `packages/interop/src/capabilities.ts` (also shown in the dialog).

| Format                  | Import               | Export | Geometry                         | Hierarchy | Materials             | Units                | Editable features | Simulation                                          | Round trip                                |
| ----------------------- | -------------------- | ------ | -------------------------------- | --------- | --------------------- | -------------------- | ----------------- | --------------------------------------------------- | ----------------------------------------- |
| STEP AP203/214/242      | yes                  | **no** | B-rep tessellated by OCCT        | yes       | partial (colours)     | declared unit → m    | no                | as imported model (explicit mass, bbox collider)    | no STEP writer                            |
| STL binary/ASCII        | yes                  | yes    | mesh                             | no        | no                    | none (user confirms) | no                | as imported model                                   | geometry to float32 precision             |
| GLB                     | yes                  | yes    | mesh (original kept for display) | yes       | partial (PBR factors) | m, +Y up             | no                | as imported model                                   | hierarchy, names, transforms, PBR factors |
| glTF (embedded)         | yes                  | as GLB | mesh                             | yes       | partial               | m, +Y up             | no                | as imported model                                   | —                                         |
| URDF                    | yes                  | no     | primitives + STL/GLB meshes      | yes       | partial (colours)     | m, rad, z-up → y-up  | partial           | links → bodies, joints → mates, inertials, dynamics | —                                         |
| SPICE (subset)          | yes                  | yes    | —                                | —         | —                     | SI suffixes          | yes               | MNA DC/transient                                    | values and connectivity identical         |
| KiCad netlist (E)       | yes                  | no     | —                                | —         | —                     | SI suffixes          | yes               | mapped parts                                        | —                                         |
| KiCad PCB               | partial              | no     | placement only                   | —         | —                     | mm                   | partial           | pad-net connectivity                                | —                                         |
| KiCad schematic         | partial (inspection) | no     | —                                | —         | —                     | —                    | no                | no connectivity                                     | —                                         |
| FORGE electrical bundle | yes                  | yes    | —                                | yes       | —                     | SI                   | yes               | complete                                            | exact                                     |
| FORGE project bundle    | yes                  | yes    | all                              | yes       | yes                   | SI                   | yes               | complete                                            | exact (hash-verified)                     |

### STEP

Header, schema (AP203/214/242), originating system, products, assembly usages, B-rep and face counts and the declared length unit are read in TypeScript (the unit assigned by the representation context, including conversion-based units such as inch). Geometry is tessellated by **Open CASCADE** through `occt-import-js` 0.0.23 (WebAssembly; LGPL-2.1, see THIRD_PARTY_NOTICES.md) in a Web Worker, at a linear deflection of 0.1 % of the bounding-box diagonal and 0.5 rad angular deflection; OCCT converts lengths to metres and applies assembly placements. Product hierarchy and names are kept; placements are baked into vertices (per-part matrices are identity). PMI, tolerances, material designations, kinematics and property definitions are reported, not imported. STEP **export is not offered**: FORGE has no B-rep writer, and a mesh must not be presented as a recovered CAD model.

### STL

Binary detection uses the exact-size rule (84 + 50·n), so a binary file whose header starts with "solid" is read correctly; ASCII files with several `solid` blocks become several nodes; stored normals are compared with the winding and reported; NaN/∞, empty, truncated and malformed facets are refused. Converted to an indexed GLB with flat normals (vertices welded only where position **and** normal coincide).

### glTF/GLB

Pure-TypeScript reader: node hierarchy (matrix or TRS), triangle primitives (u8/u16/u32 indices, normalised attributes), PBR factors. Refused: external URIs, Draco/meshopt/quantised geometry, multi-parent nodes, cycles, out-of-bounds accessors. Reported: textures (kept in the stored original for display), skins, animations, cameras, morph targets, extra scenes, non-triangle modes, sparse accessors.

### Export

STL (binary or ASCII; mm/m/cm/in; +Z or +Y up — the inverse of the import frame, verified) and GLB (m, +Y up) of the selection, built from the engineering data (portable solids, primitives, stored model assets) placed by world matrices — independent of instanced rendering. Reports preserved vs discarded information (features, mates, mass properties, circuits, interfaces; STL also loses hierarchy, names and units).

## Electrical

**SPICE**: R, C (IC), L (IC), V/I (DC, PULSE, SIN without damping, PWL), E, G, D (`.model D`: IS, N, RS), Q (NPN: IS, BF, BR), M (NMOS level 1: VTO, KP, LAMBDA; K = KP·W/L), `.tran`. SI suffixes with SPICE meanings (M = milli, MEG = mega, 4k7) parsed to the correctly rounded double. Subcircuits, B/F/H/K/S/W/T, PNP/PMOS, other analyses, `.param`, `.include` are identified; unsupported elements **block** the import unless a partial import is explicitly accepted (then listed in the record). SPICE current-source polarity is mapped. The Phase 6 exporter now keeps `R1` (not `RR1`).

**KiCad**: netlist (version E) and PCB pad nets. Only exact symbols map automatically (Device R/C/CP/L/D/LED, `Q_NPN_*`, `Q_NMOS_*`, Battery, Simulation_SPICE VDC, MCU_Module Arduino_UNO_R3 by pin function). Unmapped parts keep their reference, value, footprint and library id, are reported, and can be mapped manually (R/C/L with a value) or omitted — never substituted. PCB placement (x, y, rotation, side) is recorded; tracks, zones and 3D models are reported only. A PCB import is **not** electromagnetic, thermal or manufacturing validation. Schematics are read for inspection only (connectivity in schematics is geometric; export a netlist).

**Connectivity verification**: every electrical import recompiles the FORGE netlist and compares its partition of (part, pin) terminals with the source's node membership — identical or the import is refused.

## URDF

Safe XML; one root link, one parent per link, no cycles. Links → groups inside one assembly, placed by forward kinematics (rpy = Rz·Ry·Rx); the assembly is rotated −90° about X (REP-103 z-up → FORGE +Y up). Joints → frame mates: fixed, revolute (limits), continuous (revolute without limits), prismatic (limits); initial value 0 clamped into the limits. Box/cylinder/sphere visuals → primitives (cylinder axis converted); STL/GLB meshes resolved **only** from files the user selected (by package path, then base name; ambiguity refused; URLs never fetched); `scale` honoured (non-uniform baked). `<inertial>` → explicit mass, centre of mass and inertia tensor rotated into the link frame and checked for physical realisability. `<dynamics>` → joint damping/friction. Optional generic position actuators hold the initial pose (effort/velocity from `<limit>`; an assumption). Reported: floating/planar joints, mimic, safety_controller, calibration, transmissions, Gazebo, ros2_control, sensors, Collada/OBJ, separate collision geometry (contact uses the visual primitives).

## Verification (`packages/interop/src/__tests__`, `tests/end-to-end/phase8.spec.ts`)

Tolerances fixed before measuring: geometry stored as float32 → dimensions to 1e-6 relative; volumes 1e-5; OCCT planar faces are exact to that bound.

| Check                                                   | Result                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| STL 10 × 20 × 30 mm, Z-up → FORGE                       | 10 × 30 × 20 mm, volume and area exact to float32                                            |
| Hand-written ASCII tetrahedron                          | volume 1/6, area 1.5 + √3/2                                                                  |
| Nested transform (90° about Y, non-uniform scale 2,1,1) | bounds as derived analytically                                                               |
| Mirrored transforms / left-handed sources               | re-wound, volume positive                                                                    |
| 200 m and 50 µm parts                                   | measured; unit-error warnings                                                                |
| STEP mm / m / inch                                      | declared unit read; inch box 3 in → 0.0762 m                                                 |
| STEP 2-part assembly                                    | names, hierarchy, 200 mm placement, volume                                                   |
| STEP → split parts                                      | relative placement exact (1e-7 m)                                                            |
| STL → asset → STL → re-import                           | dimensions and volume within float32, same triangle count                                    |
| Export frame inversion                                  | STL mm / +Z up re-imports to the original FORGE frame                                        |
| URDF link frames vs independent forward kinematics      | ≤ 1e-9 m at rest; ≤ 1e-7 with every joint type moved                                         |
| URDF in Rapier                                          | 6 bodies (fixed joint welded), 5 joints, URDF masses; hold actuators keep the pose < 0.1 rad |
| SPICE RC (1 kΩ, 1 µF) transient vs 5(1 − e^(−t/τ))      | max error < 1 mV                                                                             |
| SPICE round trip                                        | identical values and connectivity                                                            |
| Phase 7 R × C sweep on an imported SPICE circuit        | τ = RC within 1 % (9 runs)                                                                   |
| Browser: STEP bracket → export STL → re-import          | extents {15, 40, 60} mm and 13.000 cm³ preserved                                             |

### Round-trip preservation

| Information                       | STL                                         | GLB                                       | SPICE                   |
| --------------------------------- | ------------------------------------------- | ----------------------------------------- | ----------------------- |
| Geometry                          | approximate (float32)                       | approximate (float32)                     | —                       |
| Dimensions / placement            | exact within float32; world placement baked | exact within float32                      | —                       |
| Hierarchy, names                  | discarded (format has none)                 | preserved                                 | element names preserved |
| Units                             | not representable (header text only)        | metres by specification                   | SI                      |
| Materials                         | discarded                                   | PBR factors preserved; textures discarded | —                       |
| Component values / connectivity   | —                                           | —                                         | exact                   |
| Features, mates, mass, interfaces | intentionally discarded (not representable) | intentionally discarded                   | —                       |

## Limits

16 MiB per stored (converted) asset: about 280 000 flat-shaded triangles (500 000 is refused with an explicit message); 2 000 000 triangles per import; STL input 64 MiB; STEP 32 MiB. No mesh repair, decimation or unit auto-detection. Imported meshes collide only through their bounding box.
