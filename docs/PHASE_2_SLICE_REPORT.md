# Phase 2 report: maintenance + first vertical slice

Date: 2026-11-20 · Branch: `phase-2/facility-foundation` (from `main` = `ab74488`). Status: **vertical slice complete, pending owner acceptance.** The other 21 laboratories and the 6 environments are **not** built.

## 1. Resource management

| Item                            | Result                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| npm cache                       | Verified at `~/.npm` (6.5 GB; `_cacache` 6.1 GB). Ran `npm cache clean --force`. `_cacache` is now 27 MB: 10 entries are owned by `root` (a past `sudo npm`) and were left alone, because cleaning them needs sudo |
| `_npx` (393 MB)                 | Not touched (outside the authorised scope)                                                                                                                                                                         |
| Project dependencies            | Untouched; `pnpm install --frozen-lockfile --offline` still succeeds                                                                                                                                               |
| Old Playwright builds (~2.1 GB) | Not removed; whether other projects use them hasn't been checked                                                                                                                                                   |
| **Free disk**                   | 3.0 GB → **about 10 GB** (95% used). **Below the 15 GB target.** The slice uses procedural geometry only (zone chunks are 1.5–2.4 kB), so no substantial assets were generated                                     |
| Memory                          | 8 GB RAM; swap about 4.3 of 5.1 GB used during the work. Heavy pressure caused one benchmark run to take more than 6 minutes                                                                                       |

## 2. Maintenance (commit `dddcd8d`)

| Item                                         | Implementation                                                                                 | Evidence                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Draw-call counter                            | Totals across all render passes per frame (the axis gizmo's extra pass had masked the scene)   | Browser test compares it with independent WebGL instrumentation. Mutation check: old behaviour gives 9 vs real 12, and the test fails |
| Demand rendering                             | `frameloop="demand"`; continuous mode via `setContinuous(reason)`                              | Browser test: 0 frames while idle, frames on orbit and on selection changes                                                           |
| Atomic batches                               | `scene.batch` (≤ 10,000 steps), one transaction and one history entry; coalescing transactions | 8 unit tests: atomicity, step-indexed errors, no nesting, net no-op, ids preserved on redo                                            |
| Linear validation (found while benchmarking) | `validateGraph` was O(siblings) per node, i.e. quadratic for flat scenes                       | Regression test: 10,000 flat children                                                                                                 |
| Sharing / instancing                         | Reference-counted shared geometry and materials; `InstancedFixtures` for static fixtures       | Unit test (reference counting, dispose) and browser test (shared geometry)                                                            |
| Virtualized hierarchy                        | Windowed rows, auto-scroll to the selection                                                    | Unit test: fewer than 60 DOM rows for 5,000 nodes                                                                                     |

### Before vs after

Headed Chrome 157, Apple M3 GPU. Same grid scenes and steps as the pre-Phase-2 baseline.

| 5,000 objects          | Before   | After                                                   |
| ---------------------- | -------- | ------------------------------------------------------- |
| Select (hierarchy)     | 636 ms   | 91 ms                                                   |
| Numeric edit           | 502 ms   | 47 ms                                                   |
| Import                 | 1,245 ms | 264 ms                                                  |
| JS heap                | 284 MB   | 68 MB                                                   |
| Hierarchy DOM rows     | 5,000+   | 36                                                      |
| Idle frames per second | 60       | 0                                                       |
| Draw calls             | 4,576    | 4,576 (probe now equals WebGL; one per selectable mesh) |

| Engine (Node)                  | Before             | After          |
| ------------------------------ | ------------------ | -------------- |
| 5,000 creates                  | ~14 s (sequential) | 147 ms (batch) |
| Single edit, 10,000 flat nodes | 323 ms             | 10 ms          |
| Redo, 10,000 flat nodes        | 322 ms             | 10 ms          |

Orbit render intervals in demand mode follow the input rate (the test sends a move about every 33 ms). That isn't directly comparable to the old continuous 16.7 ms cadence, but it is identical from 100 to 5,000 objects.

## 3. Vertical slice: Lab 20 + Corridor E

**Implemented:**

- **`@forge/facility`:** a read-only, deep-frozen facility with all 29 zones and site-plan footprints, plus a zone registry with `zonesToLoad`.
- **Coordinate frames:** F → Z → I → M → P.
- **Equipment catalogue** with 5 types.
- **`WorkspaceEngine`:** validated placement (area, category, collision, built zone), locks, single-bench mounting, its own undo history and revision, source policy.
- **Separate persistence:** `forge:workspace:*` and `.forge-workspace.json`, validated against the facility.
- **Desktop app:**
  - Facility view, with lazy zone modules as separate chunks.
  - Procedural workshop: walls with the corridor door, instanced columns, beams, light panels and accent strips, a placement-area outline and a dais ring.
  - Corridor with closed doors to planned labs 21 and 22.
  - Workspace equipment rendering.
  - Engineering and Layout edit layers.
  - Floor-constrained layout gizmo.
  - Workspace panel: zone directory, items, Place, Mount, Focus, Save/Export/Import layout.
  - Item inspector (zone-frame mm and degrees, plus a facility-frame readout).
  - Facility-frame readout for mounted project nodes.

**Phase 1 preserved:** the project format (schema v2), the command contract and all Phase 1 tests are unchanged. 88 of the original core tests and all 6 original editor browser tests pass unmodified, except that the browser tests' wait condition was adjusted for demand rendering.

### Acceptance criteria and evidence

| Criterion                                                                      | Evidence                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Zone registry: all 22 labs and 6 environments registered, only the slice built | Unit test (invariants); browser directory shows 29 entries, 27 planned                                                                                                                                             |
| Lazy loading                                                                   | Browser test: no zone chunk or module before the facility view; exactly `CentralWorkshop` + `CorridorE` after                                                                                                      |
| Fixed architecture not editable                                                | Facility data deep-frozen (unit test). No command addresses zones or walls (unit test). Wall clicks select nothing in either layer, with a positive control that equipment clicks do select (browser test)         |
| Editable workspace layout                                                      | Inspector moves, collision rejection with error, yaw in degrees, Place finds a free spot (browser test); engine rules (unit tests)                                                                                 |
| Separate histories                                                             | Layout undo leaves the project revision unchanged; project undo in the facility view leaves the layout revision unchanged (browser test)                                                                           |
| Project-to-workbench reference                                                 | Mount by id; one bench per project; a single undo step restores both benches (unit and browser tests)                                                                                                              |
| Coordinate transforms                                                          | Exact frame math (unit tests). Rendered world position of a mounted node equals the frame computation, and the inspector shows the same value (browser test)                                                       |
| Separate persistence                                                           | Distinct storage keys and file types; the project file has no workspace data; the layout file references the project by id; both survive a reload (browser test). A corrupt layout import keeps the current layout |

### Facility performance and memory (headed Chrome, M3 GPU)

| Scenario                  | Enter facility | Heap Δ  | Draw calls | Shared resources                           | Idle frames | Layout edit |
| ------------------------- | -------------- | ------- | ---------- | ------------------------------------------ | ----------- | ----------- |
| Default project           | 141 ms         | +0.4 MB | 77         | 35 geometries / 10 materials for 76 meshes | 0           | 39 ms       |
| 2,000-box project mounted | 163 ms         | +9 MB   | 2,078      | 37 / 12 for 2,173 meshes                   | 0           | 20 ms       |

- **Bundles:** main app chunk 392 kB (119 kB gzip) plus a three/R3F vendor chunk 1.07 MB (289 kB gzip); `CentralWorkshop` chunk 2.4 kB; `CorridorE` chunk 1.5 kB; physics chunk (lazy) 2.26 MB.
- **Measurement limits:**
  - JS heap only: GPU memory isn't measured.
  - Render timing is frame cadence, not GPU time.
  - Heavy swapping was present during the measurements.

## 4. Tests

| Check                           | Result                                                              |
| ------------------------------- | ------------------------------------------------------------------- |
| Format, lint, type check, build | exit 0                                                              |
| Unit and integration            | **139 / 139** in 13 files (Phase 1: 103 → 139)                      |
| Browser (Playwright)            | **14 / 14** (6 Phase 1 editor, 2 rendering maintenance, 6 facility) |

## 5. Known limitations

- **Layout gizmo coverage:** no browser test drags the layout gizmo, because its centre handle is hidden when movement is constrained to X/Z and the plane handle is hard to target reliably. Layout moves are covered through the inspector and unit tests.
- **Selection:** single-item selection only in the layout layer. There's no bulk move or snapping to neighbours; snapping is the grid step.
- **Architecture:** procedural and simple: no ceiling (so the overview camera can see in), no textures, no signage text. Visual style is deferred.
- **Facility revision mismatches:** a layout saved against facility revision N loads in a build with revision ≥ N. Migrating layouts across facility revisions is not designed yet.
- **Lazy loading:** zone modules are loaded but never unloaded. That's acceptable with 2 zones, but an unload policy is needed before many zones exist.
- **Draw calls:** engineering objects are still one draw call each. Instancing is only for non-selectable fixtures.
- **Untested environments:** headless tests use software WebGL. Real-GPU numbers come from scripted headed runs only; hands-on use is unverified.
- **Disk:** below the 15 GB target (about 10 GB free).

## 6. Before expanding to 22 zones (owner decisions)

1. **Accept the slice**, or request changes.
2. **Disk:** free more space before generating substantial assets. The candidates are the older Playwright builds (if no other project needs them) and `_npx`.
3. **Visual direction** for zones (Phase 2's holographic style), which affects the asset budget.
4. **Zone unload policy and memory budget** before many zones exist.
