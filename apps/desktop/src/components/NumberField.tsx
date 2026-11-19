import { useState } from 'react';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Numeric input that commits on Enter or blur.
 * - While not being edited it shows the current value, rounded for display.
 * - If the user does not change that text, nothing is committed — so display
 *   rounding can never overwrite the precise stored value.
 * - Rejects non-numeric / non-finite / out-of-range input locally (no command is sent).
 */
export function NumberField({
  label,
  value,
  decimals,
  onCommit,
  disabled,
  unit,
  testId,
  min,
}: {
  label: string;
  value: number;
  decimals: number;
  onCommit: (v: number) => void;
  disabled?: boolean;
  unit?: string;
  testId?: string;
  min?: number;
}) {
  const shown = formatNumber(value, decimals);
  /** Text being edited; null when the field simply displays `shown`. */
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const reset = () => {
    setDraft(null);
    setInvalid(false);
  };
  const commit = () => {
    if (draft === null || draft === shown) return reset();
    const v = Number(draft.trim().replace(',', '.'));
    if (draft.trim() === '' || !Number.isFinite(v) || (min !== undefined && v < min)) {
      setInvalid(true);
      return;
    }
    reset();
    onCommit(v);
  };

  return (
    <label className="flex min-w-0 items-center gap-1 text-xs">
      <span className="w-3 shrink-0 text-muted-foreground">{label}</span>
      <input
        aria-label={`${label}${unit ? ` (${unit})` : ''}`}
        data-testid={testId}
        className={cn(
          'h-7 w-full min-w-0 rounded border bg-background/60 px-1.5 text-right font-mono tabular-nums outline-none focus:border-ring disabled:opacity-50',
          invalid ? 'border-destructive' : 'border-border',
        )}
        inputMode="decimal"
        value={draft ?? shown}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            reset();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}
