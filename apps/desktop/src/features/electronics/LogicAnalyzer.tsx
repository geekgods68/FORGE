import { useState, type ReactElement } from 'react';
import { formatSi } from './format';
import { laneStats, type Lane } from './laneStats';

const LANE_H = 26;

/** Logic analyser: recorded transitions only (no interpolation), with timestamps and pulse measurements. */
export function LogicAnalyzer({
  lanes,
  window: [t0, t1],
  testId,
}: {
  lanes: Lane[];
  window: [number, number];
  testId?: string;
}) {
  const [sel, setSel] = useState(0);
  const W = 260;
  const X = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const lane = lanes[Math.min(sel, lanes.length - 1)];
  return (
    <div className="space-y-1" data-testid={testId}>
      <svg
        viewBox={`0 0 ${W + 70} ${lanes.length * LANE_H + 4}`}
        className="w-full rounded border border-border bg-black/40"
      >
        {lanes.map((l, i) => {
          const y0 = i * LANE_H + 4;
          const hi = y0 + 4;
          const lo = y0 + LANE_H - 6;
          const segs: ReactElement[] = [];
          let pts: string[] = [];
          for (let k = 0; k < l.t.length; k++) {
            const a = Math.max(l.t[k]!, t0);
            const b = Math.min(l.t[k + 1] ?? t1, t1);
            if (b < t0 || a > t1 || b <= a) continue;
            const lv = l.level[k]!;
            if (lv === 'X' || lv === 'Z') {
              if (pts.length)
                segs.push(
                  <polyline
                    key={`p${k}`}
                    points={pts.join(' ')}
                    fill="none"
                    stroke="#4ade80"
                    strokeWidth={1.2}
                  />,
                );
              pts = [];
              segs.push(
                <rect
                  key={`r${k}`}
                  x={X(a)}
                  y={hi}
                  width={Math.max(0.5, X(b) - X(a))}
                  height={lo - hi}
                  fill={lv === 'X' ? '#f8717155' : '#a3a3a333'}
                />,
              );
              continue;
            }
            const y = lv === '1' ? hi : lo;
            pts.push(`${X(a)},${y}`, `${X(b)},${y}`);
          }
          if (pts.length)
            segs.push(
              <polyline key="end" points={pts.join(' ')} fill="none" stroke="#4ade80" strokeWidth={1.2} />,
            );
          return (
            <g key={l.name} onClick={() => setSel(i)} style={{ cursor: 'pointer' }}>
              <rect
                x={0}
                y={y0}
                width={W + 70}
                height={LANE_H}
                fill={i === sel ? '#ffffff10' : 'transparent'}
              />
              {segs}
              <text
                x={W + 4}
                y={y0 + LANE_H / 2 + 3}
                fontSize={8}
                fill="#cbd5e1"
                fontFamily="ui-monospace, monospace"
              >
                {l.name.length > 11 ? `${l.name.slice(0, 10)}…` : l.name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{formatSi(t0 / 1e9, 's')}</span>
        <span>{formatSi(t1 / 1e9, 's')}</span>
      </div>
      {lane && (
        <div className="space-y-0.5 text-[11px]" data-testid={testId ? `${testId}-stats` : undefined}>
          {(() => {
            const s = laneStats(lane, t0, t1);
            return (
              <p className="font-mono">
                {lane.name}: high pulse {s.lastHighNs === null ? '—' : formatSi(s.lastHighNs / 1e9, 's', 5)} ·
                period {s.periodNs === null ? '—' : formatSi(s.periodNs / 1e9, 's', 5)} · duty{' '}
                {s.duty === null ? '—' : `${(s.duty * 100).toFixed(2)} %`} · {s.edges} edges
              </p>
            );
          })()}
          <details>
            <summary className="cursor-pointer text-muted-foreground">Timestamps (last 12)</summary>
            <table className="w-full font-mono">
              <tbody>
                {lane.t
                  .map((t, i) => [t, lane.level[i]!] as const)
                  .slice(-12)
                  .map(([t, l], i) => (
                    <tr key={i}>
                      <td>{(t / 1e3).toFixed(3)} µs</td>
                      <td>{l}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
    </div>
  );
}
