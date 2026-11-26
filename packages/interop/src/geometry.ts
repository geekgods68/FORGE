import {
  sha256Bytes,
  type BatchSubCommand,
  type ImportRecord,
  type ModelRef,
  type Project,
  type SceneNode,
} from '@forge/engineering-core';
import { parseGltf, weld, writeGlb } from './formats/gltf';
import { parseStl } from './formats/stl';
import {
  readStepHeader,
  stepToScene,
  type OcctKernel,
  type StepHeader,
  type Tessellation,
} from './formats/step';
import {
  apply,
  det3,
  facetNormals,
  frameMatrix,
  IDENTITY,
  metrics,
  MIRROR_Z,
  mul,
  sceneSummary,
  triangles,
  worldMatrices,
  type Frame,
  type MeshMetrics,
  type MeshScene,
  type V3,
} from './mesh';
import { nodesFingerprint } from './provenance';
import {
  err,
  hasErrors,
  info,
  INTEROP_VERSION,
  warn,
  type Diagnostic,
  type FileInput,
  type GeometryClass,
} from './schemas';

/**
 * Geometry import: analyse → (user confirms unit, axes, options) → plan → apply.
 *
 * The plan is an ordered list of validated engine commands (one atomic `scene.batch`, one
 * undo step) plus the derived assets to store. Applying it either inserts everything with
 * its provenance record or changes nothing. GLB/glTF sources are stored byte-for-byte (so
 * their textures still display); STL and STEP are converted to GLB, and the conversion is
 * recorded. Mass and collision are NEVER inferred: they are added only when the user
 * supplies them explicitly.
 */
export type GeometryFormat = 'stl' | 'glb' | 'gltf' | 'step';
export const MAX_ASSET_BYTES = 16 * 1024 * 1024;

export interface GeometryAnalysis {
  ok: boolean;
  format: GeometryFormat;
  variant: string | null;
  formatVersion: string | null;
  generator: string | null;
  fileName: string;
  sourceHash: string;
  byteLength: number;
  geometryClass: GeometryClass;
  /** Source scene (source units/axes, except STEP which OCCT returns in metres). */
  scene: MeshScene | null;
  /** Stated or default source frame; the user confirms or changes it. */
  defaultFrame: Frame & { unitName: string; unitStated: boolean };
  step: StepHeader | null;
  unsupported: string[];
  diagnostics: Diagnostic[];
  original: Uint8Array;
}

export function analyseGeometry(
  file: FileInput,
  format: GeometryFormat,
  kernel?: OcctKernel | null,
  tess?: Tessellation,
): GeometryAnalysis {
  const base = {
    fileName: file.name,
    sourceHash: `sha256-${sha256Bytes(file.bytes)}`,
    byteLength: file.bytes.byteLength,
    original: file.bytes,
  };
  if (format === 'stl') {
    const r = parseStl(file.bytes, file.name.replace(/\.[^.]+$/, ''));
    return {
      ...base,
      ok: r.ok,
      format,
      variant: r.variant,
      formatVersion: null,
      generator: r.header || null,
      geometryClass: 'mesh',
      scene: r.scene,
      defaultFrame: { toMetres: 0.001, upAxis: 'Z', handedness: 'right', unitName: 'mm', unitStated: false },
      step: null,
      unsupported: ['units (STL records none: confirm them)', 'materials', 'hierarchy', 'colours'],
      diagnostics: [
        ...r.diagnostics,
        info(
          'stl-units',
          'STL has no units or axes: FORGE proposes millimetres and +Z up (the common CAD/3D-printing convention); confirm them.',
        ),
      ],
    };
  }
  if (format === 'glb' || format === 'gltf') {
    const r = parseGltf(file.bytes);
    return {
      ...base,
      ok: r.ok,
      format: r.container ?? format,
      variant: r.container,
      formatVersion: r.version,
      generator: r.generator,
      geometryClass: 'mesh',
      scene: r.scene,
      defaultFrame: { toMetres: 1, upAxis: 'Y', handedness: 'right', unitName: 'm', unitStated: true },
      step: null,
      unsupported: r.unsupported,
      diagnostics: r.diagnostics,
    };
  }
  // STEP
  const h = readStepHeader(file.bytes);
  const d = [...h.diagnostics];
  if (!kernel) {
    d.push(err('step-kernel-unavailable', 'The STEP geometry kernel (OCCT WebAssembly) is not loaded.'));
    return {
      ...base,
      ok: false,
      format,
      variant: h.protocol,
      formatVersion: h.schema,
      generator: h.originatingSystem,
      geometryClass: 'tessellated-brep',
      scene: null,
      defaultFrame: {
        toMetres: 1,
        upAxis: 'Z',
        handedness: 'right',
        unitName: h.lengthUnit?.name ?? 'mm',
        unitStated: !!h.lengthUnit,
      },
      step: h,
      unsupported: h.unsupported,
      diagnostics: d,
    };
  }
  const t = h.ok ? stepToScene(file.bytes, kernel, tess) : null;
  if (t) d.push(...t.diagnostics);
  if (h.lengthUnit)
    d.push(
      info('step-units', `Declared length unit: ${h.lengthUnit.name}; OCCT converted all lengths to metres.`),
    );
  return {
    ...base,
    ok: h.ok && !!t?.ok,
    format,
    variant: h.protocol,
    formatVersion: h.schema,
    generator: h.originatingSystem,
    geometryClass: 'tessellated-brep',
    scene: t?.scene ?? null,
    // Coordinates are already metres; STEP has no up axis — CAD convention is +Z up.
    defaultFrame: {
      toMetres: 1,
      upAxis: 'Z',
      handedness: 'right',
      unitName: h.lengthUnit?.name ?? 'mm (assumed)',
      unitStated: !!h.lengthUnit,
    },
    step: h,
    unsupported: [
      ...h.unsupported,
      'exact B-rep surfaces (tessellated)',
      'feature tree / parametric history',
    ],
    diagnostics: d,
  };
}

export interface PartPreview {
  name: string;
  triangles: number;
  boundsM: V3;
  minM: V3;
}
export interface GeometryPreview {
  frame: Frame;
  /** Metrics in the FORGE frame (metres, +Y up). Volume is m³ and only meaningful if closed. */
  metrics: MeshMetrics;
  parts: PartPreview[];
  summary: ReturnType<typeof sceneSummary>;
  hierarchy: string[];
  warnings: Diagnostic[];
}

/** Top-level parts: the roots, or the children of a single mesh-less root (assemblies). */
export function topParts(s: MeshScene): number[] {
  if (s.roots.length === 1) {
    const r = s.nodes[s.roots[0]!]!;
    if (r.mesh === null && r.children.length > 1) return r.children;
  }
  return s.roots;
}

function subtree(s: MeshScene, i: number): number[] {
  return [i, ...s.nodes[i]!.children.flatMap((c) => subtree(s, c))];
}

export function previewGeometry(a: GeometryAnalysis, frame: Frame): GeometryPreview | null {
  if (!a.scene) return null;
  const F = frameMatrix(frame);
  const all = triangles(a.scene, F);
  const m = metrics(all.tri, 1e-9);
  const W = worldMatrices(a.scene, F);
  const parts = topParts(a.scene).map((p) => {
    const ids = new Set(subtree(a.scene!, p));
    let tris = 0;
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const i of ids) {
      const n = a.scene!.nodes[i]!;
      if (n.mesh === null) continue;
      for (const pr of a.scene!.meshes[n.mesh]!.primitives) {
        tris += pr.indices.length / 3;
        for (let v = 0; v < pr.positions.length; v += 3) {
          const w = apply(W[i]!, pr.positions[v]!, pr.positions[v + 1]!, pr.positions[v + 2]!);
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k]!, w[k]!);
            max[k] = Math.max(max[k]!, w[k]!);
          }
        }
      }
    }
    return {
      name: a.scene!.nodes[p]!.name,
      triangles: tris,
      minM: min,
      boundsM: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as V3,
    };
  });
  const warnings: Diagnostic[] = [];
  if (m.degenerateTriangles)
    warnings.push(
      warn(
        'degenerate',
        `${m.degenerateTriangles} zero-area triangles (kept; they do not affect area or volume).`,
      ),
    );
  if (!m.closed)
    warnings.push(
      info(
        'open-mesh',
        `The mesh is not closed (${m.boundaryEdges} boundary edges${m.nonManifoldEdges ? `, ${m.nonManifoldEdges} non-manifold` : ''}): volume is not meaningful.`,
      ),
    );
  if (m.closed && m.volume < 0)
    warnings.push(
      warn('inside-out', 'The closed mesh has negative volume: its triangles are wound inside-out.'),
    );
  const size = m.bounds?.size ?? [0, 0, 0];
  const big = Math.max(...size);
  if (big > 50)
    warnings.push(
      warn(
        'very-large',
        `Largest dimension is ${big.toFixed(1)} m: check the unit (a file in mm imported as m is 1000× too large).`,
      ),
    );
  else if (big > 0 && big < 1e-3)
    warnings.push(warn('very-small', `Largest dimension is ${(big * 1000).toFixed(3)} mm: check the unit.`));
  if (big === 0) warnings.push(err('zero-size', 'The geometry has zero extent.'));
  const hierarchy: string[] = [];
  const walk = (i: number, depth: number) => {
    if (hierarchy.length > 200) return;
    const n = a.scene!.nodes[i]!;
    hierarchy.push(`${'  '.repeat(depth)}${n.name}${n.mesh !== null ? '' : ' (group)'}`);
    n.children.forEach((c) => walk(c, depth + 1));
  };
  a.scene.roots.forEach((r) => walk(r, 0));
  return { frame, metrics: m, parts, summary: sceneSummary(a.scene), hierarchy, warnings };
}

export interface GeometryImportOptions {
  frame: Frame & { unitName: string };
  name: string;
  categoryId: ModelRef['categoryId'];
  description?: string;
  /** One model instance per top-level part (inside a new group) instead of one for all. */
  split: boolean;
  parentId?: string;
  /** Explicit physical properties (applied only if the project has a simulation setup). */
  physics?: { massKg: number; note: string; collider: 'bounds-box' | 'none' } | null;
  importId: string;
  newId: () => string;
  now?: Date;
}
export interface ImportAsset {
  hash: string;
  bytes: Uint8Array;
  mediaType: ModelRef['mediaType'];
}
export interface ImportPlan {
  ok: boolean;
  diagnostics: Diagnostic[];
  assets: ImportAsset[];
  commands: BatchSubCommand[];
  record: ImportRecord | null;
  /** Ids of the nodes the plan creates (first = the top node). */
  nodeIds: string[];
}

/** Build a GLB for a set of subtrees, baking the handedness mirror if requested. */
function glbFor(a: GeometryAnalysis, nodes: number[], frame: Frame): Uint8Array {
  const s = a.scene!;
  const out: MeshScene = { roots: [], nodes: [], meshes: [], materials: s.materials };
  const W = worldMatrices(s);
  // Each selected subtree is flattened to one node per mesh with its world matrix baked into
  // the vertices (exact for rigid and scaled transforms; mirrored ones are re-wound).
  for (const root of nodes)
    for (const i of subtree(s, root)) {
      const n = s.nodes[i]!;
      if (n.mesh === null) continue;
      let M = W[i]!;
      if (frame.handedness === 'left') M = mul(MIRROR_Z, M);
      const flip = det3(M) < 0;
      const prims = s.meshes[n.mesh]!.primitives.map((p) => {
        const pos = new Float32Array(p.positions.length);
        for (let v = 0; v < p.positions.length; v += 3) {
          const w = apply(M, p.positions[v]!, p.positions[v + 1]!, p.positions[v + 2]!);
          pos[v] = w[0];
          pos[v + 1] = w[1];
          pos[v + 2] = w[2];
        }
        const idx = Uint32Array.from(p.indices);
        if (flip)
          for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2]!, idx[t + 1]!];
        if (p.normals && !flip && isRigidish(M)) {
          const normals = new Float32Array(p.normals.length);
          for (let v = 0; v < p.normals.length; v += 3) {
            const nx = M[0]! * p.normals[v]! + M[4]! * p.normals[v + 1]! + M[8]! * p.normals[v + 2]!;
            const ny = M[1]! * p.normals[v]! + M[5]! * p.normals[v + 1]! + M[9]! * p.normals[v + 2]!;
            const nz = M[2]! * p.normals[v]! + M[6]! * p.normals[v + 1]! + M[10]! * p.normals[v + 2]!;
            const l = Math.hypot(nx, ny, nz) || 1;
            normals[v] = nx / l;
            normals[v + 1] = ny / l;
            normals[v + 2] = nz / l;
          }
          return { positions: pos, indices: idx, normals, material: p.material };
        }
        // Flat facet normals from the (re-wound) triangles, then weld identical vertex/normal pairs.
        const soup = new Float64Array(idx.length * 3);
        for (let t = 0; t < idx.length; t++)
          for (let k = 0; k < 3; k++) soup[t * 3 + k] = pos[idx[t]! * 3 + k]!;
        const fn = facetNormals(soup);
        return weld({
          positions: Float32Array.from(soup),
          indices: new Uint32Array(idx.length).map((_, k) => k),
          normals: fn,
          material: p.material,
        });
      });
      out.meshes.push({ name: s.meshes[n.mesh]!.name, primitives: prims });
      out.nodes.push({
        name: n.name,
        matrix: [...IDENTITY],
        mesh: out.meshes.length - 1,
        children: [],
        metadata: n.metadata,
      });
      out.roots.push(out.nodes.length - 1);
    }
  return writeGlb(out, {
    generator: `FORGE ${INTEROP_VERSION} (from ${a.format.toUpperCase()} ${a.fileName})`,
  });
}
function isRigidish(M: number[]) {
  const c = [0, 1, 2].map((j) => Math.hypot(M[j * 4]!, M[j * 4 + 1]!, M[j * 4 + 2]!));
  return Math.abs(c[0]! - c[1]!) < 1e-9 * c[0]! && Math.abs(c[1]! - c[2]!) < 1e-9 * c[0]!;
}

/** ModelRef bounds in the model's frame after unit scale and up-axis rotation (as rendered). */
function modelBounds(glbScene: MeshScene, frame: Frame): { boundsM: V3; minM: V3 } {
  const F = frameMatrix({ ...frame, handedness: 'right' });
  const t = triangles(glbScene, F);
  const m = metrics(t.tri);
  const b = m.bounds!;
  return { boundsM: b.size, minM: b.min };
}

export function planGeometryImport(
  a: GeometryAnalysis,
  o: GeometryImportOptions,
  project: Project,
): ImportPlan {
  const d: Diagnostic[] = [...a.diagnostics.filter((x) => x.severity !== 'info')];
  const fail = (e: Diagnostic): ImportPlan => ({
    ok: false,
    diagnostics: [...d, e],
    assets: [],
    commands: [],
    record: null,
    nodeIds: [],
  });
  if (!a.ok || !a.scene)
    return fail(err('not-importable', 'The file did not parse; nothing can be inserted.'));
  if (hasErrors(d)) return fail(err('not-importable', 'Resolve the errors above first.'));
  const preview = previewGeometry(a, o.frame);
  if (!preview || hasErrors(preview.warnings))
    return fail(err('not-importable', 'The geometry has no usable extent.'));
  if (o.frame.handedness === 'left' && (a.format === 'glb' || a.format === 'gltf'))
    return fail(
      err('handedness', 'glTF is right-handed by specification; a left-handed override is not offered.'),
    );
  const parentId = o.parentId ?? project.scene.rootId;
  if (!project.scene.nodes[parentId]) return fail(err('parent', `Target node "${parentId}" does not exist.`));
  const keepOriginal = (a.format === 'glb' || a.format === 'gltf') && !o.split;
  const groups = o.split ? topParts(a.scene).map((p) => [p]) : [a.scene.roots];
  if (o.split && groups.length < 2)
    return fail(err('split', 'There is only one top-level part; import it without splitting.'));
  const assets: ImportAsset[] = [];
  const commands: BatchSubCommand[] = [];
  const predicted: SceneNode[] = [];
  const conversions: string[] = [];
  const mediaType: ModelRef['mediaType'] =
    keepOriginal && a.format === 'gltf' ? 'model/gltf+json' : 'model/gltf-binary';
  // Units/axes the renderer applies (handedness is baked into converted vertices).
  const unitScale = a.format === 'step' ? 1 : o.frame.toMetres;
  if (keepOriginal)
    conversions.push(
      `${a.format.toUpperCase()} stored byte-for-byte (textures and visual data preserved for display)`,
    );
  else
    conversions.push(
      `${a.format.toUpperCase()}${a.variant ? ` (${a.variant})` : ''} → indexed GLB with flat or source normals (placements baked into vertices)`,
    );
  if (a.format === 'step') conversions.push(`STEP lengths (${a.defaultFrame.unitName}) → metres by OCCT`);
  else conversions.push(`${o.frame.unitName} → m (× ${o.frame.toMetres}) applied as the instance unit scale`);
  if (o.frame.upAxis === 'Z')
    conversions.push('+Z up → +Y up (−90° about X) applied as the instance orientation');
  if (o.frame.handedness === 'left')
    conversions.push('left-handed → right-handed: Z mirrored and triangles re-wound (baked)');
  const top = o.split ? o.newId() : null;
  const nodeIds: string[] = [];
  const position = (minM: V3): V3 => [0, -minM[1], 0];
  if (top) {
    // A group keeps the parts' relative placement exactly; it sits with its base on y = 0.
    const minY = preview.metrics.bounds!.min[1];
    const transform = {
      position: [0, -minY, 0] as V3,
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      scale: [1, 1, 1] as V3,
    };
    commands.push({
      type: 'scene.node.create',
      payload: { node: { kind: 'group', id: top, name: o.name, parentId, transform } },
    } as BatchSubCommand);
    predicted.push({ id: top, kind: 'group', name: o.name, parentId, transform } as unknown as SceneNode);
    nodeIds.push(top);
  }
  for (const [gi, g] of groups.entries()) {
    const bytes = keepOriginal ? a.original : glbFor(a, g, o.frame);
    if (bytes.byteLength > MAX_ASSET_BYTES)
      return fail(
        err(
          'asset-too-large',
          `The converted model is ${(bytes.byteLength / 1048576).toFixed(1)} MiB; the asset limit is 16 MiB (simplify the mesh or coarsen the STEP tessellation).`,
        ),
      );
    const hash = `sha256-${sha256Bytes(bytes)}`;
    if (!assets.some((x) => x.hash === hash)) assets.push({ hash, bytes, mediaType });
    const partScene = keepOriginal ? a.scene : parseGltf(bytes).scene!;
    const { boundsM, minM } = modelBounds(partScene, {
      toMetres: unitScale,
      upAxis: o.frame.upAxis,
      handedness: 'right',
    });
    const partName = o.split ? a.scene.nodes[g[0]!]!.name || `${o.name} ${gi + 1}` : o.name;
    const model: ModelRef = {
      assetHash: hash,
      byteLength: bytes.byteLength,
      mediaType,
      name: partName.slice(0, 200),
      categoryId: o.categoryId,
      description: (o.description ?? `Imported from ${a.fileName}`).slice(0, 2000),
      unitScale,
      upAxis: o.frame.upAxis,
      boundsM,
      minM,
      metadata: {
        'source.file': a.fileName.slice(0, 500),
        'source.format': a.format,
        'source.hash': a.sourceHash,
        'geometry.class': a.geometryClass,
        ...(a.generator ? { 'source.generator': a.generator.slice(0, 500) } : {}),
        ...(o.split ? { 'source.part': partName.slice(0, 500) } : {}),
      },
      interfaces: [],
    };
    const id = o.newId();
    // Split parts sit at the group origin so their relative placement is exact; a single
    // instance is lifted so its base rests on y = 0 (as Phase 4 insertion does).
    const transform = {
      position: top ? ([0, 0, 0] as V3) : position(minM),
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      scale: [1, 1, 1] as V3,
    };
    commands.push({
      type: 'model.instance.create',
      payload: { id, name: partName.slice(0, 200), parentId: top ?? parentId, transform, model },
    } as BatchSubCommand);
    predicted.push({
      id,
      kind: 'model-instance',
      name: partName.slice(0, 200),
      parentId: top ?? parentId,
      transform,
      model,
    } as unknown as SceneNode);
    nodeIds.push(id);
  }
  const root = project.scene.nodes[project.scene.rootId];
  const sim = root?.kind === 'root' ? root.simulation : undefined;
  if (o.physics) {
    if (!sim)
      d.push(
        warn(
          'no-simulation',
          'The project has no simulation setup: the supplied mass and collider were not applied (add them in Simulation mode).',
        ),
      );
    else {
      const body = top ?? nodeIds[0]!;
      commands.push({
        type: 'physics.body.set',
        payload: {
          nodeId: body,
          settings: {
            mass: { source: 'user', massKg: o.physics.massKg, note: o.physics.note.slice(0, 500) },
            collider: o.physics.collider,
          },
        },
      } as BatchSubCommand);
      conversions.push(
        `User-supplied mass ${o.physics.massKg} kg (${o.physics.note || 'no note'}); collider: ${o.physics.collider}`,
      );
    }
  }
  const s = preview.metrics;
  const record: ImportRecord = {
    id: o.importId,
    format: a.format,
    formatVersion: a.formatVersion,
    fileName: a.fileName.slice(0, 260),
    byteLength: a.byteLength,
    sourceHash: a.sourceHash,
    referencedFiles: [],
    importedAt: (o.now ?? new Date()).toISOString(),
    importer: INTEROP_VERSION,
    sourceUnit: (a.format === 'step' ? a.defaultFrame.unitName : o.frame.unitName).slice(0, 32),
    toMetres: a.format === 'step' ? (a.step?.lengthUnit?.toMetres ?? 0.001) : o.frame.toMetres,
    upAxis: o.frame.upAxis,
    handedness: o.frame.handedness,
    geometryClass: a.geometryClass,
    nodeIds,
    assetHashes: assets.map((x) => x.hash),
    summary: {
      triangles: s.triangles,
      vertices: s.vertices,
      parts: groups.length,
      'size.x.m': s.bounds!.size[0],
      'size.y.m': s.bounds!.size[1],
      'size.z.m': s.bounds!.size[2],
      'area.m2': s.surfaceAreaM2,
      ...(s.closed ? { 'volume.m3': Math.abs(s.volume) } : {}),
      closed: s.closed ? 'yes' : 'no',
      components: s.components,
      ...(a.step ? { 'step.products': a.step.products.length, 'step.brep.faces': a.step.faces } : {}),
    },
    conversions,
    unsupported: a.unsupported.slice(0, 500).map((x) => x.slice(0, 500)),
    warnings: [...d, ...preview.warnings]
      .filter((x) => x.severity !== 'info')
      .map((x) => x.message.slice(0, 1000)),
    nodesFingerprint: nodesFingerprint(predicted),
  };
  commands.push({ type: 'interop.import.record', payload: { record } } as BatchSubCommand);
  return { ok: true, diagnostics: [...d, ...preview.warnings], assets, commands, record, nodeIds };
}
