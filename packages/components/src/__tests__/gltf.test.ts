import { describe, expect, it } from 'vitest';
import { checkModelBytes, minimalGlb, modelSizeToMetres } from '../gltf';

describe('GLB / glTF validation', () => {
  it('accepts a well-formed GLB', () => {
    const r = checkModelBytes(minimalGlb());
    expect(r).toMatchObject({ ok: true, format: 'glb', issues: [] });
  });
  it('rejects bad containers, versions, truncated files, external resources and non-models', () => {
    const glb = minimalGlb();
    const badVersion = glb.slice();
    new DataView(badVersion.buffer).setUint32(4, 1, true);
    expect(checkModelBytes(badVersion).issues.join()).toMatch(/version 1/);
    expect(checkModelBytes(glb.slice(0, glb.length - 4)).issues.join()).toMatch(/does not match/);
    const ext = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: '2.0' },
        meshes: [{}],
        buffers: [{ uri: 'https://example.invalid/a.bin' }],
      }),
    );
    expect(checkModelBytes(ext)).toMatchObject({ ok: false, format: 'gltf' });
    expect(checkModelBytes(ext).issues.join()).toMatch(/External resource/);
    expect(checkModelBytes(new TextEncoder().encode('not a model')).ok).toBe(false);
    const noMesh = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } }));
    expect(checkModelBytes(noMesh).issues.join()).toMatch(/no meshes/);
  });
  it('converts measured sizes to metres with the confirmed unit and up-axis', () => {
    expect(modelSizeToMetres([100, 20, 50], 'mm', 'Y')).toEqual([0.1, 0.02, 0.05]);
    expect(modelSizeToMetres([100, 20, 50], 'mm', 'Z')).toEqual([0.1, 0.05, 0.02]);
    expect(modelSizeToMetres([1, 1, 1], 'in', 'Y')[0]).toBeCloseTo(0.0254, 12);
  });
});

describe('imported-model interface vocabulary', () => {
  it('matches the catalogue interface types (same compatibility rules apply)', async () => {
    const { MODEL_INTERFACE_TYPES } = await import('@forge/engineering-core');
    const { INTERFACE_TYPES } = await import('../schemas');
    expect([...MODEL_INTERFACE_TYPES]).toEqual([...INTERFACE_TYPES]);
  });
});
