# Parametric CAD (Phase 4)

FORGE's CAD is a deliberately small, exact **prismatic (2.5D) kernel** plus 2D constrained sketches. No STEP/IGES/B-rep kernel is installed (by decision: size, licensing and an 8 GB development machine).

## Sketches (`sketch` nodes)

- Entities: points, lines, circles and arcs in the sketch's local XZ plane (sketch x → X, sketch y → Z), in metres.
- Constraints and solver: see CONSTRAINT_SOLVER.md. Status and DOF appear live in the sketch inspector.
- **Extrude to part** (`part.create { fromSketchId, depth }`) copies the sketch's closed loop (a line loop, or a circle as a 48-gon) into a part's base profile. The part keeps `sourceSketchId` for provenance. Later sketch edits do not change the part: this is an explicit copy, not a live link.

## Parts (`part` nodes)

A part is an ordered feature list, regenerated from scratch on every change by `evaluatePart` (pure, deterministic):

| Feature        | Parameters                                     | Notes                                             |
| -------------- | ---------------------------------------------- | ------------------------------------------------- |
| `extrude`      | profile (outer + holes), depth                 | Base body, profile on local XZ, extruded along +Y |
| `hole`         | centre (u, v), diameter, depth or through      | 32-gon tool; exact cylinder volume is reported    |
| `cut`          | polygon, depth or through                      | Pocket or through cut                             |
| `boolean`      | union / difference / intersection with polygon | Planar 2D boolean on the base region              |
| `pattern-rect` | target hole/cut, counts, pitches               |                                                   |
| `pattern-circ` | target hole/cut, count, centre, total angle    |                                                   |
| `mirror`       | target hole/cut, axis (u or v), offset         |                                                   |

### Commands

`part.create`, `geometry.hole.create`, `geometry.cut.create`, `geometry.boolean.create`, `geometry.pattern.create`, `geometry.mirror.create`, `geometry.feature.update` and `geometry.feature.delete` are each one undoable command.

### Regeneration and failure handling

- Before a feature edit is committed, the engine asks the kernel to regenerate the part (`MechanicsService.checkPart`). If regeneration fails, the command is **refused** with `invalid-geometry` and the reason, and the previous valid part is kept.
- Rejected cases:
  - self-intersecting or degenerate profiles;
  - tools that leave the part or overlap each other;
  - results that split into several bodies;
  - blind depths ≥ the part depth;
  - more than 20,000 vertices.
- Deleting a feature that a pattern or mirror targets is refused until the dependant is removed.

### Interfaces

Parts declare `top-face` and `bottom-face`, plus one `hole-<id>` interface per hole and pattern copy, with descriptors such as `hole-3.4mm`, `M3-clearance` (±0.15 mm) or `M3-tapped`. They can therefore be mated and fastener-checked like catalogue components.

### Mass

Mass is exact volume × the material's typical handbook density, so it is labelled **approximate**.

## Verification (unit tests `packages/mechanics/src/__tests__/cad.test.ts`; e2e `tests/end-to-end/cad.spec.ts`)

- **Volumes match closed-form values** for the plate, through and blind holes, pockets, rectangular and circular patterns, mirrors and booleans (32-gon tools report the exact cylinder volume).
- **Every rejection case** listed above is refused with a message.
- **The browser workflow** checks a 100 × 60 × 5 mm plate at 30.00 cm³. A Ø5 hole, a 3 × 1 pattern and an edit to Ø6 all match closed-form volumes. A hole outside the plate is refused, and undo restores the previous state.
- **Sketch workflow:** 4 DOF goes to 3 DOF after a length constraint. A conflicting length is refused. A 120 × 60 × 8 extrusion gives 57.60 cm³.

## Not supported

The kernel is prismatic only. There are no:

- fillets, chamfers, drafts, shells, revolves, lofts or sweeps;
- multi-body parts, or holes on side faces;
- live sketch-to-part links;
- tolerances, threads as geometry, or drawings;
- STEP / IGES / STL export.
