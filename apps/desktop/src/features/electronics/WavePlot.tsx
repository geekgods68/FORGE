import { formatSi } from './format';

const COLORS = ['#38bdf8', '#f59e0b', '#4ade80', '#f472b6', '#a78bfa', '#f87171'];

/**
 * Plot of sampled traces exactly as recorded (straight segments between samples, or steps
 * for digital signals) — no smoothing or resampling. Auto-scaled; min/max labelled.
 */
export function WavePlot({
  t,
  series,
  unit,
  testId,
  step = false,
  height = 140,
  window: win,
}: {
  t: ArrayLike<number>;
  series: { name: string; v: ArrayLike<number> }[];
  unit: string;
  testId?: string;
  step?: boolean;
  height?: number;
  /** Optional fixed time window [t0, t1]. */
  window?: [number, number];
}) {
  const W = 260;
  const H = height;
  const n = t.length;
  const t0 = win ? win[0] : n ? t[0]! : 0;
  const t1 = win ? win[1] : n ? t[n - 1]! : 1;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series)
    for (let k = 0; k < s.v.length; k++) {
      const x = s.v[k]!;
      if (Number.isFinite(x) && t[k]! >= t0 && t[k]! <= t1) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  if (hi - lo < 1e-12) {
    hi += 0.5;
    lo -= 0.5;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const X = (x: number) => ((x - t0) / Math.max(1e-30, t1 - t0)) * W;
  const Y = (y: number) => H - ((y - lo) / (hi - lo)) * H;
  return (
    <figure className="space-y-0.5" data-testid={testId}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded border border-border bg-black/40"
        preserveAspectRatio="none"
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="#ffffff14" />
        ))}
        {series.map((s, i) => {
          const pts: string[] = [];
          for (let k = 0; k < s.v.length; k++) {
            const x = s.v[k]!;
            if (!Number.isFinite(x) || t[k]! < t0 || t[k]! > t1) continue;
            if (step && pts.length) pts.push(`${X(t[k]!)},${pts[pts.length - 1]!.split(',')[1]}`);
            pts.push(`${X(t[k]!)},${Y(x)}`);
          }
          return (
            <polyline
              key={s.name}
              points={pts.join(' ')}
              fill="none"
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <figcaption className="flex flex-wrap justify-between gap-x-2 text-[10px] text-muted-foreground">
        <span>
          {formatSi(lo, unit)} … {formatSi(hi, unit)}
        </span>
        <span>
          {formatSi(t0, 's')} → {formatSi(t1, 's')}
        </span>
        {series.map((s, i) => (
          <span key={s.name} style={{ color: COLORS[i % COLORS.length] }}>
            ■ {s.name}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
