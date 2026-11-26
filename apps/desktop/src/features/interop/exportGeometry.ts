import { worldMatrix, type Project, type SceneNode } from '@forge/engineering-core';
import { frameMatrix, parseGltf, triangles, type MeshScene } from '@forge/interop';
import { bodyGeometry } from '@forge/mechanics';
import type { BufferGeometry } from 'three';
import type { AssetStore } from '@/assets/assetStore';
import { solidGeometry } from '@/components3d/geometry';
import { createPrimitiveGeometry } from '@/rendering/resources';

/**
 * Tessellated export geometry for nodes (and their subtrees), built from the ENGINEERING
 * data — the same solids and primitive geometry FORGE renders — placed by the scene graph's
 * world matrices, in the FORGE frame (metres, +Y up). Imported models use their stored
 * asset. Exporting never modifies the project.
 */
export interface ExportScene {
  scene: MeshScene;
  nodes: number;
  skipped: string[];
}

function soupOf(g: BufferGeometry): Float32Array {
  const ng = g.index ? g.toNonIndexed() : g;
  const pos = ng.getAttribute('position');
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i);
    out[i * 3 + 1] = pos.getY(i);
    out[i * 3 + 2] = pos.getZ(i);
  }
  if (ng !== g) ng.dispose();
  return out;
}

export async function exportSceneFor(
  project: Project,
  nodeIds: string[],
  assets: AssetStore,
): Promise<ExportScene> {
  const graph = project.scene;
  const seen = new Set<string>();
  const order: SceneNode[] = [];
  const visit = (id: string) => {
    const n = graph.nodes[id];
    if (!n || seen.has(id) || !n.visible) return;
    seen.add(id);
    order.push(n);
    n.childIds.forEach(visit);
  };
  nodeIds.forEach(visit);
  const scene: MeshScene = { roots: [], nodes: [], meshes: [], materials: [] };
  const skipped: string[] = [];
  const add = (name: string, soup: Float32Array, W: number[]) => {
    const n = soup.length / 3;
    scene.meshes.push({
      name,
      primitives: [
        { positions: soup, indices: new Uint32Array(n).map((_, i) => i), normals: null, material: null },
      ],
    });
    scene.nodes.push({ name, matrix: W, mesh: scene.meshes.length - 1, children: [], metadata: {} });
    scene.roots.push(scene.nodes.length - 1);
  };
  for (const n of order) {
    const W = worldMatrix(graph, n.id) as number[];
    if (n.kind === 'primitive') {
      const g = createPrimitiveGeometry(n.geometry);
      add(n.name, soupOf(g), W);
      g.dispose();
    } else if (n.kind === 'model-instance') {
      const a = await assets.get(n.model.assetHash);
      const parsed = a ? parseGltf(a.bytes) : null;
      if (!parsed?.scene) {
        skipped.push(`${n.name}: model asset ${a ? 'unreadable' : 'missing from this browser'}`);
        continue;
      }
      const F = frameMatrix({ toMetres: n.model.unitScale, upAxis: n.model.upAxis, handedness: 'right' });
      const t = triangles(parsed.scene, F);
      add(n.name, Float32Array.from(t.tri), W);
    } else if (n.kind === 'component-instance' || n.kind === 'part') {
      const b = bodyGeometry(graph, n);
      if (!b || !b.solids.length) {
        skipped.push(`${n.name}: no tessellatable geometry`);
        continue;
      }
      const parts = b.solids.map((s) => {
        const g = solidGeometry(s);
        const soup = soupOf(g);
        g.dispose();
        return soup;
      });
      const all = new Float32Array(parts.reduce((k, p) => k + p.length, 0));
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
      add(n.name, all, W);
    }
  }
  return { scene, nodes: scene.nodes.length, skipped };
}
