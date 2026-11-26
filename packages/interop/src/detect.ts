import { isBinaryStl } from './formats/stl';
import { MAX_INPUT_BYTES, type FileInput, type FormatId } from './schemas';

/**
 * Format detection from CONTENT first (magic numbers, signatures, root elements), with the
 * extension used only to break ties and to report a mismatch. Detection never implies that
 * a format is supported — see CAPABILITIES.
 */
declare const TextDecoder: { new (label?: string): { decode(input: Uint8Array): string } };

export interface Detection {
  format: FormatId | null;
  confidence: 'content' | 'extension' | 'none';
  /** Extension disagrees with content (e.g. a GLB named .stl). */
  mismatch: string | null;
  reason: string;
}

const EXT: Record<string, FormatId> = {
  stl: 'stl',
  glb: 'glb',
  gltf: 'gltf',
  step: 'step',
  stp: 'step',
  urdf: 'urdf',
  cir: 'spice',
  sp: 'spice',
  spice: 'spice',
  ckt: 'spice',
  kicad_pcb: 'kicad-pcb',
  kicad_sch: 'kicad-schematic',
};

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9_]+)$/.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

export function detectFormat(file: FileInput): Detection {
  const b = file.bytes;
  const ext = extensionOf(file.name);
  const byExt = EXT[ext] ?? null;
  const result = (
    format: FormatId | null,
    confidence: Detection['confidence'],
    reason: string,
  ): Detection => ({
    format,
    confidence,
    mismatch:
      format && byExt && byExt !== format ? `The file is named .${ext} but its content is ${format}.` : null,
    reason,
  });
  if (b.byteLength >= 4 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46)
    return result('glb', 'content', 'GLB magic "glTF"');
  if (isBinaryStl(b)) return result('stl', 'content', 'binary STL (84 + 50·n bytes)');
  const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.byteLength, 4096)));
  const t = head.replace(/^\uFEFF/, '').trimStart();
  if (/^ISO-10303-21\s*;/.test(t)) return result('step', 'content', 'ISO-10303-21 signature');
  if (/^solid\b/i.test(t) && /facet\s+normal|endsolid/i.test(head))
    return result('stl', 'content', 'ASCII STL "solid … facet"');
  if (/^\(kicad_pcb\b/.test(t)) return result('kicad-pcb', 'content', '(kicad_pcb …) root');
  if (/^\(kicad_sch\b/.test(t)) return result('kicad-schematic', 'content', '(kicad_sch …) root');
  if (/^\(export\s*\(version\s*"?[A-Z0-9]/.test(t))
    return result('kicad-netlist', 'content', 'KiCad netlist (export (version …))');
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<robot\b/.test(t))
    return result('urdf', 'content', 'XML with <robot> root');
  if (t.startsWith('{')) {
    if (/"format"\s*:\s*"forge-electrical-bundle"/.test(head))
      return result('forge-electrical', 'content', 'FORGE electrical bundle');
    if (/"format"\s*:\s*"forge-bundle"/.test(head) || /"assets"\s*:/.test(head))
      return result('forge-bundle', 'content', 'FORGE project bundle');
    if (
      /"schemaVersion"\s*:/.test(head) &&
      /"scene"\s*:/.test(
        new TextDecoder('latin1').decode(
          b.subarray(0, Math.min(b.byteLength, MAX_INPUT_BYTES['forge-project'])),
        ),
      )
    )
      return result('forge-project', 'content', 'FORGE project document');
    if (/"asset"\s*:/.test(new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.byteLength, 1 << 20)))))
      return result('gltf', 'content', 'glTF JSON ("asset")');
  }
  // SPICE: a title line followed by element cards (R1 n1 n2 1k …) or dot-commands.
  const lines = head
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'));
  if (
    lines.length &&
    lines.some((l) => /^[RCLVIEGDQMX][\w.]*\s+\S+\s+\S+/i.test(l)) &&
    lines.every((l) => /^([RCLVIEGDQMXKFHJSWBTOU][\w.]*\s|\.|\+)/i.test(l))
  )
    return result('spice', 'content', 'SPICE element cards');
  if (byExt) return result(byExt, 'extension', `by extension .${ext} only`);
  return result(null, 'none', 'not recognised');
}
