# Scope

**Sources.** None of these Obsidian notes were read:
- *VR Workshop — Vision, Scope & Architecture*
- *Development & Claude Code Guide*
- *Quest 2 — VR Experiment Plan*
- *VR Gloves — Versioned Development Plan*
- the supporting Quest notes

None of them are present in this workspace. Scope comes from the owner's brief of 2026-11-18. Send copies if the notes differ in a way that matters.

## Owner requirements (summary)

**Product.** A persistent, original, seated-first engineering workshop for the owner's Quest 2. Its areas are:
- the bench
- electronics/soldering
- cutting/measurement
- a robotics test area
- a parts library
- wall/pinned panels
- a holographic concept bay
- a keyboard shelf

**Constraints.**
- No LLM, Vey, voice, or real-hardware control.
- No cloud, database, backend, analytics, or remote runtime assets.
- The 2D Mindspace engine is untouched.
- Every simulation is labelled honestly with its fidelity level.

**Release gates.**
- W0.1: foundation.
- W0.2: electronics slice with HC-SR04 behavioural exercise, save/reopen, undo.
- W0.3: keyboard, notes, holographic concepts.
- W0.4: solder/cut/mechanism procedures and a research route.
- W1.0: integrated, validated across repeated sessions.

Each gate stops for owner review.

## W0.1: implemented in this session

| Feature | State |
|---|---|
| Room, floor, walls, bench, wall panel (procedural, original) | Implemented, desktop-tested |
| One generic part (`generic.enclosure.v1`, GENERIC, fidelity: visual) | Implemented, desktop-tested |
| Canonical document, validation, command contract v1, atomic transactions | Implemented, unit-tested |
| Undo/redo with revision rules | Implemented, unit-tested and desktop-tested |
| Intent boundary; desktop adapter; XR controller adapter | Desktop: tested. XR: **implemented, untested on a headset** |
| Grab/move/rotate/release/cancel/reset | Desktop: tested. XR: **untested** |
| XR readiness/error states | Desktop states tested; headset states **untested** |
| Remote-default suppression + CSP; loopback-only server | Tested on desktop (0 foreign requests) |
| Headset access route | **Proposed only** (HEADSET_ACCESS.md) |

## Explicitly deferred

| Release | Deferred items |
|---|---|
| W0.2 | Save/load files; parts catalogue; ports/nets |
| W0.3 | Keyboard; notes; holographic bay |
| W0.4 | Soldering; cutting; mechanism; research |
| W1.x+ | Hand tracking and gloves (I1–I6); telemetry; Vey integration |
| No release planned | Room-scale locomotion or teleport; physics engine |
