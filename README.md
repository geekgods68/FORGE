# FORGE

Engineering research simulation platform within Project VEYRIS. It is local-first and desktop-first; Meta Quest 2 (WebXR) support comes later.

**Status: Maintenance in Progress.

The app is a desktop engineering editor with:

- a scene hierarchy, inspector and 3D viewport with transform gizmos;
- primitives with real dimensions;
- validated, undoable commands;
- millimetre/degree precision entry and snapping;
- `.forge.json` import/export.

The laboratories, component library and simulations don't exist yet. See [docs/DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md).

## Requirements

- Node.js ≥ 22.12 (developed on 24.2.0).
- pnpm 12.21.0, pinned in `package.json` (`packageManager`).
- For browser tests: `pnpm exec playwright install chromium`, a one-time download of about 100 MB.

## Commands

```bash
pnpm install          # install exact versions from pnpm-lock.yaml
pnpm dev              # http://127.0.0.1:5173 (loopback only)
pnpm build            # type-check packages + production build (apps/desktop/dist)
pnpm preview          # serve the production build at http://127.0.0.1:4173
pnpm lint             # ESLint (zero warnings allowed)
pnpm typecheck        # strict TypeScript across all packages and tests
pnpm test             # Vitest: packages, integration, desktop UI (jsdom)
pnpm test:e2e         # Playwright smoke tests against the production build
pnpm format:check     # Prettier
```

On the Mac, open `http://127.0.0.1:5173`. The server listens on IPv4 loopback only; see docs/archive for the earlier Safari/`localhost` note.

## Repository layout

```text
apps/desktop/                 React + React Three Fiber application
packages/engineering-core/    ForgeEngine: scene graph, commands, undo/redo, math, project schema/files (no UI)
packages/facility/            read-only facility data, zone registry, coordinate frames, WorkspaceEngine (no UI)
packages/persistence/         project + workspace repositories (separate stores and file types)
packages/vey-api/             PROPOSED Vey command contracts (types only; nothing executable)
tests/integration/            cross-package Vitest tests
tests/end-to-end/             Playwright smoke tests
assets/                       future component models, materials, environments (empty)
docs/                         specification, architecture, roadmap, Phase 0 audit/report
docs/archive/vr-workshop-w01/ documentation of the previous Babylon.js VR workshop
```

## Git conventions

- `main` is the primary branch. Work happens on topic branches named `phase-<n>/<topic>`, `feat/<scope>-<topic>`, `fix/<scope>-<topic>` or `docs/<topic>`.
- Commits follow Conventional Commits, `type(scope): summary`. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`. Scopes: `forge`, `core`, `persistence`, `vey-api`, `desktop`, `docs`.
- A pre-commit hook (simple-git-hooks + lint-staged) runs ESLint and Prettier checks on staged files.
- There is no remote. Nothing is pushed or published.
- The previous VR workshop is preserved at tag `archive/vr-workshop-w0.1`.
