import type { ParamValues } from '@forge/components';
import { useEffect, useMemo } from 'react';
import { acquireComponent, componentKey, releaseComponent } from './cache';

/** Built geometry for a configured component (acquired on mount/change, released on unmount). */
export function useComponentGeometry(definitionId: string, params: ParamValues, materialId: string | null) {
  const key = componentKey(definitionId, params);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` fully describes definitionId + params
  const entry = useMemo(() => acquireComponent(definitionId, params, materialId), [key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- same key
  useEffect(() => () => releaseComponent(definitionId, params), [key]);
  return entry;
}
