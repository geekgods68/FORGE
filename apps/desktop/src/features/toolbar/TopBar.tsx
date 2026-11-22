import {
  Activity,
  CircuitBoard,
  Building2,
  Sparkles,
  Download,
  Footprints,
  FilePlus2,
  FolderOpen,
  Redo2,
  Save,
  Undo2,
  Package,
  Upload,
  Wrench,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { downloadText, MAX_BUNDLE_BYTES, MAX_IMPORT_BYTES } from '@/lib/download';
import { isDirty, useEditor } from '@/app/store';
import { CreateMenu } from '@/features/create/CreateMenu';

/** Project controls, undo/redo and object creation. */
export function TopBar() {
  const name = useEditor((s) => s.project.name);
  const dirty = useEditor(isDirty);
  const history = useEditor((s) => s.history);
  const view = useEditor((s) => s.view);
  const editLayer = useEditor((s) => s.editLayer);
  const workspaceHistory = useEditor((s) => s.workspaceHistory);
  const { setView, setEditLayer, setNavMode } = useEditor((s) => s);
  const navMode = useEditor((s) => s.navMode);
  const workMode = useEditor((s) => s.workMode);
  const setWorkMode = useEditor((s) => s.setWorkMode);
  const libraryOpen = useEditor((s) => s.libraryOpen);
  const setLibraryOpen = useEditor((s) => s.setLibraryOpen);
  const layoutLayer = view === 'facility' && editLayer === 'layout';
  const activeHistory = layoutLayer ? workspaceHistory : history;
  const { newProject, save, listSaved, openSaved, exportProject, importProjectText, undo, redo, setStatus } =
    useEditor((s) => s);
  const fileInput = useRef<HTMLInputElement>(null);
  const [openMenu, setOpenMenu] = useState(false);

  const exportBundle = useEditor((s) => s.exportBundle);
  const importBundleText = useEditor((s) => s.importBundleText);
  const doExport = () => {
    const { fileName, text } = exportProject();
    downloadText(fileName, text);
  };
  const doExportBundle = async () => {
    const r = await exportBundle();
    if (r) downloadText(r.fileName, r.text);
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-semibold tracking-[0.3em]">FORGE</span>
        <span className="text-xs text-muted-foreground">Phase 5</span>
      </div>
      <span className="min-w-0 truncate text-sm" data-testid="project-name" title={name}>
        {name}
        {dirty && <span className="text-muted-foreground"> • unsaved</span>}
      </span>
      <div
        className="ml-3 flex items-center gap-1 rounded-md border border-border p-0.5"
        role="group"
        aria-label="View"
      >
        <Toggle pressed={view === 'project'} onClick={() => setView('project')} testId="view-project">
          <Wrench /> Project
        </Toggle>
        <Toggle pressed={view === 'facility'} onClick={() => setView('facility')} testId="view-facility">
          <Building2 /> Facility
        </Toggle>
      </div>
      <div
        className="flex items-center gap-1 rounded-md border border-border p-0.5"
        role="group"
        aria-label="Mode"
      >
        <Toggle pressed={workMode === 'cad'} onClick={() => setWorkMode('cad')} testId="mode-cad">
          <Wrench /> CAD
        </Toggle>
        <Toggle
          pressed={workMode === 'electronics'}
          onClick={() => setWorkMode('electronics')}
          testId="mode-electronics"
        >
          <CircuitBoard /> Electronics
        </Toggle>
        <Toggle
          pressed={workMode === 'simulation'}
          onClick={() => setWorkMode('simulation')}
          testId="mode-simulation"
        >
          <Activity /> Simulation
        </Toggle>
      </div>
      {view === 'facility' && (
        <div
          className="flex items-center gap-1 rounded-md border border-border p-0.5"
          role="group"
          aria-label="Edit layer"
        >
          <Toggle
            pressed={editLayer === 'project'}
            onClick={() => setEditLayer('project')}
            testId="layer-project"
          >
            Engineering
          </Toggle>
          <Toggle
            pressed={editLayer === 'layout'}
            onClick={() => setEditLayer('layout')}
            testId="layer-layout"
          >
            Layout
          </Toggle>
        </div>
      )}
      <Toggle pressed={libraryOpen} onClick={() => setLibraryOpen(!libraryOpen)} testId="library-toggle">
        <Sparkles /> Library
      </Toggle>
      {view === 'facility' && (
        <Toggle
          pressed={navMode === 'walk'}
          onClick={() => setNavMode(navMode === 'walk' ? 'orbit' : 'walk')}
          testId="nav-walk"
        >
          <Footprints /> Walk
        </Toggle>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        {!layoutLayer && <CreateMenu />}
        <span className="mx-1 h-6 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          onClick={undo}
          disabled={!activeHistory.canUndo}
          title={activeHistory.undoLabel ? `Undo ${activeHistory.undoLabel} (⌘/Ctrl+Z)` : 'Undo'}
          aria-label="Undo"
        >
          <Undo2 />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={redo}
          disabled={!activeHistory.canRedo}
          title={activeHistory.redoLabel ? `Redo ${activeHistory.redoLabel} (⌘/Ctrl+⇧+Z)` : 'Redo'}
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
        <Button
          size="sm"
          variant="ghost"
          data-testid="export-bundle"
          title="Project + every imported model it uses, in one portable file"
          onClick={() => void doExportBundle()}
        >
          <Package /> Bundle
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.forge.json,.forge-bundle.json,application/json"
          className="hidden"
          data-testid="import-input"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            if (file.size > MAX_BUNDLE_BYTES) {
              setStatus({
                tone: 'error',
                text: 'Import failed: file exceeds the 64 MiB limit. The current project was left unchanged.',
              });
              return;
            }
            const text = await file.text();
            // Portable bundles carry their model assets; plain project files do not.
            if (/^\s*\{\s*"format"\s*:\s*"forge-bundle"/.test(text)) void importBundleText(text);
            else if (file.size > MAX_IMPORT_BYTES)
              setStatus({
                tone: 'error',
                text: 'Import failed: project files are limited to 10 MiB. The current project was left unchanged.',
              });
            else importProjectText(text);
          }}
        />
      </div>
    </header>
  );
}

function Toggle({
  pressed,
  onClick,
  testId,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={
        'flex h-7 items-center gap-1 rounded px-2 text-xs [&_svg]:size-3.5 ' +
        (pressed ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary')
      }
    >
      {children}
    </button>
  );
}
