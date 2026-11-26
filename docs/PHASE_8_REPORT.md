# Phase 8 report: CAD interoperability, engineering data exchange and digital twins

**Branch:** `phase-8/interoperability-digital-twins`, created from `phase-7/scientific-experiments` at `fe09492`. `main` is unchanged (`878142b`). Nothing was merged or pushed.

**Status: PARTIAL — strongest defensible state.** Everything that could be built and verified in software is implemented, integrated and tested, including STEP import through a real B-rep kernel. The phase is PARTIAL rather than COMPLETE for three reasons:

- **No physical hardware was connected**, so physical connectivity, physical recordings, calibration and empirical validation are outstanding.
- **STEP export** is not implemented, because no B-rep writer exists in the toolchain.
- **KiCad schematic connectivity** is not derived; schematics are read for inspection only.

## 1. Executive summary

External engineering data now comes into FORGE as real, editable FORGE structures, never as stored files or placeholders:

| Source                              | Becomes                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| STEP                                | Tessellated B-rep assemblies (Open CASCADE)              |
| STL, glTF/GLB                       | Mesh parts                                               |
| URDF                                | Simulatable assemblies with joints, limits and inertials |
| SPICE netlists, KiCad netlists/PCBs | Circuits with independently verified connectivity        |

Every import is one atomic, undoable transaction and carries its provenance: source hash, units, conversions and unsupported data. Supported representations export to STL, GLB and SPICE, each with a report of what is preserved and what is discarded.

A versioned digital-twin layer links the VEYRIS arm model to an Arduino through:

- a checksummed, Uno-friendly telemetry protocol;
- a robust ingestion and clock-synchronisation pipeline;
- recordings with deterministic replay;
- comparison against FORGE's co-simulation;
- Phase 7 research integration;
- designations that only rise with real evidence.

Hardware access is observation only: no code path can command a device. The reference firmware runs unchanged on FORGE's virtual UNO against the simulated arm. It was **not** run on a physical board during this phase.

## 2. Starting repository state

`phase-7/scientific-experiments` at `fe09492`, with a clean tree; `main` at `878142b`. The baseline suite passed before any change:

- install, lint, typecheck, format and build: exit 0;
- `pnpm test`: 403 passed, 5 skipped;
- `pnpm test:e2e`: 67 passed.

Free disk was **7.1 GiB, below the 8 GB floor**, and fell to 5.2 GiB during the phase because of system activity outside the repository; repo artefacts total under 30 MB. I deleted nothing outside the repository. All benchmarks ran in memory.

## 3. Architectural changes

- **Project schema v7** (v1–v6 migrate unchanged):
  - root `imports` provenance records;
  - `interop.import.record` / `interop.import.forget` commands (the fingerprint is computed by the command itself);
  - the `inertial` mass source.
- **New packages:**
  - `@forge/interop`: formats, frames, metrics, transactional plans, capability matrix;
  - `@forge/digital-twin`: protocol, pipeline, twin documents, recordings, comparison, designations, synthetic adapter, actuation refusal.
- **Changes to existing packages:**
  - SHA-256 helpers moved to core;
  - physics honours inertial mass;
  - SPICE export naming fixed;
  - the UNO interpreter accepts string literals for `char[]`;
  - twin persistence added.
- **Desktop:** Data exchange dialog (STEP in a Web Worker), provenance in the Inspector, a Digital twin work mode, and Web Serial and bridge transports.
- **Tools:** `tools/serial-bridge`, a read-only loopback bridge.
- **`vey-api` v2:** six proposed, not callable, VCI contracts.

Full details are in ARCHITECTURE.md, INTEROPERABILITY.md and DIGITAL_TWIN.md.

## 4. Dependency additions and licensing

One dependency was added: **`occt-import-js` 0.0.23** (pinned), the Emscripten build of Open CASCADE, licensed **LGPL-2.1**.

- It is loaded as a separate, unmodified JS and WebAssembly module in a worker, only when importing STEP.
- The WebAssembly file is 7.6 MB and is not loaded otherwise.
- Licence texts ship with the package; obligations for any distribution are set out in THIRD_PARTY_NOTICES.md, which flags owner/legal review before V1.

There are no other new dependencies: the bridge uses Node built-ins only.

## 5. Format capability matrix

The full matrix is in INTEROPERABILITY.md and is also shown in the dialog.

| Format             | Import                                                                                                     | Export                   | Status                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------- |
| STEP AP203/214/242 | tessellated B-rep, hierarchy, names, units, colours                                                        | —                        | **PARTIAL** (no STEP export, no editable B-rep)           |
| STL binary/ASCII   | mesh, multiple solids, unit/axis/handedness confirmation                                                   | binary/ASCII, unit, axis | **COMPLETE**                                              |
| glTF/GLB           | hierarchy, transforms, meshes, PBR factors (original kept for display)                                     | GLB                      | **COMPLETE** (no compressed geometry, skins or animation) |
| URDF               | links, fixed/revolute/continuous/prismatic joints, limits, primitives, STL/GLB meshes, inertials, dynamics | —                        | **COMPLETE** for the listed subset (no URDF export)       |
| SPICE              | R, C, L, V, I, E, G, D, NPN, NMOS-1, .tran                                                                 | yes                      | **COMPLETE** for the FORGE subset                         |
| KiCad netlist      | exact-symbol mapping, manual mapping/omission                                                              | —                        | **COMPLETE**                                              |
| KiCad PCB          | pad-net connectivity and placement                                                                         | —                        | **PARTIAL** (no copper geometry or 3D models)             |
| KiCad schematic    | symbol inspection only                                                                                     | —                        | **PARTIAL** (connectivity not derived)                    |

## 6. Geometry import and export

The pipeline runs: detection, size limits, safe parsing, explicit frame, preview (FORGE-frame dimensions, topology, closure, volume, area, hierarchy, warnings, unsupported data), engine dry run, confirmation, then storage of hash-verified assets and one batch.

- The geometry class is always visible.
- Mass and collision are never inferred.
- Assemblies can be split into parts with exact relative placement.
- A part can be attached to a native body with a fixed mate.
- Exports are built from engineering data (solids, primitives, stored assets) and never change the project.
- STEP export is not offered, because a mesh must not be presented as CAD.

## 7. KiCad and SPICE interoperability

Every electrical import is checked by recompiling the FORGE netlist and comparing its terminal partition with the source; anything else is refused. Unsupported SPICE constructs block the import unless a partial import is accepted explicitly. KiCad components that don't map are reported with their reference, value, footprint and library id, and are never substituted.

The RC demonstration covers every required step:

| Requirement                           | Result                                                              |
| ------------------------------------- | ------------------------------------------------------------------- |
| Opened in FORGE                       | yes                                                                 |
| Values and connectivity preserved     | 3 nets, 7 terminals identical                                       |
| Transient vs analytic 5(1 − e^(−t/τ)) | max error < 1 mV                                                    |
| Phase 7 sweep                         | τ = RC within 1 % (package: 9 runs; browser: 4 runs incl. baseline) |
| Export                                | SPICE, with identical values on re-import                           |

A PCB import is not EM, thermal or manufacturing validation.

## 8. URDF interoperability

No ROS installation is needed. Meshes are resolved only from files the user selected and are never fetched. Joint semantics are verified against an independent forward-kinematics computation: ≤ 1e-9 m at rest and ≤ 1e-7 m with every joint type moved; limits are enforced. The test arm simulates in Rapier with its URDF inertials (6 bodies, 5 joints).

One finding: generic hold actuators on small links are unstable at FORGE's default 4 solver sub-steps (drift above 1 rad). 8 sub-steps hold the pose, so imports that create a simulation set 8 and say so. ROS-specific elements are reported, not imported.

## 9. Digital twin architecture

The twin is versioned and stored separately from the project file, its undo history, transient telemetry and recordings. Four modes are explicit in the code and the UI: simulation, read-only observation, deterministic replay, and comparison.

The six designations are evidence-based, and synthetic data never counts:

| Designation           | Requires                                                           |
| --------------------- | ------------------------------------------------------------------ |
| virtual-model         | a FORGE engineering model                                          |
| simulated-system      | a simulation or circuit setup                                      |
| telemetry-connected   | mapped channels and a non-synthetic recording                      |
| synchronised          | that recording with p95 latency ≤ 50 ms and ≤ 1 % missing messages |
| calibrated            | a Phase 7 calibration against a physical recording                 |
| empirically-validated | an agreeing validation on independent, non-synthetic data          |

The VEYRIS twin currently stands at **simulated-system**.

## 10. Telemetry and synchronisation

- **Sequencing:** sequence numbers and device clocks are unwrapped; duplicates are dropped; a 100 ms reorder window applies, with late flags; gaps count as missing messages; missing values are never filled; device restarts start a new epoch.
- **Clock fit:** independent of message rate, using a lower envelope per 50 ms bucket over 30 s.
- **Link states:** live, delayed, stale, disconnected and replay.
- **Interpolation:** explicit policy with a maximum gap.
- **State kinds:** measured, commanded and estimated, as declared by the device.

| Measurement              | Result                              |
| ------------------------ | ----------------------------------- |
| Drift, synthetic 100 ppm | estimated within ±30 ppm            |
| Drift, zero-drift stream | +0.3 ppm (20 Hz), −0.8 ppm (1 kHz)  |
| Ingestion                | 4.2 µs per line (≈ 236 000 lines/s) |

## 11. Arduino integration

`hardware/arduino/forge_telemetry/forge_telemetry.ino` reads the HC-SR04 and drives the servo gauge, emitting protocol v1 at 20 Hz:

- **Distance:** declared measured, in millimetres.
- **Servo angle:** declared **commanded**, because there is no position sensor.
- **Serial input:** never read.

The same source compiles in FORGE's UNO subset and runs on the virtual UNO against the simulated arm. There, the telemetry decodes with 0 invalid lines; distance is within 1.5 mm of the sensor model and the commanded angle is within 2° of the decoded servo target.

Two transports exist:

- **Web Serial** (Chromium desktop): the browser's port chooser is the authorisation, and only the readable side is used.
- **Local bridge:** for Safari, Firefox and setups without Web Serial, documented for Windows and macOS.

**Physical connectivity: unverified** (no hardware attached during this phase).

## 12. Hardware authorisation and safety boundaries

Physical actuation is **not implemented**, by design and per project rules:

- the adapter interface is receive-only (`canActuate: false`);
- the protocol has no command message;
- the bridge is GET-only on 127.0.0.1, with a token, an origin allowlist and a device-path allowlist; it runs only fixed `stty`/`mode` commands, without a shell;
- `requestActuation()` always refuses;
- no `vey-api` contract exists for actuation.

Loading, simulating, replaying or running an experiment cannot move hardware. Note that the bench firmware's own gauge logic does move the servo, independently of FORGE. Software refusals are not an emergency stop.

## 13. VEYRIS robotic arm demonstration

The library sample "VEYRIS arm digital twin" is the Phase 6 arm with its UNO running the telemetry firmware. The browser demonstration ran with **deterministic synthetic telemetry**, which is a software test, not a physical one. Each required step:

| Step                              | Result                                                 |
| --------------------------------- | ------------------------------------------------------ |
| Twin creation                     | done                                                   |
| Mapping validation                | no issues                                              |
| Connect                           | live within the 10 s limit                             |
| Virtual wrist                     | shown at the COMMANDED angle through the preview scene |
| Recording                         | 3 s captured                                           |
| Disconnect, then stall scenario   | link reached disconnected, then stale                  |
| Replay                            | done                                                   |
| Comparison with the co-simulation | n > 40, finite RMSE, residual chart                    |
| Research                          | dataset created and labelled SYNTHETIC                 |
| Designation                       | simulated-system                                       |
| CAD geometry                      | identical before and after, and after reload           |
| Reload                            | twin configuration and recordings restored             |
| Actuation                         | no hook can reach it; policy `implemented: false`      |

## 14. Research environment integration

- Imported circuits work directly with Phase 7 parameter targets: part ids equal the designators, e.g. `electrical.part.R1.resistanceOhm`.
- Recordings become Phase 7 datasets in model units; commanded channels are excluded, and the synthetic flag and recording hash are kept in the provenance.
- Validation against such a dataset is `synthetic-only`.
- Calibration-versus-validation separation is preserved: a calibration dataset never counts as independent validation.
- Previous Phase 7 tests all pass unchanged.

## 15. Geometry and round-trip verification results

Tolerances were fixed before measuring: 1e-6 relative for float32 storage, 1e-5 for volumes. Results:

| Check                                            | Result                                                    |
| ------------------------------------------------ | --------------------------------------------------------- |
| STL 10 × 20 × 30 mm, Z-up                        | → 10 × 30 × 20 mm, exact volume and area                  |
| Hand-written ASCII tetrahedron                   | V = 1/6                                                   |
| Nested rotation with non-uniform scale           | analytic bounds                                           |
| Mirrored and left-handed sources                 | re-wound, volume positive                                 |
| 200 m and 50 µm parts                            | measured, unit-error warnings                             |
| Degenerate, open, malformed and truncated inputs | reported or refused                                       |
| STEP mm / m / inch                               | declared unit read; 3 in → 0.0762 m                       |
| STEP assembly placement                          | 200 mm offset; split parts exact to 1e-7 m                |
| STL round trip                                   | dimensions and volume within float32, same triangle count |
| GLB round trip                                   | hierarchy, names, transforms and PBR factors preserved    |
| Browser: STEP → export STL → re-import           | extents {15, 40, 60} mm and 13.000 cm³ preserved          |

Losses are classified as exact, approximate, unsupported or intentionally discarded in INTEROPERABILITY.md.

## 16. Numerical and empirical validation status

| Evidence category                         | Status                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Software correctness                      | **verified** (tests)                                                                                    |
| Numerical verification                    | geometry metrics, forward kinematics, clock fit: **verified**                                           |
| Analytical agreement                      | RC: **verified**                                                                                        |
| Agreement with independent tools          | **not assessed** (SPICE export not run in an external simulator; no comparison with another CAD system) |
| Calibration against physical measurements | **not available**                                                                                       |
| Independent empirical validation          | **outstanding**                                                                                         |

FORGE is not described as validated.

## 17. Performance benchmarks

All figures are measured; details in PERFORMANCE_BASELINE.md and the `docs/archive/phase8-*` records.

| Case                                                           | Result                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| STL 100k triangles                                             | parse 117 ms, plan 486 ms                                                        |
| STL 500k triangles                                             | refused: converted asset over 16 MiB                                             |
| STEP 100-part assembly                                         | 506 ms (Node); 580 ms in the browser worker, 0 long tasks, steady 16.7 ms frames |
| SPICE 2001 elements                                            | 35 ms                                                                            |
| KiCad 500 components                                           | 13 ms                                                                            |
| URDF 30-link chain                                             | 5 ms plan, 59 ms apply                                                           |
| Telemetry                                                      | ≈ 236k lines/s                                                                   |
| Physics with an imported part and simultaneous 20 Hz telemetry | no measurable step overhead (0.157–0.175 ms per step)                            |
| Live twin in the browser (15 s)                                | 0 long tasks                                                                     |

## 18. Storage and memory results

| Item                               | Figure                                                      |
| ---------------------------------- | ----------------------------------------------------------- |
| Converted 100k-triangle STL        | GLB 5.7 MB; asset limit 16 MiB ≈ 280k flat-shaded triangles |
| Heap, 100k-triangle import         | +32 MB                                                      |
| Heap, 1 h of 20 Hz telemetry       | +37 MB                                                      |
| Heap, 60 s of 1 kHz telemetry      | +64 MB                                                      |
| Recordings                         | 51 KB/min at 20 Hz; 2.3 MB/min at 1 kHz                     |
| Browser JS heap                    | 28 MB                                                       |
| IndexedDB after the twin benchmark | ≈ 236 KB                                                    |
| OCCT WebAssembly                   | 7.6 MB, fetched only for STEP                               |

## 19. Unit and integration test results

`pnpm test`: **474 passed, 6 skipped (opt-in benchmarks), 61 files, exit 0**. That is 71 new tests over Phase 7's 403.

| Area                                                              | New tests |
| ----------------------------------------------------------------- | --------: |
| `@forge/interop`: geometry 21, detection 2, electrical 12, URDF 6 |        41 |
| `@forge/digital-twin`                                             |        17 |
| Core provenance / v7                                              |         3 |
| Inertial mass                                                     |         2 |
| Firmware string literals                                          |         1 |
| Twin persistence                                                  |         1 |
| Serial bridge integration                                         |         4 |
| Web Serial adapter                                                |         1 |
| `vey-api`                                                         |         1 |

Existing schema-version assertions moved from 6 to 7, and the "newer version" fixtures now use current + 1. The Phase 6 SPICE naming assertion now expects `R1`. No test was removed, skipped or weakened.

## 20. Browser and WebXR compatibility

`pnpm test:e2e`: **72 passed, exit 0** (67 from earlier phases plus 5 new). A first full run failed 3 earlier tests because the new top-bar button's accessible name ("Import / Export") matched their `Export` button selector; the button was renamed **Data exchange** and the full suite then passed unchanged. New browser tests:

- Demonstrations A, B and C;
- URDF with an STL mesh;
- the browser benchmark.

Compatibility:

| Environment     | Status                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium        | tested headless; Web Serial needs Chromium desktop                                                                                                                          |
| Safari, Firefox | lack Web Serial (use the bridge); **not tested** in this phase                                                                                                              |
| Quest browser   | no Web Serial, cannot reach another machine's loopback; FORGE binds to 127.0.0.1 only, so no live telemetry on the Quest yet                                                |
| WebXR           | **none exists in FORGE** (VR is "future" in MASTER_SPEC), so nothing was preserved or added; imported assets are ordinary scene nodes and will render in any future XR view |

## 21. Git branch and milestone commits

`phase-8/interoperability-digital-twins`:

| Commit    | Milestone                                                    |
| --------- | ------------------------------------------------------------ |
| `5b48e47` | phase8a: architecture                                        |
| `5ebcbd6` | phase8b: CAD geometry exchange                               |
| `44082a9` | phase8c: electrical and robotics interoperability            |
| `499e297` | phase8d: digital twin architecture                           |
| `bc7d1f1` | phase8e: permissioned (read-only) hardware telemetry         |
| `bfc89c1` | phase8g: UI integration and browser demonstrations           |
| `d2f8ad3` | phase8f: verification and benchmarks, plus the clock-fit fix |
| final     | docs, VCI contracts and final verification                   |

8G's UI landed before 8F because the browser benchmarks need it.

## 22. Known limitations

- No physical hardware was tested.
- No STEP export and no editable B-rep.
- No KiCad schematic connectivity, PCB copper geometry or 3D models.
- No IGES or OBJ.
- No compressed glTF, skins or animation.
- Imported meshes collide only through their bounding box.
- 16 MiB per converted asset.
- URDF collision geometry uses the visual primitives; mimic, transmissions and floating/planar joints are unsupported.
- The UI offers manual KiCad mapping only for R/C/L or omission (the API accepts any device).
- Twin recordings live in this browser's IndexedDB; export to Research is available, but there is no recording file export yet.
- No live telemetry on the Quest.
- Comparison covers one channel (distance), against a fresh co-simulation of the current project.
- Export is world-placed: an attached part exports in its world orientation.

## 23. Completion matrix

| Deliverable                                                                                    | Status                                                                           |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 8A interoperability architecture (provenance, transactions, limits, diagnostics, safe parsing) | COMPLETE                                                                         |
| STL import/export                                                                              | COMPLETE                                                                         |
| glTF/GLB import/export                                                                         | COMPLETE                                                                         |
| STEP import (OCCT)                                                                             | COMPLETE (tessellated; classified as such)                                       |
| STEP export                                                                                    | NOT IMPLEMENTED (no B-rep writer)                                                |
| Geometry classification, transforms, assembly placement, attachment                            | COMPLETE                                                                         |
| SPICE import/export                                                                            | COMPLETE (FORGE subset)                                                          |
| KiCad netlist import                                                                           | COMPLETE                                                                         |
| KiCad PCB import                                                                               | PARTIAL (connectivity and placement only)                                        |
| KiCad schematic                                                                                | PARTIAL (inspection only)                                                        |
| URDF import                                                                                    | COMPLETE (stated subset)                                                         |
| Digital twin document, modes, pipeline, synchronisation, replay, comparison, designations      | COMPLETE                                                                         |
| Research integration                                                                           | COMPLETE                                                                         |
| Web Serial transport                                                                           | PARTIAL (implemented and tested with a fake port; **not with hardware**)         |
| Local bridge                                                                                   | PARTIAL (implemented and tested with an in-memory device; **not with hardware**) |
| Arduino firmware                                                                               | PARTIAL (runs on FORGE's virtual UNO; **not flashed to a board**)                |
| Physical actuation                                                                             | NOT IMPLEMENTED (deliberately)                                                   |
| Import/export UI, provenance, twin workspace                                                   | COMPLETE                                                                         |
| VR / Quest visibility                                                                          | BLOCKED (no WebXR layer; no loopback route from the headset)                     |
| VCI boundary                                                                                   | COMPLETE as documented proposed contracts (none callable, by design)             |
| Calibration and empirical validation of the twin                                               | BLOCKED (no physical data)                                                       |

## 24. Hardware testing instructions

Follow docs/guides/CONNECT_ARDUINO.md:

1. Wire the HC-SR04 and servo.
2. Flash `forge_telemetry.ino`.
3. Close the Serial Monitor.
4. Connect, either via Chrome/Edge → Web Serial, or via `node tools/serial-bridge/bridge.mjs --device <port>` and paste the token.
5. Confirm the link badge goes **live** and the device id reads VEYRIS-ARM-01.
6. Record 60 s while moving an obstacle.
7. Replay, then compare with the simulation.
8. Export to Research.

To reach "telemetry-connected" and beyond, record with real hardware, then calibrate and validate in Research on **independent** recordings.

## 25. Outstanding V1 release requirements

- Physical hardware acceptance tests on the MacBook and the Acer Nitro 5 (Web Serial and bridge).
- A permissioned LAN relay for Quest visualisation.
- A WebXR layer.
- LGPL compliance review.
- STEP export via a B-rep-capable writer (if required).
- KiCad schematic connectivity (if required).
- Recording file export/import.
- Multi-channel comparison.
- Cross-browser testing: Safari, Firefox, Edge.
- Disk headroom on the development machine.

## 26. Readiness for Phase 9

Ready for owner review; Phase 9 has not been started. The interop and twin packages are pure and extensible. New formats implement a reader and a plan, and new transports implement the receive-only adapter.

## Final checks

| Command                          |                              Exit |
| -------------------------------- | --------------------------------: |
| `pnpm install --frozen-lockfile` |                                 0 |
| `pnpm lint`                      |                                 0 |
| `pnpm typecheck`                 |                                 0 |
| `pnpm format:check`              |                                 0 |
| `pnpm test`                      |         0 (474 passed, 6 skipped) |
| `pnpm build`                     |                                 0 |
| `pnpm test:e2e`                  | 0 (72 passed: 67 earlier + 5 new) |
