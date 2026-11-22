import { useEffect, useRef } from 'react';

/**
 * Minimal time-series plot (canvas, no charting dependency). Values are drawn as given;
 * the caller converts units for display (e.g. rad → °) and states them in the label.
 */
export function TelemetryPlot({
  series,
  label,
  unit,
  testId,
}: {
  series: { t: ArrayLike<number>; v: ArrayLike<number> }[];
  label: string;
  unit: string;
  testId?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const w = cv.width;
    const h = cv.height;
    ctx.clearRect(0, 0, w, h);
    let t0 = Infinity,
      t1 = -Infinity,
      v0 = Infinity,
      v1 = -Infinity;
    for (const s of series)
      for (let i = 0; i < s.t.length; i++) {
        const v = s.v[i]!;
        if (!Number.isFinite(v)) continue;
        t0 = Math.min(t0, s.t[i]!);
        t1 = Math.max(t1, s.t[i]!);
        v0 = Math.min(v0, v);
        v1 = Math.max(v1, v);
      }
    ctx.strokeStyle = '#3f4652';
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    if (!Number.isFinite(t0) || t1 <= t0) {
      ctx.fillStyle = '#8b93a1';
      ctx.font = '11px sans-serif';
      ctx.fillText('No samples yet', 8, h / 2);
      return;
    }
    if (v1 - v0 < 1e-12) {
      v0 -= 1;
      v1 += 1;
    }
    const pad = 4;
    const x = (t: number) => pad + ((t - t0) / (t1 - t0)) * (w - 2 * pad);
    const y = (v: number) => h - pad - ((v - v0) / (v1 - v0)) * (h - 2 * pad);
    const colors = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399'];
    series.forEach((s, k) => {
      ctx.strokeStyle = colors[k % colors.length]!;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.t.length; i++) {
        const v = s.v[i]!;
        if (!Number.isFinite(v)) {
          started = false;
          continue;
        }
        if (started) ctx.lineTo(x(s.t[i]!), y(v));
        else ctx.moveTo(x(s.t[i]!), y(v));
        started = true;
      }
      ctx.stroke();
    });
    ctx.fillStyle = '#c3c9d4';
    ctx.font = '10px sans-serif';
    ctx.fillText(`${v1.toPrecision(4)} ${unit}`, 6, 12);
    ctx.fillText(`${v0.toPrecision(4)} ${unit}`, 6, h - 6);
    ctx.fillText(`${t0.toFixed(2)}–${t1.toFixed(2)} s`, w - 80, h - 6);
  }, [series, unit]);
  return (
    <canvas
      ref={ref}
      width={268}
      height={110}
      role="img"
      aria-label={label}
      data-testid={testId}
      className="w-full rounded bg-background"
    />
  );
}
