# FORGE architecture (Phase 1 + Phase 2 foundation)

## Stack and versions (exact, pinned in pnpm-lock.yaml)

| Area               | Choice                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Language           | TypeScript 6.0.3 (strict)                                                                                                      |
| Application        | React 19.3.1, Vite 8.3.8 (`@vitejs/plugin-react` 6.3.0)                                                                        |
| 3D                 | three 0.187.0, @react-three/fiber 9.8.2, @react-three/drei 10.7.9 (OrbitControls, TransformControls, Grid, Edges, GizmoHelper) |
| Physics foundation | @react-three/rapier 2.2.0 (bundles @dimforge/rapier3d-compat 0.19.2). Paused world, no simulation                              |
| UI                 | Tailwind CSS 4.3.5, shadcn/ui-style copy-in components, lucide-react 1.76.0                                                    |
| State / validation | zustand 5.1.0 (UI mirror only), zod 4.6.7                                                                                      |
| Tooling            | pnpm 12.21.0 workspaces, ESLint 10.15 + typescript-eslint 8.73, Prettier 3.10                                                  |
| Testing            | Vitest 5.1.1, Testing Library, jsdom 29.1.1, Playwright 1.65.1                                                                 |

**Phase 1 adds no dependencies.** Matrix math, Euler conversion and snapping are implemented in `engineering-core`, so the domain stays independent of three.js.

### Version decisions (from Phase 0, unchanged)

| Decision                       | Reason                                              |
| ------------------------------ | --------------------------------------------------- |
| TypeScript 6.0.3, not 7        | typescript-eslint supports only TypeScript `<6.1.0` |
| React 19.3.1                   | R3F 9.8.2 requires `<19.4`                          |
| jsdom 29.1.1                   | jsdom 30+ needs Node ≥ 24.15; this Mac has 24.2.0   |
| pnpm through npm, not Corepack | Corepack 0.33 cannot run pnpm 12                    |

## Single source of truth

```text
┌──────────── @forge/engineering-core (no React, no three, no DOM) ────────────┐
│ ForgeEngine                                                                   │
│   project (deep-frozen) ── scene graph (nodes, root, hierarchy)               │
│   execute(command) → zod validation → policy → revision check →               │
│     GraphTransaction(handler) → integrity check → commit + history            │
│   undo()/redo() → replay recorded inverse/forward ops                         │
│   queries: getProject · queryScene · getNode · getWorldTransform ·            │
│            getHistory · getCapabilities · getSelection                        │
└───────────────────────────────────────────────────────────────────────────────┘
        ▲ commands (all writers)                       │ subscribe → snapshots
        │                                              ▼
 desktop UI · keyboard · TransformSession       zustand editor store (UI mirror +
 scripts/tests · (Phase 9: Vey)                 tool mode, snap prefs, status)
                                                       │
                                                       ▼
                                  React panels + R3F viewport (render only)
```

- **The scene graph in `ForgeEngine` is authoritative.** Three.js objects are a projection of it.
- **The engine's `execute` is the only engineering mutation path.** Returned data is deeply frozen, so callers cannot mutate state by accident.
- **Gizmo drags are previews.** The renderer object and a `TransformSession` hold intermediate poses; release submits one `scene.node.transform` command. If the command is rejected, the rendered object is re-synced from engine state.
- **Selection is ephemeral engine state:** an array, ready for multi-select. It isn't in history, isn't persisted, and is pruned automatically when nodes disappear.

## Module map

| Path                                                | Responsibility                                                                                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engineering-core/src/math/`                        | `mat4.ts` (column-major compose/decompose/invert, shear detection), `euler.ts` (XYZ ↔ quaternion for the UI), `snapping.ts`                                                         |
| `engineering-core/src/scene/`                       | `schemas.ts` (node taxonomy, geometry, limits), `graph.ts` (validation, ancestry, world matrices, world-preserving local transforms), `transaction.ts` (copy-on-write ops recorder) |
| `engineering-core/src/commands/`                    | `schemas.ts` (command contract v1, discriminated union), `handlers.ts` (one typed handler per command), `build.ts` (envelope helper)                                                |
| `engineering-core/src/engine.ts`                    | ForgeEngine: dispatcher, history, queries, capabilities, selection                                                                                                                  |
| `engineering-core/src/editing/transform-session.ts` | One continuous manipulation, committed as one command                                                                                                                               |
| `engineering-core/src/project/`                     | `schema.ts` (v2), `create.ts`, `migrate.ts` (v1 → v2), `file.ts` (`.forge.json`)                                                                                                    |
| `persistence/`                                      | `ProjectRepository` + browser quick-save adapter (loads through the same migrate/validate pipeline)                                                                                 |
| `vey-api/`                                          | Proposed Vey contracts (still non-operational; see VEY_INTEGRATION.md)                                                                                                              |
| `apps/desktop/src/app/store.ts`                     | Zustand mirror of engine snapshots + UI state; `run()` wraps `engine.execute`                                                                                                       |
| `apps/desktop/src/scenes/EngineeringViewport.tsx`   | R3F renderer, selection, highlight, gizmo, camera                                                                                                                                   |
| `apps/desktop/src/features/`                        | Hierarchy, inspector, create menu, top bar, status bar                                                                                                                              |
| `apps/desktop/src/hooks/useShortcuts.ts`            | Keyboard shortcuts (ignored while typing)                                                                                                                                           |

## Scene graph design

**Node fields:**

| Field               | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `id`                | Stable identifier                                                    |
| `name`              | 1–200 characters                                                     |
| `kind`              | Node type (taxonomy below)                                           |
| `parentId`          | `null` only for the root                                             |
| `childIds`          | Ordered; must mirror the children's `parentId`                       |
| `transform`         | `{position m, rotation unit quaternion, scale}`, local to the parent |
| `visible`, `locked` | Booleans                                                             |
| `metadata`          | Key → number / string / boolean                                      |

**Kinds:**

| Kind                 | Status                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `root`               | Exactly one; protected                                                                                                           |
| `group`              | Implemented                                                                                                                      |
| `primitive`          | Implemented: `geometry` is box / sphere / cylinder / cone / plane / torus with real dimensions in metres, plus a display `color` |
| `reference`          | Implemented: datum axes or point                                                                                                 |
| `component-instance` | **Extension point** for Phase 3 (`definitionId`); used today only for migrated Phase 0 cubes                                     |
| `assembly`           | **Extension point** for Phase 4; behaves as a group container                                                                    |

**Structural validation (`validateGraph`) checks:**

- one root;
- `key === id`;
- parent ↔ child links are consistent in both directions;
- no child is listed twice;
- every node is reachable from the root, which catches both cycles and orphans;
- depth ≤ 64 and node count ≤ 20,000.

Schema validation additionally enforces finite numbers, position ≤ ±10 km, unit quaternions, scale in [1e-6, 1e6], and dimensions in [1 µm, 1 km] with torus tube < major radius.

**Hierarchical transforms:** world = parent world × local, composed from the root.

- Reparenting keeps the world transform by default. The new local is computed as parent world⁻¹ × node world.
- **If that would need shear** (a rotated child under a non-uniformly scaled parent), the command is refused with `unrepresentable-transform` rather than silently distorting the object.

**Lock semantics:**

- A node is _effectively locked_ if it or any ancestor is locked.
- Effectively locked nodes reject transform, rename, delete, reparent and group. Their parents reject new or removed children.
- Visibility and lock/unlock are always allowed (they are view and safety properties).
- The root can't be deleted, transformed, reparented, hidden, locked or duplicated.

## Command architecture

See PHASE_1_REPORT.md §5 for the envelope and examples.

**Dispatch order:**

1. Known type (`unknown-command`).
2. Zod envelope + payload (`invalid-command`, with field-level issues).
3. Source policy (`permission-denied`; source `vey` is denied until Phase 9).
4. Optional `expectedRevision` (`stale-revision`).
5. Handler inside a `GraphTransaction`, which throws typed `CommandError`s (`not-found`, `locked`, `protected`, `cycle`, `duplicate-id`, `invalid-transform`, `invalid-operation`, `unrepresentable-transform`).
6. Integrity re-validation of every touched node plus the whole graph.
7. Commit.

Any failure discards the transaction, so there is **no partial mutation**. No-op commands succeed with `noop: true`; they don't bump the revision or add history.

**Extensibility:** a new command adds a payload schema to `PAYLOAD_SCHEMAS` and the envelope union, a handler to `HANDLERS`, and a case in `run`. TypeScript ensures handler and payload types match.

## Undo/redo

- **History entries:** each records `{forward ops, inverse ops, affectedIds, label}`. Ops are `put(node)` / `remove(id)` with full node states, captured by the transaction as the command runs. Only the changed nodes are stored, never whole-project snapshots.
- **Undo/redo** replay ops, re-validate graph integrity, and advance the revision. They never create history entries of their own.
- **Branching:** a new command clears the redo stack.
- **Limits:** history is configurable (default 200; the oldest entries are dropped).
- **Drags:** a continuous drag produces one entry via `TransformSession`. It is pinned to the revision at drag start, so a drag that overlaps another change is rejected as stale instead of clobbering it.
- **Revision semantics:** every applied change (command, undo, redo) increments `project.revision`, so undo can't make an old revision-pinned request valid again.
- **Ids:** they are generated once and stored in the ops, so redo restores identical ids.

## Coordinates, units, precision

- **Units:** metres, radians, kilograms, seconds and kelvin internally. Right-handed, +Y up, −Z forward, matching three.js and WebXR, so no axis conversion exists anywhere.
- **The UI shows** millimetres (position and dimensions), degrees (rotation, XYZ intrinsic order like three.js) and ratios (scale).
- **Rotation is stored as a quaternion.** Editing one Euler field rebuilds the quaternion from the full-precision Euler angles of the current rotation, not from the rounded display.
- **Display rounding never reaches stored data.** An inspector field commits only if its text actually changed. Values are set absolutely, never by accumulating deltas, so repeated edits don't drift.
- **Snapping** is an editor preference (UI store + `localStorage`, not the project): 10 mm translation and 15° rotation by default, applied to gizmo manipulation. `snap()` cleans binary noise at 15 significant digits, so radian steps aren't distorted. Numeric entry is exact and unsnapped.

## Persistence

- **Format:** schema v2 (`.forge.json`) holds `{schemaVersion 2, id, name, createdAt, updatedAt, revision, units, materials, definitions, scene{rootId, nodes}}`.
  - Canonical JSON: keys sorted recursively and 2-space indentation, so the same state gives byte-identical files.
  - Editor UI state (selection, camera, tool, snap) is not stored.
- **Loading pipeline** (quick-save, open and import alike): a 10 MiB size guard, then JSON parse, version check, migration, and full Zod and graph validation.
  - Failures return `corrupt` / `invalid` (with paths) / `unsupported-version` / `too-large`, and **never touch the active project**.
- **Migration:** v1 (Phase 0) → v2 is the only migration, because it is the only earlier format that existed.
  - The v1 scene becomes the root, and instances become `component-instance` nodes with scale 1. Ids, names, transforms, definitions and materials are preserved.
  - It is tested against a fixture produced by the genuine Phase 0 code.
- **Storage:**
  - _Quick-save:_ browser `localStorage`, which is not a backup.
  - _Durable copy:_ Export (download) and Import (file picker).
  - Import asks for confirmation before discarding unsaved changes.

## Rendering conventions

- Groups mirror nodes one-to-one; primitives use real geometry dimensions.
  - Plane: XZ ground orientation.
  - Torus: axis along +Y.
  - Cylinder and cone: along +Y.
- Selected meshes get an emissive tint and edge lines; selected groups get a bounding box.
- The gizmo is shown only for single, visible, unlocked, non-root selections. Orbit is disabled while dragging (verified in e2e).
- The viewport sits inside an error boundary, so renderer failures can't take down the panels.

## Phase 2: hybrid facility architecture

FORGE has three layers. Each has its own owner, its own permissions and its own persistence, and no layer can modify another.

| Layer                   | Contents                                                                                    | Owner / authority                                                | Mutation path                                                                                         | Persistence                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Facility**            | Wings, the 22 laboratories, the 6 environments, corridors, walls, fixtures, placement areas | Shipped content in `@forge/facility` (`FACILITY_V1`, `revision`) | **None.** The data is deep-frozen, no command exists for it, and its meshes are non-pickable          | Not persisted by users; versioned in the repository                     |
| **Workspace**           | Workbenches, cabinets, instruments and their poses; which project is mounted on which bench | User                                                             | `WorkspaceEngine.execute` (`forge.workspace-command/v1`), with its own undo/redo history and revision | `forge:workspace:<id>` (localStorage) and `.forge-workspace.json` files |
| **Engineering project** | The Phase 1 scene graph                                                                     | User                                                             | `ForgeEngine.execute` (`forge.command/v1`), unchanged                                                 | `forge:project:<id>` and `.forge.json`, **unchanged schema v2**         |

Links between layers are **references only**:

- A workspace item points to a zone and a placement area by id.
- A workbench item holds `mountedProjectId`.
- Project files never contain facility or workspace data, and layout files never contain scene graphs. Tests enforce both.

### Edit layers in the UI

The facility view has two edit layers: **Engineering**, which acts on project nodes, and **Layout**, which acts on workspace items.

- **Targeting:** the gizmo, selection, Delete, and undo/redo all follow the active layer. Each layer has its own history.
- **Architecture:** never a target in either layer. It has no event handlers and no raycast, and no command exists that could address it.
- **Layout gizmo:** limited to floor translation (X/Z) and yaw rotation. Every committed move is validated: the footprint must be inside the placement area, must not collide with other items, the category must be allowed there, and the zone must be built. A rejected move snaps back.

### Coordinate-frame system

All frames use metres, are right-handed, +Y up and −Z north, and every frame-to-parent transform is rigid (translation plus yaw). Conversions are therefore exact inverses and never introduce shear.

| Frame          | Origin                                            | Posed in |
| -------------- | ------------------------------------------------- | -------- |
| **F** facility | Facility datum: centre of Corridor E, floor level | —        |
| **Z** zone     | `zone.pose`                                       | F        |
| **I** item     | `item.pose` (floor-level, yaw only)               | Z        |
| **M** mount    | `equipment.mount` (work-surface centre, top)      | I        |
| **P** project  | The project root ≡ M when mounted                 | M        |

- **API** (`@forge/facility/frames`):
  - `chainToFacility(chain)` / `facilityToChain(chain)`;
  - `pointToFacility`, `pointFromFacility`, `convertPoint(from, to)`, `transformToFacility(nodeTransform, chain)`;
  - chains via `zoneChain`, `itemChain` and `mountChain`.
- **Renderer:** the project root is rendered under a group whose matrix is `chainToFacility(mountChain(...))`. The inspector shows a node's facility-frame position using the same functions.
- **Verified exact:** frame math is checked in unit tests (round trips, yaw, composition). The browser test confirms that the rendered world position equals the frame computation.

### Zone registry and lazy loading

- **Registry:** `FACILITY.zones` holds all 29 zones (22 labs, 6 environments, 1 corridor). Each has a pose, a reserved footprint on the site plan, portals, placement areas, a `status` (`implemented` or `planned`) and a `moduleKey`.
- **Loading:** `zonesToLoad(current)` returns the current zone plus implemented zones reachable through _open_ portals. Planned zones have no module and can never load.
- **Modules:** each implemented zone module is a separate Vite chunk, loaded with `React.lazy` (`apps/desktop/src/facility/zoneModules.ts`). The browser test confirms no zone chunk is requested before the facility view opens.
- **Adding a zone:** add data in `facility-v1.ts`, one line in `ZONE_MODULES`, and the module file. `validateFacility` checks invariants (labs 1–22 exactly once, 6 environments, no overlapping footprints, portals resolve, placement areas inside footprints).

### Rendering infrastructure (Phase 2 maintenance)

- **Demand rendering:** `frameloop="demand"`, so frames render only on change. Drei controls call `invalidate()`. `setContinuous(reason, on)` switches to continuous rendering for future simulations or XR.
- **Draw counter:** accumulates across all render passes per frame (`gl.info.autoReset = false`, reset at priority −1000). It is checked against independent WebGL instrumentation.
- **Shared resources:** geometries and materials are reference-counted (`rendering/resources.ts`). `InstancedFixtures` draws repeated static geometry in one draw call; it is used for facility fixtures only, never for selectable engineering objects.
- **Virtualized hierarchy:** fixed 28 px rows, overscan of 8, auto-scroll to the selection.
- **`scene.batch`:** atomic multi-command transactions with a single history entry. Transactions coalesce writes (a first-touch snapshot, then value-compared net ops), and `validateGraph` is linear.

### Forward compatibility (designed for, not implemented)

| Future capability                   | Hook in this architecture                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 28 component categories / conjuring | `component-instance` nodes in projects; workspace equipment catalogue; benches host projects                       |
| Multiphysics simulation             | Continuous-render mode; rigid frames; validity statuses on capabilities                                            |
| CAD interoperability                | GLB/glTF conventions (units, up-axis, validation flag) unchanged from Phase 1                                      |
| Multiplayer engineering             | Both layers are command logs with revisions and expected-revision checks. Merge/CRDT is **not** designed yet       |
| Vey                                 | Both engines share the envelope shape, structured results and a source policy (`vey` denied until Phase 9)         |
| Quest 2 / WebXR                     | Same units and axes as WebXR. Frame F maps to an XR reference space; XR sessions must request continuous rendering |

## Security posture (local)

- The CSP is same-origin, plus `'wasm-unsafe-eval'` for Rapier only. The e2e test verifies there are 0 requests to other origins.
- The servers bind to 127.0.0.1.
- `window.__forge` exposes **query methods only**: no execute, undo or replace.
