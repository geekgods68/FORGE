# Phase 4 report: mechanical CAD, assembly constraints & precision engineering

Date: 2026-11-21 · Branch: `phase-4/mechanical-cad` (from `main` = `7af7260`, Phase 3 fast-forwarded at the start of this phase) · Status: **implemented and verified, pending owner acceptance**, with the limitations in §10. Phase 5 has not been started. Nothing was merged or pushed.

## 1. Starting state and resources

- Phase 3 (`7af7260`) was fast-forwarded into `main` after the ancestry check, with a clean tree.
- Free disk was about 9.2 GB at the start and about 8.3 GB at the end: above the 8 GB pause line and below 15 GB. No assets were downloaded, and no CAD kernel (STEP/IGES) was installed.
- One small dependency was added: `polygon-clipping@0.15.7` (MIT), for planar booleans. `zod` was added to the desktop app's direct dependencies (it was already in the lockfile).

## 2. Milestones

| Milestone                          | Commit         | Content                                                                                                                                      |
| ---------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A–B — foundations and solver       | `3a7dd27`      | Schema v4, mates/constraints/sketch/part/model schemas, `@forge/mechanics`, assembly + sketch solvers, part kernel, measurement, 25 commands |
| E (part) — constrained robot arm   | `60bc500`      | Robotic-arm sample rebuilt as a grounded assembly with 4 limited revolute joints and fastener mates                                          |
| C — assembly construction UI       | `e623ee5`      | Assembly inspector, joints with live dry-run preview, mate creation + preview, explode, interference, mass; `engine.preview`                 |
| D — CAD UI                         | `25ed1ec`      | Part and sketch editors, measurement tool                                                                                                    |
| E — assets and reusable assemblies | `7f43011`      | IndexedDB asset store, GLB custom components, bundles, templates v2 with mates, assembly files                                               |
| F — performance and release        | (final commit) | Instanced component rendering, benchmarks, 18-step workflow test, docs                                                                       |

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

Draw calls are independent of component count. The raw results are in `docs/archive/phase4-benchmarks.json`, and the details in PERFORMANCE_BASELINE.md. Instancing is project-view only: the facility view still renders per node.

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

## 10. Known limitations (not concealed)

- **Solver:**
  - It is dense and local: it is designed for tens of joints, and stays on the current configuration branch.
  - Ball limits are per-axis boxes.
  - There are no gear, cam, screw or path mates, and no tolerance analysis.
- **Mate editing UI:**
  - The UI creates, deletes, moves joints and grounds members.
  - Alignment, offset, limits, home and suppression are editable through `assembly.mate.update` (command, tested), but **there is no inspector form for them yet**.
  - Constraints (distance, angle and so on) are available as commands and shown in the inspector, but there is **no creation form**.
- **Snapping:** interface-to-interface alignment comes from mates, with preview and confirm. There is **no drag-to-snap** of one component onto another interface in the viewport.
- **CAD:**
  - The kernel is prismatic only. Sketch-to-part is a copy, not a live link.
  - There are no fillets, chamfers, revolves or lofts, and no STEP/IGES/STL import or export.
- **Interference:** box-based. Curved parts give "possible" results only, and there is no mesh/B-rep intersection.
- **GLB:**
  - Self-contained files only.
  - The asset store is per browser profile (use bundles to move work).
  - Imported models have no interfaces, so mating them requires explicit frames; the UI only offers interface-based mates.
- **Performance:**
  - Instancing applies in the project view only.
  - Timings come from software WebGL. Real-GPU frame times were not measured (Phase 10).
- **Rendering diagnostics:** the existing `gpuEstimate` debug readout does not account for instance buffers correctly, so it was excluded from the benchmark results.
- **Layout gizmo test:** the Phase 2 `layout-gizmo` browser test failed once in a full-suite run and passed on its own, on rerun and in the final run. It is timing-sensitive under memory pressure.

## 11. Final validation (final run, this machine)

| Command                          | Exit | Result                                    |
| -------------------------------- | ---- | ----------------------------------------- |
| `pnpm install --frozen-lockfile` | 0    | lockfile unchanged (run with `--offline`) |
| `pnpm lint`                      | 0    |                                           |
| `pnpm typecheck`                 | 0    |                                           |
| `pnpm format:check`              | 0    |                                           |
| `pnpm test`                      | 0    | **237 passed** (25 files)                 |
| `pnpm build`                     | 0    |                                           |
| `pnpm test:e2e`                  | 0    | **44 passed** (4.1 min)                   |

Earlier full-suite runs during this phase had intermittent failures, which are reported here rather than hidden:

- Phase 2 `layout-gizmo` failed once, then passed alone, on rerun and in the final run.
- The new `workflow.spec.ts` failed once, because a poll helper threw before the reloaded project was ready. It was fixed (the poll now retries), then passed 3/3 on repeat and in the final run.

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
