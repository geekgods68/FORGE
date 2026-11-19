import { Download, FilePlus2, FolderOpen, Redo2, Save, Undo2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { isDirty, useEditor } from '@/app/store';
import { CreateMenu } from '@/features/create/CreateMenu';

/** Project controls, undo/redo and object creation. */
export function TopBar() {
  const name = useEditor((s) => s.project.name);
  const dirty = useEditor(isDirty);
  const history = useEditor((s) => s.history);
  const { newProject, save, listSaved, openSaved, exportProject, importProjectText, undo, redo, setStatus } =
    useEditor((s) => s);
  const fileInput = useRef<HTMLInputElement>(null);
  const [openMenu, setOpenMenu] = useState(false);

  const doExport = () => {
    const { fileName, text } = exportProject();
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-semibold tracking-[0.3em]">FORGE</span>
        <span className="text-xs text-muted-foreground">Phase 1</span>
      </div>
      <span className="min-w-0 truncate text-sm" data-testid="project-name" title={name}>
        {name}
        {dirty && <span className="text-muted-foreground"> • unsaved</span>}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <CreateMenu />
        <span className="mx-1 h-6 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          onClick={undo}
          disabled={!history.canUndo}
          title={history.undoLabel ? `Undo ${history.undoLabel} (⌘/Ctrl+Z)` : 'Undo'}
          aria-label="Undo"
        >
          <Undo2 />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={redo}
          disabled={!history.canRedo}
          title={history.redoLabel ? `Redo ${history.redoLabel} (⌘/Ctrl+⇧+Z)` : 'Redo'}
          aria-label="Redo"
        >
          <Redo2 />
        </Button>
        <span className="mx-1 h-6 w-px bg-border" />
        <Button size="sm" variant="ghost" onClick={newProject}>
          <FilePlus2 /> New
        </Button>
        <Button size="sm" variant="ghost" onClick={save} title="Quick-save to this browser">
          <Save /> Save
        </Button>
        <div className="relative">
          <Button size="sm" variant="ghost" onClick={() => setOpenMenu(!openMenu)} aria-expanded={openMenu}>
            <FolderOpen /> Open
          </Button>
          {openMenu && (
            <ul
              className="absolute top-10 right-0 z-20 w-64 rounded-lg border border-border bg-card p-1 shadow-2xl"
              role="menu"
            >
              {listSaved().length === 0 && (
                <li className="p-2 text-xs text-muted-foreground">
                  No quick-saved projects in this browser.
                </li>
              )}
              {listSaved().map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-secondary"
                    onClick={() => {
                      setOpenMenu(false);
                      openSaved(p.id);
                    }}
                  >
                    {p.name}
                    <span className="block text-[11px] text-muted-foreground">
                      {new Date(p.updatedAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}>
          <Upload /> Import
        </Button>
        <Button size="sm" variant="ghost" onClick={doExport}>
          <Download /> Export
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.forge.json,application/json"
          className="hidden"
          data-testid="import-input"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            if (file.size > 10 * 1024 * 1024) {
              setStatus({
                tone: 'error',
                text: 'Import failed: file exceeds the 10 MiB limit. The current project was left unchanged.',
              });
              return;
            }
            importProjectText(await file.text());
          }}
        />
      </div>
    </header>
  );
}
