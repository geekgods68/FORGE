import type { MechanicsService } from '@forge/engineering-core';
import { solveAssembly } from './assembly';
import { evaluatePart } from './part';
import { solveSketch } from './sketch';

export * from './assembly';
export * from './fasteners';
export * from './linalg';
export * from './measure';
export * from './part';
export * from './pose';
export * from './sketch';

/** Engine-injectable mechanics service (assembly solver, part kernel, sketch solver). */
export function createMechanicsService(): MechanicsService {
  return {
    solveAssembly,
    checkPart(features) {
      const r = evaluatePart(features);
      return r.ok ? { ok: true } : { ok: false, message: r.message };
    },
    solveSketch,
  };
}
