# Importing external CAD files

1. **Data exchange** (top bar) → **Choose file(s)…** → a `.step/.stp`, `.stl`, `.glb` or `.gltf` file.
2. Check the detected format, the **geometry class** (mesh or tessellated B-rep — never an editable CAD model) and the **size in the FORGE frame** (metres, +Y up).
3. STL has no units: choose the unit (default mm) and up axis (default +Z) until the size is right. STEP units come from the file; glTF is metres, +Y up.
4. Optional: **one instance per part** (assemblies), **attach to** the selected assembly body (fixed mate at an offset), a **mass** (kg) and the bounding-box **collider** — nothing physical is inferred.
5. Read the warnings and "Not imported" list, wait for **Ready** (engine dry run), then **Insert into project** — one undo step.
6. Select the inserted node: the Inspector shows its provenance (source file hash, units, conversions) and whether it has been modified.
7. **Export** tab: STL (unit, up axis) or GLB of the selection; the report lists what was preserved and discarded. STEP export is not available.
