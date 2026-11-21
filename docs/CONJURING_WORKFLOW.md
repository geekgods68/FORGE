# Conjuring workflow

1. **Open the library** (toolbar **Library**). Browse the 28 categories, then subcategories and families, or search by name, alias, part number or variant (for example "servo", "2040", "M3 × 12"). You can filter by tier and by favourites. The panel also shows recents, saved assemblies, the robotic-arm sample and external-model inspection.
2. **Select a family.** The detail view shows its tier, data status, simulation status (`unsupported`), description, SVG sketch, size, mass with its source, specs with their status, and references.
3. **Configure it:** variant, parameters (mm, validated live; invalid values disable **Conjure** and explain why) and material where it's allowed.
4. **Conjure.** The panel collapses to a placing bar. A translucent **ghost** follows the pointer over the active work surface:
   - **Facility view:** the work surface (frame M) of the bench hosting the project. If the project isn't mounted, a message explains how to mount it.
   - **Project view:** the project's 2 × 2 m build area on y = 0.
5. **Position it.** Placement snaps to the editor grid in the project frame. **R** / **Shift+R** rotate by 15°. The ghost is cyan when the rotated footprint fits the surface and red when it doesn't.
6. **Click to confirm.** One `scene.node.create` command creates the instance; it's undoable and selected afterwards. Clicking an invalid spot creates nothing and explains why. **Esc** or **Cancel** abandon the placement with no scene change.
7. **Edit.** Move and rotate with the gizmo or the precision fields. Duplicate, delete, group, rename, hide and lock work as in Phase 1. Dimensions, variant and material change through `scene.component.configure`; scale is fixed at 1 for catalogue parts.

## Guarantees

- **No early changes:** the ghost is renderer-only and never enters the scene graph until confirmed (browser test).
- **Same command path as Vey:** the UI uses the validated engine commands Vey will use. The resolver rejects unknown parts, invalid parameters and forbidden materials atomically.
- **Layer separation:** components live only in the engineering project. Facility geometry stays read-only and non-pickable, and workspace furniture is a separate layer. Mounting a project on another bench relocates it without rewriting any component-local coordinate (browser test, which also covers conjuring in Lab 1).
