import { describe, expect, it } from 'vitest';
import { Scheduler } from '../digital/scheduler';
import { DIGITAL_VALIDATION_CASES } from '../validation/digital';

describe('scheduler', () => {
  it('runs events in (time, sequence) order, independent of insertion order', () => {
    const s = new Scheduler();
    const out: string[] = [];
    s.at(30, () => out.push('c'));
    s.at(10, () => out.push('a1'));
    s.at(10, () => out.push('a2'));
    const h = s.at(20, () => out.push('cancelled'));
    s.at(20, () => {
      out.push('b');
      s.after(0, () => out.push('b-same-time'));
    });
    h.cancel();
    s.runUntil(100);
    expect(out).toEqual(['a1', 'a2', 'b', 'b-same-time', 'c']);
    expect(s.now).toBe(100);
  });

  it('bounds runaway zero-delay activity instead of freezing', () => {
    const s = new Scheduler();
    const loop = () => s.after(0, loop);
    s.at(0, loop);
    expect(s.runUntil(10, true, 10_000).truncated).toBe(true);
  });
});

describe('digital numerical validation', () => {
  for (const c of DIGITAL_VALIDATION_CASES)
    it(c.name, () => {
      const r = c();
      const failed = r.metrics
        .filter((m) => !m.pass)
        .map(
          (m) =>
            `${m.name}: measured ${m.measured}, reference ${m.reference}, error ${m.error} > ${m.tolerance}`,
        );
      expect(failed).toEqual([]);
    });
});
