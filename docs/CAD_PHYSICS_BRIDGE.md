# CAD-to-physics bridge

`buildPhysicsModel(scene, definition)` (`packages/physics/src/bridge.ts`) converts the authoritative engineering scene and the simulation definition into a `PhysicsModel`: plain data, no Rapier. It never throws for user data; every problem becomes an **issue** (`error` blocks the run, `warning` is shown, `info` is listed) and every modelling simplification becomes an **assumption** shown with the run.

## Bodies

1. **Body units.** Every member of an assembly (component, part, primitive, imported model, or a nested group/assembly treated as one rigid unit) and every loose body outside assemblies.
2. **Mode** (`BodySettings.mode`): `auto` = assembly member → dynamic (grounded → fixed); loose body → fixed obstacle. Explicit `dynamic`, `fixed`, `kinematic` (prescribed constant velocity) or `excluded`.
3. **Welding.** Units joined by unsuppressed **fixed** mates are merged into one rigid body (union-find). This is exact for ideal rigid fixed joints and far more robust than stiff fixed joints in an iterative solver. Fixed + kinematic members in one weld is an error.
4. **Frames.** Each physics body's frame is world-aligned at t = 0, at its centre of mass (dynamic) or at its first unit's origin. Each unit stores `body⁻¹ · unit` so its simulated world pose is `pose(t) · offset`. Bodies scaled through their parents are refused (only a primitive's own scale is allowed, baked into its geometry).

## Mass properties (never from appearance)

| Mass source (`BodySettings.mass`) | Mass                                                     | Inertia                                       | Status      |
| --------------------------------- | -------------------------------------------------------- | --------------------------------------------- | ----------- |
| `model`, density known            | modelled primary-solid volume × typical handbook density | closed-form per solid, parallel-axis composed | approximate |
| `model`, published mass           | datasheet-cited mass (e.g. MG996R 55 g)                  | envelope solids, uniform density              | approximate |
| `user`                            | user-supplied kg (with a note)                           | modelled solids, uniform density              | approximate |
| `material`                        | modelled volume × selected material density              | closed-form                                   | approximate |
| `model`, unknown                  | **error** — supply a mass or select a material model     | —                                             | —           |

Closed forms (`mass.ts`): box (with yaw), cylinder, tube, sphere, and polygon prisms with holes (exact second moments of the polygon). Tests check a rectangular prism against the equivalent box for all three axes, holes by subtraction, the eigen-decomposition by reconstruction, and that bridge masses equal the Phase 4 `massProperties` for every arm body. Payloads are point masses added to their body.

The arm sample's gripper and 608 bearing have **unknown** catalogue mass; the arm's simulation setup gives them explicitly labelled generic values (30 g and 12 g, note "generic simulation parameter for the demonstration — not measured"). Without them the bridge refuses the run.

## Collision geometry (separate from display geometry)

| Solid                        | Collider                     | Approximation recorded                     |
| ---------------------------- | ---------------------------- | ------------------------------------------ |
| box                          | cuboid                       | none                                       |
| cylinder                     | cylinder                     | none                                       |
| tube                         | cylinder of the outer radius | "hollow tube collides as a solid cylinder" |
| sphere                       | ball                         | none                                       |
| prism (convex, no holes)     | convex hull                  | none                                       |
| prism (holes / concave)      | convex hull                  | "holes and concavities are filled"         |
| any (`collider: bounds-box`) | one cuboid of the bounds     | "bounding box … approximate"               |
| imported model (`auto`)      | **none**                     | info: select the bounding box explicitly   |

Colliders have zero density (mass comes only from the table above). Rapier's trimesh colliders are not used for dynamic bodies.

**Filtering:** colliders of one rigid body never collide; jointed neighbours never collide (`setContactsEnabled(false)`); non-adjacent bodies of one assembly collide only when `selfCollision` is on, and then pairs already interpenetrating in the CAD pose are excluded and reported. Loose bodies and the work surface collide with everything.

## Joints

| Mate        | Physics joint                                  | Coordinates read back                   | Limits                                |
| ----------- | ---------------------------------------------- | --------------------------------------- | ------------------------------------- |
| fixed       | merged into one rigid body                     | —                                       | —                                     |
| revolute    | Rapier revolute about A's mate +Z              | angle = q₀ + relative twist (unwrapped) | enforced (shifted by q₀)              |
| prismatic   | Rapier prismatic along A's mate +Z             | q₀ + axial anchor displacement          | enforced                              |
| ball        | Rapier spherical                               | relative angular speed                  | **refused**, or dropped with approval |
| cylindrical | generic joint, free LinX + AngX about the axis | twist                                   | **refused**, or dropped with approval |
| planar      | generic joint, normal = mate +Z, free in-plane | in-plane displacement                   | **refused**, or dropped with approval |

- Anchors are the mate frames' origins at t = 0; because body frames start world-aligned, one axis vector serves both bodies (what Rapier's single-axis joints require).
- The sign convention is Phase 4's (`F_B = F_A · J(q) · R_z(offset) · Flip`). It is **tested**: after driving shoulder → 30° and elbow → −60°, the gripper pose matches the Phase 4 solver's within 1e-7 m.
- Suppressed mates are ignored (as in the solver). Driving assembly constraints have no dynamic equivalent: refused unless `approvals.ignoreDrivingConstraints` (then listed as ignored). A joint between two welded or two non-dynamic bodies is reported and skipped.
- Initial pose: the current CAD coordinates, or each mate's home (`initialPose: 'home'`, solved with the Phase 4 solver).

## Measured constraint drift

Every step, each joint's anchor separation (perpendicular part for sliding joints) and axis misalignment are measured from the simulated bodies and recorded (`<mate>.drift`). Validation: ≤ 0.5 µm on a free pendulum, about 8 µm / 0.008° on the arm under gravity.
