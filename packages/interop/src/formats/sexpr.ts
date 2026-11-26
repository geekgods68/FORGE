/**
 * Minimal S-expression reader for KiCad files (netlists, PCBs, schematics). Atoms are
 * strings; quoted strings support \" and \\ escapes. Pure data: nothing is evaluated.
 * Depth and node count are bounded (resource guard against hostile files).
 */
export type SExpr = string | SExpr[];

export class SExprError extends Error {}

export function parseSExpr(text: string, limits = { depth: 200, nodes: 5_000_000 }): SExpr {
  let i = 0;
  let nodes = 0;
  const n = text.length;
  const ws = () => {
    while (i < n && /\s/.test(text[i]!)) i++;
  };
  const read = (depth: number): SExpr => {
    if (depth > limits.depth) throw new SExprError('Nesting too deep.');
    if (++nodes > limits.nodes) throw new SExprError('Too many elements.');
    ws();
    if (text[i] === '(') {
      i++;
      const list: SExpr[] = [];
      for (;;) {
        ws();
        if (i >= n) throw new SExprError('Unexpected end of file (unbalanced parentheses).');
        if (text[i] === ')') {
          i++;
          return list;
        }
        list.push(read(depth + 1));
      }
    }
    if (text[i] === '"') {
      i++;
      let s = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const c = text[i + 1]!;
          s += c === 'n' ? '\n' : c;
          i += 2;
        } else s += text[i++];
      }
      if (i >= n) throw new SExprError('Unterminated string.');
      i++;
      return s;
    }
    const start = i;
    while (i < n && !/[\s()]/.test(text[i]!)) i++;
    if (start === i) throw new SExprError(`Unexpected "${text[i] ?? 'end of file'}" at offset ${i}.`);
    return text.slice(start, i);
  };
  const root = read(0);
  ws();
  if (i < n) throw new SExprError('Trailing content after the root expression.');
  return root;
}

export const head = (e: SExpr): string | null => (Array.isArray(e) && typeof e[0] === 'string' ? e[0] : null);
/** Child lists with the given head. */
export const all = (e: SExpr, name: string): SExpr[][] =>
  Array.isArray(e) ? (e.filter((c) => head(c) === name) as SExpr[][]) : [];
export const first = (e: SExpr, name: string): SExpr[] | null => all(e, name)[0] ?? null;
/** First atom argument of a child list: (name "value") → value. */
export const val = (e: SExpr, name: string): string | null => {
  const c = first(e, name);
  return c && typeof c[1] === 'string' ? c[1] : null;
};
