import { degToRad, radToDeg } from '@forge/engineering-core';
import { Camera, Magnet, Move3d, Rotate3d, Scaling } from 'lucide-react';
import { NumberField } from '@/components/NumberField';
import { useEditor, type ToolMode } from '@/app/store';
import { cn } from '@/lib/utils';

const TOOLS: { mode: ToolMode; key: string; label: string; Icon: typeof Move3d }[] = [
  { mode: 'translate', key: 'W', label: 'Translate', Icon: Move3d },
  { mode: 'rotate', key: 'E', label: 'Rotate', Icon: Rotate3d },
  { mode: 'scale', key: 'R', label: 'Scale', Icon: Scaling },
];

export function StatusBar() {
  const status = useEditor((s) => s.status);
  const snap = useEditor((s) => s.snap);
  const toolMode = useEditor((s) => s.toolMode);
  const revision = useEditor((s) => s.project.revision);
  const selectionCount = useEditor((s) => s.selection.length);
  const physics = useEditor((s) => s.physics);
  const view = useEditor((s) => s.view);
  const editLayer = useEditor((s) => s.editLayer);
  const { setSnap, setToolMode, requestCameraReset } = useEditor((s) => s);

  return (
    <footer className="flex h-9 shrink-0 items-center gap-3 border-t border-border bg-card px-3 text-xs">
      <div
        role={status.tone === 'error' ? 'alert' : 'status'}
        data-testid="status"
        className={cn(
          'min-w-0 flex-1 truncate',
          status.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
        )}
        title={[status.text, ...(status.details ?? [])].join('\n')}
      >
        {status.text}
        {status.details?.length ? ` — ${status.details[0]}` : ''}
      </div>
      <div className="flex items-center gap-0.5" role="group" aria-label="Transform tool">
        {TOOLS.map(({ mode, key, label, Icon }) => (
          <button
            key={mode}
            type="button"
            title={`${label} (${key})`}
            aria-label={label}
            aria-pressed={toolMode === mode}
            onClick={() => setToolMode(mode)}
            className={cn(
              'grid size-7 place-items-center rounded [&_svg]:size-4',
              toolMode === mode ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary',
            )}
          >
            <Icon />
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1" title="Snapping for gizmo manipulation">
        <input
          type="checkbox"
          checked={snap.enabled}
          onChange={(e) => setSnap({ enabled: e.target.checked })}
          aria-label="Snap enabled"
        />
        <Magnet className="size-3.5" />
      </label>
      <div className="w-20">
        <NumberField
          label=""
          unit="mm"
          testId="snap-translation"
          value={snap.translationM * 1000}
          decimals={2}
          min={0.01}
          onCommit={(mm) => setSnap({ translationM: mm / 1000 })}
        />
      </div>
      <span className="text-muted-foreground">mm</span>
      <div className="w-16">
        <NumberField
          label=""
          unit="deg"
          testId="snap-rotation"
          value={radToDeg(snap.rotationRad)}
          decimals={1}
          min={0.1}
          onCommit={(deg) => setSnap({ rotationRad: degToRad(deg) })}
        />
      </div>
      <span className="text-muted-foreground">°</span>
      <span className="text-muted-foreground">Units: mm · deg</span>
      {view === 'facility' && (
        <span className="text-muted-foreground" data-testid="edit-layer">
          editing: {editLayer === 'layout' ? 'layout' : 'engineering'}
        </span>
      )}
      <span className="text-muted-foreground" data-testid="revision">
        rev {revision}
      </span>
      <span className="text-muted-foreground">{selectionCount} selected</span>
      <span className="text-muted-foreground" data-testid="physics-status" title={physics.detail}>
        physics: {physics.state}
      </span>
      <button
        type="button"
        title="Reset camera"
        aria-label="Reset camera"
        className="grid size-7 place-items-center rounded hover:bg-secondary [&_svg]:size-4"
        onClick={requestCameraReset}
      >
        <Camera />
      </button>
    </footer>
  );
}
