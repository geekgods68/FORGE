import { solidBounds, type Evaluation } from '@forge/components';
import { formatLength } from './format';

/**
 * Lightweight procedural preview: top and front orthographic sketches drawn from the
 * evaluated solids' bounds, with overall dimensions. No WebGL — the catalogue never
 * creates meshes just to show a thumbnail.
 */
export function ComponentSketch({ evaluation, size = 180 }: { evaluation: Evaluation; size?: number }) {
  const [sx, sy, sz] = evaluation.size;
  const { min } = evaluation.bounds;
  const view = (ax: 0 | 2, label: string, h: number) => {
    const w = evaluation.size[0];
    const scale = (size * 0.8) / Math.max(w, h, 1e-6);
    const pad = size * 0.1;
    return (
      <figure className="flex flex-col items-center gap-0.5">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={`${label} view`}
          className="rounded bg-background/60"
        >
          {evaluation.solids.map((s, i) => {
            const b = solidBounds(s);
            const x0 = (b.min[0] - min[0]) * scale + pad;
            const x1 = (b.max[0] - min[0]) * scale + pad;
            const v0 = ax === 2 ? b.min[2] - min[2] : b.min[1] - min[1];
            const v1 = ax === 2 ? b.max[2] - min[2] : b.max[1] - min[1];
            const y0 = size - pad - v1 * scale;
            const y1 = size - pad - v0 * scale;
            const round =
              (s.type === 'cylinder' || s.type === 'tube') &&
              ((ax === 2 && s.axis === 'y') || (ax === 0 && s.axis === 'z'));
            return round ? (
              <ellipse
                key={i}
                cx={(x0 + x1) / 2}
                cy={(y0 + y1) / 2}
                rx={(x1 - x0) / 2}
                ry={(y1 - y0) / 2}
                className="fill-primary/10 stroke-primary/70"
                strokeWidth={1}
              />
            ) : (
              <rect
                key={i}
                x={x0}
                y={y0}
                width={Math.max(0.5, x1 - x0)}
                height={Math.max(0.5, y1 - y0)}
                className="fill-primary/10 stroke-primary/70"
                strokeWidth={1}
              />
            );
          })}
        </svg>
        <figcaption className="text-[10px] text-muted-foreground">
          {label}: {formatLength(w)} × {formatLength(h)}
        </figcaption>
      </figure>
    );
  };
  return (
    <div className="flex gap-2" data-testid="component-sketch" data-size={`${sx},${sy},${sz}`}>
      {view(2, 'Top', sz)}
      {view(0, 'Front', sy)}
    </div>
  );
}
