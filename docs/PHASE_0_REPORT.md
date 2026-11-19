# Phase 0 report: FORGE foundation

Date: 2026-11-19 · Branch: `phase-0/foundation` · Status: **complete, pending owner review**

## 1. Original repository findings

- **Previous app:** a Babylon.js WebXR "VR workshop W0.1". It was desktop-tested only and never headset-tested.
- **Repository:** git initialised but with **no commits**, remotes or tags.
- **Assets:** no binary assets.
- **Secrets:** none found.
- Full details are in [PHASE_0_AUDIT.md](PHASE_0_AUDIT.md).

## 2. Backup and recovery

| Item          | Location                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archive       | `/Users/advikpunugu/Desktop/VEYRIS/_recovery/VEYRIS_DEVELOPMENT-vr-workshop-w01-20261119-203131.tar.gz` (+ `.sha256`). Verified by extraction and `diff -r` |
| Git commit    | `41e78a2`, the first commit on `main`, tagged `archive/vr-workshop-w0.1`                                                                                    |
| Workshop docs | Kept in the tree under `docs/archive/vr-workshop-w01/`                                                                                                      |

## 3. Files removed or replaced (on `phase-0/foundation` only)

- **Removed:** the Babylon app (`src/**`, 18 files), its tests (4), `index.html`, `vite.config.ts`, `playwright.config.ts`, `tsconfig.json`, `package.json` and `package-lock.json`.
- **Moved to the archive:** README, CLAUDE.md and 7 workshop docs.
- **Rewritten:** `.gitignore` and `.editorconfig`.
- **Deleted, regenerable:** `node_modules`, `dist`, `test-results`.

## 4. New structure

```text
apps/desktop/src/{app,components/ui,features/project,scenes,lib,styles,test}, main.tsx, index.html
packages/{engineering-core,persistence,vey-api}/src
tests/{integration,end-to-end}
assets/{components,materials,environments,reference-models}   (empty)
docs/  MASTER_SPEC, ARCHITECTURE, DEVELOPMENT_ROADMAP, COMPONENT_CATALOG, FACILITY_LAYOUT,
       SIMULATION_VALIDITY, VEY_INTEGRATION, PHASE_0_AUDIT, PHASE_0_REPORT, archive/
root:  package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig.base.json, eslint.config.js,
       vitest.config.ts, playwright.config.ts, .prettierrc, .prettierignore, .editorconfig,
       .gitignore, .env.example, README.md, CLAUDE.md
```

The future packages (catalogue, geometry, assembly, physics, robotics, electronics, experiments, rendering) are documented in ARCHITECTURE.md and not scaffolded.

## 5. Exact dependency versions

| Workspace               | Dependencies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root (dev)              | @eslint/js 10.0.1 · @playwright/test 1.65.1 · @types/node 24.19.2 · eslint 10.15.0 · eslint-plugin-react-hooks 7.1.1 · eslint-plugin-react-refresh 0.5.8 · globals 17.14.0 · jsdom 29.1.1 · lint-staged 17.6.1 · prettier 3.10.1 · simple-git-hooks 2.14.0 · typescript 6.0.3 · typescript-eslint 8.73.0 · vitest 5.1.1                                                                                                                                                                                                                                                |
| @forge/desktop          | react 19.3.1 · react-dom 19.3.1 · three 0.187.0 · @react-three/fiber 9.8.2 · @react-three/drei 10.7.9 · @react-three/rapier 2.2.0 (→ @dimforge/rapier3d-compat 0.19.2) · three-stdlib 2.36.1 · zustand 5.1.0 · lucide-react 1.76.0 · class-variance-authority 0.7.1 · clsx 2.1.1 · tailwind-merge 3.7.0 · tailwindcss 4.3.5 · @tailwindcss/vite 4.3.5 · vite 8.3.8 · @vitejs/plugin-react 6.3.0 · @types/react 19.3.0 · @types/react-dom 19.3.0 · @types/three 0.187.0 · @testing-library/react 16.3.3 · @testing-library/dom 10.4.2 · @testing-library/jest-dom 8.0.0 |
| @forge/engineering-core | zod 4.6.7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The reasons for TypeScript 6 (not 7), React 19.3, jsdom 29 and pnpm via npm are in ARCHITECTURE.md.

## 6. Toolchain

| Tool                | Version                                  | Notes                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js             | 24.2.0                                   | Homebrew                                                                                                                                                                                               |
| pnpm                | 12.21.0                                  | Installed with `npm install -g pnpm@12.21.0` into the user-owned Homebrew prefix. Corepack 0.33 could not run pnpm 12's native layout; its shim was enabled, then removed with `corepack disable pnpm` |
| Playwright Chromium | headless shell 159.0.8154.6 (build 1255) | In `~/Library/Caches/ms-playwright`                                                                                                                                                                    |

## 7. Git

- `main` → `41e78a2`: the archive snapshot.
- `phase-0/foundation` → the Phase 0 commit, "chore(forge): initialize phase 0 development foundation", whose parent is `41e78a2`.
- No remote, nothing pushed, history not rewritten.
- The pre-commit hook (simple-git-hooks → lint-staged, which runs ESLint and Prettier checks) is installed in `.git/hooks`.

## 8. Commands executed (main ones)

```text
tar -czf …/_recovery/…tar.gz (excl. node_modules/dist/test-results) ; extract + diff -r
git add -A && git commit (archive) && git tag -a archive/vr-workshop-w0.1 && git checkout -b phase-0/foundation
git mv docs/* CLAUDE.md README.md → docs/archive/vr-workshop-w01/ ; git rm old app files
corepack enable pnpm (failed: pnpm 12 layout) → corepack disable pnpm ; npm install -g pnpm@12.21.0
pnpm add -E … (exact versions) ; pnpm approve-builds '!simple-git-hooks'
pnpm exec playwright install chromium ; pnpm exec simple-git-hooks
pnpm install --frozen-lockfile | lint | typecheck | format:check | test | build | test:e2e ; pnpm dev (manual launch check)
```

## 9. Test results (final run; real exit statuses)

| Check                            | Result                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | exit 0; no engine, peer or deprecation warnings                                                                                                                            |
| `pnpm lint`                      | exit 0 (0 warnings allowed). Boundary rule verified: a React import in `packages/` is rejected                                                                             |
| `pnpm typecheck`                 | exit 0 (4 workspace projects + tests)                                                                                                                                      |
| `pnpm format:check`              | exit 0                                                                                                                                                                     |
| `pnpm test`                      | exit 0: **40 tests in 5 files** (engineering-core 22, persistence 10, vey-api 3, integration 2, desktop UI 5)                                                              |
| `pnpm build`                     | exit 0. Main chunk 1.31 MB (365 kB gzip); lazy physics chunk 2.26 MB (850 kB gzip, mostly Rapier WASM)                                                                     |
| `pnpm test:e2e`                  | exit 0: **4 Playwright tests** (launch/render/physics/same-origin/no console errors · orbit + camera reset · create→rotate→save→page reload · invalid stored data → error) |
| `pnpm dev`                       | Launched on 127.0.0.1:5173; app rendered in Chromium with no console errors (manual scripted check)                                                                        |
| Git cleanliness                  | Generated folders ignored; no secret or generated files visible to git                                                                                                     |

The acceptance checks from the brief, mapped to evidence:

| Brief item | Evidence                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| 1–6        | Install, typecheck, lint, format, build, unit tests (above)                                            |
| 7, 8       | Browser launch and canvas rendering: e2e test 1 (draw calls and triangles > 0) and a visual screenshot |
| 9, 10      | Orbit and camera reset: e2e test 2                                                                     |
| 11, 12     | Project creation and save/load: UI tests + e2e test 3, across a real reload                            |
| 13         | Invalid data → understandable error: persistence/UI tests + e2e test 4                                 |
| 14         | Playwright smoke: passed                                                                               |
| 15         | Git clean of generated and secret files: passed                                                        |

## 10. Known issues and unresolved items

- **Console warnings, none from FORGE code:**
  - `THREE.Clock … deprecated`, from R3F 9.8.2 on three 0.187.
  - Rapier's "deprecated parameters for the initialization function", from @react-three/rapier 2.2.0 calling rapier3d-compat 0.19.
  - "GPU stall due to ReadPixels", a GL driver performance message in headless Chromium.
- **Duplicate Rapier copy:** `@dimforge/rapier3d-compat@0.12.0` is installed through `@types/three`. It is type-only and not bundled.
- **Bundle size:** the physics chunk is large (inline WASM). It is lazy-loaded, so it doesn't delay the first render.
- **Persistence:** browser `localStorage` only. It is **not a backup**; file export/import is planned for Phase 1.
- **Test hook:** `window.__forge` is a read-only diagnostics hook kept in production builds for local testing. Gating it behind a flag is a Phase 1 decision.
- **WebXR:** not implemented. Quest testing is not applicable in Phase 0.
- **Not verified:**
  - Real-GPU rendering performance (tests use headless Chromium with software WebGL).
  - Browsers other than Chromium.
  - Visual quality beyond one screenshot review.
- **Leftover tooling:** `~/Library/Android/sdk/platform-tools` remains from the previous project.

## 11. Launching FORGE

```bash
cd /Users/advikpunugu/Desktop/VEYRIS/VEYRIS_DEVELOPMENT
pnpm install
pnpm dev        # then open http://127.0.0.1:5173
```

## 12. Readiness for Phase 1

**Ready, pending owner review.**

The foundation, conventions, schemas, persistence boundary and checks are in place. Phase 1 should start with:

1. A validated command dispatcher with undo/redo, built on the archived workshop's revision semantics.
2. File export/import as the durable persistence path.
3. A selection and transform tool.

Phase 1 has **not** been started.
