/**
 * Four-valued logic: '0', '1', 'Z' (high impedance / undriven) and 'X' (unknown: contention,
 * an analog level between the input thresholds, or a computation on unknown inputs).
 * Gates treat a 'Z' input as unknown — a floating CMOS input has no defined level.
 */
export type Logic = '0' | '1' | 'Z' | 'X';

export const isKnown = (v: Logic): v is '0' | '1' => v === '0' || v === '1';

export function not(a: Logic): Logic {
  return a === '0' ? '1' : a === '1' ? '0' : 'X';
}

export type GateOp = 'and' | 'or' | 'not' | 'nand' | 'nor' | 'xor' | 'xnor' | 'buffer';

export function evalGate(op: GateOp, inputs: readonly Logic[]): Logic {
  switch (op) {
    case 'buffer':
      return isKnown(inputs[0]!) ? inputs[0]! : 'X';
    case 'not':
      return not(inputs[0]!);
    case 'and':
    case 'nand': {
      let r: Logic = '1';
      for (const v of inputs) {
        if (v === '0') {
          r = '0';
          break;
        }
        if (!isKnown(v)) r = 'X';
      }
      return op === 'and' ? r : not(r);
    }
    case 'or':
    case 'nor': {
      let r: Logic = '0';
      for (const v of inputs) {
        if (v === '1') {
          r = '1';
          break;
        }
        if (!isKnown(v)) r = 'X';
      }
      return op === 'or' ? r : not(r);
    }
    case 'xor':
    case 'xnor': {
      if (inputs.some((v) => !isKnown(v))) return 'X';
      const odd = inputs.filter((v) => v === '1').length % 2 === 1;
      return (odd ? '1' : '0') === '1' ? (op === 'xor' ? '1' : '0') : op === 'xor' ? '0' : '1';
    }
  }
}

/** Input thresholds of a digital input (V), relative to its reference. */
export interface Thresholds {
  vil: number;
  vih: number;
}

/** Logic level read from an analog voltage: below VIL → 0, above VIH → 1, between → X. */
export function threshold(v: number | null, t: Thresholds): Logic {
  if (v === null || !Number.isFinite(v)) return 'Z';
  if (v <= t.vil) return '0';
  if (v >= t.vih) return '1';
  return 'X';
}
