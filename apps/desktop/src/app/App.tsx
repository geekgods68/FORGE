import type { StoreApi } from 'zustand/vanilla';
import { ProjectPanel } from '@/features/project/ProjectPanel';
import { Phase0Scene } from '@/scenes/Phase0Scene';
import { ForgeStoreContext, type ForgeState } from './store';

export function App({ store }: { store: StoreApi<ForgeState> }) {
  return (
    <ForgeStoreContext.Provider value={store}>
      <main className="relative h-full w-full">
        <div className="absolute inset-0">
          <Phase0Scene />
        </div>
        <div className="pointer-events-none absolute top-4 left-4">
          <ProjectPanel />
        </div>
      </main>
    </ForgeStoreContext.Provider>
  );
}
