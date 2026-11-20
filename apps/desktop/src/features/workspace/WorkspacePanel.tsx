import { FACILITY, getEquipment, getZone } from '@forge/facility';
import { Building2, Crosshair, Download, Link2, Link2Off, Plus, Save, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useEditor } from '@/app/store';
import { cn } from '@/lib/utils';

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

      <details>
        <summary className="cursor-pointer text-muted-foreground">
          Zone directory (22 labs · 6 environments)
        </summary>
        <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto" aria-label="Zone directory">
          {FACILITY.zones.map((z) => (
            <li key={z.id} className="flex items-center gap-1">
              <span
                className={cn('min-w-0 flex-1 truncate', z.status === 'planned' && 'text-muted-foreground')}
              >
                {z.labNumber ? `${z.labNumber}. ` : ''}
                {z.name}
              </span>
              {z.status === 'implemented' ? (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => s.goToZone(z.id)}
                  aria-label={`Enter ${z.name}`}
                >
                  Enter
                </button>
              ) : (
                <span
                  className="text-muted-foreground"
                  title="Registered in the facility plan; not built yet"
                >
                  planned
                </span>
              )}
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
