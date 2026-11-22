import { createContext, useContext, type ReactNode } from 'react';

/**
 * Scientific charts (SVG). They draw exactly the recorded values: missing values leave gaps,
 * nothing is smoothed, extrapolated or filled in. Every chart states its units and sample sizes.
 */
const W = 460;
const H = 220;
const M = { l: 56, r: 12, t: 14, b: 40 };
const COLORS = ['#38bdf8', '#f59e0b', '#4ade80', '#f472b6', '#a78bfa', '#f87171', '#2dd4bf', '#facc15'];
const fmt = (x: number) =>
  Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-2 && x !== 0)
    ? x.toExponential(1)
    : Number(x.toPrecision(3)).toString();

function ticks(lo: number, hi: number, n = 4) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi === lo) return [lo];
  return Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
}
function range(vals: number[]): [number, number] {
  const f = vals.filter(Number.isFinite);
  if (!f.length) return [0, 1];
  let lo = Math.min(...f);
  let hi = Math.max(...f);
  if (hi === lo) {
    lo -= Math.abs(lo) * 0.1 || 0.5;
    hi += Math.abs(hi) * 0.1 || 0.5;
  }
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

function Frame({
  x,
  y,
  xLabel,
  yLabel,
  children,
  testId,
  caption,
}: {
  x: [number, number];
  y: [number, number];
  xLabel: string;
  yLabel: string;
  children: ReactNode;
  testId?: string;
  caption?: string;
}) {
  const X = (v: number) => M.l + ((v - x[0]) / (x[1] - x[0])) * (W - M.l - M.r);
  const Y = (v: number) => H - M.b - ((v - y[0]) / (y[1] - y[0])) * (H - M.t - M.b);
  return (
    <figure className="space-y-0.5" data-testid={testId}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded border border-border bg-black/30 text-[9px]">
        {ticks(...y).map((v) => (
          <g key={`y${v}`}>
            <line x1={M.l} x2={W - M.r} y1={Y(v)} y2={Y(v)} stroke="#ffffff14" />
            <text x={M.l - 4} y={Y(v) + 3} textAnchor="end" fill="#94a3b8">
              {fmt(v)}
            </text>
          </g>
        ))}
        {ticks(...x).map((v) => (
          <text key={`x${v}`} x={X(v)} y={H - M.b + 12} textAnchor="middle" fill="#94a3b8">
            {fmt(v)}
          </text>
        ))}
        <text x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle" fill="#cbd5e1">
          {xLabel}
        </text>
        <text
          x={10}
          y={(M.t + H - M.b) / 2}
          textAnchor="middle"
          fill="#cbd5e1"
          transform={`rotate(-90 10 ${(M.t + H - M.b) / 2})`}
        >
          {yLabel}
        </text>
        <line x1={M.l} x2={M.l} y1={M.t} y2={H - M.b} stroke="#64748b" />
        <line x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} stroke="#64748b" />
        <ChartContext.Provider value={{ X, Y }}>{children}</ChartContext.Provider>
      </svg>
      {caption && <figcaption className="text-[10px] text-muted-foreground">{caption}</figcaption>}
    </figure>
  );
}
const ChartContext = createContext<{ X: (v: number) => number; Y: (v: number) => number }>({
  X: (v) => v,
  Y: (v) => v,
});

/** Time series (recorded samples connected; gaps at missing values). */
export function LineChart({
  series,
  xLabel,
  yLabel,
  testId,
}: {
  series: { name: string; t: ArrayLike<number>; v: ArrayLike<number>; hold?: boolean }[];
  xLabel: string;
  yLabel: string;
  testId?: string;
}) {
  const xs = series.flatMap((s) => Array.from(s.t));
  const ys = series.flatMap((s) => Array.from(s.v));
  return (
    <Frame
      x={range(xs)}
      y={range(ys)}
      xLabel={xLabel}
      yLabel={yLabel}
      testId={testId}
      caption={
        series.map((s) => `■ ${s.name} (n = ${Array.from(s.v).filter(Number.isFinite).length})`).join('   ') +
        (series.length ? '' : 'no data')
      }
    >
      <Lines series={series} />
    </Frame>
  );
}
function Lines({
  series,
}: {
  series: { name: string; t: ArrayLike<number>; v: ArrayLike<number>; hold?: boolean }[];
}) {
  const { X, Y } = useContext(ChartContext);
  return (
    <>
      {series.map((s, i) => {
        const parts: string[][] = [[]];
        for (let k = 0; k < s.t.length; k++) {
          const v = s.v[k]!;
          if (!Number.isFinite(v)) {
            parts.push([]);
            continue;
          }
          const cur = parts[parts.length - 1]!;
          if (s.hold && cur.length) cur.push(`${X(s.t[k]!)},${cur[cur.length - 1]!.split(',')[1]}`);
          cur.push(`${X(s.t[k]!)},${Y(v)}`);
        }
        return parts
          .filter((p) => p.length)
          .map((p, j) => (
            <polyline
              key={`${i}-${j}`}
              points={p.join(' ')}
              fill="none"
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={1.3}
            />
          ));
      })}
    </>
  );
}

/** Scatter (optionally joined: response curves). Error bars = ±1 SD where given. */
export function ScatterChart({
  points,
  xLabel,
  yLabel,
  joined,
  testId,
  caption,
}: {
  points: { x: number; y: number | null; sd?: number | null; group?: string }[];
  xLabel: string;
  yLabel: string;
  joined?: boolean;
  testId?: string;
  caption?: string;
}) {
  const ok = points.filter(
    (p): p is { x: number; y: number; sd?: number | null; group?: string } =>
      p.y !== null && Number.isFinite(p.y),
  );
  const groups = [...new Set(ok.map((p) => p.group ?? ''))];
  return (
    <Frame
      x={range(ok.map((p) => p.x))}
      y={range(ok.flatMap((p) => [p.y - (p.sd ?? 0), p.y + (p.sd ?? 0)]))}
      xLabel={xLabel}
      yLabel={yLabel}
      testId={testId}
      caption={
        caption ??
        `n = ${ok.length} point(s)${points.length > ok.length ? `; ${points.length - ok.length} missing (not drawn)` : ''}${groups.length > 1 ? ` · ${groups.map((g, i) => `■${i + 1} ${g}`).join(' ')}` : ''}`
      }
    >
      <Dots points={ok} joined={!!joined} groups={groups} />
    </Frame>
  );
}
function Dots({
  points,
  joined,
  groups,
}: {
  points: { x: number; y: number; sd?: number | null; group?: string }[];
  joined: boolean;
  groups: string[];
}) {
  const { X, Y } = useContext(ChartContext);
  return (
    <>
      {groups.map((g, gi) => {
        const ps = points.filter((p) => (p.group ?? '') === g).sort((a, b) => a.x - b.x);
        const c = COLORS[gi % COLORS.length];
        return (
          <g key={g}>
            {joined && (
              <polyline
                points={ps.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')}
                fill="none"
                stroke={c}
                strokeWidth={1}
              />
            )}
            {ps.map((p, i) => (
              <g key={i}>
                {p.sd ? (
                  <line x1={X(p.x)} x2={X(p.x)} y1={Y(p.y - p.sd)} y2={Y(p.y + p.sd)} stroke={c} />
                ) : null}
                <circle cx={X(p.x)} cy={Y(p.y)} r={3} fill={c} />
              </g>
            ))}
          </g>
        );
      })}
    </>
  );
}

/** Box plot per group (quartiles, whiskers to min/max, n per group). */
export function BoxPlot({
  groups,
  yLabel,
  testId,
}: {
  groups: { label: string; values: number[] }[];
  yLabel: string;
  testId?: string;
}) {
  const all = groups.flatMap((g) => g.values).filter(Number.isFinite);
  const y = range(all);
  const n = groups.length;
  return (
    <Frame
      x={[0, Math.max(1, n)]}
      y={y}
      xLabel="condition (index; see the table)"
      yLabel={yLabel}
      testId={testId}
      caption={groups
        .map((g, i) => `${i + 1}: ${g.label} (n = ${g.values.filter(Number.isFinite).length})`)
        .join(' · ')}
    >
      <Boxes groups={groups} />
    </Frame>
  );
}
function Boxes({ groups }: { groups: { label: string; values: number[] }[] }) {
  const { X, Y } = useContext(ChartContext);
  const q = (s: number[], p: number) => {
    const h = (s.length - 1) * p;
    const lo = Math.floor(h);
    return s[lo]! + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)] ?? s[lo]!) - s[lo]!);
  };
  return (
    <>
      {groups.map((g, i) => {
        const s = g.values.filter(Number.isFinite).sort((a, b) => a - b);
        if (!s.length) return null;
        const cx = X(i + 0.5);
        const w = Math.min(28, (X(1) - X(0)) * 0.5);
        const [mn, q1, md, q3, mx] = [s[0]!, q(s, 0.25), q(s, 0.5), q(s, 0.75), s[s.length - 1]!];
        const c = COLORS[i % COLORS.length];
        return (
          <g key={i}>
            <line x1={cx} x2={cx} y1={Y(mn)} y2={Y(mx)} stroke={c} />
            <rect
              x={cx - w / 2}
              y={Y(q3)}
              width={w}
              height={Math.max(1, Y(q1) - Y(q3))}
              fill={`${c}44`}
              stroke={c}
            />
            <line x1={cx - w / 2} x2={cx + w / 2} y1={Y(md)} y2={Y(md)} stroke={c} strokeWidth={2} />
            <text x={cx} y={Y(mn) + 10} textAnchor="middle" fill="#94a3b8">
              {i + 1}
            </text>
          </g>
        );
      })}
    </>
  );
}

export function Histogram({
  edges,
  counts,
  xLabel,
  testId,
}: {
  edges: number[];
  counts: number[];
  xLabel: string;
  testId?: string;
}) {
  if (!counts.length) return <p className="text-xs text-muted-foreground">No values.</p>;
  return (
    <Frame
      x={[edges[0]!, edges[edges.length - 1]!]}
      y={[0, Math.max(...counts) * 1.1]}
      xLabel={xLabel}
      yLabel="runs"
      testId={testId}
      caption={`n = ${counts.reduce((a, b) => a + b, 0)}`}
    >
      <Bars edges={edges} counts={counts} />
    </Frame>
  );
}
function Bars({ edges, counts }: { edges: number[]; counts: number[] }) {
  const { X, Y } = useContext(ChartContext);
  return (
    <>
      {counts.map((c, i) => (
        <rect
          key={i}
          x={X(edges[i]!) + 0.5}
          y={Y(c)}
          width={Math.max(0, X(edges[i + 1]!) - X(edges[i]!) - 1)}
          height={Y(0) - Y(c)}
          fill="#38bdf866"
          stroke="#38bdf8"
        />
      ))}
    </>
  );
}

/** Two-variable heatmap of condition means (missing cells hatched, never filled). */
export function Heatmap({
  x,
  y,
  z,
  xLabel,
  yLabel,
  unit,
  testId,
}: {
  x: number[];
  y: number[];
  z: (number | null)[][];
  xLabel: string;
  yLabel: string;
  unit: string;
  testId?: string;
}) {
  const vals = z.flat().filter((v): v is number => v !== null && Number.isFinite(v));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const cw = (W - M.l - M.r) / Math.max(1, x.length);
  const ch = (H - M.t - M.b) / Math.max(1, y.length);
  return (
    <figure className="space-y-0.5" data-testid={testId}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded border border-border bg-black/30 text-[9px]">
        {z.map((row, j) =>
          row.map((v, i) => {
            const f = v === null || hi === lo ? 0.5 : (v - lo) / (hi - lo);
            return (
              <g key={`${i}-${j}`}>
                <rect
                  x={M.l + i * cw}
                  y={H - M.b - (j + 1) * ch}
                  width={cw - 1}
                  height={ch - 1}
                  fill={v === null ? 'url(#hatch)' : `hsl(${220 - 200 * f} 70% ${35 + 20 * f}%)`}
                />
                <text
                  x={M.l + i * cw + cw / 2}
                  y={H - M.b - j * ch - ch / 2 + 3}
                  textAnchor="middle"
                  fill="#fff"
                >
                  {v === null ? '—' : fmt(v)}
                </text>
              </g>
            );
          }),
        )}
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse">
            <path d="M0,6 l6,-6" stroke="#64748b" />
          </pattern>
        </defs>
        {x.map((v, i) => (
          <text key={i} x={M.l + i * cw + cw / 2} y={H - M.b + 12} textAnchor="middle" fill="#94a3b8">
            {fmt(v)}
          </text>
        ))}
        {y.map((v, j) => (
          <text key={j} x={M.l - 4} y={H - M.b - j * ch - ch / 2 + 3} textAnchor="end" fill="#94a3b8">
            {fmt(v)}
          </text>
        ))}
        <text x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle" fill="#cbd5e1">
          {xLabel}
        </text>
        <text
          x={10}
          y={(M.t + H - M.b) / 2}
          textAnchor="middle"
          fill="#cbd5e1"
          transform={`rotate(-90 10 ${(M.t + H - M.b) / 2})`}
        >
          {yLabel}
        </text>
      </svg>
      <figcaption className="text-[10px] text-muted-foreground">
        Cell = mean of completed runs ({unit || 'no unit'}); hatched = no completed run.
      </figcaption>
    </figure>
  );
}
