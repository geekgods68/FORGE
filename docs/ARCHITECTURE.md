# FORGE architecture (Phase 0)

## Stack and versions (exact, pinned in pnpm-lock.yaml)

| Area               | Choice                                                                        |
| ------------------ | ----------------------------------------------------------------------------- |
| Language           | TypeScript 6.0.3 (strict)                                                     |
| Application        | React 19.3.1, Vite 8.3.8 (`@vitejs/plugin-react` 6.3.0)                       |
| 3D                 | three 0.187.0, @react-three/fiber 9.8.2, @react-three/drei 10.7.9             |
| Physics foundation | @react-three/rapier 2.2.0 (bundles @dimforge/rapier3d-compat 0.19.2)          |
| UI                 | Tailwind CSS 4.3.5, shadcn/ui-style copy-in components, lucide-react 1.76.0   |
| State / validation | zustand 5.1.0, zod 4.6.7                                                      |
| Tooling            | pnpm 12.21.0 workspaces, ESLint 10.15 + typescript-eslint 8.73, Prettier 3.10 |
| Testing            | Vitest 5.1.1, Testing Library (React 16.3.3), jsdom 29.1.1, Playwright 1.65.1 |

### Version decisions and their evidence

| Decision                                         | Evidence                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **TypeScript 6.0.3, not 7.0.2**                  | typescript-eslint 8.73 declares a peer range of `typescript >=4.8.4 <6.1.0`                                                                                        |
| **React 19.3.1**                                 | @react-three/fiber 9.8.2 requires `react >=19 <19.4`                                                                                                               |
| **jsdom 29.1.1, not 31**                         | jsdom 30+ requires Node `^24.15`; this machine runs Node 24.2.0                                                                                                    |
| **No separate `@dimforge/rapier3d-compat`**      | @react-three/rapier pins its own (0.19.2), so a second copy would risk duplication. A third copy (0.12.0) arrives only through `@types/three` and is never bundled |
| **pnpm installed with `npm i -g`, not Corepack** | Corepack 0.33 cannot run pnpm 12's native-binary package layout                                                                                                    |

## Module boundaries

```text
apps/desktop ──▶ @forge/persistence ──▶ @forge/engineering-core ──▶ zod
      │                                          ▲
      └──────────────────────────────────────────┘
@forge/vey-api (types only; no runtime dependencies)
```

- **`@forge/engineering-core`:** units, transforms, the 28 category ids, and Zod schemas for every persisted structure, with types inferred from those schemas. It has **no DOM, React or three imports**; ESLint `no-restricted-imports` enforces this for all of `packages/*`.
- **`@forge/persistence`:** the `ProjectRepository` interface, the browser-storage adapter, and migrations.
- **`@forge/vey-api`:** proposed command contracts only (see VEY_INTEGRATION.md).
- **`apps/desktop`:** React UI, R3F scene and a Zustand store. It renders _from_ the project document and never stores renderer objects in it.

Workspace packages export TypeScript source (`"exports": "./src/index.ts"`), which Vite and Vitest compile directly; there is no package build step yet.

## Data flow

```text
user input ─▶ store action ─▶ new immutable Project ─▶ React re-render ─▶ R3F meshes
                         └─▶ ProjectRepository.save/load (validated both ways)
```

- The camera is view state, not project data.
- From Phase 1, project edits will move to validated commands with history; Phase 0 store actions are a minimal stand-in.

## Coordinate and unit conventions (mandatory)

- **Units:**
  - World unit is the **metre**.
  - Angles are **radians** internally; degrees only at the UI boundary (`degToRad` / `radToDeg`).
  - Mass is kg, time is s, temperature is K.
  - Every project stores its `units` explicitly (schema-validated literals).
- **Axes:** **right-handed, +Y up**, −Z forward. This matches three.js and WebXR, so the document needs no axis conversion.
- **Transforms:** `Transform = { position [x,y,z] m, rotation unit quaternion [x,y,z,w] }`, relative to the scene origin.
  - **No scale on instances.** Physical size belongs to the definition.
  - Visual magnification will be a view concern.
- **Origins:** primitive components use their geometric centre as the origin. Imported models must declare their origin convention once import exists (Phase 3).
- **Definitions vs instances:**
  - `ComponentDefinition` is what a part _is_: geometry, material, interfaces, capabilities, provenance.
  - `ComponentInstance` is one placement: its own id, `definitionId`, transform and configuration.
  - Definitions also carry a revision number.

### GLB/glTF import convention (defined now; implemented in Phase 3)

- Assets live under `assets/…` and are referenced by relative URI only (schema-enforced). Remote URLs are rejected.
- Each model declares `unitScaleToMetres` (e.g. 0.001 for millimetre-authored CAD exports) and `upAxis` (`Y` or `Z`).
- `dimensionsValidated: false` by default. Import must compare the model's bounding box against the definition's declared dimensions before it may be marked validated. FORGE never silently assumes an imported model is to scale.
- glTF is right-handed and Y-up by specification. Z-up sources are converted at import, not at render time.

### Lighting and materials

- Phase 0 uses `meshStandardMaterial` (physically based) with a hemisphere light and a directional light, and no environment maps.
- `MaterialDefinition.renderColor` is display-only. Physical properties (e.g. `densityKgPerM3`) are separate and carry a validity status.

## Persistence

- **Interface:** `ProjectRepository { list, load, save, remove }`.
- **Phase 0 adapter:** `BrowserStorageProjectRepository`, using `localStorage` under the key `forge:project:<id>`, with readable JSON.
- **Saves:** the project is validated before writing; invalid data is refused.
- **Loads:** JSON parse → migration by `schemaVersion` → Zod validation. Failures return typed errors (`not-found` / `corrupt` / `unsupported-version` / `invalid`) with field paths, and **never replace the open project**.
- **Migration:** a table keyed by source version, empty while only v1 exists. Newer versions are refused rather than guessed.
- **Not a backup.** Browser storage is per-profile, user-clearable and size-limited. A filesystem adapter (file export/import, later a desktop wrapper) implements the same interface.

## Extension points

| Area                 | Plan                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| WebXR                | A future `@react-three/xr` layer renders the same project; input adapters translate to the same store/command API |
| Commands and history | Phase 1 adds a validated command dispatcher with undo/redo. Vey's API will call the same dispatcher               |
| Catalogue            | Phase 3 fills `ComponentDefinition` data per category                                                             |
| Simulation           | Each capability declares `{domain, status, model, assumptions}`                                                   |

Future packages are documented, not scaffolded: `component-catalog`, `parametric-geometry`, `assembly`, `physics`, `robotics`, `electronics`, `experiments` and `rendering`.

## Security posture (local)

- The CSP is `default-src 'self'`. `'wasm-unsafe-eval'` exists only for Rapier's WebAssembly. Same-origin is verified by the e2e test (0 requests to other origins).
- The dev and preview servers bind to 127.0.0.1.
- `window.__forge` exposes read-only diagnostics for tests (project snapshot, render counters, camera position). It provides no mutation path.
