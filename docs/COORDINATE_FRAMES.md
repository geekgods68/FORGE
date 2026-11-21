# Coordinate frames

All frames use metres and radians internally, are right-handed, +Y up and −Z north. Every frame-to-parent transform is **rigid**: a translation plus a yaw about +Y, with no scale. Conversions are therefore exact inverses. Degrees appear only in the UI.

| Frame          | Origin                                                | Posed in | Source                    |
| -------------- | ----------------------------------------------------- | -------- | ------------------------- |
| **F** facility | Centre of Corridor E, floor level                     | —        | Datum                     |
| **Z** zone     | `zone.pose` (centre of the zone footprint, floor)     | F        | Facility data (read-only) |
| **I** item     | `item.pose` (footprint centre, floor; yaw only)       | Z        | Workspace layout          |
| **M** mount    | `equipment.mount` (work-surface centre, top surface)  | I        | Equipment catalogue       |
| **P** project  | Project root ≡ M when the project is mounted on bench | M        | Engineering project       |

## Zone frames in revision 2

- **Lab doors:** every lab's door is at local (0, 0, +6). Labs south of their corridor have yaw π, so their local +Z points north, toward the corridor.
- **Environment doors:** environments have yaw π and their door at local (0, 0, +12).
- **Corridors:** yaw 0 throughout.
- **Portals:** stored in each zone's own frame. `validateFacility` checks that every open portal has a reciprocal portal at the same **facility** point with the same width (unit test, plus mutation checks).
- **Furnishings and signs:** positioned in their zone frame. The renderer places each zone group at `zone.pose`. Rendered sign positions are converted back to F for tests.

## API (`@forge/facility`)

- **Chains:** `zoneChain(zone)`, `itemChain(zone, item)` and `mountChain(zone, item, equipment)` build chains, innermost first.
- **Matrices:** `chainToFacility(chain)` and `facilityToChain(chain)` give column-major 4×4 matrices, which are passed straight to three.js.
- **Points and transforms:** `pointToFacility(p, chain)`, `pointFromFacility(p, chain)`, `convertPoint(p, from, to)` and `transformToFacility(nodeTransform, chain)`.
- **Footprints:** `zoneFootprintInFacility(zone)`, `itemFootprint(pose, equipment)` and `furnishingFootprint(f)` return floor AABBs in the respective parent frame.

## Evidence

- **Frame math:** round trips, yaw and composition are covered by unit tests.
- **Mounted project:** the rendered world position of a mounted node equals the frame computation, and the inspector shows the same facility coordinates (browser test).
- **Layout gizmo:** after a real pointer drag, `itemFacilityPosition` equals the zone origin plus the item pose. The inspector's facility readout and zone-frame X field update to the same values (browser test `layout-gizmo.spec.ts`).
- **Yaw-π rooms:** camera presets and sign placement use the same rotation convention as the frames. All 28 rooms render their identity and door signs where the data says (browser test).
