# Workshop (private): Mindspace WebXR engineering workshop

**Status: W0.1 foundation, implemented and desktop-tested. Not yet headset-tested, so not accepted.**
For the details, see [docs/ACCEPTANCE_MATRIX.md](docs/ACCEPTANCE_MATRIX.md).

The current build is a seated workshop shell rendered with Babylon.js 9.37 (WebGL) and WebXR. It contains:
- A floor, walls and a bench.
- A readable wall panel.
- One generic part.

The part can be selected, grabbed, moved, rotated, released, reset, undone and redone with Quest controllers, or with mouse and keyboard on the desktop. All edits pass through one validated command path.

The app needs no network access at runtime and makes no remote asset requests (enforced by a CSP and checked in tests). It has no telemetry, no AI or model calls, and no backend.

## Requirements

- Node.js ≥ 22.12 (developed on 24.2.0) and npm.
- Google Chrome, for the desktop browser tests. Playwright drives the installed Chrome, so it downloads no browser.
- For the headset: see [docs/HEADSET_ACCESS.md](docs/HEADSET_ACCESS.md). **Not yet set up.**

## Commands

```sh
npm ci                 # install exactly what package-lock.json pins
npm run dev            # open http://127.0.0.1:5173 (loopback only), NOT http://localhost:5173 (see note below)
npm run typecheck      # TypeScript strict
npm test               # Vitest: model, commands, undo/redo, interaction, renderer (headless NullEngine), XR readiness
npm run test:browser   # Playwright in desktop Chrome: real mouse/keyboard against the production build
npm run build          # type-check + production build into dist/
npm run preview        # serve dist/ at http://127.0.0.1:4173
```

**On the Mac, open `http://127.0.0.1:5173`.**
- The dev server listens on the IPv4 loopback only.
- The owner reported that Safari could not open the `localhost` address. See docs/KNOWN_ISSUES.md for what is verified and what is not.
- This applies to the Mac only. On the Quest, the forwarded address is `http://localhost:5173` (see docs/HEADSET_ACCESS.md).

## Desktop controls

| Input | Action |
|---|---|
| Left-drag the part | Move it on the bench plane |
| Q / E | Rotate the selected part ±15° |
| R | Reset the selected part (or all parts) to its home placement |
| Esc | Cancel the current drag |
| ⌘/Ctrl+Z | Undo |
| ⇧⌘/Ctrl+Z or ⌘/Ctrl+Y | Redo |
| Right-drag / wheel / F | Orbit / zoom / reset the camera |

## VR controls (untested on a headset)

| Input | Action |
|---|---|
| Point + trigger | Select a part, or press a wall-panel button |
| Grip (squeeze) while pointing at the part | Grab it, move and rotate it with the controller, release to place |
| Panel buttons | Undo / Redo / Reset part / Exit VR |

## Project layout

```
src/model/        document types, catalogue, validation, math, initial fixture
src/commands/     command contract v1, store (dispatch, history, undo/redo)
src/interaction/  intent boundary + InteractionController (grab transactions)
src/input/        desktop adapter, XR controller adapter (emit intents only)
src/render/       Babylon imports, room, EntityView (document → meshes), wall panel
src/xr/           readiness detection, WebXR setup with remote defaults disabled
tests/unit, tests/e2e
docs/             scope, architecture, headset access, headset test plan, acceptance matrix, issues, log
```
