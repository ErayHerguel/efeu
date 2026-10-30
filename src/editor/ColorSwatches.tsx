import { Ban } from 'lucide-react';
import { cx } from '../lib/cx';
import { COLORS, COLOR_LABELS, type ColorName } from './colors';

/**
 * Farbauswahl als Reihe kleiner Felder. kind 'text': Buchstabe in der Farbe, 'bg': Fläche in der Farbe.
 * null entfernt die Farbe.
 */
export function ColorSwatches({
  kind,
  value,
  onPick,
}: {
  kind: 'text' | 'bg';
  value: ColorName | null;
  onPick: (color: ColorName | null) => void;
}) {
  const swatch = 'flex h-6 w-6 items-center justify-center rounded-md border text-xs font-semibold';
  return (
    <div className="flex flex-wrap gap-1">
      <button
        title={kind === 'text' ? 'Standardfarbe' : 'Kein Hintergrund'}
        aria-label={kind === 'text' ? 'Standardfarbe' : 'Kein Hintergrund'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(null)}
        className={cx(swatch, 'text-faint', value === null ? 'border-accent' : 'border-border hover:border-border-strong')}
      >
        {kind === 'text' ? <span className="text-text">A</span> : <Ban size={12} />}
      </button>
      {COLORS.map((color) => (
        <button
          key={color}
          title={COLOR_LABELS[color]}
          aria-label={`${kind === 'text' ? 'Textfarbe' : 'Hintergrund'} ${COLOR_LABELS[color]}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(color)}
          style={kind === 'text' ? { color: `var(--c-tag-${color}-fg)` } : { background: `var(--c-tag-${color}-bg)` }}
          className={cx(swatch, value === color ? 'border-accent' : 'border-border hover:border-border-strong')}
        >
          {kind === 'text' ? 'A' : null}
        </button>
      ))}
    </div>
  );
}
