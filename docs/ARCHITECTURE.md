# Architecture and decisions (W0.1)

Status markers:
- **(decided-provisional)**: implemented now; revisit at a gate.
- **(proposal)**: not implemented yet.

## Stack (decided-provisional, bounded to this prototype)

- TypeScript (strict) and Vite 8.
- Babylon.js 9.37.0, core + GUI, WebGL.
- WebXR through Babylon's `WebXRDefaultExperience`.
- Vitest and Playwright (installed Chrome).
- No React, backend, database, physics engine or WebGPU.
- Exact versions are pinned in `package.json` and `package-lock.json`.

## Data flow

```
input adapters ──intents──▶ InteractionController ──envelopes──▶ WorkshopStore.dispatch
 (desktop, XR)                (grab transactions,                 (validate → apply → history)
                               previews → EntityView)                        │
                                                                  subscribe ▼
                                              EntityView.sync(doc) (document → meshes), wall panel
```

- **One authoritative document.** Meshes, drag previews, XR poses and camera state are never saved and never feed back except through commands.
- **Adapters only emit intents.** The future glove and hand adapters will plug into the same boundary.
- **The wall panel only displays state and emits button callbacks.** Its buttons go through the same `InteractionController`, as source `in-world-ui`.
- **`window.__workshop` is a local debug/test hook.** It calls the same validated `dispatch`; it is not a remote interface.

## Coordinates and units (decided-provisional)

- **Units and axes:** metres; right-handed, +Y up, −Z forward. This is the WebXR convention. Babylon runs with `scene.useRightHandedSystem = true`, so no axis conversion is applied.
  - Imported assets (from W0.2 on) must declare their units and handedness.
- **Origin:** the workshop origin. In XR it is aligned to the `local-floor` reference space when the session starts. It is **not** a persistent physical room anchor.
- **Transforms:** `{position [x,y,z] m, rotation unit quaternion [x,y,z,w]}`, relative to the parent. **There is no scale field.**
  - Real dimensions live in part definitions (`dimensionsM` plus `dimensionStatus`).
  - Magnifying the view, scaling a concept and repositioning the user are separate future mechanisms, never edits to dimensions.
- **Display:** millimetres on the panel.
- **Float precision:** Babylon world matrices are 32-bit floats. Poses read back from the renderer during grabs differ from 64-bit values by about 1e-7 m. Committed grab positions therefore carry sub-micron noise; this is irrelevant at workshop scale, and tests compare within 1 µm.

## Document schema v1 (`mindspace.vr-workshop.project`)

| Field | Meaning |
|---|---|
| `schema`, `schemaVersion` | Schema identifier and version (1) |
| `projectId` | Project identifier |
| `revision` | Monotonic integer |
| `units.length = 'm'` | Declared length unit |
| `entities` | Record of `{id, kind:'part', partDefId, name, parentId, transform, home}` |

- `home` is the placement restored by Reset.
- Ports, nets, notes, exercises, assets and provenance arrive in W0.2–W0.3 as additive fields, with a schema-version bump and a migration.

## Command contract v1 (`mindspace.vr-workshop.command/v1`)

This is a separate contract; the 2D Mindspace action schema is untouched.

- **Envelope fields:** `commandId`, `label`, `commands[]`, `expectedRevision`, `requestedBy`, `source`, `timestamp`.
  - `requestedBy` is metadata only, **not** authentication.
  - `source` is one of `desktop | xr | ui | script`.
- **Commands:**
  - `entity.create`
  - `entity.delete` (`cascade` removes descendants atomically)
  - `entity.setTransform`
  - `entity.setParent`
- **Atomicity:** all commands in one envelope form one atomic transaction and one undo step.
- **Validation layers:**
  1. Envelope shape.
  2. State: targets exist, IDs are unique, part definitions are known, geometry is finite/in-bounds/unit-quaternion, there are no parent cycles, and parents are not deleted without cascade.
  3. Authorization: future work. It is not implemented, and this local single-user app is not the future VEYRIS security model.
- **Failures** change nothing: document, revision and history stay intact.

## Revision, undo and redo (decided-provisional)

- Every applied change increments `revision` by 1, **including undo and redo**. An undo therefore cannot make an old external request valid again.
- Undo and redo replay **stored primitive ops** (`put` / `remove` with full previous entity state). They are not re-validated against the original `expectedRevision`.
- A new dispatch clears redo. History is bounded to 200 entries, and no-op edits create no entry.
- **Grabs:**
  - A grab previews in the renderer only.
  - Release commits one `setTransform`, using the revision captured at grab start. If anything changed during the grab, the commit is rejected as stale and the preview is discarded.
  - Undo and redo are refused while a grab is active.
- **Cancellation:** a grab is cancelled with no edit on Esc, desktop window blur, XR controller removal, XR session end, or XR session hidden (system menu).
- **Loading (proposal for W0.2):** the saved final document is loaded as-is. Saved history is data only and is never replayed over it.

## Remote-request suppression (decided-provisional)

These are the Babylon 9.37 defaults that would fetch from the internet, as found by inspecting the package sources, and how each is handled:

| Default | Fetches from | Handled by |
|---|---|---|
| Default XR button | `cdn.babylonjs.com` | `disableDefaultUI` |
| Controller models | `controllers.babylonjs.com` | `doNotLoadControllerMeshes`; procedural proxies used instead |
| Input-profile repository | `immersive-web.github.io` | `disableOnlineControllerRepository` |
| Hand meshes | `assets.babylonjs.com` | `disableHandTracking` |
| GUI 3D "MRTK" controls | `assets.babylonjs.com` textures | Not used; only 2D GUI on meshes |

- The page also sets a CSP of `default-src 'self'` as a second layer.
- No Inspector, loaders, Draco, physics or WASM is imported.
- Fonts are system fonts.
- **Bundle:** per-module Babylon imports in `src/render/babylon.ts` give 1.60 MB minified (380 kB gzipped). The root-package import was 6.85 MB.

## Open proposals (need owner review)

- Bench top at 0.75 m (seated) and 0.4 m in front of the origin; wall panel 2 m away at 1.35 m. Comfort and readability are unverified.
- Grab = grip button, select / UI = trigger. Distance grab follows the aim ray with a fixed offset.
- An in-app recenter is not implemented; the Quest system recenter (hold the Meta button) is relied on.
