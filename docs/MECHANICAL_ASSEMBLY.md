# Mechanical assembly (Phase 4, interaction completed in 4.1)

## Data model (project schema v4)

An `assembly` node owns `mechanical`:

```ts
mechanical: {
  grounded: string[];                  // direct children fixed in the assembly frame
  mates: Mate[];                       // joints between two direct children
  constraints: AssemblyConstraint[];   // distance / angle / concentric / coincident / parallel / perpendicular
}
```

- `Mate` has `{ id, name, type, a, b, alignment, offsetRad, coordinates, home, limits, suppressed }`. `a` and `b` are `{ nodeId, ref }`, where `ref` is either an interface id or an explicit frame.
- Body transforms stay ordinary node transforms: the solver writes them through the same command transaction. A project therefore always renders and loads without the solver; the relationships simply re-solve on the next edit.
- Validation on load (Zod `superRefine`):
  - every grounded id and relationship end must be a direct child with a body kind;
  - ids must be unique;
  - joint coordinates must lie within limits.
- v1, v2 and v3 projects migrate to v4 with an empty `mechanical`.

## Commands (validated, undoable, usable inside `scene.batch`)

| Command                                         | Effect                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `assembly.create`                               | New assembly, optionally adopting existing nodes                                    |
| `assembly.insertComponent` / `removeComponent`  | Move a node into or out of an assembly (removal drops its mates)                    |
| `assembly.ground`                               | Fix or free a member                                                                |
| `assembly.mate.create` / `update` / `delete`    | Joints; create re-solves and positions the bodies                                   |
| `assembly.joint.setPosition`                    | Set joint coordinates within limits (`out-of-limits` otherwise)                     |
| `assembly.joint.home`                           | Restore every joint to its home coordinates                                         |
| `assembly.constraint.add` / `update` / `delete` | Geometric constraints (driving or check-only); update edits value, references, role |
| `component.parameters.update`                   | Parametric change; re-solves the owning assembly                                    |
| `model.instance.interfaces.set` (4.1)           | Replace the user-declared interfaces of an imported model                           |

`assembly.mate.update` (4.1) accepts `type` as well as name, alignment, offset, limits, home and suppression:

- **Safe type conversions only:** within {fixed, revolute, prismatic, cylindrical}, which share one frame convention. Coordinates, limits and home values carry over by kind (angle → angle, length → length); new coordinates start at 0 with no limit. Converting to or from ball or planar is refused (`unsupported`), because their coordinates mean something else.
- Home and the current coordinate must lie within the (new) limits (`out-of-limits` otherwise).
- The other mates' coordinates are held; the edited mate re-solves. A conflict is refused atomically with the unsatisfiable relationships named.

**Suppression and check-only.** A suppressed mate and a check-only (non-driving) constraint are ignored by the solver, so they no longer make a body "mate-driven": the body keeps its pose, becomes free (or stays placed by its remaining relationships) and can be moved directly. Constraints have no separate suppressed flag; check-only is their suppression (still reported as satisfied or not).

The engine also offers `engine.preview(command)`: a dry run that validates and runs a command exactly as `execute` would, but commits nothing (no revision, history or listener change). The desktop uses it to preview mates before confirmation and joint poses while a slider is dragged.

## Desktop workflow (assembly inspector)

Select an assembly to open the assembly inspector, which provides:

- **Status:** solver status, mobility (DOF), redundancy, maximum residual and messages.
- **Joints:** a slider and numeric field per coordinate (degrees or millimetres), limits, home value and a **Home** button. Dragging previews live through a dry run, and releasing commits one undoable command.
- **Members:** grounded / mated / free badges, and a ground toggle.
- **Mates & constraints:** each with a satisfied indicator, its role (or _suppressed_ / _check only_), an **Edit** and a delete button.
- **Mate editor (4.1):** name, type (only the safe conversions are offered), alignment, offset (°), per coordinate an optional limit range and the home value (° or mm), and suppression. The draft is validated continuously by an engine **dry run** of the exact command, so out-of-limit values and conflicts are shown (with the relationships the solver names) before anything is committed. **Preview** shows the dry-run pose; **Apply** is one undoable command; **Cancel** discards.
- **Constraint editor (4.1):** value (mm or °), the reference on each body, driving / check-only, name — same dry-run validation, Preview, Apply, Cancel.
- **New mate:** pick two members and their interfaces (compatible counterparts are marked ✓), the type and the alignment.
  - **Fastener checks** appear when one interface is a metric thread.
  - **Preview** shows the solved pose in the viewport, **Confirm** applies it, and **Cancel** discards the preview.
- **New constraint (4.1):** type (distance, angle, concentric, coincident, parallel, perpendicular), a reference on each of two members — a declared interface or a body-origin axis (+X, +Y or +Z) — the value for distance/angle (with the **currently measured** value shown and a "Use current" button), and driving / check-only. A contradictory constraint is shown as an error by the dry run and refused on Add; the assembly is unchanged.
- **Measure:** see GEOMETRY_OPERATIONS.md.
- **Exploded view:** view-only offsets. The model is not changed, and 0 restores exactly. Direct manipulation pauses while exploded.
- **Interference check:** results with highlights.
- **Mass and centre of mass**, with a validity label.

Mate-driven bodies show "Placed by assembly mates" and have no gizmo; move them through their joints instead.

## Drag-to-snap (4.1)

Turn on **Snap to interface** (status bar, or **S**). The transform gizmo is hidden while the mode is on, so ordinary free movement is unaffected when it is off. **F** frames the selection (useful for small parts).

1. Select a free body with declared interfaces (grounded, mate-driven, locked or scaled bodies are refused with the reason) and press on it.
2. Drag: the body follows the pointer in a camera-facing plane. This movement is **render-only**; the model is not touched.
3. Every target interface that is **declared compatible** with one of the body's interfaces (`checkCompatibility`: type pairing, gender, shared descriptor — never proximity or overlap) is highlighted amber; the body's own interfaces are cyan. Targets are the other members of the body's assembly, or members of any assembly for a body outside one.
4. Pairs within 36 px on screen are candidates (green); a translucent **ghost** shows the nearest candidate's solved mate pose (engine dry run).
5. Release near a candidate to open the snap panel: choose the target (all candidates in reach, nearest first), the mate type (suggested from the interface types: slider → prismatic, revolute-joint / matching shaft couplings → revolute, otherwise fixed) and the alignment. The mate is previewed by dry run.
6. **Confirm** issues one validated, undoable command: `assembly.mate.create`, or a `scene.batch` that first inserts the body into the target's assembly. A rejected confirm leaves the model unchanged and the panel open.
7. **Cancel**, **Escape**, releasing away from every candidate, changing the selection, undo/redo or leaving snap mode: nothing is committed and the body is shown back at its unchanged position.

Overlapping meshes never create a mate: only an explicit Confirm does.

## Imported-model interfaces (4.1)

Imported GLB/glTF models can carry **user-declared** connection interfaces (`ModelRef.interfaces`; see ASSET_IMPORT.md). The solver resolves them like catalogue interfaces (frame = declared position, mounting axis as +Z and the declared orientation reference as +X), so imported components take part in every supported mate and constraint, in drag-to-snap, measurement and fastener checks (via their compatibility tags). Removing an interface that a relationship uses is refused.

## Fasteners

`checkFastener` compares declared designations (`M3-thread`, `M3-clearance`, `M3-tapped`, `hole-3.4mm`) and reports:

- nominal-diameter match;
- hole type (clearance vs tapped vs nut);
- length suitability when the grip is known.

These are **dimensional checks only: no thread strength, preload, torque or fatigue is computed or implied.**

## Reusable assemblies (templates v2)

- "Save as reusable assembly" captures:
  - a group or assembly subtree: sub-groups, sub-assemblies, catalogue components, feature parts (feature by feature) and imported model instances;
  - every assembly's grounding, mates and constraints, with ends stored as member indices (`#3`).
- Inserting is **one batch command** with fresh node, mate and constraint ids, so inserting twice never conflicts, and the copies are independent (covered by unit and e2e tests).
- **Export** writes `.forge-assembly.json`, which embeds any model assets. **Import** verifies assets, gives the template a fresh id, and suffixes a clashing name.
- v1 templates (Phase 3) still load.

## Robotic-arm reference assembly

`createRoboticArmSample()` (`@forge/mechanics`), opened from the library:

- The **Robotic arm** assembly has 21 members. The base plate is grounded. Four M4×12 screws and four M4 nuts are mated to the plate's hole interfaces.
- **Revolute joints:**

| Joint    | Limits | Home |
| -------- | ------ | ---- |
| Yaw      | ±150°  | 0°   |
| Shoulder | ±90°   | 0°   |
| Elbow    | ±135°  | −90° |
| Wrist    | ±90°   | 0°   |

- Fixed mates mount the servos, brackets, shaft, bearing, gripper and sensor. Solver status: under-constrained, **mobility 4**.
- Groups **Controller & electronics** and **Power** are positioned, not mated.

Phase 4.1 browser tests (`assembly-interaction.spec.ts`, `model-interfaces.spec.ts`, `phase41-gate.spec.ts`) exercise the editors, drag-to-snap and imported-model interfaces on this sample, including the brief's completion gate in one session.

Acceptance (browser test `tests/end-to-end/mechanical.spec.ts`):

1. Open the sample.
2. Inspect the hierarchy.
3. Move the shoulder within limits. The chain moves rigidly and the base does not. Out-of-limit input is refused.
4. Move the elbow. The upper link stays and the forearm and gripper move.
5. Home restores the pose to 1e-9 m.
6. Explode, then restore exactly. The model revision is unchanged.
7. Save and reload. Joints, limits and pose are intact, and the DOF is still 4.

**Phase 4 itself simulates no actuation.** Phase 5 adds dynamics on top of these mates without changing them: fixed mates weld bodies, revolute/prismatic mates become physics joints with the same limits and sign convention, and the arm sample carries a simulation setup (ROBOTICS_DYNAMICS.md, CAD_PHYSICS_BRIDGE.md). Wiring and electrical behaviour remain unsimulated (Phase 6).

## Phase 5: assemblies in simulation

- Simulation mode never edits the assembly: runs, forces and motor commands act on an isolated physics session; leaving the mode restores the CAD pose.
- Mapping (CAD_PHYSICS_BRIDGE.md): fixed → welded rigid body; revolute/prismatic → joints with limits; ball/cylindrical/planar → joints whose limits are refused unless the user approves dropping them; suppressed mates ignored; driving constraints refused unless approved as ignored.
- The project schema is v5 (simulation setup on the root node); v4 assemblies load unchanged.
