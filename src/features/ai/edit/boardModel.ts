import { BOARD_SCHEMA, NOTE_COLORS, type BoardPlan, type NoteColor } from '../board/plan';
import { NOTE_FILL, type Skeleton } from '../board/layout';

/**
 * Boards bearbeiten mit KI: Das Board geht als Liste von Post-its, Texten und Gruppen (Rahmen) an
 * Claude, mit kurzen IDs. Zurück kommen Änderungen an einzelnen Elementen und optional neuer Inhalt.
 */

/** Vereinfachtes Element vom Board (siehe BoardBridge.snapshot) */
export interface BoardEl {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  backgroundColor: string;
  /** Text eines Textelements bzw. eines Post-its (gebundener Text) */
  text?: string;
  /** Textelement in einem Post-it */
  containerId?: string | null;
  /** ID des gebundenen Texts eines Post-its */
  textId?: string | null;
}

export interface BoardModel {
  notes: BoardEl[];
  texts: BoardEl[];
  frames: BoardEl[];
  /** Post-it-ID → Rahmen-ID */
  groupOf: Map<string, string>;
  /** Rahmen-ID → Überschrift (Textelement) */
  titleOf: Map<string, BoardEl>;
  /** Kurz-ID ↔ echte ID */
  short: Map<string, string>;
  long: Map<string, string>;
}

const inside = (el: { x: number; y: number }, f: BoardEl) => el.x >= f.x && el.x <= f.x + f.width && el.y >= f.y && el.y <= f.y + f.height;
const center = (el: BoardEl) => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });

export function buildModel(elements: BoardEl[]): BoardModel {
  const notes = elements.filter((e) => e.textId && e.text?.trim());
  const texts = elements.filter((e) => e.type === 'text' && !e.containerId && e.text?.trim());
  // Rahmen: Formen ohne Text, in denen mindestens ein Post-it liegt.
  const frames = elements
    .filter((e) => (e.type === 'rectangle' || e.type === 'frame') && !e.textId && notes.some((n) => n.id !== e.id && inside(center(n), e)))
    .sort((a, b) => a.width * a.height - b.width * b.height);
  const groupOf = new Map<string, string>();
  for (const n of notes) {
    const frame = frames.find((f) => inside(center(n), f));
    if (frame) groupOf.set(n.id, frame.id);
  }
  const titleOf = new Map<string, BoardEl>();
  for (const f of frames) {
    const title = texts
      .filter((t) => inside(t, f) && t.y - f.y < 90)
      .sort((a, b) => a.y - b.y)[0];
    if (title) titleOf.set(f.id, title);
  }
  const short = new Map<string, string>();
  const long = new Map<string, string>();
  const name = (prefix: string, list: BoardEl[]) =>
    list.forEach((el, i) => {
      short.set(el.id, `${prefix}${i + 1}`);
      long.set(`${prefix}${i + 1}`, el.id);
    });
  const reading = (a: BoardEl, b: BoardEl) => a.y - b.y || a.x - b.x;
  name('n', [...notes].sort(reading));
  name('t', [...texts].sort(reading));
  name('g', [...frames].sort(reading));
  return { notes, texts, frames, groupOf, titleOf, short, long };
}

const hex = (c: string) => {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
};

/** Nächstliegende Post-it-Farbe zu einer Hintergrundfarbe */
export function colorName(background: string): NoteColor | 'andere' {
  const rgb = hex(background);
  if (!rgb) return 'andere';
  let best: NoteColor = 'yellow';
  let dist = Infinity;
  const fills: [NoteColor, string][] = [
    ...(Object.entries(NOTE_FILL) as [NoteColor, string][]),
    // Farben der Sticky-Note-Knöpfe in efeu und der KI-Boards von früher
    ['yellow', '#fff3a3'],
    ['yellow', '#ffec99'],
    ['pink', '#ffc9c9'],
    ['green', '#b2f2bb'],
    ['blue', '#a5d8ff'],
    ['purple', '#d0bfff'],
  ];
  for (const [name, fill] of fills) {
    const f = hex(fill)!;
    const d = f.reduce((s, v, i) => s + (v - rgb[i]) ** 2, 0);
    if (d < dist) {
      dist = d;
      best = name;
    }
  }
  return dist < 3000 ? best : 'andere';
}

const esc = (s: string) => s.replace(/</g, '‹').replace(/\n/g, ' / ');

/** Board als Text für Claude; `focus` = nur diese Elemente (Auswahl), sonst alles. */
export function describeBoard(model: BoardModel, focus: Set<string> | null): string {
  const lines: string[] = [];
  const noteLine = (n: BoardEl, indent: string) =>
    `${indent}<postit id="${model.short.get(n.id)}" farbe="${colorName(n.backgroundColor)}">${esc(n.text ?? '')}</postit>`;
  const wanted = (id: string) => !focus || focus.has(id);
  const titles = new Set([...model.titleOf.values()].map((t) => t.id));
  for (const t of model.texts) if (!titles.has(t.id) && wanted(t.id)) lines.push(`<text id="${model.short.get(t.id)}">${esc(t.text ?? '')}</text>`);
  for (const f of model.frames) {
    const members = model.notes.filter((n) => model.groupOf.get(n.id) === f.id && wanted(n.id));
    if (!members.length && !wanted(f.id)) continue;
    const title = model.titleOf.get(f.id);
    lines.push(`<gruppe id="${model.short.get(f.id)}" titel="${esc(title?.text ?? '')}"${title ? ` titel_id="${model.short.get(title.id)}"` : ''}>`);
    for (const n of members) lines.push(noteLine(n, '  '));
    lines.push('</gruppe>');
  }
  for (const n of model.notes) if (!model.groupOf.has(n.id) && wanted(n.id)) lines.push(noteLine(n, ''));
  return lines.join('\n');
}

/* ---------- Antwort ---------- */

export interface BoardOp {
  op: 'edit' | 'recolor' | 'delete' | 'add';
  /** Kurz-ID eines Post-its, Texts oder einer Gruppe; bei add: wo das neue Post-it hin soll ("" = frei) */
  target: string;
  text: string;
  color: NoteColor | '';
}

export interface BoardEditPlan {
  summary: string;
  ops: BoardOp[];
  create: BoardPlan & { enabled: boolean };
}

const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export const BOARD_EDIT_SCHEMA = obj({
  summary: { type: 'string' },
  ops: {
    type: 'array',
    items: obj({
      op: { type: 'string', enum: ['edit', 'recolor', 'delete', 'add'] },
      target: { type: 'string' },
      text: { type: 'string' },
      color: { type: 'string', enum: [...NOTE_COLORS, ''] },
    }),
  },
  create: obj({ enabled: { type: 'boolean' }, ...(BOARD_SCHEMA.properties as Record<string, unknown>) }),
});

/** Nur Änderungen an Elementen, die es gibt (und die im Fokus liegen). */
export function validBoardOps(ops: BoardOp[], model: BoardModel, focus: Set<string> | null): BoardOp[] {
  const seen = new Set<string>();
  return ops.filter((op) => {
    const id = model.long.get(op.target);
    if (op.op === 'add') return op.text.trim().length > 0 && (!op.target || !!id);
    if (!id || (focus && !focus.has(id) && !op.target.startsWith('g'))) return false;
    const key = `${op.op}:${id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (op.op === 'edit') return op.text.trim().length > 0;
    if (op.op === 'recolor') return !!op.color && op.target.startsWith('n');
    return true;
  });
}

export interface BoardChange {
  kind: 'changed' | 'added' | 'removed' | 'recolored';
  before: string;
  after: string;
  color?: string;
}

export function describeBoardChanges(ops: BoardOp[], model: BoardModel): BoardChange[] {
  const textOf = (shortId: string) => {
    const id = model.long.get(shortId);
    const el = [...model.notes, ...model.texts].find((e) => e.id === id);
    if (el) return el.text ?? '';
    const frame = model.frames.find((f) => f.id === id);
    return frame ? `Gruppe „${model.titleOf.get(frame.id)?.text ?? ''}“` : '';
  };
  return ops.map((op) => {
    if (op.op === 'edit') return { kind: 'changed', before: textOf(op.target), after: op.text };
    if (op.op === 'recolor') return { kind: 'recolored', before: textOf(op.target), after: '', color: NOTE_FILL[op.color as NoteColor] };
    if (op.op === 'delete') return { kind: 'removed', before: textOf(op.target), after: '' };
    return { kind: 'added', before: '', after: op.text, color: op.color ? NOTE_FILL[op.color] : undefined };
  });
}

/* ---------- Anwenden ---------- */

export interface BoardEdits {
  texts: { id: string; text: string }[];
  colors: { id: string; color: string }[];
  deletes: string[];
  /** Rahmen, die für neue Post-its wachsen */
  grow: { id: string; height: number }[];
  /** Neue Post-its als Excalidraw-Skelette */
  add: Skeleton[];
}

const GAP = 12;
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: BoardEl) =>
  a.x < b.x + b.width && a.x + a.w > b.x && a.y < b.y + b.height && a.y + a.h > b.y;

function newNote(x: number, y: number, size: number, text: string, color: NoteColor): Skeleton {
  return {
    type: 'rectangle',
    x,
    y,
    width: size,
    height: size,
    backgroundColor: NOTE_FILL[color],
    strokeColor: 'transparent',
    strokeWidth: 1,
    fillStyle: 'solid',
    roughness: 0,
    roundness: { type: 3 },
    label: { text, fontSize: text.length > 70 ? 14 : 16, fontFamily: 6, textAlign: 'center', verticalAlign: 'middle', strokeColor: '#1e1e1e' },
  };
}

/**
 * Übersetzt Claudes Änderungen in konkrete Board-Änderungen. Neue Post-its landen im Raster ihrer
 * Gruppe (nächste freie Stelle, der Rahmen wächst bei Bedarf) bzw. neben dem Ziel-Post-it.
 */
export function planEdits(ops: BoardOp[], model: BoardModel, all: BoardEl[]): BoardEdits {
  const edits: BoardEdits = { texts: [], colors: [], deletes: [], grow: [], add: [] };
  const byId = new Map(all.map((e) => [e.id, e]));
  const occupied: BoardEl[] = [...model.notes];
  const frameHeight = new Map(model.frames.map((f) => [f.id, f.height]));
  const deleted = new Set<string>();

  for (const op of ops) {
    const id = model.long.get(op.target);
    const el = id ? byId.get(id) : undefined;
    if (op.op === 'edit' && el) {
      // Gruppe umbenennen = ihre Überschrift ändern
      const isFrame = model.frames.some((f) => f.id === el.id);
      const textId = isFrame ? model.titleOf.get(el.id)?.id : (el.textId ?? (el.type === 'text' ? el.id : undefined));
      if (textId) edits.texts.push({ id: textId, text: op.text.trim() });
    } else if (op.op === 'recolor' && el && op.color) {
      edits.colors.push({ id: el.id, color: NOTE_FILL[op.color] });
    } else if (op.op === 'delete' && el) {
      const ids = [el.id, ...(el.textId ? [el.textId] : [])];
      // Eine Gruppe löschen heißt: Rahmen, Überschrift und ihre Post-its.
      if (model.frames.some((f) => f.id === el.id)) {
        const title = model.titleOf.get(el.id);
        if (title) ids.push(title.id);
        for (const n of model.notes) if (model.groupOf.get(n.id) === el.id) ids.push(n.id, ...(n.textId ? [n.textId] : []));
      }
      for (const x of ids) deleted.add(x);
    } else if (op.op === 'add') {
      const color: NoteColor = op.color || (el ? (colorName(el.backgroundColor) as NoteColor) : 'yellow');
      const safeColor = NOTE_COLORS.includes(color as NoteColor) ? color : 'yellow';
      const frame = el ? model.frames.find((f) => f.id === el.id || f.id === model.groupOf.get(el.id)) : undefined;
      const pos = frame ? slotInFrame(frame, model, occupied, frameHeight) : besideOrFree(el, occupied, all);
      edits.add.push(newNote(pos.x, pos.y, pos.size, op.text.trim(), safeColor));
      occupied.push({ id: `neu-${edits.add.length}`, type: 'rectangle', x: pos.x, y: pos.y, width: pos.size, height: pos.size, backgroundColor: '' });
    }
  }
  edits.deletes = [...deleted];
  for (const f of model.frames) if (frameHeight.get(f.id) !== f.height) edits.grow.push({ id: f.id, height: frameHeight.get(f.id)! });
  return edits;
}

function median(values: number[], fallback: number): number {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Nächste freie Stelle im Raster einer Gruppe, zeilenweise; reicht der Platz nicht, wächst der Rahmen. */
function slotInFrame(frame: BoardEl, model: BoardModel, occupied: BoardEl[], frameHeight: Map<string, number>) {
  const members = model.notes.filter((n) => model.groupOf.get(n.id) === frame.id);
  const size = Math.round(median(members.map((n) => n.width), 160));
  const left = members.length ? Math.min(...members.map((n) => n.x)) : frame.x + 20;
  const top = members.length ? Math.min(...members.map((n) => n.y)) : frame.y + 60;
  const columns = Math.max(1, Math.floor((frame.x + frame.width - 20 - left + GAP) / (size + GAP)));
  for (let i = 0; i < 200; i++) {
    const x = left + (i % columns) * (size + GAP);
    const y = top + Math.floor(i / columns) * (size + GAP);
    if (occupied.some((o) => overlaps({ x: x + 1, y: y + 1, w: size - 2, h: size - 2 }, o))) continue;
    const bottom = y + size + 20;
    const height = frameHeight.get(frame.id) ?? frame.height;
    if (bottom > frame.y + height) frameHeight.set(frame.id, bottom - frame.y);
    return { x, y, size };
  }
  return { x: frame.x + frame.width + 40, y: frame.y, size };
}

/** Rechts neben einem Post-it (oder rechts vom ganzen Inhalt) die erste freie Stelle. */
function besideOrFree(target: BoardEl | undefined, occupied: BoardEl[], all: BoardEl[]) {
  const size = target ? Math.round(Math.max(target.width, 120)) : 160;
  let x = target ? target.x + target.width + GAP : Math.max(0, ...all.map((e) => e.x + e.width)) + 120;
  const y = target ? target.y : Math.min(0, ...all.map((e) => e.y));
  for (let i = 0; i < 100 && occupied.some((o) => overlaps({ x: x + 1, y: y + 1, w: size - 2, h: size - 2 }, o)); i++) x += size + GAP;
  return { x, y, size };
}
