import type { PrimitiveGeometry } from '@forge/engineering-core';
import { useEffect, useMemo } from 'react';
import type { BufferGeometry, Material } from 'three';
import {
  createPrimitiveGeometry,
  createStandardMaterial,
  geometryCache,
  geometryKey,
  materialCache,
  materialKey,
  type StandardMaterialSpec,
} from './resources';

/** Shared geometry for a primitive (acquired on mount, released on unmount/change). */
export function useSharedGeometry(g: PrimitiveGeometry): BufferGeometry {
  const key = geometryKey(g);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` fully describes `g`
  const geometry = useMemo(() => geometryCache.acquire(key, () => createPrimitiveGeometry(g)), [key]);
  useEffect(() => () => geometryCache.release(key), [key]);
  return geometry;
}

export function useSharedMaterial(spec: StandardMaterialSpec): Material {
  const key = materialKey(spec);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` fully describes `spec`
  const material = useMemo(() => materialCache.acquire(key, () => createStandardMaterial(spec)), [key]);
  useEffect(() => () => materialCache.release(key), [key]);
  return material;
}
