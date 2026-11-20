import { CENTRAL_WORKSHOP_ID } from './facility-v1';
import { FACILITY } from './registry';
import { WORKSPACE_SCHEMA_VERSION, type WorkspaceItem, type WorkspaceLayout } from './schemas';

declare const crypto: { randomUUID(): string };

const item = (
  id: string,
  name: string,
  equipmentId: string,
  areaId: string,
  x: number,
  z: number,
  yaw = 0,
): WorkspaceItem => ({
  id,
  name,
  equipmentId,
  zoneId: CENTRAL_WORKSHOP_ID,
  areaId,
  pose: { position: [x, 0, z], yaw },
  mountedProjectId: null,
  locked: false,
});

/** Starter layout for the Central Conjuring & Integration Workshop (user-editable copy). */
export function defaultWorkspaceLayout(now = new Date(), id = crypto.randomUUID()): WorkspaceLayout {
  const items: WorkspaceItem[] = [
    item('pedestal', 'Conjuring pedestal', 'conjuring-pedestal', 'conjuring-dais', 0, 0),
    item('bench-a', 'Bench A', 'bench-standard', 'bench-floor', -5, -3),
    item('bench-b', 'Bench B', 'bench-standard', 'bench-floor', 5, -3),
    item('bench-c', 'Bench C', 'bench-standard', 'bench-floor', -5, 1.5),
    item('bench-d', 'Bench D', 'bench-standard', 'bench-floor', 5, 1.5),
    item('bench-assembly', 'Assembly bench', 'bench-heavy', 'bench-floor', 0, -4.4),
    item('cabinet-1', 'Tool cabinet 1', 'tool-cabinet', 'bench-floor', -7.5, -4.85),
    item('cabinet-2', 'Tool cabinet 2', 'tool-cabinet', 'bench-floor', -6.4, -4.85),
    item('rack-1', 'Instrument rack', 'instrument-rack', 'bench-floor', 7.6, -4.7),
  ];
  return {
    workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
    id,
    name: 'Central Workshop layout',
    facilityRevision: FACILITY.revision,
    revision: 0,
    updatedAt: now.toISOString(),
    items: Object.fromEntries(items.map((i) => [i.id, i])),
  };
}
