# CLAUDE.md: workshop project boundaries

- **Scope:** a private WebXR engineering workshop for the owner's Quest 2. Work proceeds in small gated releases (W0.1 → W0.2 → …). **Do not start the next release until the owner has reviewed the current gate.** Current gate: W0.1 headset test.
- **Never:**
  - Push, publish, add tunnels or bind beyond 127.0.0.1 without owner approval recorded in docs/HEADSET_ACCESS.md.
  - Add model/LLM APIs, Vey, agents, voice, telemetry, analytics or remote runtime assets.
  - Control real hardware.
  - Modify the separate 2D Mindspace engine.
  - Read outside this workspace.
- **Git:** this folder has its own repo; the parent home directory has a different repo, so never stage there. Commit only when asked.
- **Code:**
  - Document changes go only through `WorkshopStore.dispatch` (command contract `mindspace.vr-workshop.command/v1`).
  - Input adapters emit intents; they never mutate the document.
  - Babylon value imports go through `src/render/babylon.ts` (per-module paths keep the bundle small).
- **Units and axes:** metres; right-handed, +Y up, −Z forward; the scene uses `useRightHandedSystem = true`.
- **Simulation honesty:** every model carries a fidelity label (visual / procedural / behavioural / calculated / physically-validated). Never raise a label because the graphics look good.
- **Validate before reporting:** `npm run typecheck && npm test && npm run test:browser && npm run build`. Desktop tests are not headset evidence. Never mark manual headset rows as passed without the owner's observations.
