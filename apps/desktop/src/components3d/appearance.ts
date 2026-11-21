import type { Appearance, Material } from '@forge/components';
import type { StandardMaterialSpec } from '@/rendering/resources';

/** Fixed appearances for non-primary parts (shared across all components → few programs). */
export const APPEARANCE_SPECS: Record<Exclude<Appearance, 'primary'>, StandardMaterialSpec> = {
  metal: { color: '#b8bdc4', roughness: 0.35, metalness: 0.6 },
  'metal-dark': { color: '#4a4f57', roughness: 0.45, metalness: 0.5 },
  black: { color: '#1f2226', roughness: 0.6 },
  white: { color: '#eceff1', roughness: 0.5 },
  grey: { color: '#8c939c', roughness: 0.6 },
  pcb: { color: '#1f6b3a', roughness: 0.55 },
  'pcb-blue': { color: '#1c4f8f', roughness: 0.55 },
  copper: { color: '#c27b4f', roughness: 0.35, metalness: 0.6 },
  gold: { color: '#d4af37', roughness: 0.3, metalness: 0.7 },
  rubber: { color: '#2a2c30', roughness: 0.95 },
  blue: { color: '#2d5fa8', roughness: 0.5 },
  red: { color: '#b3312c', roughness: 0.5 },
  yellow: { color: '#d8b13a', roughness: 0.5 },
  green: { color: '#2f8a46', roughness: 0.5 },
  glass: { color: '#cfe3ea', roughness: 0.05, opacity: 0.45, doubleSided: true },
  screen: { color: '#0b1a21', emissive: '#1d5f73', roughness: 0.3 },
  label: { color: '#e7d36b', roughness: 0.6 },
  'servo-blue': { color: '#2f5fb3', roughness: 0.5 },
  connector: { color: '#e8e2d4', roughness: 0.6 },
};

/** Material spec for an appearance; `primary` follows the instance's engineering material. */
export function appearanceSpec(
  app: Appearance,
  material: Material | undefined,
  highlight: 'none' | 'selected' | 'placeholder' = 'none',
): StandardMaterialSpec {
  const base: StandardMaterialSpec =
    app === 'primary'
      ? material
        ? {
            color: material.surface.color,
            roughness: material.surface.roughness,
            metalness: material.surface.metalness,
          }
        : { color: '#9aa4b2', roughness: 0.6 }
      : APPEARANCE_SPECS[app];
  if (highlight === 'selected') return { ...base, emissive: '#0e7490' };
  if (highlight === 'placeholder') return { ...base, opacity: 0.5, doubleSided: true };
  return base;
}
