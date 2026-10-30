import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import getStroke from 'perfect-freehand';
import { create } from 'zustand';

export type InkTool = 'pen' | 'marker' | 'arrow' | 'eraser';
export type InkColor = 'text' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink';

/** Ein Strich, Koordinaten relativ zur linken oberen Ecke des Blocks, an dem er hängt. */
export interface Stroke {
  id: string;
  tool: 'pen' | 'marker' | 'arrow';
  color: InkColor;
  /** Flach: x, y, Druck, x, y, Druck, … (Pfeil: Start und Ende) */
  points: number[];
}

export const INK_COLORS: InkColor[] = ['text', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
export const INK_COLOR_LABELS: Record<InkColor, string> = {
  text: 'Schwarz',
  red: 'Rot',
  orange: 'Orange',
  yellow: 'Gelb',
  green: 'Grün',
  blue: 'Blau',
  purple: 'Lila',
  pink: 'Rosa',
};

/** Zeichenmodus und gewähltes Werkzeug (gilt für die offene Seite). */
export const useInk = create<{ active: boolean; tool: InkTool; color: Record<'pen' | 'marker' | 'arrow', InkColor> }>(() => ({
  active: false,
  tool: 'pen',
  color: { pen: 'text', marker: 'yellow', arrow: 'red' },
}));

export const toggleInk = (on = !useInk.getState().active) => useInk.setState({ active: on });

/** Blöcke der obersten Ebene, an denen Zeichnungen hängen können. */
const INKABLE = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'codeBlock',
  'callout',
  'toggle',
  'table',
  'image',
  'file',
  'columns',
  'mathBlock',
  'horizontalRule',
  'databaseBlock',
  'boardEmbed',
  'pageRef',
];

const MAX_POINTS = 4000;

/** Nur wohlgeformte Striche übernehmen (Inhalt kann von anderen Geräten oder aus alten Ständen stammen). */
export function validStrokes(value: unknown): Stroke[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (s): s is Stroke =>
      !!s &&
      typeof s === 'object' &&
      typeof s.id === 'string' &&
      ['pen', 'marker', 'arrow'].includes(s.tool) &&
      INK_COLORS.includes(s.color) &&
      Array.isArray(s.points) &&
      s.points.length >= 6 &&
      s.points.length <= MAX_POINTS * 3 &&
      s.points.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)),
  );
}

export const strokesOf = (node: PMNode | null | undefined): Stroke[] => validStrokes(node?.attrs.ink);

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    ink: {
      /** Ersetzt die Striche des Blocks an `pos` (leere Liste entfernt die Zeichnung). */
      setInk: (pos: number, strokes: Stroke[]) => ReturnType;
    };
  }
}

/**
 * Zeichnungen als Attribut der Blöcke: Sie wandern mit dem Block, werden mit dem Inhalt gespeichert,
 * abgeglichen und rückgängig gemacht. In HTML erscheinen sie nicht (Kopieren/Export lässt sie weg).
 */
export const Ink = Extension.create({
  name: 'ink',
  addGlobalAttributes() {
    return [
      {
        types: INKABLE,
        attributes: {
          ink: {
            default: null,
            keepOnSplit: false,
            parseHTML: () => null,
            renderHTML: () => ({}),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      // Teilen eines Absatzes (Enter in der Mitte) oder Duplizieren kopiert das Attribut:
      // Jeder Strich bleibt nur am ersten Block, an dem er vorkommt.
      new Plugin({
        key: new PluginKey('inkDedupe'),
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((t) => t.docChanged)) return null;
          const seen = new Set<string>();
          let tr: Transaction | null = null;
          state.doc.forEach((node, pos) => {
            const strokes = strokesOf(node);
            if (!strokes.length) return;
            const kept = strokes.filter((s) => !seen.has(s.id));
            for (const s of strokes) seen.add(s.id);
            if (kept.length !== strokes.length) (tr ??= state.tr).setNodeAttribute(pos, 'ink', kept.length ? kept : null);
          });
          return tr;
        },
      }),
    ];
  },
  addCommands() {
    return {
      setInk:
        (pos, strokes) =>
        ({ tr, state, dispatch }) => {
          const node = state.doc.nodeAt(pos);
          if (!node || !INKABLE.includes(node.type.name)) return false;
          if (dispatch) tr.setNodeAttribute(pos, 'ink', strokes.length ? strokes : null);
          return true;
        },
    };
  },
});

/** Punkte zusammenfassen: sehr nahe Punkte weglassen, Koordinaten runden (spart Platz im Dokument). */
export function simplify(points: number[], minDistance = 1.5): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 3) {
    const x = Math.round(points[i] * 10) / 10;
    const y = Math.round(points[i + 1] * 10) / 10;
    const p = Math.round(points[i + 2] * 100) / 100;
    const n = out.length;
    const last = i + 3 >= points.length;
    if (n && !last && Math.hypot(x - out[n - 3], y - out[n - 2]) < minDistance) continue;
    out.push(x, y, p);
  }
  return out.slice(0, MAX_POINTS * 3);
}

const triples = (points: number[]) => {
  const out: number[][] = [];
  for (let i = 0; i + 2 < points.length; i += 3) out.push([points[i], points[i + 1], points[i + 2]]);
  return out;
};

/** Umriss eines Freihand-Strichs als SVG-Pfad (gefüllt). */
function outlinePath(stroke: Pick<Stroke, 'tool' | 'points'>, done: boolean): string {
  const marker = stroke.tool === 'marker';
  const pts = triples(stroke.points);
  const pressure = pts.some(([, , p]) => p !== 0.5);
  const outline = getStroke(pts, {
    size: marker ? 18 : 3.2,
    thinning: marker ? 0 : pressure ? 0.6 : 0.35,
    smoothing: 0.6,
    streamline: 0.45,
    simulatePressure: !marker && !pressure,
    start: { cap: true },
    end: { cap: true },
    last: done,
  });
  if (!outline.length) return '';
  let d = `M${outline[0][0].toFixed(1)},${outline[0][1].toFixed(1)}`;
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    d += ` Q${x0.toFixed(1)},${y0.toFixed(1)} ${((x0 + x1) / 2).toFixed(1)},${((y0 + y1) / 2).toFixed(1)}`;
  }
  return `${d} Z`;
}

/** Pfeil: Linie und Spitze. */
function arrowPaths(points: number[]): { line: string; head: string } {
  const [x1, y1, , x2, y2] = points;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.min(14, Math.hypot(x2 - x1, y2 - y1) * 0.5);
  const a = angle + Math.PI - 0.45;
  const b = angle + Math.PI + 0.45;
  const head = `M${(x2 + len * Math.cos(a)).toFixed(1)},${(y2 + len * Math.sin(a)).toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)} L${(x2 + len * Math.cos(b)).toFixed(1)},${(y2 + len * Math.sin(b)).toFixed(1)}`;
  return { line: `M${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)}`, head };
}

export interface StrokeShape {
  kind: 'fill' | 'line';
  d: string;
}

/** SVG-Formen eines Strichs. */
export function strokeShapes(stroke: Pick<Stroke, 'tool' | 'points'>, done = true): StrokeShape[] {
  if (stroke.tool === 'arrow') {
    if (stroke.points.length < 6) return [];
    const { line, head } = arrowPaths(stroke.points);
    return [
      { kind: 'line', d: line },
      { kind: 'line', d: head },
    ];
  }
  const d = outlinePath(stroke, done);
  return d ? [{ kind: 'fill', d }] : [];
}

/** Abstand eines Punkts zu einer Strecke. */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Trifft der Punkt (relativ zum Block) den Strich? */
export function hitsStroke(stroke: Stroke, x: number, y: number, radius = 8): boolean {
  const pts = stroke.points;
  const tolerance = radius + (stroke.tool === 'marker' ? 9 : 2);
  if (pts.length === 3) return Math.hypot(pts[0] - x, pts[1] - y) <= tolerance;
  for (let i = 0; i + 5 < pts.length; i += 3) {
    if (segmentDistance(x, y, pts[i], pts[i + 1], pts[i + 3], pts[i + 4]) <= tolerance) return true;
  }
  return false;
}
