import { describe, expect, it } from 'vitest';
import { detectFormat } from '../detect';
import { writeGlb } from '../formats/gltf';
import { writeStl } from '../formats/stl';
import { boxSoup, sceneOf, TETRA_ASCII } from './fixtures';
import { stepAssembly } from './step-fixtures';

const enc = new TextEncoder();
const f = (name: string, text: string | Uint8Array) => ({
  name,
  bytes: typeof text === 'string' ? enc.encode(text) : text,
});

describe('format detection (content first)', () => {
  it('detects each format by content and flags misleading extensions', () => {
    expect(detectFormat(f('a.stl', writeStl(boxSoup([1, 1, 1])))).format).toBe('stl');
    expect(detectFormat(f('a.stl', TETRA_ASCII)).format).toBe('stl');
    const glb = detectFormat(
      f('model.stl', writeGlb(sceneOf([{ name: 'a', soup: boxSoup([1, 1, 1]) }], [0]))),
    );
    expect(glb.format).toBe('glb');
    expect(glb.mismatch).toMatch(/named \.stl/);
    expect(
      detectFormat(f('x.txt', stepAssembly([{ name: 'P', size: [1, 1, 1], at: [0, 0, 0] }]))).format,
    ).toBe('step');
    expect(
      detectFormat(f('r.xml', '<?xml version="1.0"?>\n<!-- arm -->\n<robot name="arm"></robot>')).format,
    ).toBe('urdf');
    expect(
      detectFormat(f('rc.cir', 'RC test\nV1 in 0 DC 5\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 5m\n.end\n'))
        .format,
    ).toBe('spice');
    expect(detectFormat(f('a.net', '(export (version "E")\n  (design))')).format).toBe('kicad-netlist');
    expect(detectFormat(f('b.kicad_pcb', '(kicad_pcb (version 20221018))')).format).toBe('kicad-pcb');
    expect(detectFormat(f('c.kicad_sch', '(kicad_sch (version 20230121))')).format).toBe('kicad-schematic');
    expect(detectFormat(f('m.gltf', '{"asset":{"version":"2.0"},"meshes":[]}')).format).toBe('gltf');
  });
  it('falls back to the extension only when the content is not recognised, and says so', () => {
    const d = detectFormat(f('broken.step', 'not really'));
    expect(d.format).toBe('step');
    expect(d.confidence).toBe('extension');
    expect(detectFormat(f('notes.txt', 'hello world')).format).toBeNull();
  });
});
