# Asset import: GLB / glTF custom components (Phase 4)

## Pipeline

1. **Inspect** (Library → "Inspect an external 3D model"):
   - container validation (`checkModelBytes`);
   - parsing with three's GLTFLoader (lazy chunk);
   - bounding-box measurement in the **unit and up-axis the user confirms** (m / cm / mm / in; Y-up or Z-up);
   - SHA-256 of the exact bytes.
2. **Save to my library:** name, category and description.
   - The bytes go into the **local asset store**, keyed `sha256-<hex>`. This is IndexedDB in this browser profile; nothing is uploaded, and the CSP is same-origin.
   - Every write re-verifies the hash. The limit is 16 MiB per asset.
   - A `ModelRef` is added to the local custom library (`localStorage`). It holds `assetHash`, `byteLength`, `mediaType`, `name`, `categoryId`, `description`, `unitScale`, `upAxis`, `boundsM`, `minM`, and string-only `metadata`: source file, generator, mesh count and triangle count.
3. **Insert:** `model.instance.create` places a `model-instance` node with its base on y = 0. Instances persist in the project like any node; the project stores the reference, never the bytes.
4. **Render:**
   - The bytes are loaded from the asset store and parsed once per hash.
   - A shared, reference-counted template serves all instances: they share geometry and materials, and the GPU resources are disposed with the last instance.
   - The confirmed scale is applied, plus a −90° X rotation for Z-up sources.

**No engineering data is inferred.** An imported model has no mass, material, interfaces or simulation properties: its mass reports as _unknown_. It can still be mated using explicit frame references.

## No silently broken references

- On every project load, FORGE checks each referenced `assetHash` against the store (`missingAssets`).
- A missing asset renders as a **red labelled wireframe of its recorded bounds**, never as a substitute. The node's data is kept and saved unchanged.
- Once the asset arrives (a bundle or assembly import, or saving the same file again), the instance retries and loads.
- Removing a model from "My imported components" removes the library entry only. The bytes stay, so projects that use them keep working.

## Portable bundles

| File                    | Contents                                                |
| ----------------------- | ------------------------------------------------------- |
| `*.forge.json`          | Project only (asset references, no bytes)               |
| `*.forge-bundle.json`   | Project + base64 bytes of every referenced model asset  |
| `*.forge-assembly.json` | Reusable assembly template + bytes of any model members |

- **Export Bundle** is **refused** if any referenced asset is missing from the store, and the status lists which ones.
- **Import** verifies every asset's SHA-256 _before_ storing any of them. A tampered or corrupt bundle is refused, nothing is imported, and the current project is untouched.
- The import size limit is 64 MiB for bundles and assembly files, and 10 MiB for plain project files.

## Verification (browser test `tests/end-to-end/model-import.spec.ts`)

1. Inspect a GLB, save it, insert it: rendered as **loaded**.
2. Save the project and reload: the library entry and the loaded model persist (IndexedDB).
3. Export a bundle: it contains one asset.
4. In a **fresh browser profile**, a plain project file shows the **missing** placeholder and reports the hash, and exporting a bundle is refused.
5. Importing the bundle restores the asset and the model **loads**.
6. A tampered bundle fails the integrity check.

## Limits

- Supported: GLB and self-contained glTF only. External `.bin` and texture URIs are not fetched.
- No STEP / IGES / STL / OBJ.
- No mesh repair, decimation or unit auto-detection. The user confirms the unit and up-axis.
- The asset store is per browser profile: use bundles to move work between machines.
