/**
 * Electrical numerical reference cases (docs/ELECTRICAL_VALIDATION.md). Each case states its
 * initial conditions and solver configuration, the reference (analytical or independently
 * established) behaviour, tolerances chosen BEFORE comparison, the measured values and their
 * errors. Passing a case validates that case only — it does not make the models "verified"
 * for other questions.
 */
export interface Metric {
  name: string;
  reference: number;
  measured: number;
  error: number;
  tolerance: number;
  unit: string;
  relative: boolean;
  pass: boolean;
}

export interface ElectricalValidationResult {
  id: string;
  title: string;
  category:
    | 'resistive'
    | 'capacitive'
    | 'inductive'
    | 'rlc'
    | 'nonlinear'
    | 'diagnostics'
    | 'digital'
    | 'embedded'
    | 'sensor'
    | 'actuator';
  conditions: string;
  solver: string;
  reference: string;
  metrics: Metric[];
  pass: boolean;
}

export function metric(
  name: string,
  reference: number,
  measured: number,
  tolerance: number,
  unit: string,
  relative = false,
): Metric {
  const error = relative
    ? Math.abs(measured - reference) / Math.max(Math.abs(reference), 1e-300)
    : Math.abs(measured - reference);
  return {
    name,
    reference,
    measured,
    error,
    tolerance,
    unit,
    relative,
    pass: Number.isFinite(measured) && error <= tolerance,
  };
}

/** A pass/fail check expressed as a metric (1 = expected outcome observed). */
export const check = (name: string, ok: boolean): Metric => metric(name, 1, ok ? 1 : 0, 0, '', false);

export function result(r: Omit<ElectricalValidationResult, 'pass'>): ElectricalValidationResult {
  return { ...r, pass: r.metrics.length > 0 && r.metrics.every((m) => m.pass) };
}

/** Principal branch of the Lambert W function (Halley iteration), for the diode reference. */
export function lambertW(x: number): number {
  let w = x < 1 ? x : Math.log(x) - Math.log(Math.log(x) + 1e-300);
  for (let i = 0; i < 100; i++) {
    const ew = Math.exp(w);
    const f = w * ew - x;
    const wn = w - f / (ew * (w + 1) - ((w + 2) * f) / (2 * w + 2));
    if (Math.abs(wn - w) <= 1e-15 * Math.max(1, Math.abs(wn))) return wn;
    w = wn;
  }
  return w;
}
