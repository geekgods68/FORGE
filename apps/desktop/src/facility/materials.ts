import type { StandardMaterialSpec } from '@/rendering/resources';

/** Shared facility material palette (matte surfaces, restrained emissive accents). */
export const MATERIALS = {
  floor: { color: '#2d3138', roughness: 0.9 },
  wall: { color: '#c9ced6', roughness: 0.85 },
  trim: { color: '#3a4049', roughness: 0.7 },
  accent: { color: '#0b1f26', emissive: '#22d3ee', roughness: 0.4 },
  lightPanel: { color: '#f8fafc', emissive: '#e2e8f0', roughness: 0.3 },
  plannedDoor: { color: '#4b5563', roughness: 0.6 },
  column: { color: '#9aa3ad', roughness: 0.7 },
} satisfies Record<string, StandardMaterialSpec>;
