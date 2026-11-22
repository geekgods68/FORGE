/**
 * C scalar types of the FORGE Arduino subset with AVR (ATmega328P / avr-gcc) sizes:
 * int and unsigned int are 16-bit, long 32-bit, char 8-bit signed, and float AND double are
 * IEEE-754 single precision. Integer arithmetic wraps like the hardware does, so
 * `int x = 40000;` yields −25536 exactly as on an UNO.
 */
export type CType = 'void' | 'bool' | 'char' | 'uchar' | 'int' | 'uint' | 'long' | 'ulong' | 'float';

export interface Value {
  t: CType;
  v: number;
}

export const BYTES: Record<CType, number> = {
  void: 0,
  bool: 1,
  char: 1,
  uchar: 1,
  int: 2,
  uint: 2,
  long: 4,
  ulong: 4,
  float: 4,
};
const RANK: Record<CType, number> = {
  void: 0,
  bool: 1,
  char: 1,
  uchar: 1,
  int: 2,
  uint: 2,
  long: 3,
  ulong: 3,
  float: 5,
};
const UNSIGNED = new Set<CType>(['uchar', 'uint', 'ulong', 'bool']);

/** Type names accepted in source (after `unsigned`/`signed` handling) → C type. */
export const TYPE_NAMES: Record<string, CType> = {
  void: 'void',
  bool: 'bool',
  boolean: 'bool',
  char: 'char',
  byte: 'uchar',
  uint8_t: 'uchar',
  int8_t: 'char',
  short: 'int',
  int: 'int',
  int16_t: 'int',
  uint16_t: 'uint',
  word: 'uint',
  size_t: 'uint',
  long: 'long',
  int32_t: 'long',
  uint32_t: 'ulong',
  float: 'float',
  double: 'float',
};

export const unsignedOf = (t: CType): CType =>
  t === 'char' ? 'uchar' : t === 'int' ? 'uint' : t === 'long' ? 'ulong' : t;

/** Convert a JS number to the representation of type t (wrap / truncate / round to float32). */
export function convert(v: number, t: CType): number {
  switch (t) {
    case 'void':
      return 0;
    case 'bool':
      return v !== 0 && !Number.isNaN(v) ? 1 : 0;
    case 'float':
      return Math.fround(v);
    default: {
      if (!Number.isFinite(v)) return 0; // UB on hardware; FORGE uses 0 and the caller may warn
      const i = Math.trunc(v);
      switch (t) {
        case 'char':
          return (((i % 256) + 256 + 128) % 256) - 128;
        case 'uchar':
          return ((i % 256) + 256) % 256;
        case 'int':
          return (((i % 65536) + 65536 + 32768) % 65536) - 32768;
        case 'uint':
          return ((i % 65536) + 65536) % 65536;
        case 'long':
          return (((i % 4294967296) + 4294967296 + 2147483648) % 4294967296) - 2147483648;
        case 'ulong':
          return ((i % 4294967296) + 4294967296) % 4294967296;
      }
    }
  }
}

export const val = (t: CType, v: number): Value => ({ t, v: convert(v, t) });

/** Usual arithmetic conversions (simplified C rules for AVR sizes). */
export function common(a: CType, b: CType): CType {
  if (a === 'float' || b === 'float') return 'float';
  // Integer promotion: everything below int becomes int.
  const pa = RANK[a] < 2 ? 'int' : a;
  const pb = RANK[b] < 2 ? 'int' : b;
  if (pa === pb) return pa;
  const ra = RANK[pa];
  const rb = RANK[pb];
  if (ra === rb) return unsignedOf(pa); // same rank, one unsigned → unsigned
  const hi = ra > rb ? pa : pb;
  const lo = ra > rb ? pb : pa;
  // long vs unsigned int: on AVR long (32) represents all uint (16) values → long.
  if (UNSIGNED.has(lo) && !UNSIGNED.has(hi) && BYTES[hi] > BYTES[lo]) return hi;
  return UNSIGNED.has(lo) ? unsignedOf(hi) : hi;
}

export const isInteger = (t: CType) => t !== 'float' && t !== 'void';
export const promote = (t: CType): CType => (RANK[t] < 2 ? 'int' : t);
