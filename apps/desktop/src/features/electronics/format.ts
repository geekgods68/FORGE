const PREFIXES: [number, string][] = [
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
  [1e-9, 'n'],
  [1e-12, 'p'],
];

/** Engineering notation with an SI prefix: 4700 Ω → "4.7 kΩ". */
export function formatSi(v: number | null | undefined, unit: string, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v === 0) return `0 ${unit}`;
  const a = Math.abs(v);
  const [k, p] = PREFIXES.find(([k]) => a >= k * 0.9995) ?? PREFIXES[PREFIXES.length - 1]!;
  return `${Number((v / k).toPrecision(digits))} ${p}${unit}`;
}
