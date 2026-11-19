import { BrowserStorageProjectRepository, MemoryStorage } from '@forge/persistence';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';
import { createForgeStore, ForgeStoreContext, type ForgeState } from '@/app/store';
import { ProjectPanel } from './ProjectPanel';

let storage: MemoryStorage;
let store: StoreApi<ForgeState>;

function renderPanel() {
  return render(
    <ForgeStoreContext.Provider value={store}>
      <ProjectPanel />
    </ForgeStoreContext.Provider>,
  );
}

beforeEach(() => {
  storage = new MemoryStorage();
  store = createForgeStore(new BrowserStorageProjectRepository(storage, 'ui-test'));
});

describe('ProjectPanel', () => {
  it('shows the FORGE identity and Phase 0 label', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: 'FORGE' })).toBeInTheDocument();
    expect(screen.getByText('Engineering Research Environment')).toBeInTheDocument();
    expect(screen.getByText('Phase 0 · Foundation')).toBeInTheDocument();
  });

  it('creates a new project with a new id', () => {
    renderPanel();
    const before = store.getState().project.id;
    fireEvent.click(screen.getByRole('button', { name: /New project/ }));
    expect(store.getState().project.id).not.toBe(before);
    expect(screen.getByRole('status')).toHaveTextContent(/New project created/);
  });

  it('save → rotate → reload restores the saved transform', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(screen.getByRole('status')).toHaveTextContent(/Saved/);
    fireEvent.click(screen.getByRole('button', { name: /Rotate object/ }));
    expect(screen.getByTestId('instance-pose')).toHaveTextContent('yaw 15.0°');
    expect(screen.getByTestId('project-name')).toHaveTextContent('unsaved changes');
    fireEvent.click(screen.getByRole('button', { name: /Reload saved/ }));
    expect(screen.getByTestId('instance-pose')).toHaveTextContent('yaw 0.0°');
  });

  it('an invalid stored document yields an understandable error and keeps the open project', () => {
    renderPanel();
    const p = store.getState().project;
    storage.setItem(`ui-test:project:${p.id}`, JSON.stringify({ ...p, units: { length: 'furlong' } }));
    fireEvent.click(screen.getByRole('button', { name: /Reload saved/ }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/failed validation/);
    expect(alert).toHaveTextContent(/left unchanged/);
    expect(alert).toHaveTextContent(/units/);
    expect(store.getState().project).toBe(p);
  });

  it('reopens the most recently saved project on startup', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    const id = store.getState().project.id;
    const next = createForgeStore(new BrowserStorageProjectRepository(storage, 'ui-test'));
    expect(next.getState().project.id).toBe(id);
  });
});
