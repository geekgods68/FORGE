import { activeScene, formatLength, radToDeg, yawOf } from '@forge/engineering-core';
import { Camera, FilePlus2, FolderOpen, RotateCw, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useForge } from '@/app/store';

/** Phase 0 heads-up panel: identity, project/persistence controls, status. */
export function ProjectPanel() {
  const project = useForge((s) => s.project);
  const dirty = useForge((s) => s.dirty);
  const message = useForge((s) => s.message);
  const physics = useForge((s) => s.physics);
  const actions = useForge((s) => s);
  const instance = activeScene(project).instances[0];

  return (
    <aside className="pointer-events-auto w-[22rem] space-y-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xl backdrop-blur">
      <header>
        <h1 className="text-2xl font-semibold tracking-[0.3em]">FORGE</h1>
        <p className="text-sm text-muted-foreground italic">Engineering Research Environment</p>
        <span className="mt-2 inline-block rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
          Phase 0 · Foundation
        </span>
      </header>

      <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Project</dt>
        <dd data-testid="project-name">
          {project.name} {dirty ? <span className="text-muted-foreground">(unsaved changes)</span> : null}
        </dd>
        <dt className="text-muted-foreground">Project id</dt>
        <dd data-testid="project-id" className="font-mono" title={project.id}>
          {project.id.slice(0, 8)}…
        </dd>
        <dt className="text-muted-foreground">Schema</dt>
        <dd>v{project.schemaVersion} · units m / rad / kg</dd>
        {instance ? (
          <>
            <dt className="text-muted-foreground">Object</dt>
            <dd data-testid="instance-pose">
              yaw {radToDeg(yawOf(instance.transform.rotation)).toFixed(1)}° · y{' '}
              {formatLength(instance.transform.position[1])}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Physics</dt>
        <dd data-testid="physics-status">
          {physics.state}
          {physics.detail ? ` — ${physics.detail}` : ''}
        </dd>
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={actions.newProject}>
          <FilePlus2 /> New project
        </Button>
        <Button size="sm" onClick={actions.save}>
          <Save /> Save
        </Button>
        <Button size="sm" variant="secondary" onClick={actions.reloadSaved}>
          <FolderOpen /> Reload saved
        </Button>
        <Button size="sm" variant="outline" onClick={() => actions.rotateFirstInstance(15)}>
          <RotateCw /> Rotate object 15°
        </Button>
        <Button size="sm" variant="outline" onClick={actions.requestCameraReset}>
          <Camera /> Reset camera
        </Button>
      </div>

      {message ? (
        <div
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={
            message.tone === 'error'
              ? 'rounded border border-destructive/60 p-2 text-xs text-destructive'
              : 'text-xs text-muted-foreground'
          }
        >
          <p>{message.text}</p>
          {message.details?.length ? (
            <ul className="mt-1 list-disc pl-4 font-mono">
              {message.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        Left-drag orbit · right-drag pan · wheel zoom. Temporary Phase 0 scene.
      </p>
    </aside>
  );
}
