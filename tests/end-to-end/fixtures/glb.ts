/** Minimal valid GLB (one triangle list, positions in model units) for browser tests. */
export function glb(positions: number[]): Buffer {
  const bin = Buffer.from(new Float32Array(positions).buffer);
  const min = [0, 1, 2].map((i) => Math.min(...positions.filter((_, k) => k % 3 === i)));
  const max = [0, 1, 2].map((i) => Math.max(...positions.filter((_, k) => k % 3 === i)));
  let json = JSON.stringify({
    asset: { version: '2.0', generator: 'FORGE e2e' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max }],
  });
  while (json.length % 4) json += ' ';
  const j = Buffer.from(json);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(j.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, j, bh, bin]);
}
