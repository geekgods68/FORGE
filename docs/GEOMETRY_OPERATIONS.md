# Geometry operations: measurement, interference, explode (Phase 4)

Implementation: `packages/mechanics/src/measure.ts`. All operations are **read-only**: they never change the model.

## Measurement (assembly inspector → Measure)

| Quantity              | Source                                                   | Validity                                                                |
| --------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Distance              | Between interface origins (or body origins), world frame | **exact** (from model frames, not the mesh)                             |
| Axis angle            | Between interface directions                             | **exact**                                                               |
| Clearance             | Gap between world-axis-aligned bounding boxes            | **approximate** (conservative lower bound of true clearance)            |
| Hole diameter         | Declared `hole-Xmm` descriptor                           | declared value                                                          |
| Mass / centre of mass | Volume × handbook density, or the published mass         | **approximate**, or **unknown** for envelope models / unknown densities |

Assembly mass sums the known parts and lists the ones whose mass is unknown, which are excluded. The total is then labelled **unknown (partial)**.

## Interference checking

1. **Broad phase:** world AABBs of every member. Pairs with a gap above 0.01 mm are skipped.
2. **Narrow phase:** oriented boxes for every solid of each body, tested with the separating-axis test (15 axes), giving a penetration depth.
3. **Classification:**
   - **contact:** surfaces within 0.01 mm;
   - **interference:** overlap between _exact box solids_. This is verified for that geometry;
   - **possible:** overlap of bounding volumes of curved, holed or envelope solids. This is preliminary: the parts may not actually intersect.
4. Pairs related by a mate are flagged (`mated pair`), since contact there is usually intended.

Overlapping bodies are highlighted in the viewport (red: interference, amber: possible). Results go **stale** when the model changes, and the UI says so. True mesh-to-mesh or B-rep intersection is not implemented.

## Exploded view

- `explodeOffsets(graph, assemblyId, factor)` moves each member away from the assembly's centroid by `factor` × its distance (minimum 10 mm), in the assembly frame.
- The offsets are applied **only in rendering**: instanced and individual meshes both use them. The project, its revision and the undo history are untouched. Factor 0 restores exactly (browser-tested to 1e-9 m).
- The gizmo is disabled while exploded, so a display offset can never be committed as a transform.
