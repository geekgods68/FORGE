import { LogOut, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useEditor } from '@/app/store';

/** Overlay while walking: controls reminder and two reliable ways back to editing. */
export function WalkHud() {
  const walking = useEditor((s) => s.navMode === 'walk' && s.view === 'facility');
  const zoneName = useEditor((s) => s.currentZoneId);
  const { setNavMode, setView } = useEditor((s) => s);
  if (!walking) return null;
  return (
    <div
      role="region"
      aria-label="Walking"
      data-testid="walk-hud"
      className="pointer-events-none absolute inset-x-0 top-2 flex justify-center"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-border bg-card/90 px-3 py-1.5 text-xs shadow">
        <span className="text-muted-foreground">
          Walking · WASD / arrows move · Shift faster · drag or click to look · Esc to stop
        </span>
        <span className="sr-only" data-testid="walk-zone">
          {zoneName}
        </span>
        <Button size="sm" variant="secondary" data-testid="walk-exit" onClick={() => setNavMode('orbit')}>
          <LogOut /> Stop walking
        </Button>
        <Button size="sm" data-testid="walk-return-editor" onClick={() => setView('project')}>
          <Wrench /> Return to editor
        </Button>
      </div>
    </div>
  );
}
