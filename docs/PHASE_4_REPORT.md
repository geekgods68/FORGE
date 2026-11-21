# Phase 4 report: mechanical CAD, assembly constraints & precision engineering

Date: 2026-11-21, Phase 4.1 addendum 2026-11-22 · Branch: `phase-4/mechanical-cad` (from `main` = `7af7260`, Phase 3 fast-forwarded at the start of this phase) · Status: **implemented and verified, pending owner acceptance**, with the limitations in §10. Phase 4.1 (§13) completed the assembly interactions that kept Phase 4 partial. Phase 5 has not been started. Nothing was merged or pushed.

## 1. Starting state and resources

- Phase 3 (`7af7260`) was fast-forwarded into `main` after the ancestry check, with a clean tree.
- Free disk was about 9.2 GB at the start and about 8.3 GB at the end: above the 8 GB pause line and below 15 GB. No assets were downloaded, and no CAD kernel (STEP/IGES) was installed.
- One small dependency was added: `polygon-clipping@0.15.7` (MIT), for planar booleans. `zod` was added to the desktop app's direct dependencies (it was already in the lockfile).

## 2. Milestones

| Milestone                          | Commit       | Content                                                                                                                                      |
| ---------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A–B — foundations and solver       | `3a7dd27`    | Schema v4, mates/constraints/sketch/part/model schemas, `@forge/mechanics`, assembly + sketch solvers, part kernel, measurement, 25 commands |
| E (part) — constrained robot arm   | `60bc500`    | Robotic-arm sample rebuilt as a grounded assembly with 4 limited revolute joints and fastener mates                                          |
| C — assembly construction UI       | `e623ee5`    | Assembly inspector, joints with live dry-run preview, mate creation + preview, explode, interference, mass; `engine.preview`                 |
| D — CAD UI                         | `25ed1ec`    | Part and sketch editors, measurement tool                                                                                                    |
| E — assets and reusable assemblies | `7f43011`    | IndexedDB asset store, GLB custom components, bundles, templates v2 with mates, assembly files                                               |
| F — performance and release        | `5657935`    | Instanced component rendering, benchmarks, 18-step workflow test, docs                                                                       |
| 4.1 — interaction completion       | (4.1 commit) | Mate/constraint editors, constraint creation, drag-to-snap, imported-model interfaces, facility instancing, GPU benchmarks (§13)             |

## 3. Mechanical assembly architecture

- **Layering:**
  - Assemblies are ordinary `assembly` nodes of the engineering project, with `mechanical {grounded, mates, constraints}`. They are not a second scene graph.
  - Facility and workspace are untouched: a project mounted on a bench is relocated by its mount frame only.
- **Solver injection:**
  - The solver and kernel live in `@forge/mechanics` (pure: no React or three, enforced by ESLint).
  - They are injected into `ForgeEngine` as `MechanicsService`. All results are written through the same transaction, so a refused solve changes nothing.
- **Previews:** `engine.preview()` is a dry run used for mate and joint previews.
- **Compatibility:** projects are schema v4, and v1–v3 files migrate. All existing project files remain loadable: the migration tests and Phase 0–3 e2e tests pass.

Details: MECHANICAL_ASSEMBLY.md, ARCHITECTURE.md.

## 4. Mates, solver and DOF

- **Supported mates:** fixed (0 DOF), revolute (1), prismatic (1), cylindrical (2), ball (3), planar (3).
  - Each has an alignment (opposed/aligned), an axial offset, coordinates, a home position, per-coordinate limits and suppression.
- **Constraints:** distance, angle, concentric, coincident, parallel, perpendicular, each either driving or check-only.
- **Not supported:** gear, rack-and-pinion, cam, screw/helical, belt, slot and path mates, and tolerance or limit mates other than box limits on joint coordinates.
- **Solver:**
  - A spanning-tree placement, with Levenberg–Marquardt on loop closures and driving constraints.
  - Residual tolerance is 1e-7 m/rad. Conflicts are refused atomically, and the unsatisfiable mates are named.
- **DOF:** mobility and redundancy come from the rank of the Jacobian. Statuses are fully-, under- and over-constrained, conflicting, and empty.
- **Verification:** analytic forward kinematics to 1e-12 m, plus the cases listed in CONSTRAINT_SOLVER.md.
- **Validity:** kinematic positioning is **verified**. Forces, dynamics and actuation are **unsupported** (SIMULATION_VALIDITY.md).

## 5. CAD operations, measurement, fasteners

- **Sketches:** points, lines, circles and arcs, with 11 constraint types. Tolerance is 1e-9, and DOF and status are shown live. Conflicting constraints are refused. **Extrude to part** is supported.
- **Prismatic part kernel:**
  - base extrude;
  - through/blind holes and pockets/cuts;
  - planar booleans (union, difference, intersection);
  - rectangular and circular patterns, and mirror;
  - feature edit and delete, with regeneration on every change.
- **Invalid geometry is refused** with a reason, and the previous part is kept: self-intersection, degenerate profiles, tools leaving the part, overlaps, splitting results, over-deep features, and more than 20,000 vertices.
- **Volumes** match closed form. Mass is **approximate** (handbook density).
- **Not supported:** fillets, chamfers, revolve, loft, shell, side-face holes, and STEP/STL export (PARAMETRIC_CAD.md).
- **Measurement:**
  - interface distance and axis angle (**exact**, from model frames);
  - bounding-box clearance (**approximate**);
  - declared hole diameter;
  - mass and centre of mass, with validity.
- **Interference:** a broad phase on AABBs, then a narrow phase with oriented-box SAT. Box solids are **verified**; curved, holed or envelope solids are reported as **possible**. Results are highlighted in the viewport and marked stale after edits.
- **Exploded view:** view-only and exactly reversible.
- **Fasteners:**
  - checks: designation and nominal diameter, hole type, and length suitability;
  - the arm's 4 M4×12 screws and 4 nuts are mated to the plate's hole interfaces;
  - **no strength, preload or torque** is computed.

## 6. GLB/glTF, reusable assemblies, bundles

- **GLB/glTF custom components:**
  - Inspect, confirm the unit and up-axis, then save to the local library. The bytes go into the content-addressed **IndexedDB** store, SHA-256 verified.
  - `model.instance.create` places an instance, rendered from the store with a shared, ref-counted template cache.
  - Instances persist across reload (browser-tested).
  - A missing asset becomes a **red labelled placeholder** and is reported, and the instance retries after an import. No engineering data is inferred.
- **Portable bundles:** `.forge-bundle.json` holds the project plus its model bytes.
  - Export is **refused** if any asset is missing.
  - Import verifies every hash before storing anything. A tampered bundle is refused (browser-tested in a fresh profile).
- **Reusable assemblies (templates v2):**
  - They capture sub-assemblies, components, feature parts and model instances, together with grounding, mates and constraints by member index.
  - A template inserts as one undoable batch with fresh ids. Two inserts give independent copies with no id conflicts (unit and e2e tests).
  - `.forge-assembly.json` export/import is supported, and v1 templates still load.

## 7. Robotic-arm demonstration

The `Robotic arm` assembly has a grounded base plate and 4 revolute joints:

| Joint    | Limits | Home |
| -------- | ------ | ---- |
| Yaw      | ±150°  | 0°   |
| Shoulder | ±90°   | 0°   |
| Elbow    | ±135°  | −90° |
| Wrist    | ±90°   | 0°   |

Fixed mates mount the servos, brackets, shaft, bearing, gripper, sensor and fasteners. The solver reports **mobility 4**, under-constrained.

All 7 acceptance points of the brief pass in the browser (`mechanical.spec.ts`):

1. Open the sample.
2. Inspect the hierarchy.
3. Move the shoulder within limits: the arm repositions. Out-of-limit input is refused.
4. Move the elbow: the dependent parts move consistently.
5. Home restores the pose.
6. Explode, then restore.
7. Save and reload: the joints stay intact.

The full 18-step workflow, run in Lab 20, passes in `workflow.spec.ts`. Joint poses are **kinematic only**: no servo torque, speed, payload or stability is claimed.

## 8. Rendering performance

Repeated catalogue components with identical configurations (at least 4) are drawn as one `InstancedMesh` per appearance. Identity, selection, visibility, locks, undo and materials are preserved, and this is browser-tested.

Benchmarks (headless Chromium, **software WebGL**, M3 8 GB; timings are indicative only, counts are deterministic):

| Scene               | Draw calls | Triangles | Insert                       | Undo last insert |
| ------------------- | ---------- | --------- | ---------------------------- | ---------------- |
| 100 components      | 43         | 55,334    | 435 ms                       | 45 ms            |
| 1,000 components    | 43         | 551,234   | 705 ms                       | 38 ms            |
| 5,000 components    | 43         | 2,755,234 | 637–1,487 ms per 1,000 batch | 630 ms           |
| Robotic arm         | 80         | 7,698     | joint move ≈ 42–53 ms        | —                |
| Mixed (arm + 1,000) | 82         | 558,698   | 268 ms; elbow move ≈ 183 ms  | —                |

Draw calls are independent of component count. The raw results are in `docs/archive/phase4-benchmarks.json`, and the details in PERFORMANCE_BASELINE.md. In Phase 4 instancing was project-view only; Phase 4.1 extended it to the facility view and added real-GPU render timings (§13).

## 9. Tests

Final counts: **237 unit/integration tests and 44 browser tests passing** (§11).

- **Unit/integration (Vitest):**
  - solver;
  - CAD kernel;
  - sketch;
  - measurement;
  - the robot arm (kinematics, limits, home, save/reload);
  - engine preview;
  - templates v2 (mates, parts, double insert);
  - instancing plan;
  - all Phase 0–3 suites.
- **Browser (Playwright):**
  - the 18-step workflow;
  - robot-arm acceptance;
  - invalid mates refused atomically, with recovery;
  - part features with exact volumes;
  - rejected geometry;
  - sketch DOF and conflicts;
  - the GLB lifecycle and bundles;
  - assembly file export/import;
  - instancing and benchmarks;
  - all Phase 0–3 specs.
- Two Phase 3 browser assertions expected schema v3 and were updated to v4.

## 10. Known limitations (not concealed; updated for 4.1)

Resolved in Phase 4.1 (§13): the missing mate-editing form, constraint creation form, drag-to-snap, interfaces on imported models, project-view-only instancing, the absence of real-GPU timings, and the GPU-memory readout.

- **Solver:**
  - It is dense and local: it is designed for tens of joints, and stays on the current configuration branch.
  - Ball limits are per-axis boxes.
  - There are no gear, cam, screw or path mates, and no tolerance analysis.
  - A revolute closure cannot detect a flipped alignment (a hinge axis has no sign); a distance constraint cannot move bodies out of coincident origins (zero gradient). Both are documented in CONSTRAINT_SOLVER.md.
- **Relationship editing:**
  - Mate type changes are limited to the safe family {fixed, revolute, prismatic, cylindrical}; ball and planar mates must be deleted and re-created.
  - Constraints have no separate _suppressed_ flag; check-only (non-driving) is their suppression.
  - Constraint references are declared interfaces or body-origin axes (+X/+Y/+Z); faces, edges and points cannot be picked from the geometry.
- **Drag-to-snap:**
  - Only bodies with declared interfaces can snap, onto declared-compatible interfaces; frame-referenced bodies cannot.
  - The drag is a translation in a camera-facing plane (no rotation while dragging); the solved mate supplies the final orientation.
  - Candidates are found in screen space (36 px); interfaces that overlap on screen are all offered, nearest first, and the user picks.
  - A body already in an assembly snaps only onto members of that assembly.
  - Browser-tested in the project view; the same code runs in the facility view but is not browser-tested there.
- **Imported-model interfaces:** entered numerically (no click-to-place on the mesh); declared dimensions are informational; library definitions are updated by saving from a placed instance.
- **CAD:**
  - The kernel is prismatic only. Sketch-to-part is a copy, not a live link.
  - There are no fillets, chamfers, revolves or lofts, and no STEP/IGES/STL import or export.
- **Interference:** box-based. Curved parts give "possible" results only, and there is no mesh/B-rep intersection.
- **GLB:** self-contained files only; the asset store is per browser profile (use bundles to move work).
- **Performance:** real-GPU numbers come from one scripted run in Chromium's headless mode on ANGLE/Metal, as GPU-complete render cost of the current view — not interactive frame pacing with a visible window, not repeated trials, no VR.
- **Rendering diagnostics:** `gpuEstimate` is corrected and unit-tested but remains an estimate (no driver measurement exists in WebGL); it is never shown in the UI.
- **Layout gizmo test:** the Phase 2 `layout-gizmo` browser test failed once in a Phase 4 full-suite run. It passed in every Phase 4.1 full run (2 runs).
- **Disk:** free space was about 8.0 GB at the start of Phase 4.1 and 7.0 GB at the end, below the 8 GB pause line. The workspace itself is about 0.5 GB; the drop is outside it (most likely swap on this 8 GB machine while Chromium ran). No assets were downloaded, and nothing outside the workspace was inspected or deleted.

## 11. Final validation (Phase 4.1 final run, this machine)

| Command                                    | Exit | Result                                     |
| ------------------------------------------ | ---- | ------------------------------------------ |
| `pnpm install --frozen-lockfile --offline` | 0    | lockfile unchanged                         |
| `pnpm lint`                                | 0    |                                            |
| `pnpm typecheck`                           | 0    |                                            |
| `pnpm format:check`                        | 0    |                                            |
| `pnpm test`                                | 0    | **257 passed** (28 files)                  |
| `pnpm build`                               | 0    |                                            |
| `pnpm test:e2e`                            | 0    | **51 passed** (3.2 min)                    |
| `FORGE_BENCH_GPU=1` performance spec       | 0    | 5 passed (real GPU: ANGLE Metal, Apple M3) |

Phase 4 (for reference): 237 unit/integration and 44 browser tests, all exit 0. Earlier Phase 4 full-suite runs had intermittent failures, reported rather than hidden:

- Phase 2 `layout-gizmo` failed once, then passed alone, on rerun and in the final run.
- The new `workflow.spec.ts` failed once, because a poll helper threw before the reloaded project was ready. It was fixed (the poll now retries), then passed 3/3 on repeat and in the final run.

Phase 4.1 runs: the two full browser-suite runs passed 51/51. While the new specs were written, failures were test-side and fixed before the final run: a position check that should have been an orientation check (the gripper's origin is its wrist interface), a 7-vs-4 instancing expectation (selecting a nut drops its batch below the 4-instance threshold), and a virtualized-tree scroll helper. One product bug was found by the new tests and fixed: suppressed mates and check-only constraints still marked a body as mate-driven (§13).

## 12. Readiness for Phase 5

**Phase 5 (simulation and robotics) can build on:**

- joint definitions with types, axes, limits and home positions;
- the kinematic solver (forward kinematics for any pose);
- the mobility and DOF analysis;
- mass and centre of mass for bodies with known density;
- interference checks;
- stable ids and persistence for assemblies.

**Phase 5 dependencies still missing:**

- inertia tensors;
- joint dynamics (torque or speed limits, servo models);
- a Rapier body/joint mapping from mates;
- contact and friction models;
- time integration;
- validation references for dynamics.

Phase 5 will not start without the owner's go-ahead.

## 13. Phase 4.1: mechanical assembly interaction completion

Status: **COMPLETE** against the brief's completion gate, which is browser-tested in one session (`phase41-gate.spec.ts`), with the limitations in §10.

| Task                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Mate editing              | Inspector **Edit** per mate: name, type (safe conversions only), alignment, offset (°), limits and home (° / mm), suppression. Continuous dry-run validation shows limit errors and solver conflicts (naming the relationships) before Apply; Preview / Apply / Cancel; one undoable command. `assembly.mate.update` gained `type` (`convertMate`) and a home-within-limits check.                                                 |
| 2. Constraint creation       | **New constraint** form for distance, angle, concentric, coincident, parallel, perpendicular; references = declared interfaces or body-origin axes; current measured value shown; Preview; contradictory constraints shown and refused with the assembly unchanged. **Edit** (value, references, driving / check-only) via the new `assembly.constraint.update`; delete; undo/redo.                                                |
| 3. Drag-to-snap              | Snap mode (status bar / **S**) replaces the gizmo; render-only drag; compatible targets highlighted from declared metadata only; screen-space candidates with a dry-run **ghost**; release opens a panel (target, type, alignment, preview) → Confirm = one command (insert + mate as one batch if needed); Cancel / Escape / release elsewhere restore the body; undo/redo. **F** frames the selection.                           |
| 4. Imported-model interfaces | User-declared interfaces on GLB/glTF instances (name, type, gender, local position, mounting axis, roll, tags, dimensions), validated, undoable (`model.instance.interfaces.set`), drawn as markers, saved to the custom component, carried by projects, bundles and templates; usable in mates, constraints, snap, measurement and fastener checks; interfaces in use cannot be removed. Nothing inferred from the mesh.          |
| 5. Rendering and diagnostics | Facility-view instancing implemented (low risk: one shared `ProjectContent` inside the existing mount frame; facility resource tests still pass). `gpuEstimate` corrected (dedup by buffer, instance colours, morph targets, all textures), unit-tested, labelled an estimate. Real-GPU benchmarks run (ANGLE Metal, Apple M3): 5,000 instanced components 5.6 ms/frame GPU-complete vs 677 ms software (PERFORMANCE_BASELINE.md). |
| 6. Verification              | +20 unit/integration tests (mate edits and conversion, invalid alignment, constraint edits, driven-body rule, model interfaces incl. legacy files and template round trip, snap logic, GPU estimate, vocabulary parity) and +7 browser tests (mate editor, invalid alignment, constraints, drag-to-snap, rendering, GLB interfaces, completion gate). All Phase 0–4 tests preserved and passing.                                   |
| 7. Docs and Git              | Updated: this report, MECHANICAL_ASSEMBLY, CONSTRAINT_SOLVER, ASSET_IMPORT, PERFORMANCE_BASELINE (+ CLAUDE.md phase line). Committed on `phase-4/mechanical-cad`; not merged, not pushed.                                                                                                                                                                                                                                          |

**Product fix found by the new tests:** suppressed mates and check-only constraints are ignored by the solver, but `isMateDriven` (member badges, gizmo lock) and the engine's transform refusal still counted them. Both now count only driving relationships (`drivingRelations`), with a unit test.

**Compatibility:** project schema stays v4. `ModelRef.interfaces` defaults to an empty list, so files written before 4.1 load unchanged (unit- and browser-tested); no migration is needed. New commands: `assembly.constraint.update`, `model.instance.interfaces.set`; `assembly.mate.update` accepts `type`.

**Completion gate (brief) → evidence:** 1 open the arm, 2 select components, 3–4 drag a screw to a hole, preview, confirm, 5 edit the mate's alignment, 6 create and edit a constraint, 7 import a GLB, declare an interface, mate it to a screw, 8 save, reload, reopen with identical relationships and DOF, 9 undo/redo — all in `phase41-gate.spec.ts`; 10 no regressions — full suite 51/51 and 257/257.
