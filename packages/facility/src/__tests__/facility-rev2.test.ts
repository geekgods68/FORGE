import { describe, expect, it } from 'vitest';
import { CENTRAL_WORKSHOP_ID, CORRIDOR_E_ID, FACILITY_V1 } from '../facility-v1';
import type { FURNISHING_TYPES } from '../furnishings';
import { defaultWorkspaceLayout } from '../layout';
import { requiredZones } from '../lifecycle';
import {
  FACILITY,
  furnishingFootprint,
  getZone,
  neighbours,
  rectInside,
  validateFacility,
  zoneFootprintInFacility,
} from '../registry';
import type { Facility } from '../schemas';
import { roomCode, signsForZone } from '../signage';
import { validateLayout } from '../workspace';

const clone = (): Facility => structuredClone(FACILITY_V1);
const rooms = FACILITY.zones.filter((z) => z.kind !== 'corridor');

describe('facility revision 2: complete site plan', () => {
  it('builds 22 labs, 6 environments and the corridors connecting them', () => {
    expect(FACILITY.zones.filter((z) => z.kind === 'laboratory').map((z) => z.labNumber)).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 1),
    );
    expect(FACILITY.zones.filter((z) => z.kind === 'environment').map((z) => z.name)).toEqual([
      'Robotic Manipulation Arena',
      'Motion Capture & Navigation Arena',
      'Underwater Robotics Tank',
      'Aerodynamics & Wind Tunnel Bay',
      'Immersive Design Chamber',
      'Real-World Environment Simulator',
    ]);
    expect(FACILITY.zones.filter((z) => z.kind === 'corridor')).toHaveLength(11);
  });

  it('labs belong to the wings in FACILITY_LAYOUT.md', () => {
    const wing = (n: number) => FACILITY.zones.find((z) => z.labNumber === n)!.wingId;
    const expected: Record<string, number[]> = {
      'wing-a': [1, 2, 3, 4, 5],
      'wing-b': [6, 7, 8, 9],
      'wing-c': [10, 11, 12, 13, 14],
      'wing-d': [15, 16, 17, 18, 19],
      'wing-e': [20, 21, 22],
    };
    for (const [w, labs] of Object.entries(expected)) for (const n of labs) expect(wing(n)).toBe(w);
  });

  it('keeps revision-1 identities, so revision-1 layouts remain valid', () => {
    const lab20 = getZone(CENTRAL_WORKSHOP_ID)!;
    expect(lab20.pose).toEqual({ position: [0, 0, -7.5], yaw: 0 });
    expect(lab20.footprint).toEqual({ min: [-9, -6], max: [9, 6] });
    expect(lab20.placementAreas.map((a) => a.id)).toEqual(['bench-floor', 'conjuring-dais']);
    expect(getZone(CORRIDOR_E_ID)!.footprint).toEqual({ min: [-27, -1.5], max: [27, 1.5] });
    const rev1 = { ...defaultWorkspaceLayout(), facilityRevision: 1 };
    expect(validateLayout(rev1).ok).toBe(true);
  });

  it('every zone is reachable from Lab 20 through open portals (functional navigation graph)', () => {
    const seen = new Set([CENTRAL_WORKSHOP_ID]);
    const queue = [CENTRAL_WORKSHOP_ID];
    while (queue.length)
      for (const n of neighbours(queue.shift()!))
        if (!seen.has(n.id)) {
          seen.add(n.id);
          queue.push(n.id);
        }
    expect(seen.size).toBe(FACILITY.zones.length);
  });

  it('each room opens onto exactly one corridor, which is its required loaded neighbour', () => {
    for (const z of rooms) {
      expect(z.portals).toHaveLength(1);
      const c = getZone(z.portals[0]!.toZoneId)!;
      expect(c.kind).toBe('corridor');
      expect(requiredZones(z.id)).toEqual([z.id, c.id]);
    }
  });

  it('every room has discipline-specific furnishings and a placement area inside its footprint', () => {
    for (const z of rooms) {
      expect(z.discipline.length).toBeGreaterThan(5);
      expect(z.furnishings.length).toBeGreaterThanOrEqual(z.id === CENTRAL_WORKSHOP_ID ? 4 : 2);
      expect(z.placementAreas.length).toBeGreaterThan(0);
      for (const f of z.furnishings) expect(rectInside(furnishingFootprint(f)!, z.footprint)).toBe(true);
    }
    // Rooms are distinguishable: no two labs share the same furnishing set.
    const sets = rooms.map((z) =>
      z.furnishings
        .map((f) => f.type)
        .sort()
        .join(),
    );
    expect(new Set(sets).size).toBe(sets.length);
    // Discipline markers present where expected.
    const has = (n: number, t: keyof typeof FURNISHING_TYPES) =>
      FACILITY.zones.find((z) => z.labNumber === n)!.furnishings.some((f) => f.type === t);
    expect(has(11, 'cnc-mill')).toBe(true);
    expect(has(12, 'printer-row')).toBe(true);
    expect(has(16, 'air-shower')).toBe(true);
    expect(has(18, 'optical-table')).toBe(true);
    expect(has(7, 'mobile-robot-arena')).toBe(true);
    expect(has(4, 'server-rack-row')).toBe(true);
  });

  it('zones never overlap on the site plan', () => {
    const fp = FACILITY.zones.map(zoneFootprintInFacility);
    expect(fp.every((r) => r.max[0] - r.min[0] > 0)).toBe(true);
    expect(validateFacility(FACILITY)).toEqual([]);
  });
});

describe('validateFacility catches broken content (mutation checks)', () => {
  it('overlapping furnishings, furnishings in a placement area or doorway, and one-sided portals', () => {
    const a = clone();
    const lab1 = a.zones.find((z) => z.labNumber === 1)!;
    lab1.furnishings.push({ ...lab1.furnishings[0]! });
    expect(validateFacility(a).join()).toMatch(/overlaps furnishing/);

    const b = clone();
    b.zones
      .find((z) => z.labNumber === 2)!
      .furnishings.push({ type: 'cnc-mill', position: [0, 0, 0], yaw: 0 });
    expect(validateFacility(b).join()).toMatch(/overlaps placement area bench-floor/);

    const c = clone();
    c.zones
      .find((z) => z.labNumber === 3)!
      .furnishings.push({ type: 'charging-dock', position: [0, 0, 5.5], yaw: 0 });
    expect(validateFacility(c).join()).toMatch(/blocks a doorway/);

    const d = clone();
    d.zones.find((z) => z.id === 'corridor-b-main')!.portals.shift();
    expect(validateFacility(d).join()).toMatch(/no reciprocal portal/);

    const e = clone();
    e.zones
      .find((z) => z.labNumber === 5)!
      .furnishings.push({ type: 'not-a-thing', position: [8, 0, 5], yaw: 0 });
    expect(validateFacility(e).join()).toMatch(/unknown type/);
  });
});

describe('signage', () => {
  it('every room has an identity sign with its code, name and discipline', () => {
    for (const z of rooms) {
      const [s] = signsForZone(z.id).filter((x) => x.kind === 'identity');
      expect(s!.lines[0]).toBe(`${roomCode(z)} · ${z.name}`);
      expect(s!.lines[1]).toBe(z.discipline);
      expect(
        rectInside(
          {
            min: [s!.position[0] - 0.01, s!.position[2] - 0.01],
            max: [s!.position[0] + 0.01, s!.position[2] + 0.01],
          },
          z.footprint,
        ),
      ).toBe(true);
      expect(s!.position[1] + s!.size[1] / 2).toBeLessThan(z.ceilingHeightM);
    }
    expect(roomCode(getZone(CENTRAL_WORKSHOP_ID)!)).toBe('LAB 20');
    expect(roomCode(FACILITY.zones.find((z) => z.labNumber === 7)!)).toBe('LAB 07');
  });

  it('every room doorway is labelled in its corridor with the correct room, exactly once', () => {
    const doorSigns = FACILITY.zones
      .filter((z) => z.kind === 'corridor')
      .flatMap((z) => signsForZone(z.id))
      .filter((s) => s.kind === 'door');
    expect(doorSigns).toHaveLength(rooms.length);
    for (const z of rooms) {
      const s = doorSigns.filter((d) => d.id.endsWith(`:door:${z.id}`));
      expect(s).toHaveLength(1);
      expect(s[0]!.lines.slice(0, 2)).toEqual([roomCode(z), z.name]);
      expect(s[0]!.zoneId).toBe(z.portals[0]!.toZoneId);
    }
  });

  it('corridor junctions carry directional signs listing the labs ahead', () => {
    const toA = signsForZone('concourse-1').find((s) => s.id === 'concourse-1:to:corridor-a-main')!;
    expect(toA.lines).toEqual(['↓ Wing A Main Corridor', 'Labs 1, 2, 3, 4, 5']);
    const toE = signsForZone('concourse-1').find((s) => s.id === `concourse-1:to:${CORRIDOR_E_ID}`)!;
    expect(toE.lines).toEqual(['↑ Wing E Main Corridor', 'Labs 20, 21, 22']);
    const envs = signsForZone('concourse-5').find((s) => s.id.endsWith(':to:corridor-environments'))!;
    expect(envs.lines[1]).toBe('6 research environments');
  });
});
