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

- A mate references a frame on each body: either a declared **interface**, whose position and direction come from the component definition or the part kernel, or an explicit **frame** (origin, axis and an x-reference perpendicular to the axis). Mate frames are in body-local metres.

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
