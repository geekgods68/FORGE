import { COMPONENT_CATEGORY_IDS } from '@forge/engineering-core';
import { describe, expect, it } from 'vitest';
import { fam, genericFamily, L } from '../catalog/builders';
import { buildCatalog, CATALOG, catalogStats, getDefinition, validateCatalog } from '../catalog';
import { emptyPrefs, parsePrefs, recordRecent, RECENT_LIMIT, toggleFavorite } from '../prefs';
import { searchCatalog } from '../search';
import { CATEGORIES, slug } from '../taxonomy';

describe('taxonomy', () => {
  it('has exactly the 28 categories in catalogue order, each with an icon, description and subcategories', () => {
    expect(CATEGORIES.map((c) => c.id)).toEqual([...COMPONENT_CATEGORY_IDS]);
    expect(CATEGORIES.map((c) => c.number)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
    for (const c of CATEGORIES) {
      expect(c.icon.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(10);
      expect(c.subcategories.length).toBeGreaterThan(0);
      expect(new Set(c.subcategories.map((s) => s.id)).size).toBe(c.subcategories.length);
    }
    expect(CATEGORIES.find((c) => c.number === 1)!.subcategories).toHaveLength(20);
    expect(CATEGORIES.find((c) => c.number === 9)!.subcategories.map((s) => s.name)).toContain(
      'Ultrasonic sensors',
    );
    expect(slug('RP2040/RP2350 boards')).toBe('rp2040-rp2350-boards');
  });
});

describe('catalogue', () => {
  it('validates completely: every subcategory populated, every default and variant evaluates', () => {
    expect(validateCatalog(CATALOG)).toEqual([]);
    const s = catalogStats();
    expect(s.categories).toBe(28);
    expect(s.families).toBeGreaterThan(380);
    expect(s.tiers.A).toBeGreaterThan(80);
  });

  it('is deeply frozen', () => {
    expect(() => {
      (CATALOG[0] as { name: string }).name = 'x';
    }).toThrow();
  });

  it('robotic-arm pack is present with honest data status and cited references', () => {
    for (const id of [
      'arduino-uno-r3',
      'towerpro-sg90',
      'towerpro-mg996r',
      'hc-sr04',
      'servo-mount-bracket',
      'arm-link',
      'arm-base-plate',
      'precision-shaft',
      'ball-bearing',
      'machine-screw',
      'parallel-gripper',
      'breadboard',
      'jumper-wire',
      'breadboard-power-module',
      'battery-pack',
      'dual-h-bridge-module',
    ])
      expect(getDefinition(id), id).toBeDefined();
    const uno = getDefinition('arduino-uno-r3')!;
    expect(uno.dataStatus).toBe('datasheet-cited');
    expect(uno.references[0]!.url).toBe('https://docs.arduino.cc/hardware/uno-rev3/');
    // Unknown values stay unknown (null), never 0.
    const sg90 = getDefinition('towerpro-sg90')!;
    expect(sg90.specs.electrical.find((x) => x.key === 'stall-current')!.value).toBeNull();
    expect(getDefinition('dual-h-bridge-module')!.dataStatus).toBe('generic');
    // Nothing claims simulation validity in Phase 3.
    expect(CATALOG.every((d) => d.capabilities.every((c) => c.status === 'unsupported'))).toBe(true);
  });

  it('rejects invalid and duplicate definitions with explicit errors', () => {
    const good = genericFamily(
      'sensors-measurement',
      'LiDAR',
      'test-lidar',
      'Test LiDAR',
      [10, 10, 10],
      'Test.',
    );
    expect(() => buildCatalog([{ ...good, id: 'Bad Id' }])).toThrow(/kebab-case/);
    expect(() => buildCatalog([{ ...good, categoryId: 'nope' as never }])).toThrow(/categoryId/);
    const dup = buildCatalog([good, good]);
    expect(validateCatalog(dup)).toContain('duplicate component id "test-lidar"');
    const badSub = buildCatalog([{ ...good, subcategoryId: 'nope' }]);
    expect(validateCatalog(badSub).join()).toMatch(/unknown subcategory/);
    const badGen = buildCatalog([{ ...good, geometry: { ...good.geometry, generator: 'missing' } }]);
    expect(validateCatalog(badGen).join()).toMatch(/unknown generator/);
    const badDefault = buildCatalog([
      fam('structure-raw-materials', 'Metal bars and rods', 'bad-rod', 'Bad', {
        description: 'x',
        tier: 'A',
        generator: 'rod',
        representation: 'exact',
        parameters: [L('diameter', 'D', 50, 1, 10), L('length', 'L', 10, 1, 100)],
      }),
    ]);
    expect(validateCatalog(badDefault).join()).toMatch(/default of diameter outside its range/);
    const unclaimed = buildCatalog([{ ...good, manufacturer: { name: 'X', product: 'Y' } }]);
    expect(validateCatalog(unclaimed).join()).toMatch(/cites no reference/);
  });

  it('missing optional metadata (manufacturer, references, specs) is accepted as unknown', () => {
    const d = buildCatalog([
      genericFamily('sensors-measurement', 'LiDAR', 'bare', 'Bare', [10, 10, 10], 'x'),
    ])[0]!;
    expect(d.manufacturer).toBeNull();
    expect(d.references).toEqual([]);
    expect(d.specifiedMassKg).toBeNull();
  });
});

describe('search and filtering', () => {
  it('finds servos by name, alias and part number; named products rank highly', () => {
    const hits = searchCatalog('servo');
    expect(hits.length).toBeGreaterThan(5);
    expect(hits.slice(0, 8).map((h) => h.definition.id)).toEqual(
      expect.arrayContaining(['towerpro-sg90', 'towerpro-mg996r']),
    );
    expect(searchCatalog('sg90')[0]!.definition.id).toBe('towerpro-sg90');
    expect(searchCatalog('hc-sr04')[0]!.definition.id).toBe('hc-sr04');
    const ext = searchCatalog('2040');
    expect(ext[0]!.definition.id).toBe('t-slot-extrusion');
    expect(searchCatalog('m3 × 12')[0]!.variantId).toBe('m3x12');
    expect(searchCatalog('aluminium plate')[0]).toMatchObject({ variantId: null });
    expect(searchCatalog('zzzz-no-such-thing')).toEqual([]);
  });

  it('filters by category, subcategory, tier, data status, favourites', () => {
    const elec = searchCatalog('', { categoryId: 'passive-electronics' });
    expect(elec.every((h) => h.definition.categoryId === 'passive-electronics')).toBe(true);
    expect(
      searchCatalog('', { categoryId: 'motors-actuators', subcategoryId: 'micro-servos' })
        .map((h) => h.definition.id)
        .sort(),
    ).toEqual(['micro-servo-generic', 'towerpro-sg90']);
    expect(searchCatalog('', { tiers: ['A'] }).every((h) => h.definition.tier === 'A')).toBe(true);
    expect(searchCatalog('', { dataStatus: ['standard'] }).map((h) => h.definition.id)).toEqual(
      expect.arrayContaining(['machine-screw', 'ball-bearing', 'stepper-nema']),
    );
    expect(searchCatalog('', { namedProductsOnly: true }).length).toBe(
      CATALOG.filter((d) => d.manufacturer).length,
    );
    expect(
      searchCatalog('', { ids: ['hc-sr04', 'arm-link'] })
        .map((h) => h.definition.id)
        .sort(),
    ).toEqual(['arm-link', 'hc-sr04']);
  });

  it('is fast enough for interactive use (< 20 ms per query over the full catalogue)', () => {
    searchCatalog('warm');
    const t0 = performance.now();
    for (const q of ['servo', 'm3', 'aluminium plate', 'sensor', 'gear module 1']) searchCatalog(q);
    expect((performance.now() - t0) / 5).toBeLessThan(20);
  });
});

describe('library preferences', () => {
  it('toggles favourites and keeps a bounded, de-duplicated recent list', () => {
    let p = emptyPrefs();
    p = toggleFavorite(p, 'hc-sr04');
    expect(p.favorites).toEqual(['hc-sr04']);
    p = toggleFavorite(p, 'hc-sr04');
    expect(p.favorites).toEqual([]);
    for (let i = 0; i < RECENT_LIMIT + 5; i++) p = recordRecent(p, `c${i}`, null);
    p = recordRecent(p, 'c3', null);
    expect(p.recent).toHaveLength(RECENT_LIMIT);
    expect(p.recent[0]).toEqual({ id: 'c3', variantId: null });
    expect(p.recent.filter((r) => r.id === 'c3')).toHaveLength(1);
    expect(parsePrefs({ version: 2 })).toEqual(emptyPrefs());
  });
});
