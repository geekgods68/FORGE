/** Wall-clock milliseconds (for budgets and benchmarks only — never simulation time). */
export const wallMs = (): number =>
  (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();
