import {
  FirmwareError,
  parse,
  type Expr,
  type FuncDecl,
  type Pos,
  type ProgramAst,
  type Stmt,
  type VarDecl,
} from './parse';
import { BYTES, common, convert, isInteger, promote, val, type CType, type Value } from './types';

/**
 * Interpreter for the FORGE Arduino subset (Level 2: API-compatible simulated runtime).
 *
 * Execution is a GENERATOR so firmware can block on simulation time: blocking builtins
 * (delay, pulseIn …) yield requests to the host runtime, which resumes the program when the
 * simulated condition is met. Every evaluated node costs `opCostNs` of simulated time (a
 * documented approximation — the ATmega328P is NOT emulated cycle by cycle); the debt is
 * paid to the scheduler before any I/O and at least every `sliceOps` operations.
 *
 * Isolation: the program can reach only the builtins it is given; there is no `eval`, no host
 * object access, no filesystem or network. Recursion depth, loop work and memory are bounded.
 */
export type Request =
  { k: 'slice' } | { k: 'sync' } | { k: 'sleep'; ns: number } | { k: 'host'; name: string; data: unknown };

export type Gen<T> = Generator<Request, T, unknown>;

export class FirmwareRuntimeError extends Error {
  constructor(
    message: string,
    readonly pos: Pos | null,
  ) {
    super(pos ? `line ${pos.line}: ${message}` : message);
  }
}

export interface Builtin {
  /** Allowed argument counts. */
  arity: [number, number];
  ret: CType;
  /** Performs I/O at the current simulated time (time debt is paid first). */
  io?: boolean;
  fn: (args: Value[], pos: Pos) => Value | Gen<Value>;
  /** Parameter types for implicit conversion (e.g. map() takes long). */
  params?: CType[];
}

export interface MethodTable {
  /** Methods on the global Serial object. */
  Serial: Record<string, Builtin>;
  /** Methods on Servo objects (first argument is the servo handle). */
  Servo: Record<string, Builtin>;
}

export interface CompileResult {
  ok: boolean;
  program: ProgramAst | null;
  errors: { line: number; col: number; message: string }[];
  warnings: { line: number; col: number; message: string }[];
  stats: { functions: number; globals: number; nodes: number; sramBytes: number };
}

export const UNO_SRAM_BYTES = 2048;

interface Slot {
  t: CType;
  cls: 'Servo' | null;
  isConst: boolean;
  v: number;
  /** Arrays: element storage. */
  data: number[] | null;
}
type Scope = Map<string, Slot>;
interface Env {
  scopes: Scope[];
  fn: FuncDecl;
  /** Value of the executed return statement (per call, so nested calls and ISRs cannot clobber it). */
  ret: Value;
}

const enum Flow {
  Normal,
  Break,
  Continue,
  Return,
}

/** Constants the Arduino core defines (values as in Arduino.h for AVR). */
export const ARDUINO_CONSTANTS: Record<string, Value> = {
  HIGH: { t: 'int', v: 1 },
  LOW: { t: 'int', v: 0 },
  INPUT: { t: 'int', v: 0 },
  OUTPUT: { t: 'int', v: 1 },
  INPUT_PULLUP: { t: 'int', v: 2 },
  LED_BUILTIN: { t: 'int', v: 13 },
  A0: { t: 'int', v: 14 },
  A1: { t: 'int', v: 15 },
  A2: { t: 'int', v: 16 },
  A3: { t: 'int', v: 17 },
  A4: { t: 'int', v: 18 },
  A5: { t: 'int', v: 19 },
  CHANGE: { t: 'int', v: 1 },
  FALLING: { t: 'int', v: 2 },
  RISING: { t: 'int', v: 3 },
  PI: { t: 'float', v: Math.fround(Math.PI) },
  HALF_PI: { t: 'float', v: Math.fround(Math.PI / 2) },
  TWO_PI: { t: 'float', v: Math.fround(Math.PI * 2) },
  DEG_TO_RAD: { t: 'float', v: Math.fround(Math.PI / 180) },
  RAD_TO_DEG: { t: 'float', v: Math.fround(180 / Math.PI) },
  DEC: { t: 'int', v: 10 },
  HEX: { t: 'int', v: 16 },
  BIN: { t: 'int', v: 2 },
  OCT: { t: 'int', v: 8 },
};

/** Static checks: names, arity, control flow, entry points, memory estimate. */
export function compileFirmware(
  source: string,
  builtins: Record<string, Builtin>,
  methods: MethodTable,
): CompileResult {
  const errors: CompileResult['errors'] = [];
  const warnings: CompileResult['warnings'] = [];
  let program: ProgramAst;
  try {
    program = parse(source);
  } catch (e) {
    const pos = e instanceof FirmwareError ? e.pos : { line: 1, col: 1 };
    return {
      ok: false,
      program: null,
      errors: [
        { ...pos, message: e instanceof FirmwareError ? e.message.replace(/^\d+:\d+: /, '') : String(e) },
      ],
      warnings,
      stats: { functions: 0, globals: 0, nodes: 0, sramBytes: 0 },
    };
  }
  const err = (p: Pos, message: string) => errors.push({ line: p.line, col: p.col, message });
  const globals = new Map<string, VarDecl>();
  for (const g of program.globals) {
    if (globals.has(g.name)) err(g, `"${g.name}" is declared twice.`);
    if (g.t === 'void' && !g.cls) err(g, `Variable "${g.name}" cannot be void.`);
    globals.set(g.name, g);
  }
  for (const name of ['setup', 'loop']) {
    const f = program.functions.get(name);
    if (!f) err({ line: 1, col: 1 }, `The sketch needs a "void ${name}()" function.`);
    else if (f.ret !== 'void' || f.params.length) err(f, `"${name}" must be declared as void ${name}().`);
  }
  const isServo = (e: Expr, scopes: Map<string, VarDecl>[]): boolean => {
    if (e.k === 'id') {
      const d = lookup(e.name, scopes);
      return !!d && d.cls === 'Servo';
    }
    if (e.k === 'index') return isServo(e.a, scopes);
    return false;
  };
  const lookup = (name: string, scopes: Map<string, VarDecl>[]) => {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i]!.has(name)) return scopes[i]!.get(name)!;
    return globals.get(name);
  };
  const checkExpr = (e: Expr, scopes: Map<string, VarDecl>[]): void => {
    switch (e.k) {
      case 'id':
        if (!lookup(e.name, scopes) && !(e.name in ARDUINO_CONSTANTS) && !program.functions.has(e.name))
          err(e, `"${e.name}" is not declared.`);
        return;
      case 'num':
      case 'str':
        return;
      case 'unary':
      case 'cast':
        return checkExpr(e.a, scopes);
      case 'incdec':
        if (e.a.k !== 'id' && e.a.k !== 'index') err(e, `${e.op} needs a variable.`);
        return checkExpr(e.a, scopes);
      case 'bin':
        checkExpr(e.a, scopes);
        return checkExpr(e.b, scopes);
      case 'assign': {
        checkExpr(e.target, scopes);
        checkExpr(e.value, scopes);
        const base = e.target.k === 'index' ? e.target.a : e.target;
        if (base.k === 'id') {
          const d = lookup(base.name, scopes);
          if (d?.isConst) err(e, `"${base.name}" is const.`);
          if (d?.cls) err(e, 'Servo objects cannot be assigned.');
        }
        return;
      }
      case 'cond':
        checkExpr(e.c, scopes);
        checkExpr(e.a, scopes);
        return checkExpr(e.b, scopes);
      case 'index':
        checkExpr(e.a, scopes);
        return checkExpr(e.i, scopes);
      case 'call': {
        e.args.forEach((a) => checkExpr(a, scopes));
        const f = program.functions.get(e.callee);
        if (f) {
          if (f.params.length !== e.args.length)
            err(e, `${e.callee}() takes ${f.params.length} argument(s), ${e.args.length} given.`);
          return;
        }
        const b = builtins[e.callee];
        if (!b) return void err(e, `Function "${e.callee}" is not available in the FORGE Arduino subset.`);
        if (e.args.length < b.arity[0] || e.args.length > b.arity[1])
          err(
            e,
            `${e.callee}() takes ${b.arity[0] === b.arity[1] ? b.arity[0] : `${b.arity[0]}–${b.arity[1]}`} argument(s), ${e.args.length} given.`,
          );
        if (
          e.callee === 'attachInterrupt' &&
          e.args[1] &&
          (e.args[1].k !== 'id' || !program.functions.has(e.args[1].name))
        )
          err(e, 'attachInterrupt needs the name of a function as its second argument.');
        return;
      }
      case 'method': {
        e.args.forEach((a) => checkExpr(a, scopes));
        let table: Record<string, Builtin>;
        if (e.obj.k === 'id' && e.obj.name === 'Serial' && !lookup('Serial', scopes)) table = methods.Serial;
        else if (isServo(e.obj, scopes)) {
          table = methods.Servo;
          checkExpr(e.obj, scopes);
        } else return void err(e, 'Methods are supported on Serial and Servo objects only.');
        const m = table[e.name];
        if (!m) return void err(e, `"${e.name}" is not a supported method.`);
        // Servo methods receive the object handle as a hidden first argument.
        const n = e.args.length + (table === methods.Servo ? 1 : 0);
        const off = table === methods.Servo ? 1 : 0;
        if (n < m.arity[0] || n > m.arity[1])
          err(
            e,
            `.${e.name}() takes ${m.arity[0] - off}${m.arity[1] !== m.arity[0] ? `–${m.arity[1] - off}` : ''} argument(s), ${e.args.length} given.`,
          );
        return;
      }
    }
  };
  const checkStmt = (s: Stmt, scopes: Map<string, VarDecl>[], loop: boolean, sw: boolean): void => {
    switch (s.k) {
      case 'block': {
        const inner = [...scopes, new Map<string, VarDecl>()];
        s.body.forEach((x) => checkStmt(x, inner, loop, sw));
        return;
      }
      case 'decl':
        for (const d of s.decls) {
          if (d.t === 'void' && !d.cls) err(d, `Variable "${d.name}" cannot be void.`);
          if (d.cls) err(d, 'Servo objects must be global.');
          if (d.init) (Array.isArray(d.init) ? d.init : [d.init]).forEach((x) => checkExpr(x, scopes));
          const top = scopes[scopes.length - 1]!;
          if (top.has(d.name)) err(d, `"${d.name}" is declared twice in this scope.`);
          top.set(d.name, d);
        }
        return;
      case 'expr':
        return checkExpr(s.e, scopes);
      case 'if':
        checkExpr(s.c, scopes);
        checkStmt(s.a, scopes, loop, sw);
        if (s.b) checkStmt(s.b, scopes, loop, sw);
        return;
      case 'while':
      case 'do':
        checkExpr(s.c, scopes);
        return checkStmt(s.body, scopes, true, sw);
      case 'for': {
        const inner = [...scopes, new Map<string, VarDecl>()];
        if (s.init) checkStmt(s.init, inner, loop, sw);
        if (s.c) checkExpr(s.c, inner);
        if (s.step) checkExpr(s.step, inner);
        return checkStmt(s.body, inner, true, sw);
      }
      case 'switch': {
        checkExpr(s.c, scopes);
        const inner = [...scopes, new Map<string, VarDecl>()];
        s.body.forEach((x) => checkStmt(x, inner, loop, true));
        return;
      }
      case 'break':
        if (!loop && !sw) err(s, '"break" outside a loop or switch.');
        return;
      case 'continue':
        if (!loop) err(s, '"continue" outside a loop.');
        return;
      case 'return':
        if (s.e) checkExpr(s.e, scopes);
        return;
      case 'empty':
        return;
    }
  };
  for (const g of program.globals)
    if (g.init) (Array.isArray(g.init) ? g.init : [g.init]).forEach((x) => checkExpr(x, []));
  for (const f of program.functions.values()) {
    const params = new Map<string, VarDecl>(
      f.params.map((p) => [
        p.name,
        {
          name: p.name,
          t: p.t,
          cls: null,
          isConst: false,
          isStatic: false,
          size: p.array ? 1 : null,
          init: null,
          line: f.line,
          col: f.col,
        },
      ]),
    );
    if (builtins[f.name]) err(f, `"${f.name}" is a built-in Arduino function and cannot be redefined.`);
    checkStmt(f.body, [params], false, false);
  }
  const sramBytes = program.globals.reduce((n, g) => n + (g.cls ? 3 : BYTES[g.t]) * (g.size ?? 1), 0);
  if (sramBytes > UNO_SRAM_BYTES)
    err(
      { line: 1, col: 1 },
      `Global variables need about ${sramBytes} bytes; the UNO has ${UNO_SRAM_BYTES} bytes of SRAM.`,
    );
  else if (sramBytes > UNO_SRAM_BYTES * 0.75)
    warnings.push({
      line: 1,
      col: 1,
      message: `Global variables use about ${sramBytes} of ${UNO_SRAM_BYTES} bytes of SRAM (stack space may run out).`,
    });
  return {
    ok: errors.length === 0,
    program: errors.length ? null : program,
    errors: errors.sort((a, b) => a.line - b.line || a.col - b.col),
    warnings,
    stats: {
      functions: program.functions.size,
      globals: program.globals.length,
      nodes: program.nodes,
      sramBytes,
    },
  };
}

export interface InterpreterOptions {
  opCostNs: number;
  sliceOps?: number;
  maxDepth?: number;
  /** Creates a host Servo object; returns its handle. */
  newServo: () => number;
}

export class Interpreter {
  ops = 0;
  /** Simulated time (ns) consumed by executed operations but not yet paid to the scheduler. */
  debtNs = 0;
  private sinceSlice = 0;
  private depth = 0;
  private readonly globals: Scope = new Map();
  private readonly statics = new Map<VarDecl, Slot>();
  private readonly sliceOps: number;
  private readonly maxDepth: number;

  constructor(
    readonly program: ProgramAst,
    private readonly builtins: Record<string, Builtin>,
    private readonly methods: MethodTable,
    private readonly opts: InterpreterOptions,
  ) {
    this.sliceOps = opts.sliceOps ?? 32;
    this.maxDepth = opts.maxDepth ?? 64;
  }

  /** Initialise globals (static initialisation runs before setup, as in C++). */
  *init(): Gen<void> {
    const env: Env = {
      scopes: [this.globals],
      fn: {
        name: '<globals>',
        ret: 'void',
        params: [],
        body: { k: 'block', body: [], line: 0, col: 0 },
        line: 0,
        col: 0,
      },
      ret: { t: 'void', v: 0 },
    };
    for (const g of this.program.globals) this.globals.set(g.name, yield* this.makeSlot(g, env));
  }

  private *makeSlot(d: VarDecl, env: Env): Gen<Slot> {
    if (d.cls === 'Servo') {
      const n = d.size ?? 1;
      const handles = Array.from({ length: n }, () => this.opts.newServo());
      return {
        t: 'int',
        cls: 'Servo',
        isConst: true,
        v: handles[0]!,
        data: d.size === null ? null : handles,
      };
    }
    if (d.size !== null) {
      const data = new Array<number>(d.size).fill(0);
      if (Array.isArray(d.init))
        for (let i = 0; i < d.init.length; i++) data[i] = convert((yield* this.eval(d.init[i]!, env)).v, d.t);
      else if (d.init) throw new FirmwareRuntimeError('An array needs a brace initialiser.', d);
      return { t: d.t, cls: null, isConst: d.isConst, v: 0, data };
    }
    const v = d.init ? convert((yield* this.eval(d.init as Expr, env)).v, d.t) : 0;
    return { t: d.t, cls: null, isConst: d.isConst, v, data: null };
  }

  /** Call a user function by name (setup, loop, an interrupt handler). */
  *call(name: string, args: Value[] = []): Gen<Value> {
    const f = this.program.functions.get(name);
    if (!f) throw new FirmwareRuntimeError(`No function "${name}".`, null);
    return yield* this.invoke(f, args, f);
  }

  private *invoke(f: FuncDecl, args: (Value | Slot)[], pos: Pos): Gen<Value> {
    if (++this.depth > this.maxDepth)
      throw new FirmwareRuntimeError(
        `Call depth exceeds ${this.maxDepth} (runaway recursion would overflow the UNO's stack).`,
        pos,
      );
    try {
      const scope: Scope = new Map();
      f.params.forEach((p, i) => {
        const a = args[i]!;
        if (p.array) {
          if (!('data' in a) || !a.data)
            throw new FirmwareRuntimeError(`Argument ${i + 1} of ${f.name}() must be an array.`, pos);
          scope.set(p.name, a);
        } else
          scope.set(p.name, {
            t: p.t,
            cls: null,
            isConst: false,
            v: convert((a as Value).v, p.t),
            data: null,
          });
      });
      const env: Env = { scopes: [scope], fn: f, ret: { t: 'void', v: 0 } };
      const flow = yield* this.exec(f.body, env);
      const r = flow === Flow.Return ? env.ret : { t: 'void' as CType, v: 0 };
      return f.ret === 'void' ? { t: 'void', v: 0 } : val(f.ret, r.v);
    } finally {
      this.depth--;
    }
  }

  private *tick(): Gen<void> {
    this.ops++;
    this.debtNs += this.opts.opCostNs;
    if (++this.sinceSlice >= this.sliceOps) {
      this.sinceSlice = 0;
      yield { k: 'slice' };
    }
  }

  private find(name: string, env: Env): Slot | undefined {
    for (let i = env.scopes.length - 1; i >= 0; i--) {
      const s = env.scopes[i]!.get(name);
      if (s) return s;
    }
    return this.globals.get(name);
  }

  // -- statements --------------------------------------------------------------------------
  private *exec(s: Stmt, env: Env): Gen<Flow> {
    yield* this.tick();
    switch (s.k) {
      case 'block': {
        env.scopes.push(new Map());
        try {
          for (const x of s.body) {
            const f = yield* this.exec(x, env);
            if (f !== Flow.Normal) return f;
          }
          return Flow.Normal;
        } finally {
          env.scopes.pop();
        }
      }
      case 'decl':
        for (const d of s.decls) {
          if (d.isStatic) {
            let slot = this.statics.get(d);
            if (!slot) {
              slot = yield* this.makeSlot(d, env);
              this.statics.set(d, slot);
            }
            env.scopes[env.scopes.length - 1]!.set(d.name, slot);
          } else env.scopes[env.scopes.length - 1]!.set(d.name, yield* this.makeSlot(d, env));
        }
        return Flow.Normal;
      case 'expr':
        yield* this.eval(s.e, env);
        return Flow.Normal;
      case 'if':
        if ((yield* this.eval(s.c, env)).v !== 0) return yield* this.exec(s.a, env);
        return s.b ? yield* this.exec(s.b, env) : Flow.Normal;
      case 'while':
        while ((yield* this.eval(s.c, env)).v !== 0) {
          const f = yield* this.exec(s.body, env);
          if (f === Flow.Break) break;
          if (f === Flow.Return) return f;
        }
        return Flow.Normal;
      case 'do':
        do {
          const f = yield* this.exec(s.body, env);
          if (f === Flow.Break) break;
          if (f === Flow.Return) return f;
        } while ((yield* this.eval(s.c, env)).v !== 0);
        return Flow.Normal;
      case 'for': {
        env.scopes.push(new Map());
        try {
          if (s.init) yield* this.exec(s.init, env);
          while (!s.c || (yield* this.eval(s.c, env)).v !== 0) {
            const f = yield* this.exec(s.body, env);
            if (f === Flow.Break) break;
            if (f === Flow.Return) return f;
            if (s.step) yield* this.eval(s.step, env);
          }
          return Flow.Normal;
        } finally {
          env.scopes.pop();
        }
      }
      case 'switch': {
        const v = (yield* this.eval(s.c, env)).v;
        const c = s.cases.find((x) => x.v === v) ?? s.cases.find((x) => x.v === null);
        if (!c) return Flow.Normal;
        env.scopes.push(new Map());
        try {
          for (let i = c.at; i < s.body.length; i++) {
            const f = yield* this.exec(s.body[i]!, env);
            if (f === Flow.Break) break;
            if (f !== Flow.Normal) return f;
          }
          return Flow.Normal;
        } finally {
          env.scopes.pop();
        }
      }
      case 'break':
        return Flow.Break;
      case 'continue':
        return Flow.Continue;
      case 'return':
        env.ret = s.e ? yield* this.eval(s.e, env) : { t: 'void', v: 0 };
        return Flow.Return;
      case 'empty':
        return Flow.Normal;
    }
  }

  // -- expressions -------------------------------------------------------------------------
  private *lvalue(e: Expr, env: Env): Gen<{ slot: Slot; index: number | null }> {
    if (e.k === 'id') {
      const slot = this.find(e.name, env);
      if (!slot) throw new FirmwareRuntimeError(`"${e.name}" is not declared.`, e);
      return { slot, index: null };
    }
    if (e.k === 'index') {
      const { slot } = yield* this.lvalue(e.a, env);
      const i = (yield* this.eval(e.i, env)).v;
      if (!slot.data) throw new FirmwareRuntimeError('Indexing a variable that is not an array.', e);
      if (!Number.isInteger(i) || i < 0 || i >= slot.data.length)
        throw new FirmwareRuntimeError(
          `Array index ${i} is out of bounds (size ${slot.data.length}). On a real UNO this silently corrupts memory.`,
          e,
        );
      return { slot, index: i };
    }
    throw new FirmwareRuntimeError('Not assignable.', e);
  }

  private read(l: { slot: Slot; index: number | null }): Value {
    return { t: l.slot.t, v: l.index === null ? l.slot.v : l.slot.data![l.index]! };
  }
  private write(l: { slot: Slot; index: number | null }, v: number): Value {
    const c = convert(v, l.slot.t);
    if (l.index === null) l.slot.v = c;
    else l.slot.data![l.index] = c;
    return { t: l.slot.t, v: c };
  }

  *eval(e: Expr, env: Env): Gen<Value> {
    yield* this.tick();
    switch (e.k) {
      case 'num':
        return { t: e.t, v: e.v };
      case 'str':
        throw new FirmwareRuntimeError('A string can only be printed (Serial.print/println).', e);
      case 'id': {
        const slot = this.find(e.name, env);
        if (slot) {
          if (slot.data && !slot.cls)
            throw new FirmwareRuntimeError(`"${e.name}" is an array; use an index.`, e);
          return { t: slot.t, v: slot.v };
        }
        const c = ARDUINO_CONSTANTS[e.name];
        if (c) return c;
        throw new FirmwareRuntimeError(`"${e.name}" is not declared.`, e);
      }
      case 'cast':
        return val(e.t, (yield* this.eval(e.a, env)).v);
      case 'unary': {
        const a = yield* this.eval(e.a, env);
        if (e.op === '!') return { t: 'bool', v: a.v === 0 ? 1 : 0 };
        const t = promote(a.t);
        if (e.op === '~') {
          if (!isInteger(t)) throw new FirmwareRuntimeError('~ needs an integer.', e);
          return val(t, ~a.v);
        }
        return val(t, e.op === '-' ? -a.v : a.v);
      }
      case 'incdec': {
        const l = yield* this.lvalue(e.a, env);
        const old = this.read(l);
        const nv = this.write(l, old.v + (e.op === '++' ? 1 : -1));
        return e.prefix ? nv : old;
      }
      case 'bin': {
        if (e.op === '&&') {
          const a = yield* this.eval(e.a, env);
          if (a.v === 0) return { t: 'bool', v: 0 };
          return { t: 'bool', v: (yield* this.eval(e.b, env)).v !== 0 ? 1 : 0 };
        }
        if (e.op === '||') {
          const a = yield* this.eval(e.a, env);
          if (a.v !== 0) return { t: 'bool', v: 1 };
          return { t: 'bool', v: (yield* this.eval(e.b, env)).v !== 0 ? 1 : 0 };
        }
        const a = yield* this.eval(e.a, env);
        const b = yield* this.eval(e.b, env);
        return this.binop(e.op, a, b, e);
      }
      case 'assign': {
        const l = yield* this.lvalue(e.target, env);
        const rhs = yield* this.eval(e.value, env);
        if (l.slot.isConst) throw new FirmwareRuntimeError('Assignment to a const variable.', e);
        if (e.op === '=') return this.write(l, rhs.v);
        const cur = this.read(l);
        return this.write(l, this.binop(e.op.slice(0, -1), cur, rhs, e).v);
      }
      case 'cond': {
        const c = yield* this.eval(e.c, env);
        const a = c.v !== 0 ? yield* this.eval(e.a, env) : yield* this.eval(e.b, env);
        return a;
      }
      case 'index': {
        const l = yield* this.lvalue(e, env);
        return this.read(l);
      }
      case 'call': {
        const f = this.program.functions.get(e.callee);
        if (f) {
          const args: (Value | Slot)[] = [];
          for (let i = 0; i < e.args.length; i++) {
            const a = e.args[i]!;
            if (f.params[i]?.array) {
              if (a.k !== 'id') throw new FirmwareRuntimeError('Array arguments must be array names.', a);
              const s = this.find(a.name, env);
              if (!s?.data) throw new FirmwareRuntimeError(`"${a.name}" is not an array.`, a);
              args.push(s);
            } else args.push(yield* this.eval(a, env));
          }
          return yield* this.invoke(f, args, e);
        }
        const b = this.builtins[e.callee];
        if (!b) throw new FirmwareRuntimeError(`Unknown function "${e.callee}".`, e);
        const args: Value[] = [];
        for (let i = 0; i < e.args.length; i++) {
          const a = e.args[i]!;
          if (e.callee === 'attachInterrupt' && i === 1 && a.k === 'id')
            args.push({ t: 'int', v: this.fnIndex(a.name) });
          else if (this.isStringArg(a)) args.push(yield* this.stringArg(a, env));
          else {
            const v = yield* this.eval(a, env);
            const pt = b.params?.[i];
            args.push(pt ? val(pt, v.v) : v);
          }
        }
        return yield* this.runBuiltin(b, args, e);
      }
      case 'method': {
        let table: Record<string, Builtin>;
        const args: Value[] = [];
        if (e.obj.k === 'id' && e.obj.name === 'Serial' && !this.find('Serial', env))
          table = this.methods.Serial;
        else {
          table = this.methods.Servo;
          const l =
            e.obj.k === 'index'
              ? yield* this.lvalue(e.obj, env)
              : { slot: this.find((e.obj as { name: string }).name, env)!, index: null };
          if (!l.slot || l.slot.cls !== 'Servo') throw new FirmwareRuntimeError('Not a Servo object.', e);
          args.push({ t: 'int', v: l.index === null ? l.slot.v : l.slot.data![l.index]! });
        }
        const m = table[e.name]!;
        // String literals are passed as interned ids, flagged by `t: 'void'`.
        for (const a of e.args)
          args.push(this.isStringArg(a) ? yield* this.stringArg(a, env) : yield* this.eval(a, env));
        return yield* this.runBuiltin(m, args, e);
      }
    }
  }

  /** A string literal, or a conditional choosing between string arguments. */
  private isStringArg(a: Expr): boolean {
    return a.k === 'str' || (a.k === 'cond' && this.isStringArg(a.a) && this.isStringArg(a.b));
  }
  private *stringArg(a: Expr, env: Env): Gen<Value> {
    if (a.k === 'str') return { t: 'void', v: this.intern(a.s) };
    if (a.k === 'cond')
      return (yield* this.eval(a.c, env)).v !== 0
        ? yield* this.stringArg(a.a, env)
        : yield* this.stringArg(a.b, env);
    throw new FirmwareRuntimeError('Expected a string.', a);
  }

  private *runBuiltin(b: Builtin, args: Value[], pos: Pos): Gen<Value> {
    if (b.io && this.debtNs > 0) yield { k: 'sync' };
    const r = b.fn(args, pos);
    if (r && typeof (r as Gen<Value>).next === 'function') return yield* r as Gen<Value>;
    return r as Value;
  }

  private strings: string[] = [];
  private intern(s: string): number {
    let i = this.strings.indexOf(s);
    if (i < 0) {
      this.strings.push(s);
      i = this.strings.length - 1;
    }
    return i;
  }
  string(id: number): string {
    return this.strings[id] ?? '';
  }
  private fnNames: string[] = [];
  private fnIndex(name: string): number {
    let i = this.fnNames.indexOf(name);
    if (i < 0) {
      this.fnNames.push(name);
      i = this.fnNames.length - 1;
    }
    return i;
  }
  functionName(i: number): string | undefined {
    return this.fnNames[i];
  }

  private binop(op: string, a: Value, b: Value, pos: Pos): Value {
    if (['==', '!=', '<', '<=', '>', '>='].includes(op)) {
      const t = common(a.t, b.t);
      const x = convert(a.v, t);
      const y = convert(b.v, t);
      const r =
        op === '=='
          ? x === y
          : op === '!='
            ? x !== y
            : op === '<'
              ? x < y
              : op === '<='
                ? x <= y
                : op === '>'
                  ? x > y
                  : x >= y;
      return { t: 'bool', v: r ? 1 : 0 };
    }
    if (op === '<<' || op === '>>') {
      const t = promote(a.t);
      if (!isInteger(t) || !isInteger(b.t)) throw new FirmwareRuntimeError(`${op} needs integers.`, pos);
      const n = b.v;
      if (n < 0 || n >= BYTES[t] * 8) return val(t, 0); // UB on hardware; FORGE yields 0
      return val(t, op === '<<' ? a.v * 2 ** n : Math.floor(a.v / 2 ** n));
    }
    const t = common(a.t, b.t);
    const x = convert(a.v, t);
    const y = convert(b.v, t);
    switch (op) {
      case '+':
        return val(t, x + y);
      case '-':
        return val(t, x - y);
      case '*':
        if (t === 'float') return val(t, Math.fround(x) * Math.fround(y));
        // Exact low 32 bits of the product (doubles lose them above 2^53).
        return val(t, Math.abs(x * y) < 2 ** 53 ? x * y : Number(BigInt.asUintN(32, BigInt(x) * BigInt(y))));
      case '/':
        if (t !== 'float' && y === 0) throw new FirmwareRuntimeError('Integer division by zero.', pos);
        return val(t, t === 'float' ? x / y : Math.trunc(x / y));
      case '%':
        if (t === 'float') throw new FirmwareRuntimeError('% needs integers (use fmod for floats).', pos);
        if (y === 0) throw new FirmwareRuntimeError('Integer modulo by zero.', pos);
        return val(t, x % y);
      case '&':
      case '|':
      case '^': {
        if (t === 'float') throw new FirmwareRuntimeError(`${op} needs integers.`, pos);
        const hi = (u: number) => Math.floor(u / 65536);
        const lo = (u: number) => u - hi(u) * 65536;
        const f =
          op === '&'
            ? (p: number, q: number) => p & q
            : op === '|'
              ? (p: number, q: number) => p | q
              : (p: number, q: number) => p ^ q;
        // 32-bit safe bitwise on the two's-complement pattern.
        const ux = convert(x, 'ulong');
        const uy = convert(y, 'ulong');
        return val(t, f(hi(ux), hi(uy)) * 65536 + f(lo(ux), lo(uy)));
      }
    }
    throw new FirmwareRuntimeError(`Unsupported operator ${op}.`, pos);
  }
}

export { BYTES };
