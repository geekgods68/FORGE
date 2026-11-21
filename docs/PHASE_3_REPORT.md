# Phase 3 report: universal component library & conjuring

Date: 2026-11-21 · Branch: `phase-3/component-library` (from `main` = `fffe281`, the Phase 2 polish) · Status: **implemented and verified, pending owner acceptance** (with the partial items in §9). Phase 4 has not been started.

## 1. Starting state

- **Phase 2:** the final polish was merged into `main` (`fffe281`), and the working tree was clean. All 22 labs and 6 environments, project mounting and the coordinate frames were present and tested.
- **Resources:** about 8.3 GB of free disk (just above the 8 GB pause line, below 15 GB), so this phase is procedural only: no models were downloaded or generated. Swap use was 5–5.7 of 6–7 GB throughout.

## 2. Milestones (each committed after its tests passed)

| Milestone                        | Commit         | Content                                                                                                                                                               |
| -------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — catalogue engine             | `e21a120`      | `@forge/components`: schemas, 28-category taxonomy (379 subcategories), 401 families, 191 variants, materials, generators, validation, search, favourites and recents |
| B — parametric geometry          | `622cd25`      | Solids → GPU geometry merged per appearance; reference-counted per-configuration cache; SVG previews; all 401 families checked against the domain bounds              |
| C — conjuring                    | `176e3c3`      | Schema v3 with component references; resolver-validated create and configure commands; scale protection; library panel; ghost placement; component inspector          |
| D — connections and arm pack     | `769e588`      | Interface compatibility inspection and highlighting; group membership; saved assemblies; robotic-arm sample                                                           |
| (fix)                            | `3e239a1`      | Hardened two timing-sensitive unit tests that failed intermittently under heavy swap                                                                                  |
| E — integration and verification | (final commit) | Bench switching and other-lab conjuring tests; GLB/glTF inspection; benchmarks; documentation                                                                         |

## 3. Catalogue

- **Coverage:** 28 categories and **379 subcategories**, every one populated. There are **401 families** with **191 variants and presets**. The full list is in COMPONENT_CATALOG.md.
- **Tier A — fully parametric (102 families):** plates, sheets, blocks, bars, rods, tubes, rectangular sections, structural sections (I, C, L, T), T-slot extrusions (2020, 2040, 3030, 4040, 4080 presets), brackets, machine screws and bolts (ISO heads), nuts, washers, dowels, shaft collars, couplings, gears, linkages, arm links, enclosures, PCB substrates, specimens, test objects, wafers, wire and jumpers, and more.
- **Tier B — dimensional models (172):** named products (Arduino UNO R3, SG90, MG996R, HC-SR04, Raspberry Pi 4 Model B, Raspberry Pi Pico) and standard-dimensioned parts (608-series bearings, NEMA 14/17/23 steppers, IEC cells), plus generic modules, packages, motors, sensors and fans.
- **Tier C — generic-preview catalogue entries (127):** clearly labelled "Generic preview — not a model of a specific product".
- **Data honesty:**
  - unknown values are `null` and shown as "unknown";
  - named products cite their source documents (`datasheet-cited`, not verified by FORGE);
  - commodity modules (L298N-type, MB102-type, breadboards) are `generic`;
  - no family claims any simulation capability (all `unsupported`, enforced by validation).
- **Materials:** 29 typical handbook values marked `approximate`, with unknowns left `null`.

## 4. Conjuring, editing and assemblies

- **Library:** the 28 categories with icons and counts, subcategories, search (name, alias, part number, variant), tier and favourite filters, recents, family detail (variants, parameters in mm, material, specs with data status, references, SVG preview), **Conjure**.
- **Ghost placement:** the active work surface is the project's bench (frame M) in the facility or the 2 × 2 m build area in the project view. Placement snaps to the grid, R and Shift+R rotate, the ghost shows valid or invalid, a click confirms and Esc or Cancel abandon it. No scene object exists until confirmed (browser test).
- **Editing:** select, move and rotate (gizmo and precision fields), duplicate, delete, group, rename, visibility and lock all use the Phase 1 commands. Dimensions, variant and material change through `scene.component.configure`, and scale is locked at 1.
- **Inspector:** identity, tier, data status, editable parameters, material, and read-only dimensions, volume, mass with its source, specs, interfaces, provenance and simulation status.
- **Connections:** the 11 interface types, with metadata on every generator and named model. Clicking an interface lists and highlights compatible interfaces across the project (metadata only).
- **Assemblies:** group membership inspection; save a group as a reusable template (local user data) and re-insert it as one atomic batch.
- **Workspace:** conjuring works in Lab 20 and on benches in other labs (browser test in Lab 1). Moving the project between benches leaves component-local coordinates unchanged (browser test).
- **Robotic-arm sample:** 29 library parts in 4 groups (arm, M4 fastener set, controller and electronics, power), built through engine commands and opened from the library. It renders with no reference warnings and fits a standard bench. No actuation, wiring or joint constraint is claimed.

## 5. Persistence and import/export

- **Schema v3:**
  - v1 and v2 files migrate on load (unit tests) and newer versions are refused;
  - component variant, parameters, material and identity snapshot round-trip byte-identically through canonical JSON;
  - save, reload, export and import preserve positions and metadata (browser test).
- **Missing definitions:** a recoverable warning plus a labelled placeholder of the recorded size, with the data preserved and never substituted (unit and browser tests).
- **Rejected files:** structurally invalid component data (non-unit scale, dangling connection, bad snapshot) is refused, and the current project is kept.
- **External models (GLB / glTF 2.0):**
  - **Implemented:** validation, unit and up-axis conversion, bounding-box measurement, content hash and resource disposal.
  - **Not implemented:** saving or placing imported models as components (see §9).

## 6. Tests

| Check                                      | Result                                                     |
| ------------------------------------------ | ---------------------------------------------------------- |
| `pnpm install --frozen-lockfile`           | exit 0                                                     |
| `pnpm lint` / `typecheck` / `format:check` | exit 0 / 0 / 0                                             |
| `pnpm test`                                | exit 0: **208 / 208** in 22 files (165 → 208)              |
| `pnpm build`                               | exit 0                                                     |
| `pnpm test:e2e`                            | exit 0: **32 / 32** (23 existing + 9 new) on the final run |

- **New unit tests:**
  - taxonomy, catalogue validation (and its rejection cases), search, filters, preferences;
  - geometry dimensions, determinism, bounds, mass and materials;
  - compatibility;
  - engine commands (create, configure, scale protection, locks, duplicate, group, batch atomicity, no-resolver);
  - persistence (round-trip, missing definition, invalid data, v2 migration);
  - the sample, assemblies and GLB validation;
  - GPU geometry for all 401 families.
- **New browser tests (9):** the full conjuring flow (the brief's 18 steps); cancellation and invalid placement; malformed data; the sample; groups and assemblies; connection inspection; bench switching and Lab 1; GLB inspection.
- **Flaky browser tests:** two earlier full runs each had one different failure under machine load.
  - The zone-retry test timed out while Lab 20 was still loading; it passed 3/3 when run alone.
  - The Phase 2 resource-release test compared against a baseline captured before the first frame had uploaded its buffers. The test now waits for a stable snapshot. Steady state is unchanged from Phase 2 (20 geometries, 10 textures), so there's no leak.
- **Existing tests changed** only for intentional facts: the exported schema version is now 3 (5 assertions) and conjuring moved from planned to implemented in the capability list (1 assertion).

## 7. Performance

Measured in headed Chrome on the M3 (real GPU), from one scripted run. Projects were generated through the engine with a mix of 16 component families, or 5,000 identical nuts.

| Components | Import (to rendered) | Draw calls | Geometry builds (cache) | JS heap Δ | Selection | Conjure (click → rendered) | Export |
| ---------- | -------------------- | ---------- | ----------------------- | --------- | --------- | -------------------------- | ------ |
| 100        | 56 ms                | 209        | 16                      | +6.6 MB   | 24–76 ms  | 36 ms                      | 66 ms  |
| 500        | 76 ms                | 984        | 16                      | +12.0 MB  | 31–46 ms  | 35 ms                      | 51 ms  |
| 1,000      | 106 ms               | 1,948      | 16                      | +18.6 MB  | 34–68 ms  | 52 ms                      | 60 ms  |
| 5,000 nuts | 314 ms               | 5,008      | **1**                   | +59.1 MB  | 44–59 ms  | 132 ms                     | 86 ms  |

- **Engine (Node):** batch-creating 100 / 1,000 / 5,000 components takes 10 / 22 / 191 ms.
- **Catalogue search:** 8–11 ms from typing to results in the UI. The unit test bound is under 50 ms per query, best of 3.
- **Geometry cache:** one build per distinct configuration, shared by every instance and disposed on last release.
- **Draw calls:** about one per appearance per instance. Selectable components aren't instanced yet (see §9).
- **Bundles:** the main chunk is 668 kB (204 kB gzip), up from 400 kB (121 kB), because the catalogue, generators and library UI ship in it. GLTFLoader is a lazy 45.6 kB chunk.
- **GPU memory:** not measured.

## 8. Resources and repository

- **Disk:** about 8.3 GB free. No assets were downloaded or generated, and every model is procedural.
- **Git:** branch `phase-3/component-library`. Not merged to `main` and not pushed. Generated benchmark files and screenshots stayed in the session scratchpad, outside the repository.

## 9. Known limitations and partial items

- **GLB/glTF import (partial):** validation, measurement in the confirmed unit and axes, and content hashing are implemented. **Persisting imported models as user components and placing them in projects is not.** There is no STEP or IGES support (that's the CAD phase).
- **Draw calls scale with instances:** components are one draw per appearance per instance (5,000 nuts = 5,008 draws). Instancing selectable components (instance-id picking) is a future optimisation.
- **Catalogue in the main bundle:** it adds about 82 kB gzip. Lazy-loading the catalogue and library is possible later.
- **Geometry fidelity:** threads, gear involutes, spring helices, T-slot cavities and board component placement are simplified, and labelled `approximate` or `envelope`. Named-product geometry reproduces published overall dimensions; detail placement is approximate.
- **Data verification:** no dimension or spec was measured by FORGE. Cited values are transcribed, and clones and variants of commodity parts differ.
- **Connections:** compatibility is metadata-only. No mates, joint limits or circuits are evaluated, and `connections` stay empty (Phase 4 and 6).
- **Placement surface:** the active bench's work surface or the build area. Ghost placement ignores other components (no collision between parts).
- **Saved assemblies:** stored per browser (local user data), not inside projects or files.
- **Benchmarks:** one scripted real-GPU run under heavy swap; variance is likely.

## 10. Readiness for Phase 4

- **Ready:** components are first-class engine nodes with stable definition references, interfaces with frames, gender and descriptors, a reserved `connections` array, groups and assembly templates, and one validated command path. Phase 4 can add mate and constraint commands that consume interface frames without changing the catalogue format.
- **Recommended before Phase 4:**
  - owner review of the catalogue's honesty labels and the conjuring UX;
  - a decision on instanced rendering of repeated components;
  - a decision on whether imported GLB models should become persisted user components.

**Phase 4 is not started.**
