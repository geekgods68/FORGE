import { isDimensionless, mulDims, parseUnit, powDims, sameDims, formatDims, type Dims } from './units';

/**
 * Restricted expression language for derived measurements. Allowed: numbers, signal aliases,
 * + − × ÷, integer powers (^), parentheses and the functions abs, sqrt, sq, min, max.
 * Nothing else is evaluated — no JavaScript, no property access. Dimensions are checked at
 * parse time: adding an angle to an effort, or sqrt of a non-square dimension, is an error.
 */
export type Node =
  | { k: 'num'; v: number }
  | { k: 'sig'; name: string }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Node; b: Node }
  | { k: 'pow'; a: Node; p: number }
  | { k: 'fn'; name: 'abs' | 'sqrt' | 'sq' | 'min' | 'max'; args: Node[] };

export interface ParsedExpr {
  ast: Node;
  dims: Dims;
  signals: string[];
}

export class ExprError extends Error {}

const FNS = new Set(['abs', 'sqrt', 'sq', 'min', 'max']);

export function parseExpr(src: string, signalUnits: Record<string, string>): ParsedExpr {
  if (src.length > 500) throw new ExprError('Expression too long (500 characters max).');
  const toks = src.match(/\s*(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|[-+*/^(),])/gy);
  const joined = (toks ?? []).join('');
  if (joined.replace(/\s/g, '') !== src.replace(/\s/g, ''))
    throw new ExprError('Invalid character in expression.');
  const t = (toks ?? []).map((x) => x.trim());
  let i = 0;
  const signals = new Set<string>();
  const peek = () => t[i];
  const eat = (x?: string) => {
    const v = t[i++];
    if (x !== undefined && v !== x) throw new ExprError(`Expected "${x}" but found "${v ?? 'end'}".`);
    return v;
  };
  const dimsOf = (n: Node): Dims => {
    switch (n.k) {
      case 'num':
        return [0, 0, 0, 0, 0, 0];
      case 'sig': {
        const u = parseUnit(signalUnits[n.name] ?? '');
        if (!u) throw new ExprError(`Signal "${n.name}" has an unknown unit "${signalUnits[n.name]}".`);
        return u.dims;
      }
      case 'neg':
        return dimsOf(n.a);
      case 'pow':
        return powDims(dimsOf(n.a), n.p);
      case 'bin': {
        const a = dimsOf(n.a);
        const b = dimsOf(n.b);
        if (n.op === '+' || n.op === '-') {
          if (!sameDims(a, b))
            throw new ExprError(
              `Cannot ${n.op === '+' ? 'add' : 'subtract'} ${formatDims(a)} and ${formatDims(b)}.`,
            );
          return a;
        }
        return mulDims(a, b, n.op === '*' ? 1 : -1);
      }
      case 'fn': {
        const ds = n.args.map(dimsOf);
        if (n.name === 'sqrt') {
          const h = powDims(ds[0]!, 0.5);
          if (h.some((x) => Math.abs(x - Math.round(x)) > 1e-9))
            throw new ExprError(`sqrt of ${formatDims(ds[0]!)} has no valid unit.`);
          return h;
        }
        if (n.name === 'sq') return powDims(ds[0]!, 2);
        if (n.name === 'min' || n.name === 'max')
          if (!sameDims(ds[0]!, ds[1]!))
            throw new ExprError(`${n.name}() needs arguments with the same unit.`);
        return ds[0]!;
      }
    }
  };
  const primary = (): Node => {
    const v = eat();
    if (v === undefined) throw new ExprError('Unexpected end of expression.');
    if (/^[\d.]/.test(v)) return { k: 'num', v: Number(v) };
    if (v === '(') {
      const e = expr();
      eat(')');
      return e;
    }
    if (v === '-') return { k: 'neg', a: unary() };
    if (/^[A-Za-z_]/.test(v)) {
      if (peek() === '(') {
        if (!FNS.has(v)) throw new ExprError(`Unknown function "${v}" (allowed: ${[...FNS].join(', ')}).`);
        eat('(');
        const args = [expr()];
        while (peek() === ',') {
          eat(',');
          args.push(expr());
        }
        eat(')');
        const want = v === 'min' || v === 'max' ? 2 : 1;
        if (args.length !== want) throw new ExprError(`${v}() takes ${want} argument(s).`);
        return { k: 'fn', name: v as 'abs', args };
      }
      if (!(v in signalUnits)) throw new ExprError(`Unknown signal "${v}".`);
      signals.add(v);
      return { k: 'sig', name: v };
    }
    throw new ExprError(`Unexpected "${v}".`);
  };
  const unary = (): Node => (peek() === '-' ? (eat(), { k: 'neg', a: unary() }) : power());
  const power = (): Node => {
    const a = primary();
    if (peek() === '^') {
      eat('^');
      const neg = peek() === '-' ? (eat(), -1) : 1;
      const p = Number(eat());
      if (!Number.isInteger(p) || Math.abs(p) > 4)
        throw new ExprError('Powers must be integers between −4 and 4.');
      return { k: 'pow', a, p: neg * p };
    }
    return a;
  };
  const term = (): Node => {
    let a = unary();
    while (peek() === '*' || peek() === '/') {
      const op = eat() as '*' | '/';
      a = { k: 'bin', op, a, b: unary() };
    }
    return a;
  };
  const expr = (): Node => {
    let a = term();
    while (peek() === '+' || peek() === '-') {
      const op = eat() as '+' | '-';
      a = { k: 'bin', op, a, b: term() };
    }
    return a;
  };
  const ast = expr();
  if (i < t.length) throw new ExprError(`Unexpected "${t[i]}".`);
  return { ast, dims: dimsOf(ast), signals: [...signals] };
}

/** Evaluate elementwise; NaN propagates (missing stays missing). */
export function evalExpr(n: Node, get: (name: string) => number): number {
  switch (n.k) {
    case 'num':
      return n.v;
    case 'sig':
      return get(n.name);
    case 'neg':
      return -evalExpr(n.a, get);
    case 'pow':
      return evalExpr(n.a, get) ** n.p;
    case 'bin': {
      const a = evalExpr(n.a, get);
      const b = evalExpr(n.b, get);
      return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : a / b;
    }
    case 'fn': {
      const a = evalExpr(n.args[0]!, get);
      if (n.name === 'abs') return Math.abs(a);
      if (n.name === 'sqrt') return Math.sqrt(a);
      if (n.name === 'sq') return a * a;
      const b = evalExpr(n.args[1]!, get);
      return n.name === 'min' ? Math.min(a, b) : Math.max(a, b);
    }
  }
}

export { isDimensionless };
