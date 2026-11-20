import { degToRad, radToDeg } from '@forge/engineering-core';
import { getEquipment, getZone, itemChain, pointToFacility } from '@forge/facility';
import { Lock, LockOpen, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NumberField } from '@/components/NumberField';
import { useEditor } from '@/app/store';
import { formatNumber } from '@/lib/format';

/**
 * Inspector for a workspace item (layout edit layer). Positions are in the ZONE frame
 * (mm in the UI, m stored); yaw in degrees (rad stored). Every edit is one validated
 * workspace command; the facility frame position is shown for reference.
 */
export function ItemInspector() {
  const id = useEditor((s) => s.itemSelection);
  const item = useEditor((s) => (id ? s.layout.items[id] : undefined));
  const run = useEditor((s) => s.runWorkspace);
  if (!item) {
    return (
      <section aria-label="Inspector" className="space-y-2 p-3 text-sm text-muted-foreground">
        <h2 className="text-xs font-semibold tracking-wider uppercase">Layout inspector</h2>
        <p>
          Select equipment in the viewport or the workspace list. Walls, floors and corridors are fixed
          architecture and cannot be edited.
        </p>
      </section>
    );
  }
  const eq = getEquipment(item.equipmentId)!;
  const zone = getZone(item.zoneId)!;
  const facilityPos = pointToFacility([0, 0, 0], itemChain(zone, item));
  const [x, , z] = item.pose.position;
  const move = (patch: { position?: [number, number]; yaw?: number }, label: string) =>
    run('workspace.item.move', { itemId: item.id, ...patch }, { label });

  return (
    <section aria-label="Inspector" className="space-y-3 p-3 text-sm">
      <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        Layout inspector
      </h2>
      <div>
        <input
          key={item.id + item.name}
          aria-label="Item name"
          defaultValue={item.name}
          disabled={item.locked}
          className="h-8 w-full rounded border border-border bg-background/60 px-2 font-medium"
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== item.name)
              run('workspace.item.rename', { itemId: item.id, name }, { label: 'Rename equipment' });
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {eq.name} · {eq.category} · {eq.sizeM.map((v) => formatNumber(v * 1000, 0)).join(' × ')} mm
        </p>
      </div>
      <fieldset className="space-y-1">
        <legend className="mb-1 text-xs text-muted-foreground">Position in zone (mm) · yaw (deg)</legend>
        <div className="grid grid-cols-3 gap-1.5">
          <NumberField
            label="X"
            unit="mm"
            testId="item-x"
            value={x * 1000}
            decimals={1}
            disabled={item.locked}
            onCommit={(v) => move({ position: [v / 1000, z] }, 'Move equipment')}
          />
          <NumberField
            label="Z"
            unit="mm"
            testId="item-z"
            value={z * 1000}
            decimals={1}
            disabled={item.locked}
            onCommit={(v) => move({ position: [x, v / 1000] }, 'Move equipment')}
          />
          <NumberField
            label="θ"
            unit="deg"
            testId="item-yaw"
            value={radToDeg(item.pose.yaw)}
            decimals={1}
            disabled={item.locked}
            onCommit={(v) => move({ yaw: degToRad(v) }, 'Rotate equipment')}
          />
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground" data-testid="item-facility-position">
        Facility frame: {facilityPos.map((v) => formatNumber(v * 1000, 1)).join(', ')} mm
      </p>
      {eq.category === 'workbench' && (
        <p className="text-xs text-muted-foreground">
          Hosts project:{' '}
          <span className="font-mono">{item.mountedProjectId ? item.mountedProjectId.slice(0, 8) : '—'}</span>
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            run(
              'workspace.item.lock',
              { itemId: item.id, locked: !item.locked },
              { label: item.locked ? 'Unlock equipment' : 'Lock equipment' },
            )
          }
        >
          {item.locked ? <LockOpen /> : <Lock />} {item.locked ? 'Unlock' : 'Lock'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={item.locked}
          onClick={() => run('workspace.item.remove', { itemId: item.id }, { label: 'Remove equipment' })}
        >
          <Trash2 /> Remove
        </Button>
      </div>
    </section>
  );
}
