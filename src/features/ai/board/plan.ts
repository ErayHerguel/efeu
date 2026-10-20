/**
 * Was Claude für ein Board liefert: nur der Inhalt, als garantiert gültiges JSON (Structured Outputs).
 * Das Layout rechnet efeu selbst (layout.ts), damit das Board immer sauber aussieht.
 */

export const NOTE_COLORS = ['yellow', 'pink', 'green', 'blue', 'orange', 'purple', 'gray'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
export type BoardLayout = 'matrix' | 'clusters' | 'flow';

export interface BoardPlan {
  title: string;
  subtitle: string;
  layout: BoardLayout;
  /** Matrix: Spalten (Kriterien) */
  columns: { label: string; color: NoteColor }[];
  /** Matrix: Zeilen (verglichene Dinge); cells[i] = Notizen in Spalte i */
  rows: { label: string; sublabel: string; badge: string; highlight: boolean; cells: string[][] }[];
  /** Cluster: Gruppen von Notizen */
  groups: { label: string; color: NoteColor; notes: string[] }[];
  /** Ablauf: Schritte in Reihenfolge */
  steps: string[];
  /** Wichtigste Erkenntnisse */
  takeaways: string[];
}

const str = { type: 'string' };
const color = { type: 'string', enum: [...NOTE_COLORS] };
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

export const BOARD_SCHEMA = obj({
  title: str,
  subtitle: str,
  layout: { type: 'string', enum: ['matrix', 'clusters', 'flow'] },
  columns: { type: 'array', items: obj({ label: str, color }) },
  rows: {
    type: 'array',
    items: obj({
      label: str,
      sublabel: str,
      badge: str,
      highlight: { type: 'boolean' },
      cells: { type: 'array', items: { type: 'array', items: str } },
    }),
  },
  groups: { type: 'array', items: obj({ label: str, color, notes: { type: 'array', items: str } }) },
  steps: { type: 'array', items: str },
  takeaways: { type: 'array', items: str },
});

/** Für das Clustern vorhandener Post-its: Gruppen aus Nummern der Notizen. */
export interface ClusterPlan {
  groups: { label: string; color: NoteColor; notes: number[] }[];
}

export const CLUSTER_SCHEMA = obj({
  groups: { type: 'array', items: obj({ label: str, color, notes: { type: 'array', items: { type: 'integer' } } }) },
});

/** Begrenzt, was in ein Board passt, und räumt leere Einträge weg (das Modell hält Grenzen nicht immer ein). */
export function normalizePlan(plan: BoardPlan): BoardPlan {
  const clean = (list: string[], max: number) => list.map((s) => s.trim()).filter(Boolean).slice(0, max);
  const columns = plan.columns.slice(0, 6);
  return {
    title: plan.title.trim(),
    subtitle: plan.subtitle.trim(),
    layout: plan.layout,
    columns,
    rows: plan.rows.slice(0, 10).map((r) => ({
      ...r,
      cells: columns.map((_, i) => clean(r.cells[i] ?? [], 6)),
    })),
    groups: plan.groups
      .slice(0, 10)
      .map((g) => ({ ...g, label: g.label.trim(), notes: clean(g.notes, 12) }))
      // Leere Gruppen mit Überschrift bleiben (Vorlagen zum Ausfüllen).
      .filter((g) => g.notes.length || g.label),
    steps: clean(plan.steps, 12),
    takeaways: clean(plan.takeaways, 6),
  };
}
