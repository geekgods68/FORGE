import { CATALOG } from './catalog';
import type { ComponentDefinition, DataStatus, Tier } from './schemas';
import { CATEGORIES } from './taxonomy';

/**
 * Catalogue search: a precomputed lowercase index (name, aliases, family, category,
 * subcategory, variants, part numbers, manufacturer, description) ranked by match
 * quality. Pure and synchronous; the UI virtualises the result list.
 */
export interface SearchFilters {
  categoryId?: string;
  subcategoryId?: string;
  tiers?: Tier[];
  dataStatus?: DataStatus[];
  hasInterfaces?: boolean;
  namedProductsOnly?: boolean;
  /** Restrict to these ids (e.g. favourites). */
  ids?: readonly string[];
}

export interface SearchHit {
  definition: ComponentDefinition;
  score: number;
  /** Variant whose name/part number matched, if any. */
  variantId: string | null;
}

interface Entry {
  def: ComponentDefinition;
  name: string;
  keys: string;
  body: string;
  variants: { id: string; text: string }[];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}.+-]+/gu, ' ')
    .trim();

function buildIndex(defs: readonly ComponentDefinition[]): Entry[] {
  return defs.map((def) => {
    const cat = CATEGORIES.find((c) => c.id === def.categoryId);
    const sub = cat?.subcategories.find((s) => s.id === def.subcategoryId);
    return {
      def,
      name: norm(def.name),
      keys: norm(
        [
          ...def.aliases,
          def.family,
          def.id,
          def.manufacturer?.product ?? '',
          def.manufacturer?.name ?? '',
        ].join(' '),
      ),
      body: norm([cat?.name ?? '', sub?.name ?? '', def.description].join(' ')),
      variants: def.variants.map((v) => ({
        id: v.id,
        text: norm(`${v.name} ${v.partNumber ?? ''} ${v.id}`),
      })),
    };
  });
}

let defaultIndex: Entry[] | null = null;

export function searchCatalog(
  query: string,
  filters: SearchFilters = {},
  defs: readonly ComponentDefinition[] = CATALOG,
): SearchHit[] {
  const index = defs === CATALOG ? (defaultIndex ??= buildIndex(CATALOG)) : buildIndex(defs);
  const terms = norm(query).split(' ').filter(Boolean);
  const ids = filters.ids ? new Set(filters.ids) : null;
  const hits: SearchHit[] = [];
  for (const e of index) {
    const d = e.def;
    if (filters.categoryId && d.categoryId !== filters.categoryId) continue;
    if (filters.subcategoryId && d.subcategoryId !== filters.subcategoryId) continue;
    if (filters.tiers?.length && !filters.tiers.includes(d.tier)) continue;
    if (filters.dataStatus?.length && !filters.dataStatus.includes(d.dataStatus)) continue;
    if (filters.namedProductsOnly && !d.manufacturer) continue;
    if (
      filters.hasInterfaces &&
      d.interfaces.length === 0 &&
      ![
        'board',
        'servo',
        'ultrasonic',
        'screw',
        'nut',
        'bearing',
        'gear',
        'tslot',
        'plate',
        'bracket-l',
        'arm-link',
        'rod',
        'motor-can',
        'stepper',
        'ic-package',
        'wire',
      ].includes(d.geometry.generator)
    )
      continue;
    if (ids && !ids.has(d.id)) continue;
    if (terms.length === 0) {
      hits.push({ definition: d, score: 0, variantId: null });
      continue;
    }
    let score = 0;
    let variantId: string | null = null;
    let all = true;
    const variantOnly: string[] = [];
    for (const t of terms) {
      let s = 0;
      if (e.name.split(' ').some((w) => w === t)) s = 10;
      else if (e.name.split(' ').some((w) => w.startsWith(t))) s = 7;
      else if (e.keys.split(' ').some((w) => w === t)) s = 8;
      else if (e.keys.includes(t)) s = 5;
      else if (e.name.includes(t)) s = 4;
      else {
        if (e.variants.some((x) => x.text.includes(t))) {
          s = 4;
          variantOnly.push(t);
        } else if (e.body.includes(t)) s = 1;
      }
      if (s === 0) {
        all = false;
        break;
      }
      score += s;
    }
    if (all) {
      // A variant is preselected only for terms the family itself does not match
      // (e.g. "m3 × 12" → M3×12, but "aluminium plate" → no variant).
      let best = 0;
      for (const v of e.variants) {
        const n = variantOnly.filter((t) => v.text.includes(t)).length;
        if (n > best) {
          best = n;
          variantId = v.id;
        }
      }
      hits.push({ definition: d, score: score + (d.manufacturer ? 0.5 : 0) + best * 0.1, variantId });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.definition.name.localeCompare(b.definition.name));
}
