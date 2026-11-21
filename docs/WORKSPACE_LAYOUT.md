# Workspace layout

The workspace layer is the user-editable arrangement of equipment inside facility zones. It's owned by `WorkspaceEngine` (`forge.workspace-command/v1`) and is completely separate from the facility (read-only) and from engineering projects (`ForgeEngine`).

## Model

- **Items:** `WorkspaceItem { id, name, equipmentId, zoneId, areaId, pose (zone frame, floor, yaw), mountedProjectId, locked }`.
- **Equipment catalogue:** standard bench, heavy bench, tool cabinet, instrument rack and conjuring pedestal. Only workbenches have a mount frame M and can host a project.
- **Placement areas:** every lab and environment has at least one. Corridors have none, so they're circulation only. Furnishings, doorways and placement areas never overlap (`validateFacility`).

## Commands

`workspace.item.place`, `.move`, `.remove`, `.rename`, `.lock` and `workspace.bench.mount`. Each runs in one of two ways:

- **Applied atomically:** the result has a new revision and one history entry.
- **Rejected with a code:** for example `out-of-bounds`, `collision`, `not-allowed-here`, `locked`, `stale-revision` or `zone-unavailable` (the last applies to unbuilt zones; none exist in revision 2).

The rules: the footprint must be inside the item's placement area, must not collide with other items in the zone, and the category must be allowed in that area.

## Editing in the UI

- **Layout edit layer:** item list and Place for the current zone; the inspector shows zone-frame mm and degrees plus a facility-frame readout. Mount here / Unmount, Focus bench.
- **Gizmo:** floor-constrained, X/Z translate or yaw rotate, snapped to the editor grid (10 mm and 15° by default). A drag produces one history entry. A rejected drag (for example onto another bench) commits nothing and the item snaps back.
- **Undo/redo:** separate from the engineering project's history.

## Persistence

- **Storage:** `forge:workspace:<id>` in localStorage, and `.forge-workspace.json` files (2 MiB limit), validated against the facility.
- **Revisions:** a layout records the `facilityRevision` it was authored against. Layouts from the same or an older revision load; newer ones are rejected. Revision-1 layouts load in revision 2 (unit test).
- **Project link:** a layout references a project only by `mountedProjectId`. Project files never contain layout data (browser test).

## Zone transitions

Unloading a zone never modifies the layout or the project. Items in unloaded zones stay in the layout and simply aren't rendered. A project mounted on a bench in an unloaded zone isn't rendered until that zone loads again, at exactly the same frames (browser test `facility-zones.spec.ts`).

## Verification

| Behaviour                                                        | Evidence                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Placement rules, locks, mounting, stale revisions, source policy | Unit tests (`facility.test.ts`)                                                       |
| Inspector moves, collision rejection, yaw, Place                 | Browser test `facility.spec.ts`                                                       |
| **Real pointer drag of the gizmo**                               | Browser test `layout-gizmo.spec.ts`. A mutation that disables snap-back makes it fail |
| Undo/redo of a drag, separate from project history               | `layout-gizmo.spec.ts`                                                                |
| Facility-frame readout after a drag                              | `layout-gizmo.spec.ts`                                                                |
| Persistence across reload                                        | `layout-gizmo.spec.ts`, `facility.spec.ts`                                            |
| Layout preserved across zone unload/reload                       | `facility-zones.spec.ts`                                                              |
