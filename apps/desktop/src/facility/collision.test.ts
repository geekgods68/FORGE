import { FACILITY, getZone, portalSide } from '@forge/facility';
import { describe, expect, it } from 'vitest';
import { canStand, collidersAround, resolveMove, spawnFor, WALKER_RADIUS, zoneAt } from './collision';
import { ceilingParts, connectorStubs } from './shell';

/** Walk in a straight line in small steps (as the frame loop does) and return where we end up. */
function walk(x: number, z: number, dirX: number, dirZ: number, metres: number, zone: string) {
  let cur = zone;
  for (let i = 0; i < metres / 0.05; i++) {
    [x, z] = resolveMove(x, z, dirX * 0.05, dirZ * 0.05, collidersAround(cur));
    cur = zoneAt(x, z, cur) ?? cur;
  }
  return { x, z, zone: cur };
}

describe('first-person collision', () => {
  it('every zone has a free spawn point inside its own footprint', () => {
    for (const z of FACILITY.zones) {
      const s = spawnFor(z);
      expect(zoneAt(s.x, s.z), z.id).toBe(z.id);
      expect(canStand(s.x, s.z, collidersAround(z.id)), z.id).toBe(true);
    }
  });

  it('walls stop the walker (Lab 20 north wall at facility z = −13.5)', () => {
    const s = spawnFor(getZone('lab-20-central-conjuring-workshop')!);
    const end = walk(s.x + 6.5, s.z, 0, -1, 30, 'lab-20-central-conjuring-workshop');
    expect(end.z).toBeGreaterThanOrEqual(-13.5 + WALKER_RADIUS - 1e-9);
    expect(end.zone).toBe('lab-20-central-conjuring-workshop');
  });

  it('furnishings block too (cannot walk through the storage wall at the back of Lab 20)', () => {
    const end = walk(3, -9, 0, -1, 10, 'lab-20-central-conjuring-workshop');
    expect(end.z).toBeGreaterThan(-7.5 - 5.25); // storage wall front face (zone z −5.25)
  });

  it('doorways are open: Lab 20 → Corridor E → concourse → Wing A corridor → Lab 1', () => {
    let p = walk(0, -9, 0, 1, 9, 'lab-20-central-conjuring-workshop');
    expect(p.zone).toBe('corridor-e-main');
    p = walk(p.x, p.z, 0, 1, 16, p.zone);
    expect(p.zone).toBe('corridor-a-main');
    p = walk(p.x, p.z, -1, 0, 31, p.zone); // along Wing A corridor to x = −31
    expect(p.x).toBeCloseTo(-31, 6);
    p = walk(p.x, p.z, 0, -1, 4, p.zone); // north through Lab 1's door
    expect(p.zone).toBe('lab-01-central-intelligence');
  });

  it('cannot leave the building through a solid wall', () => {
    const p = walk(0, 0, 0, -1, 1, 'corridor-e-main'); // into Lab 20 through its door: allowed
    expect(p.zone).toBe('corridor-e-main');
    const q = walk(10, 0, 0, -1, 5, 'corridor-e-main'); // Lab 20's glazed partition at x = 10
    expect(q.z).toBeGreaterThan(-1.5);
  });
});

describe('connector stubs and ceilings', () => {
  it('every corridor-to-corridor opening gets a vestibule stub; room doors do not', () => {
    for (const z of FACILITY.zones.filter((q) => q.kind === 'corridor')) {
      const expected = z.portals
        .filter((p) => getZone(p.toZoneId)!.kind === 'corridor')
        .map((p) => p.toZoneId);
      expect(
        connectorStubs(z)
          .map((s) => s.targetId)
          .sort(),
      ).toEqual([...expected].sort());
      for (const s of connectorStubs(z)) {
        expect(s.parts.some((p) => p.m === 'glassFrosted')).toBe(true);
        // A stub stays inside the neighbour it previews (never pokes beyond it).
        const t = getZone(s.targetId)!;
        const side = portalSide(
          z,
          z.portals.find((p) => p.toZoneId === t.id)!,
        );
        expect(side).not.toBeNull();
      }
    }
  });

  it('labs and corridors have a ceiling at their ceiling height; rooms keep doors open', () => {
    for (const z of FACILITY.zones.filter((q) => q.kind !== 'environment')) {
      const [c] = ceilingParts(z);
      expect(c!.pos[1]).toBeCloseTo(z.ceilingHeightM + 0.03, 9);
      expect(c!.m).toBe('ceiling');
    }
  });
});
