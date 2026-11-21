import { getZone } from './registry';
import type { Zone } from './schemas';

/**
 * Zone lifecycle (renderer-independent, unit-testable):
 *
 *   UNLOADED ──load──▶ LOADING ──ok──▶ ACTIVE ──not wanted──▶ UNLOADING ──renderer released──▶ UNLOADED
 *                         │                                       ▲
 *                         └──fail──▶ ERROR ──retry()──▶ LOADING   │ (a zone wanted again while
 *                                                                   UNLOADING simply re-loads)
 *
 * Wanted set = the active zone + its required connecting corridor(s) + at most ONE
 * prefetched destination. Each load carries a generation token; a resolution or failure
 * that arrives after the zone stopped being wanted (or was re-requested) is ignored, so
 * stale asynchronous loads can never activate a zone. Only renderer resources are
 * managed here — workspace layouts and engineering projects are never touched.
 */
export type ZoneLoadState = 'unloaded' | 'loading' | 'active' | 'unloading' | 'error';
export type ZoneRole = 'active' | 'required' | 'prefetch';

export interface ZoneStatus {
  state: ZoneLoadState;
  role: ZoneRole | null;
  error?: string;
}

/** The active zone plus every implemented corridor it opens onto (its required connections). */
export function requiredZones(activeId: string): string[] {
  const z = getZone(activeId);
  if (!z || z.status !== 'implemented') return [];
  const out = [z.id];
  if (z.kind === 'corridor') return out;
  for (const p of z.portals) {
    const n = getZone(p.toZoneId);
    if (p.open && n?.status === 'implemented' && n.kind === 'corridor' && !out.includes(n.id)) out.push(n.id);
  }
  return out;
}

export class ZoneLifecycle {
  private statuses = new Map<string, ZoneStatus>();
  private generation = new Map<string, number>();
  private wanted = new Map<string, ZoneRole>();
  private listeners = new Set<() => void>();
  /** Completed loads (diagnostics). */
  loadsCompleted = 0;
  staleResultsIgnored = 0;

  constructor(private readonly loader: (zone: Zone) => Promise<void>) {}

  /** Declare what should be loaded (null = nothing, e.g. the facility view closed). Unknown/planned zones are ignored. */
  setTarget(activeZoneId: string | null, prefetchZoneId: string | null = null): void {
    const next = new Map<string, ZoneRole>();
    if (activeZoneId)
      requiredZones(activeZoneId).forEach((id, i) => next.set(id, i === 0 ? 'active' : 'required'));
    if (
      activeZoneId &&
      prefetchZoneId &&
      !next.has(prefetchZoneId) &&
      getZone(prefetchZoneId)?.status === 'implemented'
    )
      next.set(prefetchZoneId, 'prefetch'); // at most one prefetch by construction
    this.wanted = next;

    for (const [id, role] of next) {
      const s = this.status(id);
      if (s.state === 'unloaded' || s.state === 'unloading') this.startLoad(id, role);
      else this.statuses.set(id, { ...s, role });
    }
    for (const [id, s] of this.statuses) {
      if (next.has(id)) continue;
      if (s.state === 'active' || s.state === 'loading') {
        this.bump(id); // invalidates any in-flight load
        this.statuses.set(id, { state: s.state === 'active' ? 'unloading' : 'unloaded', role: null });
      } else if (s.state === 'error') {
        this.statuses.set(id, { state: 'unloaded', role: null });
      }
    }
    this.emit();
  }

  /** Called by the renderer once a zone's scene objects are unmounted and resources released. */
  confirmUnloaded(zoneId: string): void {
    const s = this.statuses.get(zoneId);
    if (s?.state === 'unloading' && !this.wanted.has(zoneId)) {
      this.statuses.set(zoneId, { state: 'unloaded', role: null });
      this.emit();
    }
  }

  retry(zoneId: string): void {
    const s = this.statuses.get(zoneId);
    const role = this.wanted.get(zoneId);
    if (s?.state === 'error' && role) {
      this.startLoad(zoneId, role);
      this.emit();
    }
  }

  status(zoneId: string): ZoneStatus {
    return this.statuses.get(zoneId) ?? { state: 'unloaded', role: null };
  }

  snapshot(): Record<string, ZoneStatus> {
    return Object.fromEntries([...this.statuses].filter(([, s]) => s.state !== 'unloaded'));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private bump(id: string): number {
    const g = (this.generation.get(id) ?? 0) + 1;
    this.generation.set(id, g);
    return g;
  }

  private startLoad(id: string, role: ZoneRole) {
    const zone = getZone(id);
    if (!zone) return;
    const gen = this.bump(id);
    this.statuses.set(id, { state: 'loading', role });
    const current = () => this.generation.get(id) === gen && this.wanted.has(id);
    this.loader(zone).then(
      () => {
        if (!current()) {
          this.staleResultsIgnored++;
          return;
        }
        this.loadsCompleted++;
        this.statuses.set(id, { state: 'active', role: this.wanted.get(id)! });
        this.emit();
      },
      (e: unknown) => {
        if (!current()) {
          this.staleResultsIgnored++;
          return;
        }
        this.statuses.set(id, {
          state: 'error',
          role: this.wanted.get(id)!,
          error: e instanceof Error ? e.message : String(e),
        });
        this.emit();
      },
    );
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}
