import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import getStroke from 'perfect-freehand';
import { create } from 'zustand';

export type InkTool = 'select' | 'pen' | 'marker' | 'arrow' | 'text' | 'eraser';
export type InkColor = 'text' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink';
export type ArrowHeads = 'end' | 'both' | 'none';
export type TextSize = 's' | 'm' | 'l';
/** Werkzeuge mit eigener Farbe */
export type ColorTool = 'pen' | 'marker' | 'arrow' | 'text';

/**
 * Ein Element der Zeichnung, Koordinaten relativ zur linken oberen Ecke des Blocks, an dem es hängt.
 * Freihand: Punkte mit Druck; Pfeil: Start und Ende, optional gebogen; Text: Position oben links.
 */
export interface Stroke {
  id: string;
  tool: 'pen' | 'marker' | 'arrow' | 'text';
  color: InkColor;
  /** Flach: x, y, Druck, x, y, Druck, … (Pfeil: Start und Ende; Text: nur die Position) */
  points: number[];
  /** Pfeil: Punkt, durch den die Kurve in der Mitte läuft (fehlt = gerade) */
  bend?: [number, number] | null;
  heads?: ArrowHeads;
  dash?: boolean;
  text?: string;
  size?: TextSize;
  hand?: boolean;
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

/** Zeichenmodus, Werkzeug und Einstellungen (gelten für die offene Seite). */
export const useInk = create<{
  active: boolean;
  tool: InkTool;
  color: Record<ColorTool, InkColor>;
  heads: ArrowHeads;
  dash: boolean;
  size: TextSize;
  hand: boolean;
}>(() => ({
  active: false,
  tool: 'pen',
  color: { pen: 'text', marker: 'yellow', arrow: 'red', text: 'text' },
  heads: 'end',
  dash: false,
  size: 'm',
  hand: false,
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

const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);

function validStroke(s: Record<string, unknown>): boolean {
  if (typeof s.id !== 'string' || !INK_COLORS.includes(s.color as InkColor) || !Array.isArray(s.points)) return false;
  const points = s.points as unknown[];
  if (!points.every(finite) || points.length > MAX_POINTS * 3) return false;
  switch (s.tool) {
    case 'pen':
    case 'marker':
      return points.length >= 6;
    case 'arrow':
      return (
        points.length === 6 &&
        (s.bend == null || (Array.isArray(s.bend) && s.bend.length === 2 && s.bend.every(finite))) &&
        (s.heads === undefined || ['end', 'both', 'none'].includes(s.heads as string)) &&
        (s.dash === undefined || typeof s.dash === 'boolean')
      );
    case 'text':
      return (
        points.length >= 3 &&
        typeof s.text === 'string' &&
        s.text.length <= 5000 &&
        (s.size === undefined || ['s', 'm', 'l'].includes(s.size as string)) &&
        (s.hand === undefined || typeof s.hand === 'boolean')
      );
    default:
      return false;
  }
}

/** Nur wohlgeformte Elemente übernehmen (Inhalt kann von anderen Geräten oder aus alten Ständen stammen). */
export function validStrokes(value: unknown): Stroke[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is Stroke => !!s && typeof s === 'object' && validStroke(s as Record<string, unknown>));
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

const f = (n: number) => n.toFixed(1);

/** Kontrollpunkt der quadratischen Kurve, die durch `bend` in der Mitte läuft. */
export function controlPoint(stroke: Pick<Stroke, 'points' | 'bend'>): [number, number] {
  const [x1, y1, , x2, y2] = stroke.points;
  if (!stroke.bend) return [(x1 + x2) / 2, (y1 + y2) / 2];
  return [2 * stroke.bend[0] - (x1 + x2) / 2, 2 * stroke.bend[1] - (y1 + y2) / 2];
}

/** Punkt in der Mitte des Pfeils (Anfasser zum Biegen). */
export function arrowMid(stroke: Pick<Stroke, 'points' | 'bend'>): [number, number] {
  const [x1, y1, , x2, y2] = stroke.points;
  return stroke.bend ?? [(x1 + x2) / 2, (y1 + y2) / 2];
}

function head(tipX: number, tipY: number, fromX: number, fromY: number, length: number): string {
  const angle = Math.atan2(tipY - fromY, tipX - fromX);
  const a = angle + Math.PI - 0.45;
  const b = angle + Math.PI + 0.45;
  return `M${f(tipX + length * Math.cos(a))},${f(tipY + length * Math.sin(a))} L${f(tipX)},${f(tipY)} L${f(tipX + length * Math.cos(b))},${f(tipY + length * Math.sin(b))}`;
}

/** Pfeil: Linie (gerade oder gebogen) und Spitzen. */
function arrowPaths(stroke: Pick<Stroke, 'points' | 'bend' | 'heads'>): string[] {
  const [x1, y1, , x2, y2] = stroke.points;
  const [cx, cy] = controlPoint(stroke);
  const line = stroke.bend ? `M${f(x1)},${f(y1)} Q${f(cx)},${f(cy)} ${f(x2)},${f(y2)}` : `M${f(x1)},${f(y1)} L${f(x2)},${f(y2)}`;
  const length = Math.min(14, Math.hypot(x2 - x1, y2 - y1) * 0.5);
  const heads = stroke.heads ?? 'end';
  const out = [line];
  if (heads !== 'none') out.push(head(x2, y2, cx, cy, length));
  if (heads === 'both') out.push(head(x1, y1, cx, cy, length));
  return out;
}

export interface StrokeShape {
  kind: 'fill' | 'line';
  d: string;
}

/** SVG-Formen eines Strichs (Text wird als HTML gezeigt, nicht hier). */
export function strokeShapes(stroke: Pick<Stroke, 'tool' | 'points' | 'bend' | 'heads'>, done = true): StrokeShape[] {
  if (stroke.tool === 'text') return [];
  if (stroke.tool === 'arrow') {
    if (stroke.points.length < 6) return [];
    return arrowPaths(stroke).map((d) => ({ kind: 'line', d }));
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

/** Linienzug eines Elements (Pfeil: Kurve in Stücken), für Treffer und Rahmen. */
export function polyline(stroke: Pick<Stroke, 'tool' | 'points' | 'bend'>): number[] {
  if (stroke.tool !== 'arrow' || !stroke.bend) return stroke.points;
  const [x1, y1, , x2, y2] = stroke.points;
  const [cx, cy] = controlPoint(stroke);
  const out: number[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const u = 1 - t;
    out.push(u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2, 0.5);
  }
  return out;
}

/** Trifft der Punkt (relativ zum Block) den Strich? Text wird über seinen Rahmen geprüft. */
export function hitsStroke(stroke: Stroke, x: number, y: number, radius = 8): boolean {
  const pts = polyline(stroke);
  const tolerance = radius + (stroke.tool === 'marker' ? 9 : 2);
  if (pts.length === 3) return Math.hypot(pts[0] - x, pts[1] - y) <= tolerance;
  for (let i = 0; i + 5 < pts.length; i += 3) {
    if (segmentDistance(x, y, pts[i], pts[i + 1], pts[i + 3], pts[i + 4]) <= tolerance) return true;
  }
  return false;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Rahmen eines Strichs (ohne Text, dessen Größe kennt nur das DOM). */
export function strokeBox(stroke: Stroke): Box {
  const pts = polyline(stroke);
  const pad = stroke.tool === 'marker' ? 9 : 3;
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (let i = 0; i + 1 < pts.length; i += 3) {
    box.left = Math.min(box.left, pts[i] - pad);
    box.right = Math.max(box.right, pts[i] + pad);
    box.top = Math.min(box.top, pts[i + 1] - pad);
    box.bottom = Math.max(box.bottom, pts[i + 1] + pad);
  }
  return box;
}

/** Verschiebt ein Element um dx, dy (Punkte und Biegung). */
export function moveStroke(stroke: Stroke, dx: number, dy: number): Stroke {
  const points = stroke.points.map((n, i) => (i % 3 === 0 ? Math.round((n + dx) * 10) / 10 : i % 3 === 1 ? Math.round((n + dy) * 10) / 10 : n));
  return { ...stroke, points, ...(stroke.bend ? { bend: [stroke.bend[0] + dx, stroke.bend[1] + dy] as [number, number] } : {}) };
}

export const TEXT_SIZES: Record<TextSize, number> = { s: 14, m: 18, l: 26 };
