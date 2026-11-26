/**
 * Minimal, safe XML reader for URDF. Elements, attributes, text, comments, CDATA and the
 * XML declaration. DOCTYPE and ENTITY declarations are REFUSED (no external entities, no
 * entity expansion); only the five predefined entities and numeric character references
 * are decoded. Depth and element count are bounded.
 */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}
export class XmlError extends Error {}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    const r = ENT[e];
    if (r === undefined) throw new XmlError(`Unknown entity ${m} (custom entities are not allowed).`);
    return r;
  });
}

export function parseXml(text: string, limits = { depth: 64, elements: 200_000 }): XmlElement {
  let i = 0;
  let count = 0;
  const n = text.length;
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new XmlError('DOCTYPE/ENTITY declarations are not allowed.');
  const skipMisc = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i]!)) i++;
      if (text.startsWith('<?', i)) {
        const e = text.indexOf('?>', i);
        if (e < 0) throw new XmlError('Unterminated processing instruction.');
        i = e + 2;
      } else if (text.startsWith('<!--', i)) {
        const e = text.indexOf('-->', i);
        if (e < 0) throw new XmlError('Unterminated comment.');
        i = e + 3;
      } else return;
    }
  };
  const element = (depth: number): XmlElement => {
    if (depth > limits.depth) throw new XmlError('XML nested too deeply.');
    if (++count > limits.elements) throw new XmlError('Too many XML elements.');
    if (text[i] !== '<') throw new XmlError(`Expected "<" at offset ${i}.`);
    i++;
    const nm = /^[A-Za-z_][\w:.-]*/.exec(text.slice(i, i + 200));
    if (!nm) throw new XmlError(`Bad element name at offset ${i}.`);
    const el: XmlElement = { name: nm[0], attrs: {}, children: [], text: '' };
    i += nm[0].length;
    for (;;) {
      while (i < n && /\s/.test(text[i]!)) i++;
      if (text.startsWith('/>', i)) {
        i += 2;
        return el;
      }
      if (text[i] === '>') {
        i++;
        break;
      }
      const am = /^([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(text.slice(i, i + 100_000));
      if (!am) throw new XmlError(`Bad attribute in <${el.name}> at offset ${i}.`);
      if (am[1]! in el.attrs) throw new XmlError(`Duplicate attribute "${am[1]}" in <${el.name}>.`);
      el.attrs[am[1]!] = decode(am[3] ?? am[4] ?? '');
      i += am[0].length;
    }
    for (;;) {
      if (i >= n) throw new XmlError(`Unclosed <${el.name}>.`);
      if (text.startsWith('</', i)) {
        const e = text.indexOf('>', i);
        const close = text.slice(i + 2, e).trim();
        if (close !== el.name) throw new XmlError(`</${close}> does not close <${el.name}>.`);
        i = e + 1;
        return el;
      }
      if (text.startsWith('<!--', i)) {
        const e = text.indexOf('-->', i);
        if (e < 0) throw new XmlError('Unterminated comment.');
        i = e + 3;
      } else if (text.startsWith('<![CDATA[', i)) {
        const e = text.indexOf(']]>', i);
        if (e < 0) throw new XmlError('Unterminated CDATA.');
        el.text += text.slice(i + 9, e);
        i = e + 3;
      } else if (text[i] === '<') el.children.push(element(depth + 1));
      else {
        const e = text.indexOf('<', i);
        el.text += decode(text.slice(i, e < 0 ? n : e));
        i = e < 0 ? n : e;
      }
    }
  };
  skipMisc();
  const root = element(0);
  skipMisc();
  if (i < n) throw new XmlError('Content after the root element.');
  return root;
}

export const kids = (e: XmlElement, name: string) => e.children.filter((c) => c.name === name);
export const kid = (e: XmlElement, name: string) => e.children.find((c) => c.name === name) ?? null;
