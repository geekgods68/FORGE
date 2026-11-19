import type { Vec3 } from './types';

/**
 * Fidelity labels (owner requirement, section 18). Never raise a label because
 * the graphics look convincing.
 */
export type Fidelity = 'visual' | 'procedural' | 'behavioural' | 'calculated' | 'physically-validated';
export type InventoryLabel = 'owned' | 'candidate' | 'generic';
export type DimensionStatus = 'verified' | 'assumed' | 'declared-generic';

export interface PartDefinition {
  id: string;
  name: string;
  shape: 'box';
  /** Width (x), height (y), depth (z) in metres. */
  dimensionsM: Vec3;
  dimensionStatus: DimensionStatus;
  fidelity: Fidelity;
  inventory: InventoryLabel;
  provenance: string;
  omissions: string[];
}

/** W0.1 catalogue: one generic part. The electronics catalogue arrives in W0.2. */
export const CATALOG: Readonly<Record<string, PartDefinition>> = {
  'generic.enclosure.v1': {
    id: 'generic.enclosure.v1',
    name: 'Generic enclosure',
    shape: 'box',
    dimensionsM: [0.12, 0.05, 0.08],
    dimensionStatus: 'declared-generic',
    fidelity: 'visual',
    inventory: 'generic',
    provenance: 'Authored placeholder for W0.1; does not represent a real product.',
    omissions: ['no ports', 'no mass or material', 'no internal geometry'],
  },
};

export function formatMm(m: number): string {
  return `${Math.round(m * 1000)} mm`;
}
