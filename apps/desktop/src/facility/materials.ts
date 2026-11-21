import type { StandardMaterialSpec } from '@/rendering/resources';

/**
 * Shared facility palette — "80 % realistic research institute, 20 % engineering
 * interface": light concrete, painted plaster, brushed aluminium, clear glazing,
 * neutral-white luminaires. Blue/cyan appears ONLY on interactive engineering
 * interfaces (screens, consoles, the conjuring dais/pedestal) — never as decoration.
 * Every zone template draws from this one palette, so the facility compiles a small,
 * fixed set of shader programs and materials are shared across all zones.
 */
export const MATERIALS = {
  // Architecture
  floor: { color: '#b4b7ba', roughness: 0.85 }, // light polished concrete
  floorCorridor: { color: '#9fa4a9', roughness: 0.8 },
  wall: { color: '#e3e5e7', roughness: 0.9 }, // painted plaster
  concrete: { color: '#c4c6c6', roughness: 0.92 }, // exposed concrete (environments)
  trim: { color: '#5c636c', roughness: 0.7 },
  column: { color: '#cfd2d4', roughness: 0.85 },
  aluminium: { color: '#b9bec4', metalness: 0.35, roughness: 0.38 }, // brushed mullions, frames
  steel: { color: '#7c838b', metalness: 0.3, roughness: 0.5 }, // trusses, structural steel
  ceiling: { color: '#eef0f1', emissive: '#8a8f94', roughness: 0.95 }, // acoustic tile; emissive ≈ indirect bounce light
  glassFrosted: { color: '#e4ecef', roughness: 0.4, opacity: 0.86, depthWrite: false }, // fire-door glazing
  glass: { color: '#d7e6ec', roughness: 0.05, opacity: 0.22, doubleSided: true, depthWrite: false },
  lightPanel: { color: '#f8fafc', emissive: '#eef1f4', roughness: 0.3 }, // neutral-white luminaire
  lightLine: { color: '#f1f3f5', emissive: '#d9dde1', roughness: 0.3 }, // linear wall wash
  floorMarking: { color: '#c9a23a', roughness: 0.7 }, // safety-yellow floor tape
  // Furniture & equipment
  worktop: { color: '#e8e9e9', roughness: 0.55 }, // white phenolic resin
  epoxyTop: { color: '#2e3238', roughness: 0.5 }, // black epoxy (wet/electronics benches)
  enamel: { color: '#dfe2e5', roughness: 0.5 }, // white enamel equipment bodies
  graphite: { color: '#3a3f46', roughness: 0.6 }, // dark equipment housings, frames
  timber: { color: '#b89a74', roughness: 0.75 }, // meeting tables
  fabric: { color: '#5f6b78', roughness: 0.95 }, // seating, acoustic panels
  rubber: { color: '#26292d', roughness: 0.95 },
  water: { color: '#7fb0c4', roughness: 0.1, opacity: 0.45, doubleSided: true, depthWrite: false },
  safetyYellow: { color: '#d6ad2f', roughness: 0.6 },
  // Engineering interfaces (the restrained 20 %)
  screen: { color: '#0b1a21', emissive: '#1d5f73', roughness: 0.3 },
  accent: { color: '#0b1f26', emissive: '#22d3ee', roughness: 0.4 },
  plannedDoor: { color: '#8a9097', roughness: 0.6 },
} satisfies Record<string, StandardMaterialSpec>;

export const PALETTE_SPECS: readonly StandardMaterialSpec[] = Object.values(MATERIALS);
