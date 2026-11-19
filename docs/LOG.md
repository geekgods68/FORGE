# Implementation log

## 2026-11-18 · Session 1: Phase 0 + W0.1

### Phase 0
- The workspace was empty: no existing implementation, and no AGENTS.md or CLAUDE.md.
- The enclosing git repository is the home directory. A nested repository was created; there are no commits.
- No Obsidian notes were read (none in the workspace).
- Tools: Node 24.2.0, npm 11.4.2, git 2.49.0, openssl 3.5.2, Google Chrome. `adb` and `mkcert` are absent.

### W0.1 work
- Installed pinned dependencies, after checking versions and licences on npm. Babylon is Apache-2.0.
- Inspected Babylon sources for remote defaults and disabled each one (see ARCHITECTURE.md).
- Built the model, validation, command contract v1, store, interaction controller, desktop and XR adapters, room, entity view, wall panel, readiness detection and the CSP.

### Found and fixed during the session
- Importing Babylon from the package root bundled 6.85 MB. Switched to per-module imports: now 1.60 MB.
- The 0.5 m bench pegboard blocked the wall panel from seated eye height (seen in a screenshot). Reduced it to a 0.15 m riser.
- Float32 renderer read-back broke an exact-equality test. Changed it to a 1 µm tolerance and documented the precision.
- The XR system menu hides the session rather than ending it. Added cancellation of grabs on `visibilitychange`.
- The panel help line was cut off. Split it into three lines.

### Results and gate
- Unit tests: 49 passed. Browser tests: 7 passed.
- Desktop Chrome made 0 requests to other origins.
- **Stopped at the W0.1 headset gate.**
