# Acceptance matrix

Status vocabulary:
- **Pending**: nothing done.
- **Implemented**: code exists, unverified.
- **Desktop-tested**: automated or desktop evidence.
- **Headset-tested**: owner observed it on the Quest.
- **Accepted**: the owner approved it at a gate.

Simulated poses and desktop runs are **not** headset evidence. No row is Headset-tested or Accepted yet.

| ID | Requirement | Status | Evidence / notes |
|---|---|---|---|
| VR-01 | Equipment/runtime readiness | **Pending** | Host recorded: macOS 26.5.1, M3, 8 GB. Quest OS/browser and controller condition unknown. HEADSET_TEST_W01.md has the record form |
| VR-02 | Constrained secure private headset access | **Pending (proposal)** | HEADSET_ACCESS.md: Option A (USB + `adb reverse`, no LAN exposure) recommended. `adb` not installed; owner decision needed |
| VR-03 | Actual XR enter/exit/re-entry | Implemented | Desktop: `vr-unsupported` and `no-webxr` states tested (e2e), readiness unit-tested. Re-sync creates no duplicate meshes (unit). Headset: pending |
| VR-04 | Controller interaction and input loss | Implemented (XR) / Desktop-tested (logic) | Grab transaction, cancel, source-lost, session-end, foreign-source and stale-commit rules unit-tested. Desktop drag/rotate/reset/Esc/blur e2e-tested. XR adapter not run on a device |
| VR-05 | Readability/comfort | Pending | Desktop screenshot only; the panel is legible on a 1280×800 monitor, which says nothing about the headset |
| VR-06 | Measured performance | Pending | The panel shows a rAF-interval proxy (desktop Chrome: ~16.3 ms mean). Headset measurement not done. GPU time unmeasured |
| VR-07 | Canonical state, commands, undo, rejection integrity | **Desktop-tested** | 26 store tests: malformed, stale, missing target, NaN/∞, bounds, non-unit quaternion, duplicate, unknown part, missing parent, cycles, atomic failure, no-op, cascade delete + undo, redo invalidation, undo-vs-stale, redo-after-old-revision, script = desktop undo, bounded history. e2e scripted path |
| VR-08 | Persistence, invalid files, missing assets | Pending (W0.2) | — |
| VR-09 | Electronics nets, correct/faulted behaviour | Pending (W0.2) | — |
| VR-10 | Privacy, network/resource cleanup | Partially desktop-tested | e2e: 0 requests to other origins (production build, desktop Chrome). Loopback-only server. Remote Babylon defaults disabled (sources inspected). Headset-route cleanup steps documented, not exercised |
| VR-11 | Keyboard, focus, notes, numeric entry | Pending (W0.3) | — |
| VR-12 | Holographic assemblies, scale, alternatives | Pending (W0.3) | — |
| VR-13 | Procedural solder/cut/mechanism | Pending (W0.4) | — |
| VR-14 | Agreed research workflow | Pending (W0.4) | — |
| VR-15 | Complete repeated walkthrough | Pending (W1.0) | — |
| VR-16 | Later input-version calibration/recovery | Pending (W1.x) | — |
| VR-17 | Optional read-only telemetry | Pending (later) | — |

## Negative cases from the brief

| Case | Coverage |
|---|---|
| Missing/stale targets | Unit + e2e |
| Invalid transforms | Unit + e2e |
| Cyclic groups | Unit (parent cycles; groups as such arrive later) |
| Invalid terminal connections | W0.2 |
| Failed import / missing asset | W0.2 |
| Undo after compound deletion | Unit |
| New edit after undo | Unit |
| Session exit while grabbing | Unit (logic); headset pending |
| Input source disconnected | Unit (logic); headset pending |
| Re-entry without duplicated objects | Unit (renderer); headset pending |
| No XR support | e2e |
| No secure context | Unit (detection); not exercised in a real insecure page |
| Loss of a later bridge | Not applicable yet |
