import { describe, expect, it } from 'vitest';
import { CENTRAL_WORKSHOP_ID, CORRIDOR_E_ID } from '../facility-v1';
import { requiredZones, ZoneLifecycle } from '../lifecycle';
import { implementedZones } from '../registry';
import type { Zone } from '../schemas';

/** Loader whose promises the test resolves/rejects explicitly. */
function controlledLoader() {
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }[]>();
  const loader = (z: Zone) =>
    new Promise<void>((resolve, reject) => {
      pending.set(z.id, [...(pending.get(z.id) ?? []), { resolve, reject }]);
    });
  const settle = async (id: string, ok = true, which: 'first' | 'last' = 'last') => {
    const list = pending.get(id) ?? [];
    const p = which === 'first' ? list.shift() : list.pop();
    if (ok) p?.resolve();
    else p?.reject(new Error(`boom ${id}`));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { loader, settle, pending };
}
const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe('requiredZones', () => {
  it('a room requires its connecting corridor; a corridor requires only itself', () => {
    expect(requiredZones(CENTRAL_WORKSHOP_ID)).toEqual([CENTRAL_WORKSHOP_ID, CORRIDOR_E_ID]);
    expect(requiredZones(CORRIDOR_E_ID)).toEqual([CORRIDOR_E_ID]);
    expect(requiredZones('nope')).toEqual([]);
  });
});

describe('ZoneLifecycle', () => {
  it('UNLOADED → LOADING → ACTIVE for the active zone and its corridor', async () => {
    const c = controlledLoader();
    const lc = new ZoneLifecycle(c.loader);
    lc.setTarget(CENTRAL_WORKSHOP_ID);
    expect(lc.status(CENTRAL_WORKSHOP_ID)).toEqual({ state: 'loading', role: 'active' });
    expect(lc.status(CORRIDOR_E_ID)).toEqual({ state: 'loading', role: 'required' });
    await c.settle(CENTRAL_WORKSHOP_ID);
    await c.settle(CORRIDOR_E_ID);
    expect(lc.status(CENTRAL_WORKSHOP_ID).state).toBe('active');
    expect(lc.status(CORRIDOR_E_ID).state).toBe('active');
  });

  it('ACTIVE → UNLOADING → UNLOADED only after the renderer confirms release', async () => {
    const lc = new ZoneLifecycle(async () => {});
    lc.setTarget(CENTRAL_WORKSHOP_ID);
    await flush();
    lc.setTarget(CORRIDOR_E_ID);
    expect(lc.status(CENTRAL_WORKSHOP_ID).state).toBe('unloading');
    expect(lc.status(CORRIDOR_E_ID)).toEqual({ state: 'active', role: 'active' }); // kept, role updated
    lc.confirmUnloaded(CENTRAL_WORKSHOP_ID);
    expect(lc.status(CENTRAL_WORKSHOP_ID).state).toBe('unloaded');
  });

  it('a stale load that resolves after the user moved on never activates the zone', async () => {
    const c = controlledLoader();
    const lc = new ZoneLifecycle(c.loader);
    lc.setTarget(CENTRAL_WORKSHOP_ID); // starts loading workshop + corridor
    lc.setTarget(CORRIDOR_E_ID); // user immediately moves on
    expect(lc.status(CENTRAL_WORKSHOP_ID).state).toBe('unloaded');
    await c.settle(CENTRAL_WORKSHOP_ID);
    expect(lc.status(CENTRAL_WORKSHOP_ID).state).toBe('unloaded');
    expect(lc.staleResultsIgnored).toBe(1);
  });

  it('re-requesting a zone supersedes its earlier in-flight load (only the newest generation counts)', async () => {
    const c = controlledLoader();
    const lc = new ZoneLifecycle(c.loader);
    lc.setTarget(CENTRAL_WORKSHOP_ID);
    lc.setTarget(CORRIDOR_E_ID);
    lc.setTarget(CENTRAL_WORKSHOP_ID); // second load request for the workshop
    await c.settle(CENTRAL_WORKSHOP_ID, false, 'first'); // old request fails late → ignored
    expect(lc.status(CENTRAL_WORKSHOP_ID).state).toBe('loading');
    await c.settle(CENTRAL_WORKSHOP_ID, true, 'last');
    expect(lc.status(CENTRAL_WORKSHOP_ID).state).toBe('active');
  });

  it('errors are reported and recoverable with retry', async () => {
    const c = controlledLoader();
    const lc = new ZoneLifecycle(c.loader);
    lc.setTarget(CORRIDOR_E_ID);
    await c.settle(CORRIDOR_E_ID, false);
    expect(lc.status(CORRIDOR_E_ID)).toMatchObject({ state: 'error', error: `boom ${CORRIDOR_E_ID}` });
    lc.retry(CORRIDOR_E_ID);
    expect(lc.status(CORRIDOR_E_ID).state).toBe('loading');
    await c.settle(CORRIDOR_E_ID);
    expect(lc.status(CORRIDOR_E_ID).state).toBe('active');
  });

  it('holds at most one prefetched destination; prefetch never duplicates a required zone', async () => {
    const lc = new ZoneLifecycle(async () => {});
    const others = implementedZones().filter((z) => z.id !== CENTRAL_WORKSHOP_ID && z.id !== CORRIDOR_E_ID);
    lc.setTarget(CENTRAL_WORKSHOP_ID, CORRIDOR_E_ID); // prefetch = required → ignored
    await flush();
    expect(Object.values(lc.snapshot()).filter((s) => s.role === 'prefetch')).toHaveLength(0);
    if (others.length >= 2) {
      lc.setTarget(CENTRAL_WORKSHOP_ID, others[0]!.id);
      lc.setTarget(CENTRAL_WORKSHOP_ID, others[1]!.id);
      await flush();
      const prefetched = Object.entries(lc.snapshot()).filter(([, s]) => s.role === 'prefetch');
      expect(prefetched.map(([id]) => id)).toEqual([others[1]!.id]);
    }
  });

  it('repeated transitions do not accumulate loaded zones', async () => {
    const lc = new ZoneLifecycle(async () => {});
    const ids = implementedZones().map((z) => z.id);
    for (let round = 0; round < 5; round++)
      for (const id of ids) {
        lc.setTarget(id);
        await flush();
        for (const [zid, s] of Object.entries(lc.snapshot()))
          if (s.state === 'unloading') lc.confirmUnloaded(zid);
        const live = Object.values(lc.snapshot()).filter((s) => s.state !== 'unloaded');
        expect(live.length).toBeLessThanOrEqual(requiredZones(id).length);
      }
  });
});
