import type { PrimitiveGeometry } from '@forge/engineering-core';
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  FrontSide,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Material,
} from 'three';

/**
 * Reference-counted GPU resource sharing (renderer-side only; never engineering state).
 *
 * Every mesh with identical parameters shares ONE BufferGeometry / Material, so N
 * identical parts upload one vertex buffer and compile one program. Resources are
 * disposed when the last user releases them. Draw calls are NOT reduced by sharing —
 * see InstancedFixtures for that (static, non-selectable geometry only).
 */
class SharedCache<T extends { dispose(): void }> {
  private entries = new Map<string, { value: T; refs: number }>();

  acquire(key: string, create: () => T): T {
    let e = this.entries.get(key);
    if (!e) {
      e = { value: create(), refs: 0 };
      this.entries.set(key, e);
    }
    e.refs += 1;
    return e.value;
  }

  release(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.refs -= 1;
    if (e.refs <= 0) {
      e.value.dispose();
      this.entries.delete(key);
    }
  }

  stats() {
    let refs = 0;
    for (const e of this.entries.values()) refs += e.refs;
    return { unique: this.entries.size, refs };
  }
}

export const geometryCache = new SharedCache<BufferGeometry>();
export const materialCache = new SharedCache<Material>();

/** Stable key for a primitive's real dimensions (metres). */
export const geometryKey = (g: PrimitiveGeometry) => JSON.stringify(g);

export function createPrimitiveGeometry(g: PrimitiveGeometry): BufferGeometry {
  switch (g.shape) {
    case 'box':
      return new BoxGeometry(g.width, g.height, g.depth);
    case 'sphere':
      return new SphereGeometry(g.radius, 48, 24);
    case 'cylinder':
      return new CylinderGeometry(g.radius, g.radius, g.height, 48);
    case 'cone':
      return new ConeGeometry(g.radius, g.height, 48);
    case 'plane':
      return new PlaneGeometry(g.width, g.length);
    case 'torus':
      return new TorusGeometry(g.majorRadius, g.tubeRadius, 24, 64);
  }
}

export interface StandardMaterialSpec {
  color: string;
  emissive?: string;
  roughness?: number;
  metalness?: number;
  doubleSided?: boolean;
  transparent?: boolean;
  opacity?: number;
  /** Opt-in: false for glazing/water so overlapping transparent instances don't occlude. */
  depthWrite?: boolean;
}

export const materialKey = (m: StandardMaterialSpec) =>
  `std:${m.color}:${m.emissive ?? '#000000'}:${m.roughness ?? 0.6}:${m.metalness ?? 0.05}:${m.doubleSided ? 2 : 0}:${m.opacity ?? 1}${m.depthWrite === false ? ':nodw' : ''}`;

export function createStandardMaterial(m: StandardMaterialSpec): Material {
  return new MeshStandardMaterial({
    color: m.color,
    emissive: m.emissive ?? '#000000',
    roughness: m.roughness ?? 0.6,
    metalness: m.metalness ?? 0.05,
    side: m.doubleSided ? DoubleSide : FrontSide,
    transparent: m.transparent ?? (m.opacity !== undefined && m.opacity < 1),
    opacity: m.opacity ?? 1,
    depthWrite: m.depthWrite ?? true,
  });
}

export function resourceStats() {
  return { geometries: geometryCache.stats(), materials: materialCache.stats() };
}
