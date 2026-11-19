# Phase 1 report: engineering core and command architecture

Date: 2026-11-20 · Branch: `phase-1/engineering-core` (from `main` = `c8dc95e`) · Status: **complete, pending owner review**

## 1. Original repository state

- **Phase 0 was verified before any change:**
  - `c8dc95e` on `phase-0/foundation`, with `main` (`41e78a2`) as its direct ancestor.
  - Clean working tree, no stashes.
- **Baseline, all exit 0:** lint, typecheck, format check, 40 unit tests and 4 browser tests.
- `main` was fast-forwarded to `c8dc95e` (`--ff-only`), then `phase-1/engineering-core` was created.
- **A genuine Phase 0 project file was captured** (`tests/fixtures/phase0-v1-project.json`) from the Phase 0 code _before_ the schema changed. It is the migration fixture.

## 2. Implementation plan (as executed)

1. Domain math (matrices, Euler, snapping) with no three.js dependency.
2. Scene-graph schema and validation.
3. Copy-on-write transaction with invertible ops.
4. Command contract (Zod discriminated union) and one typed handler per command.
5. `ForgeEngine`: dispatcher, history, queries, capabilities, selection.
6. `TransformSession` for single-entry drags.
7. Project v2 schema, v1 → v2 migration, `.forge.json` serialise/parse.
8. Persistence adapter switched to the shared loading pipeline.
9. Desktop editor: store mirror, viewport, gizmo, hierarchy, inspector, create menu, top bar, status bar, shortcuts.
10. Unit, UI and browser tests at each layer; documentation.

## 3. Modules added or modified

**Added (engineering-core):**

| Area     | Files                                                                             |
| -------- | --------------------------------------------------------------------------------- |
| Math     | `math/mat4.ts`, `math/euler.ts`, `math/snapping.ts`                               |
| Scene    | `scene/schemas.ts`, `scene/graph.ts`, `scene/transaction.ts`                      |
| Commands | `commands/schemas.ts`, `commands/handlers.ts`, `commands/build.ts`                |
| Engine   | `engine.ts`, `editing/transform-session.ts`                                       |
| Project  | `project/schema.ts`, `project/create.ts`, `project/migrate.ts`, `project/file.ts` |
| Tests    | `__tests__/` (6 files)                                                            |

**Added (desktop):**

- `scenes/EngineeringViewport.tsx`
- `features/{hierarchy,inspector,create,toolbar}/*`
- `components/NumberField.tsx`
- `hooks/useShortcuts.ts`
- `lib/format.ts`
- `app/editor.test.tsx`

**Modified:**

| File                        | Change                                             |
| --------------------------- | -------------------------------------------------- |
| `schemas.ts`                | v1 names kept for migration                        |
| `persistence/repository.ts` | Uses the shared loader; canonical JSON             |
| `app/store.ts`              | Rewritten as the engine mirror                     |
| `App.tsx`                   | Editor layout and viewport error boundary          |
| `main.tsx`                  | Query-only debug hook                              |
| `PhysicsLayer.tsx`          | Moved to the new store                             |
| tsconfigs                   | Tests are type-checked separately, with Node types |

**Removed (superseded):**

- `project.ts` (v1 creation code)
- `Phase0Scene.tsx`, `ProjectPanel.tsx` and its test
- `tests/end-to-end/phase0.spec.ts`
- `schemas.test.ts` (v1 API)

## 4. Major architectural decisions

| Decision                                                                                              | Rationale                                                         |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `ForgeEngine` in `engineering-core` is the single authoritative state; React/three only render it     | Mandatory single source of truth; testable without React or WebGL |
| Undo via recorded `put`/`remove` ops of changed nodes (not snapshots)                                 | Exact, cheap, restores ids and parent/child lists                 |
| Every applied change (incl. undo/redo) bumps `revision`; `expectedRevision` optional on commands      | Stale requests can never become valid again after an undo         |
| Gizmo drags are renderer previews committed through `TransformSession` (one command, revision-pinned) | One history entry per drag; no hidden mutation                    |
| World-preserving reparent/ungroup **refuses** transforms that would need shear                        | Never silently distort geometry                                   |
| Effective lock = node or ancestor locked; visibility/lock always editable                             | Predictable safety semantics                                      |
| Group = identity-transform group under the members' common parent                                     | World placement unchanged; simple, invertible                     |
| Snapping is an editor preference, not project data                                                    | Keeps engineering files free of UI state                          |
| Primitive size lives in `geometry`; `scale` is a separate transform property                          | Real dimensions aren't conflated with visual scaling              |
| Own mat4/Euler math instead of three.js in the domain                                                 | Keeps domain packages framework-independent (lint-enforced)       |
| Commands from source `vey` denied by default policy                                                   | Vey needs a permission/audit layer first (Phase 9)                |

## 5. Command schema and examples

**Envelope** (`forge.command/v1`):

```json
{
  "commandId": "3b0d…",
  "type": "scene.node.transform",
  "payload": { "nodeId": "a1f…", "position": [0.15, 0.05, 0.1] },
  "metadata": {
    "source": "desktop-ui",
    "timestamp": "2026-11-20T10:00:00.000Z",
    "expectedRevision": 7,
    "label": "Move"
  }
}
```

`source` is one of `desktop-ui | keyboard | api | test | vey`.

| Type                    | Payload                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scene.node.create`     | `{ node: { kind: 'group' \| 'primitive' \| 'reference', id?, name?, parentId?, index?, transform?, metadata?, visible?, locked?, geometry/color \| referenceType/sizeM } }` |
| `scene.node.delete`     | `{ nodeId }` (deletes the subtree)                                                                                                                                          |
| `scene.node.duplicate`  | `{ nodeId, offset? }` (subtree, new ids)                                                                                                                                    |
| `scene.node.rename`     | `{ nodeId, name }`                                                                                                                                                          |
| `scene.node.transform`  | `{ nodeId, position?, rotation?, scale? }` (at least one)                                                                                                                   |
| `scene.node.reparent`   | `{ nodeId, parentId, keepWorldTransform = true, index? }`                                                                                                                   |
| `scene.node.visibility` | `{ nodeId, visible }`                                                                                                                                                       |
| `scene.node.lock`       | `{ nodeId, locked }`                                                                                                                                                        |
| `scene.node.group`      | `{ nodeIds[], groupId?, name? }` (same parent)                                                                                                                              |
| `scene.node.ungroup`    | `{ groupId }` (bakes the group transform into its children)                                                                                                                 |

**Results:**

```ts
{ ok: true, commandId, type, revision, affectedIds, noop }
{ ok: false, commandId, type, revision, error: { code, message, issues?: [{ path, message }] } }
```

Error codes:

| Code                                                                           | Meaning                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------- |
| `unknown-command`, `invalid-command`                                           | Unknown type, or envelope/payload failed validation |
| `not-found`, `duplicate-id`                                                    | Bad references or ids                               |
| `locked`, `protected`                                                          | Lock or root protection                             |
| `cycle`, `invalid-transform`, `invalid-operation`, `unrepresentable-transform` | Structural or geometric violation                   |
| `stale-revision`, `permission-denied`                                          | Concurrency or policy refusal                       |
| `integrity`                                                                    | Post-command graph check failed                     |

## 6. Scene graph design

The full design is in ARCHITECTURE.md ("Scene graph design"). In summary:

- Nodes are kept as a flat map plus ordered `childIds`, with `parentId` back-references, validated both ways.
- The root is unique and protected.
- Node kinds: root, group, primitive (6 shapes), reference, and the extension points component-instance and assembly.
- Limits: 20,000 nodes and depth 64.
- World transform = parent world × local.

## 7. Undo/redo approach

Undo and redo replay recorded inverse/forward op lists.

| Property  | Behaviour                                        |
| --------- | ------------------------------------------------ |
| Recursion | None: undo and redo never record history entries |
| Branching | Redo is cleared by any new command               |
| Limit     | Configurable (default 200)                       |
| Drags     | One entry per drag                               |
| Keyboard  | ⌘/Ctrl+Z, ⌘/Ctrl+⇧+Z, Ctrl+Y                     |
| Toolbar   | Undo and Redo buttons                            |
| Safety    | Both are refused while a gizmo drag is active    |

## 8. Persistence format

`.forge.json` is canonical JSON of project schema v2 (ARCHITECTURE.md "Persistence").

| Property                   | Detail                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Import validation          | Size (10 MiB), JSON, version, migration, then Zod and graph validation, all **before** the active project is touched |
| Migrations                 | v1 → v2 only (Phase 0 was the only prior format)                                                                     |
| Unknown or future versions | Refused                                                                                                              |
| Quick-save                 | `localStorage`, using the same pipeline (reopens v1 quick-saves)                                                     |
| Durable copy               | Export (download) and Import (file picker)                                                                           |

## 9. API examples (no GUI)

```ts
import { ForgeEngine, createProject, makeCommand } from '@forge/engineering-core';
const forge = new ForgeEngine(createProject('Scripted'));
const r = forge.execute(
  makeCommand(
    'scene.node.create',
    {
      node: {
        kind: 'primitive',
        name: 'Bracket',
        geometry: { shape: 'box', width: 0.08, height: 0.01, depth: 0.04 },
      },
    },
    'api',
  ),
);
if (r.ok)
  forge.execute(
    makeCommand('scene.node.transform', { nodeId: r.affectedIds[0], position: [0.15, 0.05, 0.1] }, 'api'),
  );
forge.queryScene(); // read-only outline with depth/lock state
forge.getWorldTransform(id); // composed world TRS (+ exact flag)
forge.getCapabilities(); // 10 implemented commands + planned future operations
forge.undo();
```

`api.test.ts` covers this, shows that UI and API sources get identical validation, and confirms query results are frozen.

## 10. Test results (final run)

| Check                            | Result                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | exit 0                                                                                                                                                     |
| `pnpm lint`                      | exit 0 (zero warnings)                                                                                                                                     |
| `pnpm typecheck`                 | exit 0 (4 workspace projects + tests)                                                                                                                      |
| `pnpm format:check`              | exit 0                                                                                                                                                     |
| `pnpm test`                      | exit 0: **103 tests / 9 files** (commands 32, history 17, project files 12, scene graph 10, API 7, persistence 7, vey-api 3, integration 2, desktop UI 13) |
| `pnpm build`                     | exit 0. Main chunk 1.42 MB (394 kB gzip); lazy physics chunk 2.26 MB                                                                                       |
| `pnpm test:e2e`                  | exit 0: **6 Playwright tests** (see below)                                                                                                                 |

The Playwright tests cover:

1. Launch: no console errors, 0 requests to other origins, physics ready.
2. Create a 120 mm box → hierarchy → viewport deselect and click-select → numeric X = 250 mm → undo/redo by keyboard and toolbar.
3. Export → delete → import → identical scene.
4. A failed import keeps the project.
5. A gizmo drag of 20 pointer moves gives **one** history entry with 10 mm-snapped values, and the camera doesn't orbit. Escape mid-drag restores and commits nothing. Undo returns to the pre-drag pose.
6. Rename, hide, lock (inspector disabled) and reparent through the parent picker.

**Defects found by the tests and fixed:**

| Defect                                                                                                                 | Fix                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `snap()` distorted radian steps (~1.4e-6°)                                                                             | Now uses 15-significant-digit cleanup                         |
| Clicking empty space never deselected (OrbitControls fires `end` on every click)                                       | Detects real pointer travel instead                           |
| Escape during a gizmo drag caused infinite recursion (`reset()` re-dispatches `objectChange`) that **crashed the app** | Re-entrancy guard, plus an error boundary around the viewport |
| Two lint errors (setState inside effects)                                                                              | Draft-only input state; target resolved in the frame loop     |

**Environment note:** one full e2e run hit a Playwright web-server timeout, and another had a single test take 15 minutes against a 30-second timeout while free memory was about 90 MB. That indicates the machine stalled. The same test passed alone in 0.97 s, and the other runs passed; the final run is recorded above.

## 11. Known issues

- **Headless only:** browser tests run headless Chromium with software WebGL. Real-GPU performance, non-Chromium browsers and trackpad gestures are unverified.
- **Gizmo coverage:** e2e drags only the translate gizmo's centre handle. Axis handles, the rotate/scale gizmos and rotation snapping are exercised by code paths and unit tests (snap math, `TransformSession`), not by a browser drag.
- **Selection:** single-object only in the UI. Groups are selected via the hierarchy (a viewport click selects the clicked primitive).
- **Geometry edits:** primitive dimensions are set at creation and can't be edited afterwards (needs a geometry command). Creation always places objects at x = 400 mm.
- **Inherited warnings:** the console warnings from Phase 0 (THREE.Clock deprecation, Rapier init parameters) remain; they come from the libraries.
- **Debug hook:** `window.__forge` (read-only queries) ships in production builds for local testing.
- **Disk space:** the machine had about 2.3 GB free during the run.

## 12. Deferred work

- Multi-select and box selection.
- Drag-and-drop tree reparenting.
- A geometry-edit command.
- Snapping to other objects or surfaces, and mates (Phase 4).
- Measurement tools beyond the world-position readout.
- A filesystem adapter for overwrite-in-place saves.
- Visual redesign (Phase 2).
- WebXR.
- The Vey permission layer (Phase 9).

## 13. Phase 2 readiness

**Ready, pending owner review.** The engine API, command contract, persistence format and editor shell are stable foundations for building the laboratory environment.

Phase 2 environment geometry should be added as scene content or a separate environment layer, **not** as engineering nodes, unless it is meant to be editable. That decision is needed at the start of Phase 2.

Phase 2 has **not** been started.
