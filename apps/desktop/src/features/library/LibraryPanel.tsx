import {
  CATALOG,
  CATEGORIES,
  evaluate,
  getDefinition,
  getMaterial,
  resolveParameters,
  searchCatalog,
  TIER_LABELS,
  type ComponentDefinition,
  type ParameterDef,
  type ParamValues,
  type Tier,
} from '@forge/components';
import {
  Aperture,
  ArrowLeft,
  Atom,
  AudioLines,
  BatteryFull,
  Bot,
  Box,
  Boxes,
  Cable,
  CircuitBoard,
  Cog,
  Cpu,
  Droplets,
  Factory,
  FlaskConical,
  Hand,
  Layers,
  Microchip,
  Monitor,
  Mountain,
  Package,
  Plane,
  PlugZap,
  Radar,
  Search,
  Sparkles,
  Star,
  Thermometer,
  Wifi,
  Workflow,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { NumberField } from '@/components/NumberField';
import { useEditor } from '@/app/store';
import { ComponentSketch } from '@/components3d/ComponentSketch';
import { formatLength, formatMass } from '@/components3d/format';
import { cn } from '@/lib/utils';

/**
 * Universal component library: 28 categories → subcategories → families → variants,
 * with search, filters, favourites and recents. Selecting a family shows its
 * engineering data and parameters; "Conjure" starts ghost placement. The catalogue is
 * pure data — no meshes are created until a part is previewed or placed.
 */
const ICONS: Record<string, LucideIcon> = {
  box: Box,
  wrench: Wrench,
  cog: Cog,
  zap: Zap,
  bot: Bot,
  'circuit-board': CircuitBoard,
  microchip: Microchip,
  cpu: Cpu,
  radar: Radar,
  'battery-full': BatteryFull,
  'plug-zap': PlugZap,
  cable: Cable,
  wifi: Wifi,
  monitor: Monitor,
  aperture: Aperture,
  'audio-lines': AudioLines,
  droplets: Droplets,
  thermometer: Thermometer,
  factory: Factory,
  plane: Plane,
  workflow: Workflow,
  atom: Atom,
  package: Package,
  boxes: Boxes,
  layers: Layers,
  'flask-conical': FlaskConical,
  hand: Hand,
  mountain: Mountain,
};
const COUNTS = new Map(CATEGORIES.map((c) => [c.id, CATALOG.filter((d) => d.categoryId === c.id).length]));
const MAX_ROWS = 150;

export const TierBadge = ({ tier }: { tier: Tier }) => (
  <span
    title={TIER_LABELS[tier]}
    className={cn(
      'rounded px-1 text-[10px] font-semibold',
      tier === 'A'
        ? 'bg-primary/20 text-primary'
        : tier === 'B'
          ? 'bg-secondary text-foreground'
          : 'bg-amber-500/15 text-amber-300',
    )}
  >
    {tier}
  </span>
);

export function LibraryPanel() {
  const open = useEditor((s) => s.libraryOpen);
  const placing = useEditor((s) => s.conjure !== null);
  if (!open) return null;
  // While placing, the panel collapses to a slim bar so the workbench is unobstructed.
  return (
    <>
      {placing && <PlacingBar />}
      <div hidden={placing}>
        <Library />
      </div>
    </>
  );
}

function PlacingBar() {
  const conjure = useEditor((s) => s.conjure)!;
  const cancel = useEditor((s) => s.cancelConjure);
  const def = getDefinition(conjure.definitionId);
  return (
    <div
      role="status"
      data-testid="library-placing"
      className="absolute top-2 left-2 z-20 flex items-center gap-2 rounded-md border border-primary/60 bg-card/95 px-3 py-1.5 text-xs shadow"
    >
      <Sparkles className="size-4 text-primary" />
      <span>
        Placing <strong>{def?.name}</strong> · R / Shift+R rotate ({Math.round((conjure.yaw * 180) / Math.PI)}
        °) · click to place · Esc cancels
      </span>
      <Button size="sm" variant="secondary" onClick={cancel}>
        Cancel
      </Button>
    </div>
  );
}

function Library() {
  const setOpen = useEditor((s) => s.setLibraryOpen);
  const prefs = useEditor((s) => s.libraryPrefs);
  const assemblies = useEditor((s) => s.assemblies);
  const openSample = useEditor((s) => s.openSample);
  const insertAssembly = useEditor((s) => s.insertAssembly);
  const deleteAssembly = useEditor((s) => s.deleteAssembly);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [subId, setSubId] = useState<string | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [favOnly, setFavOnly] = useState(false);
  const [selected, setSelected] = useState<{ id: string; variantId: string | null } | null>(null);

  const hits = useMemo(
    () =>
      searchCatalog(deferred, {
        ...(categoryId ? { categoryId } : {}),
        ...(subId ? { subcategoryId: subId } : {}),
        ...(tiers.length ? { tiers } : {}),
        ...(favOnly ? { ids: prefs.favorites } : {}),
      }),
    [deferred, categoryId, subId, tiers, favOnly, prefs.favorites],
  );
  const category = CATEGORIES.find((c) => c.id === categoryId);
  const browsing = !deferred && !categoryId && !favOnly && tiers.length === 0;

  return (
    <aside
      aria-label="Component library"
      data-testid="library-panel"
      className="absolute inset-y-0 left-0 z-20 flex w-[380px] max-w-full flex-col border-r border-border bg-card/95 text-xs shadow-xl backdrop-blur"
    >
      <header className="flex items-center gap-2 border-b border-border p-2">
        <Sparkles className="size-4 text-primary" />
        <h2 className="flex-1 text-sm font-semibold">Component library</h2>
        <span className="text-muted-foreground">{CATALOG.length} families</span>
        <Button size="icon" variant="ghost" aria-label="Close library" onClick={() => setOpen(false)}>
          <X />
        </Button>
      </header>

      {selected ? (
        <FamilyDetail
          key={selected.id}
          definition={getDefinition(selected.id)!}
          initialVariant={selected.variantId}
          onBack={() => setSelected(null)}
        />
      ) : (
        <>
          <div className="space-y-1.5 border-b border-border p-2">
            <label className="flex items-center gap-1.5 rounded border border-border bg-background px-2">
              <Search className="size-3.5 text-muted-foreground" />
              <input
                data-testid="library-search"
                aria-label="Search components"
                className="h-8 flex-1 bg-transparent outline-none"
                placeholder="Search: servo, 2040, M3 × 12, Arduino…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filters">
              {(['A', 'B', 'C'] as Tier[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  data-testid={`library-tier-${t}`}
                  aria-pressed={tiers.includes(t)}
                  title={TIER_LABELS[t]}
                  className={cn(
                    'rounded border px-1.5 py-0.5',
                    tiers.includes(t) ? 'border-primary bg-primary/20' : 'border-border',
                  )}
                  onClick={() => setTiers((v) => (v.includes(t) ? v.filter((x) => x !== t) : [...v, t]))}
                >
                  Tier {t}
                </button>
              ))}
              <button
                type="button"
                data-testid="library-favorites-filter"
                aria-pressed={favOnly}
                className={cn(
                  'flex items-center gap-1 rounded border px-1.5 py-0.5',
                  favOnly ? 'border-primary bg-primary/20' : 'border-border',
                )}
                onClick={() => setFavOnly((v) => !v)}
              >
                <Star className="size-3" /> Favourites ({prefs.favorites.length})
              </button>
            </div>
            {category && (
              <div className="flex items-center gap-1 text-muted-foreground">
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => (setCategoryId(null), setSubId(null))}
                >
                  All categories
                </button>
                <span>›</span>
                <span className="text-foreground">{category.name}</span>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {browsing && (
              <section aria-label="Samples and saved assemblies" className="mb-2 space-y-1">
                <button
                  type="button"
                  data-testid="library-open-sample"
                  className="flex w-full items-center gap-2 rounded border border-primary/40 px-2 py-1 text-left hover:bg-secondary"
                  onClick={openSample}
                >
                  <Bot className="size-3.5 text-primary" /> Open sample project: robotic arm + controller
                </button>
                {assemblies.length > 0 && (
                  <>
                    <h3 className="font-semibold text-muted-foreground">Saved assemblies</h3>
                    <ul aria-label="Saved assemblies">
                      {assemblies.map((a) => (
                        <li key={a.id} className="flex items-center gap-1">
                          <Boxes className="size-3.5 text-muted-foreground" />
                          <span className="flex-1 truncate">
                            {a.name} <span className="text-muted-foreground">({a.members.length})</span>
                          </span>
                          <button
                            type="button"
                            data-testid={`assembly-insert-${a.name}`}
                            className="text-primary hover:underline"
                            onClick={() => insertAssembly(a.id)}
                          >
                            Insert
                          </button>
                          <button
                            type="button"
                            className="text-muted-foreground hover:underline"
                            onClick={() => deleteAssembly(a.id)}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            )}
            {browsing && prefs.recent.length > 0 && (
              <section aria-label="Recently used" className="mb-2">
                <h3 className="mb-1 font-semibold text-muted-foreground">Recently used</h3>
                <div className="flex flex-wrap gap-1">
                  {prefs.recent.slice(0, 8).map((r) => {
                    const d = getDefinition(r.id);
                    return d ? (
                      <button
                        key={`${r.id}|${r.variantId}`}
                        type="button"
                        className="rounded border border-border px-1.5 py-0.5 hover:bg-secondary"
                        onClick={() => setSelected({ id: r.id, variantId: r.variantId })}
                      >
                        {d.name}
                        {r.variantId ? ` · ${d.variants.find((v) => v.id === r.variantId)?.name ?? ''}` : ''}
                      </button>
                    ) : null;
                  })}
                </div>
              </section>
            )}

            {!category && !deferred && !favOnly && (
              <ul aria-label="Categories" className="grid grid-cols-1 gap-0.5">
                {CATEGORIES.map((c) => {
                  const Icon = ICONS[c.icon] ?? Box;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        data-testid={`library-category-${c.id}`}
                        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-secondary"
                        onClick={() => (setCategoryId(c.id), setSubId(null))}
                        title={c.description}
                      >
                        <Icon className="size-3.5 text-primary" />
                        <span className="w-5 text-right text-muted-foreground">
                          {String(c.number).padStart(2, '0')}
                        </span>
                        <span className="flex-1 truncate">{c.name}</span>
                        <span className="text-muted-foreground">{COUNTS.get(c.id)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {category && !deferred && (
              <ul aria-label="Subcategories" className="mb-2 flex flex-wrap gap-1">
                {category.subcategories.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      data-testid={`library-sub-${s.id}`}
                      aria-pressed={subId === s.id}
                      className={cn(
                        'rounded border px-1.5 py-0.5',
                        subId === s.id ? 'border-primary bg-primary/20' : 'border-border hover:bg-secondary',
                      )}
                      onClick={() => setSubId(subId === s.id ? null : s.id)}
                    >
                      {s.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {(!browsing || category) && (
              <ul aria-label="Components" data-testid="library-results" className="space-y-0.5">
                {hits.length === 0 && <li className="p-2 text-muted-foreground">No components match.</li>}
                {hits.slice(0, MAX_ROWS).map((h) => (
                  <li key={h.definition.id}>
                    <button
                      type="button"
                      data-testid={`library-item-${h.definition.id}`}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-secondary"
                      onClick={() => setSelected({ id: h.definition.id, variantId: h.variantId })}
                    >
                      <TierBadge tier={h.definition.tier} />
                      <span className="flex-1 truncate">
                        {h.definition.name}
                        {h.variantId && (
                          <span className="text-muted-foreground">
                            {' '}
                            · {h.definition.variants.find((v) => v.id === h.variantId)?.name}
                          </span>
                        )}
                      </span>
                      {prefs.favorites.includes(h.definition.id) && (
                        <Star className="size-3 fill-current text-amber-300" />
                      )}
                      {h.definition.manufacturer && (
                        <span className="text-[10px] text-muted-foreground">
                          {h.definition.manufacturer.name}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
                {hits.length > MAX_ROWS && (
                  <li className="p-2 text-muted-foreground">
                    {hits.length - MAX_ROWS} more — refine the search or pick a category.
                  </li>
                )}
              </ul>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function FamilyDetail({
  definition: d,
  initialVariant,
  onBack,
}: {
  definition: ComponentDefinition;
  initialVariant: string | null;
  onBack: () => void;
}) {
  const startConjure = useEditor((s) => s.startConjure);
  const toggleFavorite = useEditor((s) => s.toggleFavorite);
  const favorite = useEditor((s) => s.libraryPrefs.favorites.includes(d.id));
  const [variantId, setVariantId] = useState<string | null>(initialVariant);
  const [overrides, setOverrides] = useState<ParamValues>({});
  const [materialId, setMaterialId] = useState<string | null>(d.materialId);
  const resolved = useMemo(() => resolveParameters(d, variantId, overrides), [d, variantId, overrides]);
  const evaluation = useMemo(
    () => (resolved.ok ? evaluate(d, resolved.values, materialId) : null),
    [d, resolved, materialId],
  );
  const cat = CATEGORIES.find((c) => c.id === d.categoryId);
  const sub = cat?.subcategories.find((s) => s.id === d.subcategoryId);

  return (
    <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="library-detail">
      <button
        type="button"
        className="mb-1 flex items-center gap-1 text-muted-foreground hover:text-foreground"
        onClick={onBack}
      >
        <ArrowLeft className="size-3.5" /> Back
      </button>
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <h3 className="text-sm font-semibold" data-testid="library-detail-name">
            {d.name}
          </h3>
          <p className="text-muted-foreground">
            {cat?.name} › {sub?.name}
          </p>
        </div>
        <button
          type="button"
          aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'}
          aria-pressed={favorite}
          data-testid="library-favorite"
          onClick={() => toggleFavorite(d.id)}
        >
          <Star
            className={cn('size-4', favorite ? 'fill-current text-amber-300' : 'text-muted-foreground')}
          />
        </button>
      </div>
      <div className="my-1 flex flex-wrap items-center gap-1">
        <TierBadge tier={d.tier} />
        <span className="text-muted-foreground">{TIER_LABELS[d.tier]}</span>
        <span className="rounded border border-border px-1 text-[10px]" title="Data provenance">
          data: {d.dataStatus}
        </span>
        <span
          className="rounded border border-border px-1 text-[10px]"
          title="No simulation model in Phase 3"
        >
          simulation: unsupported
        </span>
      </div>
      <p className="mb-2">{d.description}</p>
      {d.manufacturer && (
        <p className="mb-1 text-muted-foreground">
          Product: {d.manufacturer.name} {d.manufacturer.product} (values cited from public documents; not
          verified by FORGE)
        </p>
      )}
      {evaluation && <ComponentSketch evaluation={evaluation} size={160} />}

      {d.variants.length > 0 && (
        <label className="mt-2 flex items-center gap-2">
          <span className="w-20 text-muted-foreground">Variant</span>
          <select
            data-testid="library-variant"
            className="h-8 flex-1 rounded border border-border bg-background px-1"
            value={variantId ?? ''}
            onChange={(e) => (setVariantId(e.target.value || null), setOverrides({}))}
          >
            <option value="">Default</option>
            {d.variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {d.parameters.length > 0 && (
        <fieldset className="mt-2 space-y-1 rounded border border-border p-2">
          <legend className="px-1 text-muted-foreground">Parameters (editable)</legend>
          {d.parameters.map((p) => (
            <ParamField
              key={p.id}
              def={p}
              value={resolved.values[p.id]}
              onChange={(v) => setOverrides((o) => ({ ...o, [p.id]: v }))}
              testId={`library-param-${p.id}`}
            />
          ))}
        </fieldset>
      )}
      {d.allowedMaterialIds.length > 0 && (
        <label className="mt-2 flex items-center gap-2">
          <span className="w-20 text-muted-foreground">Material</span>
          <select
            data-testid="library-material"
            className="h-8 flex-1 rounded border border-border bg-background px-1"
            value={materialId ?? ''}
            onChange={(e) => setMaterialId(e.target.value || null)}
          >
            {d.allowedMaterialIds.map((m) => (
              <option key={m} value={m}>
                {getMaterial(m)?.name ?? m}
              </option>
            ))}
          </select>
        </label>
      )}
      {!resolved.ok && (
        <ul
          role="alert"
          className="mt-2 list-disc rounded border border-destructive/60 p-2 pl-5 text-destructive"
        >
          {resolved.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}

      {evaluation && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5" aria-label="Read-only data">
          <dt className="text-muted-foreground">Size</dt>
          <dd data-testid="library-size">{evaluation.size.map(formatLength).join(' × ')}</dd>
          <dt className="text-muted-foreground">Mass</dt>
          <dd title={evaluation.mass.note}>
            {formatMass(evaluation.mass.massKg)}{' '}
            <span className="text-muted-foreground">({evaluation.mass.source})</span>
          </dd>
          <dt className="text-muted-foreground">Interfaces</dt>
          <dd>{evaluation.interfaces.length}</dd>
          {[...d.specs.mechanical, ...d.specs.electrical].slice(0, 8).map((s) => (
            <SpecRow
              key={s.key}
              label={s.label}
              value={s.value}
              unit={s.unit}
              status={s.status}
              note={s.note}
            />
          ))}
        </dl>
      )}
      {d.references.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-muted-foreground" aria-label="References">
          {d.references.map((r) => (
            <li key={r.title}>
              {r.kind}:{' '}
              {r.url ? (
                <span className="text-primary">
                  {r.title} — {r.url}
                </span>
              ) : (
                r.title
              )}
            </li>
          ))}
        </ul>
      )}

      <Button
        className="mt-3 w-full"
        data-testid="library-conjure"
        disabled={!resolved.ok}
        onClick={() => startConjure({ definitionId: d.id, variantId, parameters: overrides, materialId })}
      >
        <Sparkles /> Conjure
      </Button>
      <p className="mt-1 text-center text-muted-foreground">
        Move over the workbench · R rotates · click to place · Esc cancels
      </p>
    </div>
  );
}

export function SpecRow({
  label,
  value,
  unit,
  status,
  note,
}: {
  label: string;
  value: number | string | null;
  unit: string;
  status: string;
  note?: string | undefined;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd title={[status, note].filter(Boolean).join(' — ')}>
        {value === null ? (
          <span className="text-muted-foreground">unknown</span>
        ) : (
          `${value}${unit ? ` ${unit}` : ''}`
        )}
        <span className="ml-1 text-[10px] text-muted-foreground">[{status}]</span>
      </dd>
    </>
  );
}

export function ParamField({
  def,
  value,
  onChange,
  testId,
  disabled,
}: {
  def: ParameterDef;
  value: unknown;
  onChange: (v: number | string | boolean) => void;
  testId: string;
  disabled?: boolean;
}) {
  switch (def.kind) {
    case 'length':
      return (
        <NumberField
          label={def.label}
          unit="mm"
          testId={testId}
          value={(value as number) * 1000}
          decimals={3}
          disabled={disabled ?? false}
          onCommit={(v) => onChange(v / 1000)}
        />
      );
    case 'angle':
      return (
        <NumberField
          label={def.label}
          unit="deg"
          testId={testId}
          value={((value as number) * 180) / Math.PI}
          decimals={2}
          disabled={disabled ?? false}
          onCommit={(v) => onChange((v * Math.PI) / 180)}
        />
      );
    case 'count':
      return (
        <NumberField
          label={def.label}
          testId={testId}
          value={value as number}
          decimals={0}
          disabled={disabled ?? false}
          onCommit={(v) => onChange(Math.round(v))}
        />
      );
    case 'choice':
      return (
        <label className="flex items-center gap-2">
          <span className="w-24 truncate text-muted-foreground">{def.label}</span>
          <select
            data-testid={testId}
            disabled={disabled}
            className="h-7 flex-1 rounded border border-border bg-background px-1"
            value={value as string}
            onChange={(e) => onChange(e.target.value)}
          >
            {def.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      );
    case 'boolean':
      return (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid={testId}
            disabled={disabled}
            checked={value as boolean}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{def.label}</span>
        </label>
      );
  }
}
