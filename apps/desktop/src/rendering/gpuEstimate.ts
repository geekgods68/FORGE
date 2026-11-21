import {
  InstancedMesh,
  Mesh,
  type BufferAttribute,
  type BufferGeometry,
  type InterleavedBufferAttribute,
  type Material,
  type Object3D,
  type Texture,
} from 'three';

/**
 * ESTIMATE of GPU memory held by a scene — explicitly NOT a measurement (WebGL exposes no
 * per-resource GPU memory; drivers pad, compress and keep their own copies). Phase 4.1
 * corrected the earlier readout, which counted interleaved/shared vertex buffers once per
 * attribute and ignored instance colours, morph targets and non-sign textures:
 * - vertex/index data: each underlying ArrayBuffer once (shared and interleaved buffers deduplicated);
 * - instance data: instanceMatrix and instanceColor of every InstancedMesh (each buffer once);
 * - textures: every distinct texture on scene materials, RGBA8 with a full mip chain (×4/3)
 *   unless mipmaps are disabled; compressed formats and render targets are not modelled;
 * - default framebuffer: colour + depth (8 B/px), ×samples when antialiased.
 * Shader programs and driver overhead are excluded. Use only for relative comparisons.
 */
export interface GpuEstimate {
  kind: 'estimate';
  geometryBytes: number;
  instanceBytes: number;
  textureBytes: number;
  framebufferBytes: number;
  totalMB: number;
}

type Attr = BufferAttribute | InterleavedBufferAttribute;
const bufferOf = (a: Attr): ArrayBufferView =>
  ((a as InterleavedBufferAttribute).isInterleavedBufferAttribute
    ? (a as InterleavedBufferAttribute).data.array
    : (a as BufferAttribute).array) as unknown as ArrayBufferView;

export function estimateGpuMemory(
  root: Object3D,
  framebuffer: { width: number; height: number; samples: number },
): GpuEstimate {
  const buffers = new Set<ArrayBufferLike>();
  let geometryBytes = 0;
  let instanceBytes = 0;
  const addBuffer = (view: ArrayBufferView, instance = false) => {
    // Count the viewed bytes once per underlying buffer.
    if (buffers.has(view.buffer)) return;
    buffers.add(view.buffer);
    if (instance) instanceBytes += view.byteLength;
    else geometryBytes += view.byteLength;
  };
  const geometries = new Set<BufferGeometry>();
  const textures = new Set<Texture>();
  root.traverse((o) => {
    if (o instanceof Mesh) {
      geometries.add(o.geometry as BufferGeometry);
      for (const m of ([] as Material[]).concat(o.material as Material | Material[]))
        for (const v of Object.values(m)) if ((v as Texture | null)?.isTexture) textures.add(v as Texture);
    }
    if (o instanceof InstancedMesh) {
      addBuffer(o.instanceMatrix.array, true);
      if (o.instanceColor) addBuffer(o.instanceColor.array, true);
    }
  });
  for (const g of geometries) {
    for (const a of Object.values(g.attributes)) addBuffer(bufferOf(a as Attr));
    for (const list of Object.values(g.morphAttributes)) for (const a of list) addBuffer(bufferOf(a as Attr));
    if (g.index) addBuffer(g.index.array);
  }
  let textureBytes = 0;
  for (const t of textures) {
    const img = t.image as { width?: number; height?: number } | null;
    const w = img?.width ?? 0;
    const h = img?.height ?? 0;
    textureBytes += w * h * 4 * (t.generateMipmaps ? 4 / 3 : 1);
  }
  textureBytes = Math.round(textureBytes);
  const framebufferBytes = framebuffer.width * framebuffer.height * 8 * framebuffer.samples;
  const total = geometryBytes + instanceBytes + textureBytes + framebufferBytes;
  return {
    kind: 'estimate',
    geometryBytes,
    instanceBytes,
    textureBytes,
    framebufferBytes,
    totalMB: +(total / 1048576).toFixed(2),
  };
}
