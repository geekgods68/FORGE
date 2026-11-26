import { emptyTwinDocument, TwinDocumentSchema, TwinSchema, type Twin, type TwinDocument } from './schemas';

/**
 * Twin document operations: validated, versioned (revision + updatedAt), separate from the
 * CAD undo history. Every change returns a new document; invalid changes are refused.
 */
export type TwinResult = { ok: true; doc: TwinDocument } | { ok: false; error: string };

export function upsertTwin(doc: TwinDocument, twin: Twin, now = new Date()): TwinResult {
  const prev = doc.twins.find((t) => t.id === twin.id);
  const next = {
    ...twin,
    projectId: doc.projectId,
    revision: prev ? prev.revision + 1 : Math.max(1, twin.revision),
    createdAt: prev?.createdAt ?? twin.createdAt,
    updatedAt: now.toISOString(),
  };
  const v = TwinSchema.safeParse(next);
  if (!v.success)
    return { ok: false, error: v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return {
    ok: true,
    doc: {
      ...doc,
      twins: prev ? doc.twins.map((t) => (t.id === twin.id ? v.data : t)) : [...doc.twins, v.data],
    },
  };
}
export function removeTwin(doc: TwinDocument, id: string): TwinResult {
  if (!doc.twins.some((t) => t.id === id)) return { ok: false, error: `No twin ${id}.` };
  return { ok: true, doc: { ...doc, twins: doc.twins.filter((t) => t.id !== id) } };
}
export function parseTwinDocument(text: string, projectId: string): TwinResult {
  if (text.length > 2 * 1024 * 1024) return { ok: false, error: 'Twin document too large.' };
  try {
    const v = TwinDocumentSchema.safeParse(JSON.parse(text));
    if (!v.success)
      return {
        ok: false,
        error: v.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      };
    if (v.data.projectId !== projectId)
      return { ok: false, error: 'The twin document belongs to another project.' };
    return { ok: true, doc: v.data };
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
}
export { emptyTwinDocument };
