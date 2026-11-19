import type { StoreApi } from 'zustand/vanilla';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HierarchyPanel } from '@/features/hierarchy/HierarchyPanel';
import { Inspector } from '@/features/inspector/Inspector';
import { StatusBar } from '@/features/toolbar/StatusBar';
import { TopBar } from '@/features/toolbar/TopBar';
import { useShortcuts } from '@/hooks/useShortcuts';
import { EngineeringViewport } from '@/scenes/EngineeringViewport';
import { EditorStoreContext, type EditorState } from './store';

export function App({ store }: { store: StoreApi<EditorState> }) {
  useShortcuts(store);
  return (
    <EditorStoreContext.Provider value={store}>
      <div className="flex h-full flex-col">
        <TopBar />
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(200px,260px)_1fr_minmax(240px,300px)]">
          <aside className="min-h-0 border-r border-border bg-card/60">
            <HierarchyPanel />
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
          </main>
          <aside className="min-h-0 overflow-auto border-l border-border bg-card/60">
            <Inspector />
          </aside>
        </div>
        <StatusBar />
      </div>
    </EditorStoreContext.Provider>
  );
}
