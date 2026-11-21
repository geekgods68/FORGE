import type { Project } from '@forge/engineering-core';
import { CATALOG_REVISION, getDefinition } from './catalog';
import { resolveParameters } from './evaluate';

/**
 * Load-time audit of a project's component-library references. Problems are reported
 * as recoverable WARNINGS: the instance keeps its stored metadata and is shown as a
 * labelled placeholder (missing definition) — it is never silently substituted.
 */
export interface ComponentWarning {
  nodeId: string;
  nodeName: string;
  definitionId: string;
  kind: 'missing-definition' | 'invalid-parameters' | 'newer-catalog';
  message: string;
}

export function auditProjectComponents(project: Project): ComponentWarning[] {
  const out: ComponentWarning[] = [];
  for (const n of Object.values(project.scene.nodes)) {
    if (n.kind !== 'component-instance' || !n.component) continue;
    const base = { nodeId: n.id, nodeName: n.name, definitionId: n.definitionId };
    const def = getDefinition(n.definitionId);
    if (!def) {
      out.push({
        ...base,
        kind: 'missing-definition',
        message: `"${n.name}" references "${n.definitionId}" (${n.component.snapshot.name}), which is not in this component library. Shown as a placeholder; its stored data is preserved.`,
      });
      continue;
    }
    if (n.component.catalogRevision > CATALOG_REVISION)
      out.push({
        ...base,
        kind: 'newer-catalog',
        message: `"${n.name}" was created with a newer component library (revision ${n.component.catalogRevision}).`,
      });
    const r = resolveParameters(def, n.component.variantId, n.component.parameters);
    if (!r.ok)
      out.push({ ...base, kind: 'invalid-parameters', message: `"${n.name}": ${r.issues.join('; ')}` });
  }
  return out;
}
