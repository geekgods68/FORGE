import { FACILITY, getZone, portalSide } from './registry';
import type { Zone } from './schemas';

/**
 * Wayfinding signage, derived entirely from facility data (so signs can never disagree
 * with the registry). Positions are in the OWNING zone's frame; `yaw` turns the sign's
 * readable face (+Z of the sign plane) about +Y. Renderers rasterise `lines` locally
 * (no remote fonts or textures).
 */
export type SignKind = 'identity' | 'door' | 'directional';

export interface SignSpec {
  id: string;
  zoneId: string;
  kind: SignKind;
  /** First line is the headline. */
  lines: string[];
  position: [number, number, number];
  yaw: number;
  /** Sign panel size (m). */
  size: [number, number];
}

const wingOf = (z: Zone) => FACILITY.wings.find((w) => w.id === z.wingId)!;

/** Short identifier shown first on every sign for a room. */
export function roomCode(z: Zone): string {
  if (z.kind === 'laboratory') return `LAB ${String(z.labNumber).padStart(2, '0')}`;
  if (z.kind === 'environment')
    return `ENV ${FACILITY.zones.filter((q) => q.kind === 'environment').indexOf(z) + 1}`;
  return wingOf(z).letter === 'E' && z.id.startsWith('concourse') ? 'CONCOURSE' : `WING ${wingOf(z).letter}`;
}

/** What lies through a corridor/concourse opening — the labs (and onward wings) it serves. */
function destinationSummary(target: Zone, from: Zone): string[] {
  if (target.kind !== 'corridor') return [roomCode(target), target.name];
  const rooms = target.portals.map((p) => getZone(p.toZoneId)!).filter((z) => z.kind !== 'corridor');
  const labs = rooms.filter((z) => z.kind === 'laboratory').map((z) => z.labNumber!);
  const envs = rooms.filter((z) => z.kind === 'environment').length;
  const onward = target.portals
    .map((p) => getZone(p.toZoneId)!)
    .filter((z) => z.kind === 'corridor' && z.id !== from.id);
  const parts: string[] = [];
  if (labs.length) parts.push(`Labs ${labs.sort((a, b) => a - b).join(', ')}`);
  if (envs) parts.push(`${envs} research environments`);
  if (target.id.startsWith('concourse') && onward.length)
    return [`${target.name.replace(/ \(.*\)$/, '')}`, ...onward.map((c) => `To ${c.name}`)];
  return [target.name, parts.join(' · ') || wingOf(target).name];
}

/** All signs owned by a zone. Every room gets an identity sign; corridors label each doorway. */
export function signsForZone(zoneId: string): SignSpec[] {
  const z = getZone(zoneId);
  if (!z) return [];
  const out: SignSpec[] = [];
  const { min, max } = z.footprint;
  if (z.kind !== 'corridor') {
    // Identity panel high on the back (north, local −z) wall, facing into the room.
    const y = Math.min(z.ceilingHeightM - 0.9, z.kind === 'environment' ? 5.6 : 3.4);
    out.push({
      id: `${z.id}:identity`,
      zoneId: z.id,
      kind: 'identity',
      lines: [`${roomCode(z)} · ${z.name}`, z.discipline, `Wing ${wingOf(z).letter} · ${wingOf(z).name}`],
      position: [0, y, min[1] + 0.03],
      yaw: 0,
      size: z.kind === 'environment' ? [8, 1.4] : [6, 1.05],
    });
    return out;
  }
  for (const p of z.portals) {
    const t = getZone(p.toZoneId);
    const side = portalSide(z, p);
    if (!t || !side) continue;
    if (t.kind === 'corridor') {
      // Hanging directional sign over a corridor/concourse opening, readable from inside this zone.
      const inward = side === 'north' ? 1 : side === 'south' ? -1 : 0;
      out.push({
        id: `${z.id}:to:${t.id}`,
        zoneId: z.id,
        kind: 'directional',
        lines: [
          `${side === 'north' ? '↑' : side === 'south' ? '↓' : '→'} ${destinationSummary(t, z)[0]}`,
          ...destinationSummary(t, z).slice(1),
        ],
        position: [p.position[0], z.ceilingHeightM - 0.55, p.position[2] + inward * 0.6],
        yaw: side === 'north' ? 0 : Math.PI,
        size: [Math.min(3.6, p.widthM + 0.4), 0.7],
      });
      continue;
    }
    // Door sign beside a room's doorway, on the corridor face of the wall (walls are
    // drawn just outside each zone's footprint, so the room's wall face is 0.2 m in).
    const inward = side === 'north' ? 1 : -1;
    const wallFace = (side === 'north' ? min[1] : max[1]) + inward * 0.23;
    out.push({
      id: `${z.id}:door:${t.id}`,
      zoneId: z.id,
      kind: 'door',
      lines: [roomCode(t), t.name, t.discipline],
      position: [p.position[0] + p.widthM / 2 + 0.85, 1.75, wallFace],
      yaw: side === 'north' ? 0 : Math.PI,
      size: [1.3, 0.62],
    });
  }
  return out;
}
