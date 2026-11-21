import {
  BoxGeometry,
  BufferGeometry,
  DataTexture,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import { describe, expect, it } from 'vitest';
import { estimateGpuMemory } from './gpuEstimate';

const fb = { width: 0, height: 0, samples: 1 };

describe('GPU memory estimate (debug readout)', () => {
  it('counts a shared geometry once and every instance buffer (matrix + colour)', () => {
    const geo = new BoxGeometry(1, 1, 1);
    const own =
      Object.values(geo.attributes).reduce((s, a) => s + (a.array as Float32Array).byteLength, 0) +
      geo.index!.array.byteLength;
    const mat = new MeshBasicMaterial();
    const root = new Group();
    root.add(new Mesh(geo, mat), new Mesh(geo, mat));
    const inst = new InstancedMesh(geo, mat, 10);
    inst.instanceColor = new InstancedBufferAttribute(new Float32Array(30), 3);
    root.add(inst);
    const e = estimateGpuMemory(root, fb);
    expect(e.kind).toBe('estimate');
    expect(e.geometryBytes).toBe(own);
    expect(e.instanceBytes).toBe(10 * 16 * 4 + 30 * 4);
  });

  it('counts an interleaved vertex buffer once, not once per attribute', () => {
    const data = new InterleavedBuffer(new Float32Array(6 * 100), 6);
    const g = new BufferGeometry();
    g.setAttribute('position', new InterleavedBufferAttribute(data, 3, 0));
    g.setAttribute('normal', new InterleavedBufferAttribute(data, 3, 3));
    const root = new Group();
    root.add(new Mesh(g, new MeshBasicMaterial()));
    expect(estimateGpuMemory(root, fb).geometryBytes).toBe(6 * 100 * 4);
  });

  it('includes each distinct material texture once (RGBA8, with mips when generated) and the framebuffer', () => {
    const tex = new DataTexture(new Uint8Array(64 * 32 * 4), 64, 32);
    tex.generateMipmaps = false;
    const mat = new MeshBasicMaterial({ map: tex });
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(), mat), new Mesh(new BoxGeometry(), mat));
    const e = estimateGpuMemory(root, { width: 100, height: 50, samples: 4 });
    expect(e.textureBytes).toBe(64 * 32 * 4);
    expect(e.framebufferBytes).toBe(100 * 50 * 8 * 4);
  });
});
