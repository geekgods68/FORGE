# Constraint solver (Phase 4)

Implementation: `packages/mechanics/src/assembly.ts` (assembly solver), `sketch.ts` (2D sketch solver), `linalg.ts` (dense linear algebra). Both are injected into the engine through `EngineOptions.mechanics` (`MechanicsService` in `@forge/engineering-core`). The core holds no solver code, and every solve runs inside a validated, undoable command.

## Assembly solver

### Unknowns and equations

- **Bodies** are the direct children of an assembly node that some mate or constraint references (components, parts, model instances).
- **Grounded bodies** (`mechanical.grounded`) never move. If nothing is grounded, the first related body becomes an **implicit ground**, and the report says so.
- Each **mate** contributes a joint with `MATE_COORDINATES[type]` coordinates:

| Mate        | Coordinates                  | Joint DOF |
| ----------- | ---------------------------- | --------- |
| fixed       | —                            | 0         |
| revolute    | angle about the mate axis    | 1         |
| prismatic   | length along the mate axis   | 1         |
| cylindrical | angle + length               | 2         |
| ball        | 3 angles (rotation vector)   | 3         |
| planar      | 2 in-plane lengths + 1 angle | 3         |

- A mate references a frame on each body: either a declared **interface**, whose position and direction come from the component definition, the part kernel or (4.1) the user's declaration on an imported model, or an explicit **frame** (origin, axis and an x-reference perpendicular to the axis). Mate frames are in body-local metres. Catalogue and part interfaces derive their x-reference from the axis (`defaultXRef`); imported-model interfaces carry the user's own orientation reference.

### Algorithm

1. **Spanning tree.** A breadth-first search from the grounded bodies over non-suppressed mates builds a tree. Each tree mate places its child body exactly:

   `pose(B) = pose(A) · F_A · J(q) · R_z(offset) · Flip · F_B⁻¹`

   Here `F` is the mate frame, `J(q)` the joint motion, `offset` the fixed rotation about the mate axis, and `Flip = R_x(π)` for `opposed` alignment (face to face). For `aligned` alignment, `Flip = I`.

2. **Loop closures** (mates outside the tree) and **driving constraints** (distance, angle, concentric, coincident, parallel, perpendicular) become residual equations in metres and radians. The free joint coordinates of the tree mates are adjusted by **Levenberg–Marquardt** (damped normal equations, central finite-difference Jacobian with h = 1e-7, at most 100 iterations). Joint limits are enforced by projection after each step.
3. **Held coordinates.** `assembly.joint.setPosition` holds the edited joint at its requested value, and `analyzeAssembly` holds all of them. Only unheld coordinates move to satisfy closures.
4. **Acceptance.** A solve is accepted when the maximum residual is ≤ **1e-7 m / rad**. Otherwise the command fails with `constraint-conflict`, names the relationships that cannot be satisfied, and changes **nothing**: the transaction is atomic.

### DOF reporting

Rank and null space come from a Jacobi eigen-decomposition of JᵀJ over all joint coordinates (singular-value threshold `max(1e-9, 1e-6·σmax)`).

- `mobility = unknowns − rank`. Free bodies add 6 each.
- `redundancy = equations − rank`.

| Status            | Meaning                                                      |
| ----------------- | ------------------------------------------------------------ |
| fully-constrained | mobility 0, residual within tolerance                        |
| under-constrained | mobility > 0 (free joints remain), consistent                |
| over-constrained  | redundant equations that are consistent (e.g. a closed loop) |
| conflicting       | residual above tolerance; the edit that caused it is refused |
| empty             | no relationships                                             |

Each relationship report carries its role (`tree`, `closure`, `driving` or `check`), its residual, whether it is satisfied, and which of its coordinates are free (null-space participation).

### Invalidation

- A parameter change that removes or moves an interface used by a mate (`component.parameters.update` / `scene.component.configure`) re-solves the owning assembly. If the interface no longer exists, the change is refused (`invalid-reference`).
- Deleting a body cascades its relationships. Duplicating an assembly remaps relationship ids and ends.
- Mate-driven bodies cannot be moved directly: `scene.node.transform`, reparent, group and ungroup are refused for them. Moving a grounded body re-solves the assembly.
- "Mate-driven" counts only what the solver uses (4.1 correction): **unsuppressed mates and driving constraints**. A body related only through a suppressed mate or a check-only constraint is free and can be moved; previously the UI still treated it as driven.
- Changing an imported model's declared interfaces re-solves its assembly (moving what is mated to a moved interface); removing an interface in use is refused.

## Editing relationships (Phase 4.1)

| Command                              | Held during the re-solve       | Refused when                                                                                                |
| ------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `assembly.mate.update`               | every other mate's coordinates | unsafe type conversion (`unsupported`); coordinate or home outside the limits (`out-of-limits`); conflict   |
| `assembly.constraint.add` / `update` | nothing (all coordinates free) | missing / negative distance, angle outside 0–180° (`invalid-command`); references not members; conflict     |
| `model.instance.interfaces.set`      | — (owner re-solved)            | invalid declaration (schema); an interface still used by a relationship; conflict after moving an interface |

- **Type conversion** (`convertMate`, `@forge/engineering-core`): only within {fixed, revolute, prismatic, cylindrical}, which share the mate-axis convention; coordinates, limits and home carry over by kind and new coordinates start at 0. A converted mate keeps its current pose wherever the kept coordinates allow (revolute → cylindrical: identical pose, verified). Ball (rotation vector) and planar (in-plane translation) coordinates have other meanings, so those conversions are refused rather than guessed.
- **Validation before commit:** the desktop editors run the exact command as an engine dry run (`engine.preview`) on every change of the draft, show the refusal or the solver's conflict message, and commit only on Apply. A refused Apply changes nothing (atomic transaction).
- **Things the solver cannot tell apart (documented behaviour, not bugs):**
  - A **revolute** closure is insensitive to its alignment: a hinge axis has no sign, so flipping it is not a contradiction. A **fixed** (or prismatic) closure is: its orientation is fully constrained, and the flip is refused as a conflict (verified).
  - A **distance** constraint has a zero gradient when its two origins coincide, so it cannot move bodies out of that singular start. The constraint form shows the currently measured value ("Use current") so a value is chosen from a regular configuration.

### Verification (unit tests, `packages/mechanics/src/__tests__/solver.test.ts`, `sample.test.ts`)

| Case                                                          | Result                                   | Status       |
| ------------------------------------------------------------- | ---------------------------------------- | ------------ |
| Two-link revolute chain vs analytic forward kinematics        | agreement to 1e-12 m                     | **verified** |
| Prismatic slider, fixed mount                                 | exact pose                               | **verified** |
| DOF per mate type                                             | 0, 1, 1, 2, 3, 3                         | **verified** |
| Redundant consistent loop                                     | over-constrained, residual < 1e-7        | **verified** |
| Contradictory mates                                           | refused atomically, state unchanged      | **verified** |
| Driving distance constraint on a slider                       | fully constrained at the requested value | **verified** |
| Free body / implicit ground                                   | 6 DOF / reported                         | **verified** |
| Robotic arm: 4 revolute joints, limits, home, save and reload | mobility 4, rigid dependent motion       | **verified** |
| 4.1: alignment flip, offset, limits, home, suppression        | exact poses; refusals leave state intact | **verified** |
| 4.1: safe type conversion (revolute → cylindrical)            | pose unchanged; ball/planar refused      | **verified** |
| 4.1: alignment flip against a fixed loop closure              | refused (`constraint-conflict`), atomic  | **verified** |
| 4.1: constraint value edit / check-only / contradictory edit  | exact; check-only reported; refused      | **verified** |
| 4.1: mate on an imported model's declared interface           | interface frames coincide to 1e-9 m      | **verified** |

The 4.1 rows are in `packages/mechanics/src/__tests__/interaction.test.ts` (unit) and the browser specs `assembly-interaction.spec.ts`, `model-interfaces.spec.ts` and `phase41-gate.spec.ts`.

"Verified" refers to the kinematic geometry only: positions and orientations implied by ideal rigid joints. **No forces, torques, dynamics, friction, compliance, backlash or tolerances are modelled.** The solver is a kinematic positioning tool, not a mechanism simulator (that is Phase 5).

### Limits

- The solver is dense: cost grows roughly with the cube of the free coordinates per assembly, which is fine for tens of joints and not designed for hundreds.
- Levenberg–Marquardt finds _a_ solution near the current configuration. Assemblies with several valid configurations (e.g. elbow up or down) stay on the branch they start from.
- Joint limits are box limits per coordinate. Ball-joint limits are on the rotation vector, not a cone.
- Constraint `value`s are absolute: no tolerances, fits or GD&T.

## Sketch solver

- Variables are the x, y of every point and the radius of every circle.
- There are 11 constraint types: horizontal, vertical, coincident, parallel, perpendicular, equal, distance (point–point or line length), radius, diameter, angle (signed, line to line) and fixed. Arcs add an implicit equal-radius condition.
- Solved by Levenberg–Marquardt to **1e-9**. DOF = variables − rank(J).
- A conflicting constraint is refused (`sketch.constraint.add` fails) and the sketch is unchanged. The status (fully, under, over constrained or conflicting) and the DOF are shown live in the sketch inspector.
