import {
  activeScene,
  createProject,
  degToRad,
  rotateAboutWorldY,
  type Project,
} from '@forge/engineering-core';
import type { ProjectRepository } from '@forge/persistence';
import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type Message = { tone: 'info' | 'success' | 'error'; text: string; details?: string[] } | null;
export type PhysicsStatus = { state: 'loading' | 'ready' | 'error'; detail?: string };

export interface ForgeState {
  project: Project;
  /** True when the open project differs from what was last saved/loaded. */
  dirty: boolean;
  message: Message;
  physics: PhysicsStatus;
  /** Incremented to ask the camera rig to reset (view state, not project data). */
  cameraResetRequest: number;
  newProject(): void;
  save(): void;
  reloadSaved(): void;
  rotateFirstInstance(degrees: number): void;
  requestCameraReset(): void;
  setPhysics(status: PhysicsStatus): void;
}

/**
 * Application state. The project document is replaced immutably on every change;
 * persistence goes through the injected repository so it can be swapped for a
 * filesystem adapter later. Failed loads never replace the open project.
 */
export function createForgeStore(repo: ProjectRepository): StoreApi<ForgeState> {
  const initial = (() => {
    const latest = repo.list()[0];
    if (latest) {
      const r = repo.load(latest.id);
      if (r.ok)
        return {
          project: r.value,
          message: { tone: 'info', text: `Opened saved project “${r.value.name}”.` } as Message,
        };
    }
    return {
      project: createProject(),
      message: { tone: 'info', text: 'New project (not yet saved).' } as Message,
    };
  })();

  return createStore<ForgeState>()((set, get) => ({
    project: initial.project,
    dirty: false,
    message: initial.message,
    physics: { state: 'loading' },
    cameraResetRequest: 0,

    newProject() {
      set({
        project: createProject(),
        dirty: true,
        message: { tone: 'info', text: 'New project created (not yet saved).' },
      });
    },

    save() {
      const project = { ...get().project, updatedAt: new Date().toISOString() };
      const r = repo.save(project);
      if (r.ok) {
        set({
          project,
          dirty: false,
          message: { tone: 'success', text: 'Saved to this browser’s local storage (not a backup).' },
        });
      } else {
        set({
          message: {
            tone: 'error',
            text: r.error.message,
            ...(r.error.code === 'invalid' ? { details: r.error.details } : {}),
          },
        });
      }
    },

    reloadSaved() {
      const r = repo.load(get().project.id);
      if (r.ok) {
        set({
          project: r.value,
          dirty: false,
          message: { tone: 'success', text: `Loaded saved copy of “${r.value.name}”.` },
        });
      } else {
        set({
          message: {
            tone: 'error',
            text: `Could not load: ${r.error.message} The open project was left unchanged.`,
            ...(r.error.code === 'invalid' ? { details: r.error.details.slice(0, 5) } : {}),
          },
        });
      }
    },

    rotateFirstInstance(degrees) {
      const p = get().project;
      const scene = activeScene(p);
      const first = scene.instances[0];
      if (!first) return;
      const instances = scene.instances.map((i) =>
        i.id === first.id
          ? {
              ...i,
              transform: {
                ...i.transform,
                rotation: rotateAboutWorldY(i.transform.rotation, degToRad(degrees)),
              },
            }
          : i,
      );
      set({
        project: { ...p, scenes: p.scenes.map((s) => (s.id === scene.id ? { ...s, instances } : s)) },
        dirty: true,
      });
    },

    requestCameraReset() {
      set({ cameraResetRequest: get().cameraResetRequest + 1 });
    },

    setPhysics(physics) {
      set({ physics });
    },
  }));
}

export const ForgeStoreContext = createContext<StoreApi<ForgeState> | null>(null);

export function useForge<T>(selector: (s: ForgeState) => T): T {
  const store = useContext(ForgeStoreContext);
  if (!store) throw new Error('ForgeStoreContext missing');
  return useStore(store, selector);
}
