# Mechanical assembly (Phase 4)

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

| Command                                        | Effect                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `assembly.create`                              | New assembly, optionally adopting existing nodes                 |
| `assembly.insertComponent` / `removeComponent` | Move a node into or out of an assembly (removal drops its mates) |
| `assembly.ground`                              | Fix or free a member                                             |
| `assembly.mate.create` / `update` / `delete`   | Joints; create re-solves and positions the bodies                |
| `assembly.joint.setPosition`                   | Set joint coordinates within limits (`out-of-limits` otherwise)  |
| `assembly.joint.home`                          | Restore every joint to its home coordinates                      |
| `assembly.constraint.add` / `delete`           | Geometric constraints (driving or check-only)                    |
| `component.parameters.update`                  | Parametric change; re-solves the owning assembly                 |

The engine also offers `engine.preview(command)`: a dry run that validates and runs a command exactly as `execute` would, but commits nothing (no revision, history or listener change). The desktop uses it to preview mates before confirmation and joint poses while a slider is dragged.

## Desktop workflow (assembly inspector)

Select an assembly to open the assembly inspector, which provides:

- **Status:** solver status, mobility (DOF), redundancy, maximum residual and messages.
- **Joints:** a slider and numeric field per coordinate (degrees or millimetres), limits, home value and a **Home** button. Dragging previews live through a dry run, and releasing commits one undoable command.
- **Members:** grounded / mated / free badges, and a ground toggle.
- **Mates & constraints:** each with a satisfied indicator, its role and a delete button.
- **New mate:** pick two members and their interfaces (compatible counterparts are marked ✓), the type and the alignment.
  - **Fastener checks** appear when one interface is a metric thread.
  - **Preview** shows the solved pose in the viewport, **Confirm** applies it, and **Cancel** discards the preview.
- **Measure:** see GEOMETRY_OPERATIONS.md.
- **Exploded view:** view-only offsets. The model is not changed, and 0 restores exactly. Direct manipulation pauses while exploded.
- **Interference check:** results with highlights.
- **Mass and centre of mass**, with a validity label.

Mate-driven bodies show "Placed by assembly mates" and have no gizmo; move them through their joints instead.

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

Acceptance (browser test `tests/end-to-end/mechanical.spec.ts`):

1. Open the sample.
2. Inspect the hierarchy.
3. Move the shoulder within limits. The chain moves rigidly and the base does not. Out-of-limit input is refused.
4. Move the elbow. The upper link stays and the forearm and gripper move.
5. Home restores the pose to 1e-9 m.
6. Explode, then restore exactly. The model revision is unchanged.
7. Save and reload. Joints, limits and pose are intact, and the DOF is still 4.

**No actuation, servo dynamics, torque, payload or wiring behaviour is simulated or claimed.**
