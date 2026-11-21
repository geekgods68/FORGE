# Component schema

## Definitions (catalogue, `@forge/components`, library schema v1)

`ComponentDefinitionSchema` (Zod) holds one entry per **family**. It contains:

- **Identity:** `id` (stable kebab-case), `revision`, `name`, `categoryId` (one of 28), `subcategoryId`, `family`, `description`, `aliases`.
- **Implementation:** `tier` (A/B/C), `geometry` (`generator`, `fixed` inputs, `representation`).
- **Parameters:** `length`, `count`, `angle`, `choice` or `boolean`. Each has a default and range, and lengths are stored in metres with a display unit.
- **Variants and presets:** parameter overrides, with an optional part number.
- **Material:** `materialId` (the default, or null for unspecified) and `allowedMaterialIds` (empty means the material is fixed by the product).
- **Interfaces:** static interfaces. Generators add parameter-dependent ones (see COMPONENT_CONNECTIONS.md).
- **Specs:** `specs.mechanical` and `specs.electrical`, each a `{ key, label, value | null, unit, status, note }`. A null value means unknown.
- **Mass:** `specifiedMassKg`, a cited published mass, or null.
- **Provenance:** `manufacturer` (name and product, only for named products), `references` (title, kind, and a URL only when certain), `dataStatus`.
- **Simulation:** `capabilities`. In Phase 3 every domain is `unsupported`.

Catalogue validation (`validateCatalog`, run in tests) checks:

- ids are unique, the taxonomy is valid, and every subcategory is populated;
- parameter defaults are in range and choice defaults are options;
- variant ids are unique, materials exist, and generators exist;
- every default and variant evaluates, with the base at y = 0 and unique interface ids;
- named products must cite a reference and can't be marked generic;
- no family claims simulation validity.

## Instances (engineering project, schema v3)

A component instance is a `component-instance` scene node. Phase 3 adds an optional `component` reference:

```ts
{
  catalogRevision: number,          // catalogue revision the parameters were resolved against
  variantId: string | null,
  parameters: Record<string, number | string | boolean>, // fully resolved (m / rad / options)
  materialId: string | null,
  snapshot: { name, categoryId, subcategoryId, family, tier, dataStatus, boundsM: [x, y, z] },
  connections: { interfaceId, targetNodeId, targetInterfaceId }[], // declared only; empty in Phase 3
}
```

- **Shared definition:** multiple instances reference one definition by id, and only their configuration is stored. The small snapshot keeps a project self-describing.
- **Transform:** position and rotation are free. **Scale must be 1**: catalogue parts are resized through parameters, never deformed. This is enforced for the node, through parent groups and on reparenting, and again on load.
- **Locks and visibility** use the Phase 1 node fields.

## Commands

- `scene.node.create` with `kind: 'component-instance'` (`definitionId`, `variantId?`, `parameters?`, `materialId?`, `transform?`) conjures a part.
- `scene.component.configure` (`nodeId`, `variantId?`, `parameters?` merged onto the current values, `materialId?`) changes it. Choosing a new variant starts from that variant's values.
- Both are validated by the injected `ComponentResolver`. They are undoable and work inside atomic `scene.batch` commands. Error codes: `unknown-component`, `invalid-parameters`, `invalid-transform`, `locked`.
- Duplicate, delete, group, ungroup, rename, visibility and lock are the unchanged Phase 1 commands.

## Persistence and migration

- **Versions:** project schema v3. v1 (Phase 0) and v2 (Phases 1–2) files migrate on load, and newer versions are refused.
- **Load-time audit:** `auditProjectComponents` produces recoverable warnings for missing definitions, invalid stored parameters and newer catalogues. A missing definition is shown as a translucent, labelled placeholder of the recorded size, with its data preserved. It is never substituted.
- **Rejected files:** structurally invalid component data (non-unit scale, dangling connection, unknown category in the snapshot) rejects the file, and the current project is kept.
