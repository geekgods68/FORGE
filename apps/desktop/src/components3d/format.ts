/** Engineering display units: lengths in mm (m above 10 m), masses in g / kg. Unknown → "unknown". */
export const formatLength = (m: number) =>
  Math.abs(m) >= 10 ? `${m.toFixed(3)} m` : `${(m * 1000).toFixed(m < 0.01 ? 2 : 1)} mm`;
export const formatMass = (kg: number | null) =>
  kg === null ? 'unknown' : kg < 1 ? `${(kg * 1000).toFixed(kg < 0.01 ? 2 : 1)} g` : `${kg.toFixed(3)} kg`;
export const formatVolume = (m3: number | null) =>
  m3 === null ? 'not computed (envelope model)' : `${(m3 * 1e6).toFixed(m3 < 1e-6 ? 4 : 2)} cm³`;
