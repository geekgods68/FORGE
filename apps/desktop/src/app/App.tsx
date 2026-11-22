import type { StoreApi } from 'zustand/vanilla';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HierarchyPanel } from '@/features/hierarchy/HierarchyPanel';
import { ItemInspector } from '@/features/workspace/ItemInspector';
import { LibraryPanel } from '@/features/library/LibraryPanel';
import { WalkHud } from '@/features/walk/WalkHud';
import { SnapPanel } from '@/features/snap/SnapPanel';
import { WorkspacePanel } from '@/features/workspace/WorkspacePanel';
import { Inspector } from '@/features/inspector/Inspector';
import { StatusBar } from '@/features/toolbar/StatusBar';
import { TopBar } from '@/features/toolbar/TopBar';
import { useShortcuts } from '@/hooks/useShortcuts';
import { EngineeringViewport } from '@/scenes/EngineeringViewport';
import { SimulationPanel } from '@/features/simulation/SimulationPanel';
import { ElectronicsPanel } from '@/features/electronics/ElectronicsPanel';
import { SchematicOverlay } from '@/features/electronics/SchematicView';
import { simulationFor } from '@/features/simulation/controller';
import { cosimFor } from '@/features/electronics/cosim';
import { ResearchPanel } from '@/features/research/ResearchPanel';
import { ResearchOverlay } from '@/features/research/Workspace';
import { useEffect } from 'react';
import { EditorStoreContext, useEditor, type EditorState } from './store';

export function App({ store }: { store: StoreApi<EditorState> }) {
  useShortcuts(store);
  useSimulationLifecycle(store);
  return (
    <EditorStoreContext.Provider value={store}>
      <div className="flex h-full flex-col">
        <TopBar />
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(200px,260px)_1fr_minmax(240px,300px)]">
          <aside className="flex min-h-0 flex-col border-r border-border bg-card/60">
            <div className="min-h-0 flex-1">
              <HierarchyPanel />
            </div>
            <FacilitySidebar />
          </aside>
          <main className="relative min-h-0">
            {/* A renderer failure must not take down the hierarchy, inspector or project controls. */}
            <ErrorBoundary
              fallback={
                <div
                  role="alert"
                  className="grid h-full place-items-center p-6 text-center text-sm text-destructive"
                >
                  The 3D viewport failed. Engineering data is unaffected — export the project, then reload.
                </div>
              }
            >
              <EngineeringViewport />
            </ErrorBoundary>
            <SnapPanel />
            <SchematicOverlay />
            <ResearchOverlay />
            <WalkHud />
            <LibraryPanel />
          </main>
          <aside className="min-h-0 overflow-auto border-l border-border bg-card/60">
            <InspectorSwitch />
          </aside>
        </div>
        <StatusBar />
      </div>
    </EditorStoreContext.Provider>
  );
}

function FacilitySidebar() {
  const facility = useEditor((s) => s.view === 'facility');
  return facility ? (
    <div className="max-h-[55%] shrink-0 overflow-auto">
      <WorkspacePanel />
    </div>
  ) : null;
}

/** The inspector follows the active edit layer: workspace items in layout mode, engineering nodes otherwise. */
function InspectorSwitch() {
  const layout = useEditor((s) => s.view === 'facility' && s.editLayer === 'layout');
  const simulating = useEditor((s) => s.workMode === 'simulation');
  const electronics = useEditor((s) => s.workMode === 'electronics');
  const research = useEditor((s) => s.workMode === 'research');
  if (research) return <ResearchPanel />;
  if (simulating) return <SimulationPanel />;
  if (electronics) return <ElectronicsPanel />;
  return layout ? <ItemInspector /> : <Inspector />;
}

/** Simulation mode owns a physics session only while it is active. */
function useSimulationLifecycle(store: StoreApi<EditorState>) {
  useEffect(() => {
    cosimFor(store); // registers the electronics runtime with the simulation controller
    const c = simulationFor(store);
    let last = store.getState().workMode;
    const unsub = store.subscribe((s) => {
      if (s.workMode === last) return;
      last = s.workMode;
      if (s.workMode === 'simulation') void c.enter();
      else c.exit();
    });
    return () => {
      unsub();
      c.exit();
    };
  }, [store]);
}
