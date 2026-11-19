/** Fixed-decimal display formatting that never shows "-0.000". Display only — never fed back as data. */
export function formatNumber(v: number, decimals: number): string {
  const s = v.toFixed(decimals);
  return s === `-${(0).toFixed(decimals)}` ? (0).toFixed(decimals) : s;
}
