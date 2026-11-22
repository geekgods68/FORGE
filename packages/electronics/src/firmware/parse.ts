import { TYPE_NAMES, unsignedOf, type CType } from './types';

/**
 * Lexer + recursive-descent parser for the FORGE Arduino subset (docs/EMBEDDED_RUNTIME.md).
 * Untrusted input: source size, token count, nesting depth and node count are bounded, and
 * every error carries a line and column. Nothing here executes code.
 */
export const LIMITS = { sourceBytes: 64 * 1024, tokens: 60_000, nodes: 120_000, depth: 96 };
export const ALLOWED_INCLUDES = new Set(['Arduino.h', 'Servo.h']);

export interface Pos {
  line: number;
  col: number;
}
export class FirmwareError extends Error {
  constructor(
    message: string,
    readonly pos: Pos,
  ) {
    super(`${pos.line}:${pos.col}: ${message}`);
  }
}

interface Tok extends Pos {
  k: 'id' | 'num' | 'str' | 'op' | 'eof';
  v: string;
  n?: number;
  nt?: CType;
}

const OPS = [
  '<<=',
  '>>=',
  '...',
  '->',
  '++',
  '--',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '::',
  ...'+-*/%<>=!&|^~?:;,.()[]{}'.split(''),
];

const ESC: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  '\\': '\\',
  "'": "'",
  '"': '"',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
};

export interface Preprocessed {
  tokens: Tok[];
  includes: string[];
  defines: string[];
}

export function lex(src: string): Preprocessed {
  if (src.length > LIMITS.sourceBytes)
    throw new FirmwareError(`Source too large (${src.length} > ${LIMITS.sourceBytes} bytes).`, {
      line: 1,
      col: 1,
    });
  const raw: Tok[] = [];
  const includes: string[] = [];
  const macros = new Map<string, Tok[]>();
  let i = 0;
  let line = 1;
  let col = 1;
  let lineStart = true;
  const adv = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
        lineStart = true;
      } else col++;
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') {
      adv(1);
      continue;
    }
    if (/\s/.test(c)) {
      adv(1);
      continue;
    }
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') adv(1);
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new FirmwareError('Unterminated comment.', { line, col });
      adv(end + 2 - i);
      continue;
    }
    const pos = { line, col };
    if (c === '#' && lineStart) {
      let end = src.indexOf('\n', i);
      if (end < 0) end = src.length;
      const text = src.slice(i + 1, end).trim();
      adv(end - i);
      const inc = /^include\s*[<"]([^>"]+)[>"]$/.exec(text);
      if (inc) {
        if (!ALLOWED_INCLUDES.has(inc[1]!))
          throw new FirmwareError(
            `Library <${inc[1]}> is not supported by the FORGE Arduino subset (supported: ${[...ALLOWED_INCLUDES].join(', ')}).`,
            pos,
          );
        includes.push(inc[1]!);
        continue;
      }
      const def = /^define\s+([A-Za-z_]\w*)(\(?)(.*)$/.exec(text);
      if (def) {
        if (def[2] === '(')
          throw new FirmwareError(`Function-like macro "${def[1]}" is not supported; use a function.`, pos);
        const body = lex(def[3]!.replace(/\/\/.*$/, '')).tokens.filter((t) => t.k !== 'eof');
        macros.set(
          def[1]!,
          body.map((t) => ({ ...t, ...pos })),
        );
        continue;
      }
      throw new FirmwareError(`Preprocessor directive "#${text.split(/\s/)[0]}" is not supported.`, pos);
    }
    lineStart = false;
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 256))!;
      raw.push({ k: 'id', v: m[0], ...pos });
      adv(m[0].length);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const s = src.slice(i, i + 64);
      let m = /^0[xX][0-9a-fA-F]+([uUlL]*)/.exec(s);
      let n: number;
      let nt: CType;
      if (m) {
        n = parseInt(m[0].replace(/[uUlL]+$/, ''), 16);
        nt = intLiteralType(n, m[1]!, false);
      } else if ((m = /^0[bB][01]+([uUlL]*)/.exec(s))) {
        n = parseInt(m[0].slice(2).replace(/[uUlL]+$/, ''), 2);
        nt = intLiteralType(n, m[1]!, false);
      } else if ((m = /^(\d+\.\d*|\.\d+|\d+(?=[eE]))([eE][+-]?\d+)?[fF]?/.exec(s))) {
        n = parseFloat(m[0].replace(/[fF]$/, ''));
        nt = 'float';
      } else if ((m = /^0[0-7]+([uUlL]*)/.exec(s))) {
        n = parseInt(m[0].replace(/[uUlL]+$/, ''), 8); // C octal: 010 == 8
        nt = intLiteralType(n, m[1]!, false);
      } else {
        m = /^\d+([uUlL]*)/.exec(s)!;
        n = parseInt(m[0].replace(/[uUlL]+$/, ''), 10);
        nt = intLiteralType(n, m[1]!, true);
      }
      if (/^[A-Za-z_]/.test(s.slice(m[0].length)))
        throw new FirmwareError(`Invalid number "${s.slice(0, m[0].length + 1)}".`, pos);
      raw.push({ k: 'num', v: m[0], n, nt, ...pos });
      adv(m[0].length);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\n') throw new FirmwareError('Unterminated string.', pos);
        if (src[j] === '\\') {
          out += ESC[src[j + 1]!] ?? src[j + 1];
          j += 2;
        } else out += src[j++];
      }
      if (src[j] !== '"') throw new FirmwareError('Unterminated string.', pos);
      raw.push({ k: 'str', v: out, ...pos });
      adv(j + 1 - i);
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let ch: string;
      if (src[j] === '\\') {
        ch = ESC[src[j + 1]!] ?? src[j + 1]!;
        j += 2;
      } else ch = src[j++]!;
      if (src[j] !== "'") throw new FirmwareError('Invalid character literal.', pos);
      raw.push({ k: 'num', v: `'${ch}'`, n: ch.charCodeAt(0), nt: 'char', ...pos });
      adv(j + 1 - i);
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FirmwareError(`Unexpected character "${c}".`, pos);
    raw.push({ k: 'op', v: op, ...pos });
    adv(op.length);
    if (raw.length > LIMITS.tokens) throw new FirmwareError('Program too large (token limit).', pos);
  }
  // Object-like macro substitution (bounded: no recursive expansion).
  const tokens: Tok[] = [];
  for (const t of raw) {
    const body = t.k === 'id' ? macros.get(t.v) : undefined;
    if (body) tokens.push(...body.map((b) => ({ ...b, line: t.line, col: t.col })));
    else tokens.push(t);
  }
  tokens.push({ k: 'eof', v: '', line, col });
  return { tokens, includes, defines: [...macros.keys()] };
}

function intLiteralType(n: number, suffix: string, decimal: boolean): CType {
  const u = /u/i.test(suffix);
  const l = /l/i.test(suffix);
  if (!l && !u && n <= 32767) return 'int';
  if (!l && u && n <= 65535) return 'uint';
  if (!l && !u && !decimal && n <= 65535) return 'uint';
  if (!u && n <= 2147483647) return 'long';
  return 'ulong';
}

// -- AST ------------------------------------------------------------------------------------
export type Expr =
  | (Pos & { k: 'num'; v: number; t: CType })
  | (Pos & { k: 'str'; s: string })
  | (Pos & { k: 'id'; name: string })
  | (Pos & { k: 'unary'; op: '-' | '+' | '!' | '~'; a: Expr })
  | (Pos & { k: 'incdec'; op: '++' | '--'; prefix: boolean; a: Expr })
  | (Pos & { k: 'bin'; op: string; a: Expr; b: Expr })
  | (Pos & { k: 'assign'; op: string; target: Expr; value: Expr })
  | (Pos & { k: 'cond'; c: Expr; a: Expr; b: Expr })
  | (Pos & { k: 'call'; callee: string; args: Expr[] })
  | (Pos & { k: 'method'; obj: Expr; name: string; args: Expr[] })
  | (Pos & { k: 'index'; a: Expr; i: Expr })
  | (Pos & { k: 'cast'; t: CType; a: Expr });

export interface VarDecl extends Pos {
  name: string;
  t: CType;
  cls: 'Servo' | null;
  isConst: boolean;
  isStatic: boolean;
  /** null = scalar; number = array length. */
  size: number | null;
  init: Expr | Expr[] | null;
}

export type Stmt =
  | (Pos & { k: 'block'; body: Stmt[] })
  | (Pos & { k: 'decl'; decls: VarDecl[] })
  | (Pos & { k: 'expr'; e: Expr })
  | (Pos & { k: 'if'; c: Expr; a: Stmt; b: Stmt | null })
  | (Pos & { k: 'while'; c: Expr; body: Stmt })
  | (Pos & { k: 'do'; c: Expr; body: Stmt })
  | (Pos & { k: 'for'; init: Stmt | null; c: Expr | null; step: Expr | null; body: Stmt })
  | (Pos & { k: 'switch'; c: Expr; cases: { v: number | null; at: number }[]; body: Stmt[] })
  | (Pos & { k: 'break' })
  | (Pos & { k: 'continue' })
  | (Pos & { k: 'return'; e: Expr | null })
  | (Pos & { k: 'empty' });

export interface FuncDecl extends Pos {
  name: string;
  ret: CType;
  params: { name: string; t: CType; array: boolean }[];
  body: Stmt & { k: 'block' };
}

export interface ProgramAst {
  includes: string[];
  globals: VarDecl[];
  functions: Map<string, FuncDecl>;
  nodes: number;
}

const QUALIFIERS = new Set(['const', 'volatile', 'static', 'unsigned', 'signed', 'inline']);

export function parse(src: string): ProgramAst {
  const { tokens, includes } = lex(src);
  let p = 0;
  let nodes = 0;
  let depth = 0;
  const peek = (o = 0) => tokens[Math.min(p + o, tokens.length - 1)]!;
  const next = () => tokens[p++]!;
  const is = (v: string, o = 0) => {
    const t = peek(o);
    return (t.k === 'op' || t.k === 'id') && t.v === v;
  };
  const expect = (v: string) => {
    const t = next();
    if ((t.k !== 'op' && t.k !== 'id') || t.v !== v)
      throw new FirmwareError(`Expected "${v}" but found "${t.v || 'end of file'}".`, t);
    return t;
  };
  const ident = () => {
    const t = next();
    if (t.k !== 'id') throw new FirmwareError(`Expected a name but found "${t.v || 'end of file'}".`, t);
    return t;
  };
  const node = <T>(n: T): T => {
    if (++nodes > LIMITS.nodes) throw new FirmwareError('Program too large (node limit).', peek());
    return n;
  };
  const enter = () => {
    if (++depth > LIMITS.depth) throw new FirmwareError('Nesting too deep.', peek());
  };

  const consts = new Map<string, number>();
  const isTypeStart = (o = 0) => {
    const t = peek(o);
    return t.k === 'id' && (t.v in TYPE_NAMES || QUALIFIERS.has(t.v) || t.v === 'Servo' || t.v === 'String');
  };

  function typeSpec() {
    let isConst = false;
    let isStatic = false;
    let uns: boolean | null = null;
    let base: string | null = null;
    let longs = 0;
    const start = peek();
    for (;;) {
      const t = peek();
      if (t.k !== 'id') break;
      if (t.v === 'const') isConst = true;
      else if (t.v === 'static') isStatic = true;
      else if (t.v === 'volatile' || t.v === 'inline') {
        /* accepted, no effect in the interpreter */
      } else if (t.v === 'unsigned') uns = true;
      else if (t.v === 'signed') uns = false;
      else if (t.v === 'long') longs++;
      else if (t.v === 'String')
        throw new FirmwareError(
          'The Arduino String class is not supported; use char constants and Serial.print.',
          t,
        );
      else if (t.v === 'Servo' || (t.v in TYPE_NAMES && t.v !== 'long')) {
        if (base) break;
        base = t.v;
      } else break;
      next();
    }
    if (longs > 1)
      throw new FirmwareError(
        'long long is not supported (64-bit integers are not part of the subset).',
        start,
      );
    if (base === 'Servo') return { t: 'void' as CType, cls: 'Servo' as const, isConst, isStatic };
    let t: CType;
    if (longs) t = base === 'double' ? 'float' : 'long';
    else if (base) t = TYPE_NAMES[base]!;
    else if (uns !== null) t = 'int';
    else throw new FirmwareError(`Expected a type but found "${start.v}".`, start);
    if (base === 'short' && longs) throw new FirmwareError('Invalid type.', start);
    if (uns) t = unsignedOf(t);
    return { t, cls: null, isConst, isStatic };
  }

  function constEval(e: Expr): number {
    switch (e.k) {
      case 'num':
        return e.v;
      case 'id':
        if (consts.has(e.name)) return consts.get(e.name)!;
        break;
      case 'unary':
        return e.op === '-'
          ? -constEval(e.a)
          : e.op === '+'
            ? constEval(e.a)
            : e.op === '~'
              ? ~constEval(e.a)
              : constEval(e.a)
                ? 0
                : 1;
      case 'bin': {
        const a = constEval(e.a);
        const b = constEval(e.b);
        switch (e.op) {
          case '+':
            return a + b;
          case '-':
            return a - b;
          case '*':
            return a * b;
          case '/':
            return Math.trunc(a / b);
          case '<<':
            return a << b;
          case '>>':
            return a >> b;
        }
      }
    }
    throw new FirmwareError('Array sizes must be constant expressions.', e);
  }

  function declarators(spec: ReturnType<typeof typeSpec>, first: Tok): VarDecl[] {
    const out: VarDecl[] = [];
    let nameTok = first;
    for (;;) {
      let size: number | null = null;
      let unsized = false;
      if (is('[')) {
        next();
        if (is(']')) unsized = true;
        else size = constEval(expr());
        expect(']');
        if (is('[')) throw new FirmwareError('Multi-dimensional arrays are not supported.', peek());
      }
      let init: Expr | Expr[] | null = null;
      if (is('=')) {
        next();
        if (is('{')) {
          next();
          const list: Expr[] = [];
          while (!is('}')) {
            list.push(assignment());
            if (!is('}')) expect(',');
          }
          expect('}');
          init = list;
          if (unsized) size = list.length;
        } else init = assignment();
      }
      if (unsized && size === null)
        throw new FirmwareError(`Array "${nameTok.v}" needs a size or an initialiser list.`, nameTok);
      if (size !== null && (!(size >= 1) || size > 4096))
        throw new FirmwareError(`Array size ${size} is out of range (1…4096).`, nameTok);
      if (Array.isArray(init) && size === null)
        throw new FirmwareError('A brace initialiser needs an array.', nameTok);
      if (Array.isArray(init) && init.length > size!)
        throw new FirmwareError(`Too many initialisers for "${nameTok.v}".`, nameTok);
      const d: VarDecl = node({
        name: nameTok.v,
        t: spec.t,
        cls: spec.cls,
        isConst: spec.isConst,
        isStatic: spec.isStatic,
        size,
        init,
        line: nameTok.line,
        col: nameTok.col,
      });
      if (spec.isConst && size === null && init && !Array.isArray(init)) {
        try {
          consts.set(d.name, constEval(init));
        } catch {
          /* not a compile-time constant: fine for a const variable */
        }
      }
      out.push(d);
      if (!is(',')) break;
      next();
      nameTok = ident();
    }
    expect(';');
    return out;
  }

  // -- expressions (C precedence) --------------------------------------------------------
  function expr(): Expr {
    const e = assignment();
    if (is(',')) throw new FirmwareError('The comma operator is not supported.', peek());
    return e;
  }
  function assignment(): Expr {
    const left = conditional();
    const t = peek();
    if (t.k === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='].includes(t.v)) {
      next();
      if (left.k !== 'id' && left.k !== 'index')
        throw new FirmwareError('Left side of an assignment must be a variable or array element.', t);
      return node({ k: 'assign', op: t.v, target: left, value: assignment(), line: t.line, col: t.col });
    }
    return left;
  }
  function conditional(): Expr {
    const c = binary(0);
    if (is('?')) {
      const t = next();
      const a = assignment();
      expect(':');
      const b = conditional();
      return node({ k: 'cond', c, a, b, line: t.line, col: t.col });
    }
    return c;
  }
  const LEVELS = [
    ['||'],
    ['&&'],
    ['|'],
    ['^'],
    ['&'],
    ['==', '!='],
    ['<', '<=', '>', '>='],
    ['<<', '>>'],
    ['+', '-'],
    ['*', '/', '%'],
  ];
  function binary(level: number): Expr {
    if (level >= LEVELS.length) return unary();
    let a = binary(level + 1);
    for (;;) {
      const t = peek();
      if (t.k !== 'op' || !LEVELS[level]!.includes(t.v)) return a;
      next();
      a = node({ k: 'bin', op: t.v, a, b: binary(level + 1), line: t.line, col: t.col });
    }
  }
  function unary(): Expr {
    const t = peek();
    enter();
    try {
      if (t.k === 'op' && (t.v === '-' || t.v === '+' || t.v === '!' || t.v === '~')) {
        next();
        return node({ k: 'unary', op: t.v, a: unary(), line: t.line, col: t.col });
      }
      if (t.k === 'op' && (t.v === '++' || t.v === '--')) {
        next();
        return node({ k: 'incdec', op: t.v, prefix: true, a: unary(), line: t.line, col: t.col });
      }
      if (t.k === 'op' && t.v === '(' && isTypeStart(1)) {
        next();
        const spec = typeSpec();
        if (spec.cls) throw new FirmwareError('Cannot cast to Servo.', t);
        expect(')');
        return node({ k: 'cast', t: spec.t, a: unary(), line: t.line, col: t.col });
      }
      // Functional cast: int(x), float(x), byte(x), long(x), word(x)
      if (t.k === 'id' && t.v in TYPE_NAMES && is('(', 1) && t.v !== 'void') {
        next();
        next();
        const a = assignment();
        expect(')');
        return node({ k: 'cast', t: TYPE_NAMES[t.v]!, a, line: t.line, col: t.col });
      }
      return postfix(primary());
    } finally {
      depth--;
    }
  }
  function postfix(e: Expr): Expr {
    for (;;) {
      const t = peek();
      if (t.k === 'op' && t.v === '[') {
        next();
        const i = expr();
        expect(']');
        e = node({ k: 'index', a: e, i, line: t.line, col: t.col });
      } else if (t.k === 'op' && t.v === '.') {
        next();
        const name = ident();
        expect('(');
        e = node({ k: 'method', obj: e, name: name.v, args: args(), line: name.line, col: name.col });
      } else if (t.k === 'op' && (t.v === '++' || t.v === '--')) {
        next();
        e = node({ k: 'incdec', op: t.v, prefix: false, a: e, line: t.line, col: t.col });
      } else return e;
    }
  }
  function args(): Expr[] {
    const out: Expr[] = [];
    while (!is(')')) {
      out.push(assignment());
      if (!is(')')) expect(',');
    }
    expect(')');
    return out;
  }
  function primary(): Expr {
    const t = next();
    if (t.k === 'num') return node({ k: 'num', v: t.n!, t: t.nt!, line: t.line, col: t.col });
    if (t.k === 'str') {
      let s = t.v;
      while (peek().k === 'str') s += next().v; // adjacent literals concatenate
      return node({ k: 'str', s, line: t.line, col: t.col });
    }
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false')
        return node({ k: 'num', v: t.v === 'true' ? 1 : 0, t: 'bool', line: t.line, col: t.col });
      if (t.v === 'F' && is('(')) {
        // F("…") keeps strings in flash on AVR; here it is the string itself.
        next();
        const a = expr();
        expect(')');
        return a;
      }
      if (is('(')) {
        next();
        return node({ k: 'call', callee: t.v, args: args(), line: t.line, col: t.col });
      }
      return node({ k: 'id', name: t.v, line: t.line, col: t.col });
    }
    if (t.k === 'op' && t.v === '(') {
      const e = expr();
      expect(')');
      return e;
    }
    throw new FirmwareError(`Unexpected "${t.v || 'end of file'}".`, t);
  }

  // -- statements ------------------------------------------------------------------------
  function statement(): Stmt {
    const t = peek();
    enter();
    try {
      if (t.k === 'op' && t.v === '{') return block();
      if (t.k === 'op' && t.v === ';') {
        next();
        return { k: 'empty', line: t.line, col: t.col };
      }
      if (isTypeStart()) {
        const spec = typeSpec();
        return node({ k: 'decl', decls: declarators(spec, ident()), line: t.line, col: t.col });
      }
      if (t.k === 'id')
        switch (t.v) {
          case 'if': {
            next();
            expect('(');
            const c = expr();
            expect(')');
            const a = statement();
            let b: Stmt | null = null;
            if (is('else')) {
              next();
              b = statement();
            }
            return node({ k: 'if', c, a, b, line: t.line, col: t.col });
          }
          case 'while': {
            next();
            expect('(');
            const c = expr();
            expect(')');
            return node({ k: 'while', c, body: statement(), line: t.line, col: t.col });
          }
          case 'do': {
            next();
            const body = statement();
            expect('while');
            expect('(');
            const c = expr();
            expect(')');
            expect(';');
            return node({ k: 'do', c, body, line: t.line, col: t.col });
          }
          case 'for': {
            next();
            expect('(');
            let init: Stmt | null = null;
            if (is(';')) next();
            else if (isTypeStart()) {
              const spec = typeSpec();
              init = { k: 'decl', decls: declarators(spec, ident()), line: t.line, col: t.col };
            } else {
              init = { k: 'expr', e: expr(), line: t.line, col: t.col };
              expect(';');
            }
            const c = is(';') ? null : expr();
            expect(';');
            const step = is(')') ? null : expr();
            expect(')');
            return node({ k: 'for', init, c, step, body: statement(), line: t.line, col: t.col });
          }
          case 'switch': {
            next();
            expect('(');
            const c = expr();
            expect(')');
            expect('{');
            const cases: { v: number | null; at: number }[] = [];
            const body: Stmt[] = [];
            while (!is('}')) {
              if (is('case')) {
                const ct = next();
                const v = constEval(conditional());
                expect(':');
                if (cases.some((x) => x.v === v)) throw new FirmwareError(`Duplicate case ${v}.`, ct);
                cases.push({ v, at: body.length });
              } else if (is('default')) {
                next();
                expect(':');
                cases.push({ v: null, at: body.length });
              } else body.push(statement());
            }
            expect('}');
            return node({ k: 'switch', c, cases, body, line: t.line, col: t.col });
          }
          case 'break':
          case 'continue':
            next();
            expect(';');
            return { k: t.v as 'break' | 'continue', line: t.line, col: t.col };
          case 'return': {
            next();
            const e = is(';') ? null : expr();
            expect(';');
            return node({ k: 'return', e, line: t.line, col: t.col });
          }
          case 'goto':
            throw new FirmwareError('goto is not supported.', t);
        }
      const e = expr();
      expect(';');
      return node({ k: 'expr', e, line: t.line, col: t.col });
    } finally {
      depth--;
    }
  }
  function block(): Stmt & { k: 'block' } {
    const t = expect('{');
    const body: Stmt[] = [];
    while (!is('}')) {
      if (peek().k === 'eof') throw new FirmwareError('Missing "}".', t);
      body.push(statement());
    }
    expect('}');
    return node({ k: 'block', body, line: t.line, col: t.col });
  }

  // -- top level ---------------------------------------------------------------------------
  const globals: VarDecl[] = [];
  const functions = new Map<string, FuncDecl>();
  while (peek().k !== 'eof') {
    const t = peek();
    if (
      t.k === 'id' &&
      (t.v === 'class' ||
        t.v === 'struct' ||
        t.v === 'enum' ||
        t.v === 'typedef' ||
        t.v === 'template' ||
        t.v === 'namespace')
    )
      throw new FirmwareError(`"${t.v}" is not supported by the FORGE Arduino subset.`, t);
    if (is(';')) {
      next();
      continue;
    }
    const spec = typeSpec();
    const name = ident();
    if (is('(')) {
      next();
      const params: FuncDecl['params'] = [];
      if (is('void') && is(')', 1)) next();
      while (!is(')')) {
        const ps = typeSpec();
        if (ps.cls)
          throw new FirmwareError('Servo parameters are not supported; use a global Servo.', peek());
        const pn = ident();
        let array = false;
        if (is('[')) {
          next();
          if (!is(']')) expr();
          expect(']');
          array = true;
        }
        params.push({ name: pn.v, t: ps.t, array });
        if (!is(')')) expect(',');
      }
      expect(')');
      if (is(';')) {
        next(); // prototype
        continue;
      }
      if (functions.has(name.v))
        throw new FirmwareError(
          `Function "${name.v}" is defined twice (overloading is not supported).`,
          name,
        );
      functions.set(name.v, {
        name: name.v,
        ret: spec.t,
        params,
        body: block(),
        line: name.line,
        col: name.col,
      });
    } else globals.push(...declarators(spec, name));
  }
  return { includes, globals, functions, nodes };
}
