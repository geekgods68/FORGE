import { checkModelBytes, modelSizeToMetres, MODEL_UNITS, type ModelUnit } from '@forge/components';
import { useState } from 'react';
import { Box3, Mesh, Vector3, type Material, type Texture } from 'three';
import { formatLength } from '@/components3d/format';

/**
 * External model inspection (GLB / glTF 2.0): validates the container, parses it with
 * three's bundled GLTFLoader (lazy chunk), measures its bounding box in the unit and
 * up-axis the USER confirms, and reports a stable content hash. GPU/CPU resources are
 * disposed immediately after measuring. Imported models get no mass, material or
 * connection interfaces; saving them as library components is a later phase.
 */
interface Report {
  name: string;
  hash: string;
  rawSize: [number, number, number];
  meshes: number;
  triangles: number;
  generator: string;
}

export function ModelInspect() {
  const [report, setReport] = useState<Report | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [unit, setUnit] = useState<ModelUnit>('mm');
  const [up, setUp] = useState<'Y' | 'Z'>('Y');
  const [busy, setBusy] = useState(false);

  const inspect = async (file: File) => {
    setBusy(true);
    setReport(null);
    setIssues([]);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const check = checkModelBytes(bytes);
      if (!check.ok) return setIssues(check.issues);
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().parseAsync(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        '',
      );
      const box = new Box3().setFromObject(gltf.scene);
      const size = box.getSize(new Vector3()).toArray() as [number, number, number];
      let meshes = 0;
      let triangles = 0;
      gltf.scene.traverse((o) => {
        if (o instanceof Mesh) {
          meshes += 1;
          const g = o.geometry;
          triangles += (g.index ? g.index.count : g.attributes.position!.count) / 3;
          g.dispose();
          for (const m of ([] as Material[]).concat(o.material)) {
            for (const v of Object.values(m)) if ((v as Texture | null)?.isTexture) (v as Texture).dispose();
            m.dispose();
          }
        }
      });
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      setReport({
        name: file.name,
        hash,
        rawSize: size,
        meshes,
        triangles: Math.round(triangles),
        generator: check.json?.asset?.generator ?? 'unknown',
      });
    } catch (e) {
      setIssues([`Could not parse the model: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setBusy(false);
    }
  };

  const metres = report ? modelSizeToMetres(report.rawSize, unit, up) : null;
  return (
    <details className="rounded border border-border p-1.5">
      <summary className="cursor-pointer text-muted-foreground">
        Inspect an external 3D model (GLB / glTF)
      </summary>
      <div className="mt-1 space-y-1">
        <input
          type="file"
          accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
          data-testid="glb-input"
          aria-label="Choose a GLB or glTF file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void inspect(f);
            e.target.value = '';
          }}
        />
        <div className="flex gap-2">
          <label className="flex items-center gap-1">
            Source unit
            <select
              data-testid="glb-unit"
              className="h-7 rounded border border-border bg-background"
              value={unit}
              onChange={(e) => setUnit(e.target.value as ModelUnit)}
            >
              {Object.keys(MODEL_UNITS).map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            Up axis
            <select
              data-testid="glb-up"
              className="h-7 rounded border border-border bg-background"
              value={up}
              onChange={(e) => setUp(e.target.value as 'Y' | 'Z')}
            >
              <option value="Y">Y</option>
              <option value="Z">Z</option>
            </select>
          </label>
        </div>
        {busy && <p className="text-muted-foreground">Inspecting…</p>}
        {issues.length > 0 && (
          <ul role="alert" data-testid="glb-issues" className="list-disc pl-4 text-destructive">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        {report && metres && (
          <dl data-testid="glb-report" className="grid grid-cols-[auto_1fr] gap-x-2">
            <dt className="text-muted-foreground">File</dt>
            <dd className="truncate">{report.name}</dd>
            <dt className="text-muted-foreground">
              Size (as {unit}, {up}-up)
            </dt>
            <dd data-testid="glb-size">{metres.map(formatLength).join(' × ')}</dd>
            <dt className="text-muted-foreground">Meshes / triangles</dt>
            <dd>
              {report.meshes} / {report.triangles}
            </dd>
            <dt className="text-muted-foreground">Content hash</dt>
            <dd className="truncate font-mono" title={report.hash} data-testid="glb-hash">
              sha256:{report.hash.slice(0, 16)}…
            </dd>
            <dt className="text-muted-foreground">Engineering data</dt>
            <dd>none inferred — no mass, material or interfaces</dd>
          </dl>
        )}
      </div>
    </details>
  );
}
