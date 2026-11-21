# Phase 2 report: research laboratory environment & spatial infrastructure

Date: 2026-11-21 · Branch: `phase-2/facility-foundation` · Status: **approved by the owner; final polish pass complete** (§9). Phase 3 has not been started.

Earlier Phase 2 milestones are recorded in [PHASE_2_SLICE_REPORT.md](PHASE_2_SLICE_REPORT.md): maintenance `dddcd8d` and the vertical slice `960fef3`. The owner accepted the slice on 2026-11-20.

## 1. Recovery after the interrupted session

The previous session was cut off when the machine slept. The repository was reconstructed before any further changes:

- **Branch and commits:** HEAD was still `960fef3` and nothing had been committed after it. No resets, cleans or checkouts were used.
- **Uncommitted work found and kept:**
  - `lifecycle.ts` plus 8 passing unit tests;
  - `furnishings.ts` (the furnishing catalogue);
  - a schema extension (`Zone.discipline`, `Zone.furnishings`).
- **Interruption point:** the schema extension had landed but the facility data rewrite hadn't, so `pnpm typecheck` failed in `@forge/facility` (missing `discipline`/`furnishings`) while all 147 unit tests passed.
- **Resources at resume:** 9.3 GB free disk (no asset downloads were made); swap about 5.1 of 6 GB used, so heavy jobs were run one at a time.

Progress matrix at resume (from code, tests and history):

| Item                              | Status at resume                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| Zone lifecycle                    | PARTIALLY IMPLEMENTED: state machine and unit tests existed; not integrated in the app |
| Layout gizmo browser test         | NOT STARTED                                                                            |
| Templates / furnishings           | PARTIALLY IMPLEMENTED: catalogue data and schema only                                  |
| Remaining 21 labs, 6 environments | NOT STARTED: registry entries only                                                     |
| Navigation and signage            | NOT STARTED                                                                            |
| Performance verification, docs    | NOT STARTED for the expansion                                                          |

## 2. Work completed in this session

**A. Zone lifecycle (integrated):**

- States run `UNLOADED → LOADING → ACTIVE → UNLOADING → UNLOADED`, plus `ERROR → Retry`.
- The loaded set is the active zone, its required corridor, and at most one prefetched destination (prefetched on hover or focus; code only, not rendered).
- Generation tokens make stale loads harmless.
- The renderer confirms an unload only after unmount. Zone-specific resources are released (instance buffers, sign textures, unshared geometry and materials), while the shared palette and unit geometries stay pinned.
- Workspace and project data are never touched by unloading.

**B. Layout gizmo verification:** a browser test drags the real TransformControls picker handle with pointer events. It covers:

- a valid move: one history entry, 10 mm snap, single axis;
- a rejected collision: nothing commits, a visible alert, and the gizmo snaps back;
- undo/redo, separate from the project history;
- facility-frame and inspector readouts;
- persistence across a reload.

A mutation check (disabling snap-back) makes the test fail.

**C/D. Facility revision 2:**

- **Contents:** a connected site plan with all 22 labs, 6 environments and 11 corridors. Five reusable templates, a 44-type procedural fixture library, and discipline furnishings for every room, as validated data.
- **Signage:** derived from data, rasterised locally.
- **Navigation:** a directory grouped by wing, an Exits list, per-zone camera presets, and error/Retry UI.
- **Visual direction:** realistic institute palette, with cyan used only on interfaces.
- **Compatibility:** revision-1 identities are unchanged and revision-1 layouts still validate.

**E. Research infrastructure:** nothing from later phases was implemented. The forward-compatibility hooks in ARCHITECTURE.md are unchanged.

Other fixes found during the work:

- `InstancedFixtures` didn't free per-mesh instance buffers on unmount (a GPU leak once zones unload). It's now disposed.
- Transparent instanced glass needed `depthWrite: false`, added as an opt-in material field.
- The facility sidebar had nested scroll containers that made lower directory entries unclickable at 860 px height. It now uses one scroll container (found by the headed benchmark).

## 3. Laboratories and environments implemented

Each room has an interior, discipline furnishings, an identity sign and a door sign, is reachable through the directory and Exits, loads and unloads lazily, and has a placement area. The exact table with zone ids, poses, sizes, corridors and furnishings is in [FACILITY_ARCHITECTURE.md](FACILITY_ARCHITECTURE.md#rooms-generated-from-the-registry).

| Wing                                | Rooms                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A · AI & Computational Intelligence | 1 Central Intelligence Research Lab · 2 Computer Vision & Perception Lab · 3 Autonomous Systems & Robot Learning Lab · 4 Research Computing & Systems Lab · 5 Human–AI Interaction & Immersive Lab                        |
| B · Robotics & Mechatronics         | 6 Robotic Manipulation Laboratory · 7 Mobile Robotics & Navigation Arena · 8 Embedded Systems & Computer Engineering Lab · 9 Sensors, Controls & Instrumentation Lab                                                      |
| C · Mechanical & Manufacturing      | 10 Mechanical Design & Assembly Studio · 11 Precision Fabrication & Machine Shop · 12 Advanced Additive Manufacturing Centre · 13 Materials Science & Mechanical Testing Lab · 14 Structures, Dynamics & Multiphysics Lab |
| D · Electronics & Physical Sciences | 15 Electronics & PCB Engineering Lab · 16 Microelectronics & Nanofabrication Cleanroom · 17 Power, Energy & Electric Machines Lab · 18 Photonics, Imaging & Optics Lab · 19 Aerospace, Fluid & Environmental Test Arena   |
| E · Research Operations             | 20 Central Conjuring & Integration Workshop · 21 Research Experimentation & Validation Centre · 22 Engineering Documentation & Design Review Studio                                                                       |
| Environments                        | Robotic Manipulation Arena · Motion Capture & Navigation Arena · Underwater Robotics Tank · Aerodynamics & Wind Tunnel Bay · Immersive Design Chamber · Real-World Environment Simulator                                  |
| Corridors                           | Corridor E · Wing A, B, C and D corridors · Environments corridor · Central concourse segments 1–5                                                                                                                        |

The environments are **architectural only**: there is no simulation, flow, hydrodynamics, motion capture or weather behaviour. Their equipment is illustrative (`SIMULATION_VALIDITY.md`: no capability claimed).

## 4. Tests

| Check               | Result                                                                             |
| ------------------- | ---------------------------------------------------------------------------------- |
| `pnpm lint`         | exit 0                                                                             |
| `pnpm typecheck`    | exit 0                                                                             |
| `pnpm format:check` | exit 0                                                                             |
| `pnpm test`         | exit 0: **158 / 158** in 15 files (139 → 158: lifecycle 8, revision-2 facility 11) |
| `pnpm build`        | exit 0                                                                             |
| `pnpm test:e2e`     | exit 0: **21 / 21** (14 existing + 1 layout gizmo + 6 zones)                       |

New browser tests:

- **All 39 zones:** each is entered, its loaded set equals the required set (plus at most 1 prefetch), its interior is rendered, its signs match the registry, and nothing outside the set is mounted.
- **Resource release:** after 84 transitions, GPU resources return exactly to baseline and heap growth stays under 10 MB. A mutation that leaks sign textures makes this fail.
- **Stale load:** held back by delaying the chunk, then ignored.
- **Error and Retry:** shown on an aborted chunk, and Retry recovers.
- **Prefetch:** code only, one at a time.
- **Data safety:** workspace and project data are preserved across transitions.

Existing tests changed because the facility facts changed, not their intent:

- The facility directory now expects 39 enterable zones and 0 planned (it was 29 and 27).
- Two unit tests that asserted "only the slice is implemented" now assert "all zones implemented", and Lab 1 now accepts equipment.
- Every other Phase 1 and Phase 2 test is unmodified.

## 5. Performance

See [PERFORMANCE_BASELINE.md](PERFORMANCE_BASELINE.md). Summary on the real GPU (M3, headed Chrome):

| Measure               | Result                                                                      | Target                   |
| --------------------- | --------------------------------------------------------------------------- | ------------------------ |
| Warm zone transitions | median 9.5 ms, max 18.4 ms (n = 76)                                         | < 300 ms: met            |
| Cold template loads   | 25–68 ms                                                                    | —                        |
| Draw calls            | labs 31–35 (Lab 20: 76 with equipment); environments 29–33; corridors 12–20 | —                        |
| Additional JS heap    | +7.1 MB after two cycles of all zones                                       | < 150 MB: met            |
| Facility GPU memory   | **estimate** 22.5–29 MB                                                     | ≤ 200 MB: met (estimate) |
| Selection latency     | 12–31 ms (including test IPC)                                               | —                        |
| Idle rendering        | 0 frames (demand mode)                                                      | none: met                |

## 6. Resources and repository

- **Free disk:** 9.3 GB, unchanged. No assets were downloaded; everything is procedural.
- **Memory:** about 5 GB of swap was in use throughout. One test run was blocked only by a leftover local preview server on port 4173, which was stopped.
- **Branch:** `phase-2/facility-foundation`, committed as `feat(forge): phase 2 facility — zone lifecycle, all 22 labs and 6 environments`. Not merged and not pushed.

## 7. Known limitations

- ~~Concourse openings showed empty space~~ and ~~no ceilings~~: resolved in the polish pass (§9).
- **Furnishing detail:** furnishings are low-detail primitive assemblies. They identify each discipline but aren't instrument models, and nothing in them has engineering meaning.
- **Default equipment:** only Lab 20 has default workspace equipment. Other rooms have empty, outlined bench floors where equipment can be placed.
- **Equipment draw calls:** each workspace equipment part is still one draw call (76 draws in Lab 20). Instancing it is possible later.
- **Single real-GPU run:** the real-GPU numbers come from one scripted headed run, not repeated trials. GPU memory is an estimate, not a driver measurement. Heavy swapping adds variance, and one cold first entry measured 586 ms during an exploratory run.
- **Error recovery:** retry after a failed chunk load is verified in Chromium only.
- **Layout migration:** migration across facility revisions isn't needed yet (revision-1 layouts validate unchanged) and isn't designed.

## 8. Readiness for Phase 3

The facility, workspace and project layers are complete and verified. Benches and placement areas exist in every room for future equipment, and the lifecycle and resource budgets leave large headroom: under 30 MB estimated GPU and under 10 MB additional heap per loaded set.

Recommended before Phase 3: owner review of the visual direction from the running app, and a decision on ceilings and walk-through navigation, because they affect VR.

**Phase 3 is not started** and needs the owner's explicit go-ahead.

## 9. Final polish pass (after owner approval)

| Item                     | Implementation                                                                                                                                                                                                                                                                    | Evidence                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corridor ↔ concourse gap | Each corridor draws a short **vestibule stub** into an unloaded corridor neighbour (floor, side walls, ceiling, frosted fire-door screen). Corridors are never co-mounted, so the neighbour isn't loaded and lazy loading is unchanged. Stubs are visual only and never colliders | Unit test: every corridor-to-corridor opening has exactly one stub. Browser test: stubs render while the loaded set stays `[corridor]`                                  |
| Ceilings                 | Labs and corridors (and stubs) have ceiling slabs in a separate group. **Automatic cutaway:** a ceiling is drawn only while the camera is below it, checked each frame before rendering, so overhead inspection is unaffected. Environments keep their open roof trusses          | Unit test: ceiling height per zone. Browser test: hidden in the overview, drawn while walking, hidden again after Esc                                                   |
| First-person walking     | **Walk** toggle in the facility view. Controls: WASD and arrows, Shift to go faster, mouse-look by drag or pointer lock (click), eye height 1.6 m, walker radius 0.25 m                                                                                                           | Browser test (below)                                                                                                                                                    |
| Collision                | Derived from the same template and furnishing data the renderer draws. Body-height parts block (walls, glazing, door frames, furnishings); doorways stay open. Movement slides along walls per axis; frame time is clamped to 0.1 s so the walker can't tunnel                    | Unit tests walk Lab 20 → Corridor E → concourse → Wing A → Lab 1 and confirm walls and furnishings block. A mutation that removes colliders makes the browser test fail |
| Zone handover            | Crossing into another zone's footprint makes it current (camera unchanged), so the lifecycle loads it and releases what's no longer required                                                                                                                                      | Browser test: walking out of Lab 20 → Corridor E becomes the only active zone                                                                                           |
| Return to editing        | **Esc** (or releasing pointer lock) stops walking and restores the zone overview. A HUD offers **Stop walking** and **Return to editor**. While walking, clicks never select or edit, and bare-key shortcuts are suppressed                                                       | Browser test: Esc, both HUD buttons, layout and project unchanged by walking, an engineering edit afterwards commits normally                                           |

**Layers:** unchanged. Walking is camera-only and issues no commands. The facility stays read-only, and workspace layouts, project mounting and engineering commands are untouched (all earlier tests pass unmodified).

**Tests:** `pnpm lint`, `typecheck`, `format:check`, `test` (**165 / 165**, 16 files; +7 collision/stub/ceiling), `build` and `test:e2e` (**24 / 24**; +3 walking/ceiling/stub) all exit 0.

**Performance impact (real GPU, headed Chrome, M3):**

| Measure                                              | Before polish                     | After polish                                      |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------------- |
| Overview draw calls: labs / environments / corridors | 31–35 (Lab 20 76) / 29–33 / 12–20 | 31–35 (Lab 20 77) / 29–33 / 14–28 (stubs)         |
| Warm transitions (n = 76)                            | median 9.5 ms, max 18.4 ms        | median 7.9 ms, max 18.0 ms                        |
| Walking                                              | —                                 | about 60 fps, 28–38 draws, estimated 26–29 MB GPU |
| Idle frames after walking stops                      | —                                 | 0 (continuous mode released)                      |
| JS heap after visiting every zone twice              | +7.1 MB                           | +7.9 MB (7.4 → 15.3 MB)                           |

**Disk:** 8.3 GB free after the work, above the 8 GB pause line and below the 15 GB asset line. No assets were downloaded.

**Remaining limitations:** walking has no stairs or levels (the facility is single-storey) and no collision with workspace equipment (only architecture and furnishings block). Pointer-lock look is untested in automation (headless runs use drag-look). Corridor views show a vestibule rather than the full neighbouring corridor.
