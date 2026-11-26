import { importOf, importStatus } from '@forge/interop';
import { useEditor } from '@/app/store';

/** Origin of the selected node: native FORGE data, or an import with its full provenance. */
export function ProvenanceSection({ nodeId }: { nodeId: string }) {
  const graph = useEditor((s) => s.project.scene);
  const rec = importOf(graph, nodeId);
  if (!rec)
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="provenance">
        Origin: native FORGE data
      </p>
    );
  const status = importStatus(rec, graph);
  return (
    <section className="space-y-1 rounded border border-border p-2 text-[11px]" data-testid="provenance">
      <h3 className="font-semibold">Imported from {rec.fileName}</h3>
      <p>
        {rec.format.toUpperCase()}
        {rec.formatVersion ? ` (${rec.formatVersion})` : ''} · geometry:{' '}
        <strong data-testid="provenance-class">{rec.geometryClass}</strong> · source unit {rec.sourceUnit} (×{' '}
        {rec.toMetres} → m), +{rec.upAxis} up · status{' '}
        <strong data-testid="provenance-status">{status}</strong>
      </p>
      <p className="font-mono text-[10px] text-muted-foreground" title="SHA-256 of the exact source file">
        {rec.sourceHash}
      </p>
      <details>
        <summary className="cursor-pointer">Conversion history, unsupported data and warnings</summary>
        <ul className="list-disc pl-4">
          {rec.conversions.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        {rec.unsupported.length > 0 && (
          <p className="text-muted-foreground">Not imported: {rec.unsupported.join('; ')}</p>
        )}
        {rec.warnings.length > 0 && <p className="text-amber-300">{rec.warnings.join(' ')}</p>}
        <p>
          {Object.entries(rec.summary)
            .map(([k, v]) => `${k} = ${typeof v === 'number' ? Number(v.toPrecision(6)) : v}`)
            .join(' · ')}
        </p>
      </details>
    </section>
  );
}
