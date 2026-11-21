import { FACILITY, getEquipment, getZone, neighbours, roomCode, type Zone } from '@forge/facility';
import { Building2, Crosshair, Download, Link2, Link2Off, Plus, RotateCw, Save, Upload } from 'lucide-react';
import { useRef, useState, useSyncExternalStore } from 'react';
import { subscribeZones, zoneLifecycle, zoneSnapshot } from '@/facility/zoneRuntime';
import { Button } from '@/components/ui/button';
import { useEditor } from '@/app/store';
import { cn } from '@/lib/utils';

/** Directory grouped by wing: rooms by number, then that wing's corridors. */
const DIRECTORY: { title: string; zones: Zone[] }[] = [
  ...FACILITY.wings.map((w) => ({
    title: `Wing ${w.letter} · ${w.name}`,
    zones: FACILITY.zones.filter((z) => z.wingId === w.id && z.kind === 'laboratory'),
  })),
  { title: 'Research environments', zones: FACILITY.zones.filter((z) => z.kind === 'environment') },
  { title: 'Corridors & concourse', zones: FACILITY.zones.filter((z) => z.kind === 'corridor') },
];

/** Loading / error state of the current zone, with recovery. */
function ZoneLoadStatus({ zone }: { zone: Zone }) {
  const states = useSyncExternalStore(subscribeZones, zoneSnapshot);
  const st = states[zone.id];
  if (!st || st.state === 'active') return null;
  if (st.state === 'error')
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded border border-destructive/60 p-2"
        data-testid="zone-error"
      >
        <span className="flex-1">
          {zone.name} failed to load: {st.error}
        </span>
        <Button size="sm" variant="secondary" onClick={() => zoneLifecycle.retry(zone.id)}>
          <RotateCw /> Retry
        </Button>
      </div>
    );
  return (
    <p className="text-muted-foreground" data-testid="zone-state">
      {st.state === 'loading' ? 'Loading zone…' : st.state}
    </p>
  );
}

/** Facility navigation + editable workspace layout for the current zone. */
export function WorkspacePanel() {
  const zoneId = useEditor((s) => s.currentZoneId);
  const items = useEditor((s) => s.layout.items);
  const itemSelection = useEditor((s) => s.itemSelection);
  const editLayer = useEditor((s) => s.editLayer);
  const projectId = useEditor((s) => s.project.id);
  const s = useEditor((st) => st);
  const zone = getZone(zoneId)!;
  const [equipmentId, setEquipmentId] = useState('bench-standard');
  const fileInput = useRef<HTMLInputElement>(null);
  const zoneItems = Object.values(items).filter((i) => i.zoneId === zoneId);
  const allowed = FACILITY.equipment.filter((e) =>
    zone.placementAreas.some((a) => a.allowedCategories.includes(e.category)),
  );
  const hostBench = Object.values(items).find((i) => i.mountedProjectId === projectId);
  const selected = itemSelection ? items[itemSelection] : undefined;
  const selectedIsBench = selected && getEquipment(selected.equipmentId)?.category === 'workbench';

  const download = () => {
    const { fileName, text } = s.exportLayout();
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <section
      aria-label="Workspace"
      className="flex min-h-0 flex-col gap-2 border-t border-border p-3 text-xs"
    >
      <header>
        <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Facility</h2>
        <p className="mt-1 text-sm font-medium" data-testid="zone-name">
          {zone.name}
        </p>
        <p className="text-muted-foreground">
          {zone.labNumber ? `Lab ${zone.labNumber} · ` : ''}Wing{' '}
          {FACILITY.wings.find((w) => w.id === zone.wingId)?.letter} · {zone.kind}
        </p>
      </header>

      <ZoneLoadStatus zone={zone} />

      <nav aria-label="Exits" className="space-y-0.5">
        <p className="text-muted-foreground">Exits</p>
        <ul className="flex flex-wrap gap-1" aria-label="Exits">
          {neighbours(zone.id).map((n) => (
            <li key={n.id}>
              <button
                type="button"
                data-testid={`exit-${n.id}`}
                className="rounded border border-border px-1.5 py-0.5 hover:bg-secondary"
                onPointerEnter={() => s.setPrefetchZone(n.id)}
                onFocus={() => s.setPrefetchZone(n.id)}
                onClick={() => s.goToZone(n.id)}
                title={`Go to ${n.name}`}
              >
                {n.kind === 'corridor' ? n.name : `${roomCode(n)} · ${n.name}`}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <details>
        <summary className="cursor-pointer text-muted-foreground">
          Zone directory (22 labs · 6 environments)
        </summary>
        <ul className="mt-1 space-y-0.5" aria-label="Zone directory">
          {DIRECTORY.map((g) => (
            <li key={g.title} className="list-none">
              <p className="mt-1 font-semibold text-muted-foreground">{g.title}</p>
              <ul aria-label={g.title}>
                {g.zones.map((z) => (
                  <li key={z.id} className="flex items-center gap-1" data-testid={`dir-${z.id}`}>
                    <span className={cn('min-w-0 flex-1 truncate', z.id === zoneId && 'text-primary')}>
                      {z.kind === 'corridor' ? '' : `${roomCode(z)} · `}
                      {z.name}
                    </span>
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onPointerEnter={() => s.setPrefetchZone(z.id)}
                      onFocus={() => s.setPrefetchZone(z.id)}
                      onClick={() => s.goToZone(z.id)}
                      aria-label={`Enter ${z.name}`}
                    >
                      Enter
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </details>

      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Layout ({zoneItems.length} items)</span>
        <span className="text-muted-foreground">rev {s.layout.revision}</span>
      </div>
      <ul className="max-h-36 overflow-auto rounded border border-border" aria-label="Workspace items">
        {zoneItems.length === 0 && (
          <li className="p-2 text-muted-foreground">No configurable equipment in this zone.</li>
        )}
        {zoneItems.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              data-testid={`item-row-${i.id}`}
              className={cn(
                'flex w-full items-center gap-1 px-2 py-1 text-left hover:bg-secondary',
                i.id === itemSelection && editLayer === 'layout' && 'bg-primary/20',
              )}
              onClick={() => {
                s.setEditLayer('layout');
                s.selectItem(i.id);
              }}
            >
              <Building2 className="size-3.5 text-muted-foreground" />
              <span className="flex-1 truncate">{i.name}</span>
              {i.mountedProjectId === projectId && (
                <Link2 className="size-3.5 text-primary" aria-label="hosts this project" />
              )}
            </button>
          </li>
        ))}
      </ul>

      {zone.placementAreas.length > 0 && (
        <div className="flex gap-1">
          <select
            aria-label="Equipment type"
            className="h-8 min-w-0 flex-1 rounded border border-border bg-background px-1"
            value={equipmentId}
            onChange={(e) => setEquipmentId(e.target.value)}
          >
            {allowed.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              s.setEditLayer('layout');
              s.placeEquipment(equipmentId);
            }}
          >
            <Plus /> Place
          </Button>
        </div>
      )}

      <div className="space-y-1">
        <p className="text-muted-foreground">
          Project on bench:{' '}
          <span data-testid="mounted-bench">{hostBench ? hostBench.name : 'not mounted'}</span>
        </p>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="secondary"
            disabled={!selectedIsBench}
            onClick={() => s.mountProjectOn(selected!.id)}
            title="Mount the open engineering project on the selected workbench"
          >
            <Link2 /> Mount here
          </Button>
          <Button size="sm" variant="ghost" disabled={!hostBench} onClick={() => s.mountProjectOn(null)}>
            <Link2Off /> Unmount
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!hostBench}
            onClick={() => hostBench && s.focusItem(hostBench.id)}
            aria-label="Focus bench"
          >
            <Crosshair /> Focus
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-t border-border pt-2">
        <Button size="sm" variant="ghost" onClick={s.saveLayout}>
          <Save /> Save layout
        </Button>
        <Button size="sm" variant="ghost" onClick={download}>
          <Download /> Export
        </Button>
        <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}>
          <Upload /> Import
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.forge-workspace.json"
          className="hidden"
          data-testid="layout-import-input"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) s.importLayoutText(await f.text());
          }}
        />
      </div>
    </section>
  );
}
