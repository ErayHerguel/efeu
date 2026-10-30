import type { Editor } from '@tiptap/core';
import {
  Eraser,
  Highlighter,
  Minus,
  MousePointer2,
  MoveHorizontal,
  MoveRight,
  MoveUpRight,
  PenLine,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx';
import { newId } from '../../lib/ids';
import {
  arrowMid,
  hitsStroke,
  INK_COLOR_LABELS,
  INK_COLORS,
  moveStroke,
  simplify,
  strokeBox,
  strokeShapes,
  strokesOf,
  TEXT_SIZES,
  toggleInk,
  useInk,
  type ArrowHeads,
  type Box,
  type ColorTool,
  type InkColor,
  type InkTool,
  type Stroke,
  type TextSize,
} from './ink';

/** Ein Block der obersten Ebene mit Lage relativ zum Editor und seinen Elementen. */
interface Placed {
  pos: number;
  x: number;
  y: number;
  bottom: number;
  strokes: Stroke[];
}

/** Wie weit man links und rechts neben dem Text noch zeichnen kann. */
const GUTTER = 48;
/** Greifradius der Anfasser am Pfeil */
const HANDLE = 9;

function measure(editor: Editor, wrapper: HTMLElement): Placed[] {
  if (editor.isDestroyed) return [];
  const base = wrapper.getBoundingClientRect();
  const out: Placed[] = [];
  editor.state.doc.forEach((node, offset) => {
    const dom = editor.view.nodeDOM(offset);
    if (!(dom instanceof HTMLElement)) return;
    const r = dom.getBoundingClientRect();
    out.push({ pos: offset, x: r.left - base.left, y: r.top - base.top, bottom: r.bottom - base.top, strokes: strokesOf(node) });
  });
  return out;
}

/** Block, an dem ein neues Element bei Höhe y hängt: der Block an dieser Stelle, sonst der nächstgelegene. */
function anchorAt(blocks: Placed[], y: number): Placed | null {
  let best: Placed | null = null;
  let distance = Infinity;
  for (const b of blocks) {
    const d = y < b.y ? b.y - y : y > b.bottom ? y - b.bottom : 0;
    if (d < distance) {
      best = b;
      distance = d;
    }
  }
  return best;
}

const colorVar = (color: InkColor) => (color === 'text' ? 'var(--c-text)' : `var(--ink-${color})`);
const isColorTool = (tool: InkTool): tool is ColorTool => tool !== 'select' && tool !== 'eraser';
const intersects = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function StrokeView({ stroke, done = true }: { stroke: Stroke; done?: boolean }) {
  const color = colorVar(stroke.color);
  return (
    <g className={stroke.tool === 'marker' ? 'ink-marker' : undefined}>
      {strokeShapes(stroke, done).map((shape, i) =>
        shape.kind === 'fill' ? (
          <path key={i} d={shape.d} fill={color} />
        ) : (
          <path
            key={i}
            d={shape.d}
            fill="none"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={stroke.dash && i === 0 ? '7 7' : undefined}
          />
        ),
      )}
    </g>
  );
}

/** Laufende Geste mit Maus, Stift oder Finger. */
type Gesture =
  | { kind: 'draw'; stroke: Stroke; anchor: Placed }
  | { kind: 'erase' }
  | { kind: 'move'; x: number; y: number; ids: Set<string> }
  | { kind: 'handle'; id: string; which: 'start' | 'end' | 'bend' }
  | { kind: 'marquee'; x: number; y: number };

/** Gerade bearbeitetes Textfeld (id null = neu). */
interface TextEdit {
  id: string | null;
  pos: number;
  x: number;
  y: number;
  text: string;
  color: InkColor;
  size: TextSize;
  hand: boolean;
}

/**
 * Zeichnungen über dem Text. Ohne Zeichenmodus nur sichtbar (Klicks gehen an den Text),
 * im Zeichenmodus fängt eine Fläche über der Seite Stift, Maus und Finger ab.
 */
export function InkLayer({ editor, wrapper }: { editor: Editor; wrapper: RefObject<HTMLDivElement | null> }) {
  const [blocks, setBlocks] = useState<Placed[]>([]);
  const [preview, setPreview] = useState<{ stroke: Stroke; anchor: Placed } | null>(null);
  const [erased, setErasedState] = useState<Set<string>>(new Set());
  const [selected, setSelectedState] = useState<Set<string>>(new Set());
  const selectedRef = useRef<Set<string>>(new Set());
  const setSelected = (next: Set<string>) => {
    selectedRef.current = next;
    setSelectedState(next);
  };
  const [moveBy, setMoveBy] = useState<{ dx: number; dy: number } | null>(null);
  const [override, setOverrideState] = useState<Stroke | null>(null);
  const [marquee, setMarqueeState] = useState<Box | null>(null);
  const [editing, setEditing] = useState<TextEdit | null>(null);
  const { active, tool } = useInk();
  const [editable, setEditable] = useState(editor.isEditable);
  const gesture = useRef<Gesture | null>(null);
  const blocksRef = useRef<Placed[]>([]);
  const textEls = useRef(new Map<string, HTMLElement>());
  const frame = useRef(0);
  // Zwischenstände der Geste auch als Ref: Loslassen kann im selben Moment wie die letzte Bewegung kommen.
  const erasedRef = useRef<Set<string>>(new Set());
  const overrideRef = useRef<Stroke | null>(null);
  const marqueeRef = useRef<Box | null>(null);
  const setErased = (next: Set<string>) => {
    erasedRef.current = next;
    setErasedState(next);
  };
  const setOverride = (next: Stroke | null) => {
    overrideRef.current = next;
    setOverrideState(next);
  };
  const setMarquee = (next: Box | null) => {
    marqueeRef.current = next;
    setMarqueeState(next);
  };

  const remeasure = useCallback(() => {
    if (!wrapper.current) return;
    const next = measure(editor, wrapper.current);
    blocksRef.current = next;
    setBlocks(next);
  }, [editor, wrapper]);

  useLayoutEffect(() => {
    remeasure();
    const onTransaction = () => {
      setEditable(editor.isEditable);
      remeasure();
    };
    editor.on('transaction', onTransaction);
    const observer = new ResizeObserver(() => remeasure());
    if (wrapper.current) observer.observe(wrapper.current);
    window.addEventListener('resize', remeasure);
    return () => {
      editor.off('transaction', onTransaction);
      observer.disconnect();
      window.removeEventListener('resize', remeasure);
    };
  }, [editor, wrapper, remeasure]);

  // Zeichenmodus endet beim Verlassen der Seite.
  useEffect(() => () => toggleInk(false), []);

  const drawingMode = active && editable;

  // Beim ersten Zeichnen ist der Editor oft noch ohne Transaktion: Lage sicher frisch messen.
  useEffect(() => {
    const timer = window.setTimeout(remeasure, 0);
    return () => window.clearTimeout(timer);
  }, [remeasure, drawingMode]);

  /** Element samt Block zu einer Kennung. */
  const find = (id: string): { block: Placed; stroke: Stroke } | null => {
    for (const block of blocksRef.current) {
      const stroke = block.strokes.find((s) => s.id === id);
      if (stroke) return { block, stroke };
    }
    return null;
  };

  /** Ersetzt Elemente (null = löschen), fügt neue an und speichert alles in einem Schritt (ein ⌘Z). */
  const commit = (changes: Map<string, Stroke | null>, added: { pos: number; stroke: Stroke }[] = []) => {
    const byPos = new Map<number, Stroke[]>();
    const touch = (pos: number) => {
      if (!byPos.has(pos)) byPos.set(pos, strokesOf(editor.state.doc.nodeAt(pos)));
      return byPos.get(pos)!;
    };
    for (const [id, next] of changes) {
      const found = find(id);
      if (!found) continue;
      const list = touch(found.block.pos);
      const index = list.findIndex((s) => s.id === id);
      if (index === -1) continue;
      if (next) list[index] = next;
      else list.splice(index, 1);
    }
    for (const { pos, stroke } of added) touch(pos).push(stroke);
    if (!byPos.size) return;
    const chain = editor.chain();
    for (const [pos, list] of byPos) chain.setInk(pos, list);
    chain.run();
  };

  /** Rahmen eines Elements relativ zum Editor. */
  const boxOf = (block: Placed, stroke: Stroke): Box => {
    if (stroke.tool === 'text') {
      const el = textEls.current.get(stroke.id);
      const base = wrapper.current?.getBoundingClientRect();
      if (el && base) {
        const r = el.getBoundingClientRect();
        return { left: r.left - base.left, top: r.top - base.top, right: r.right - base.left, bottom: r.bottom - base.top };
      }
      const [x, y] = stroke.points;
      return { left: block.x + x, top: block.y + y, right: block.x + x + 40, bottom: block.y + y + 24 };
    }
    const b = strokeBox(stroke);
    return { left: b.left + block.x, top: b.top + block.y, right: b.right + block.x, bottom: b.bottom + block.y };
  };

  /** Oberstes Element an einem Punkt. */
  const hitAt = (x: number, y: number): { block: Placed; stroke: Stroke } | null => {
    for (const block of [...blocksRef.current].reverse()) {
      for (const stroke of [...block.strokes].reverse()) {
        if (stroke.tool === 'text') {
          const b = boxOf(block, stroke);
          if (x >= b.left - 4 && x <= b.right + 4 && y >= b.top - 4 && y <= b.bottom + 4) return { block, stroke };
        } else if (hitsStroke(stroke, x - block.x, y - block.y)) return { block, stroke };
      }
    }
    return null;
  };

  /** Ist genau ein Pfeil ausgewählt? Dann zeigt er Anfasser. */
  const singleArrow = () => {
    const current = selectedRef.current;
    if (current.size !== 1) return null;
    const found = find([...current][0]);
    return found?.stroke.tool === 'arrow' ? found : null;
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const base = wrapper.current!.getBoundingClientRect();
    return { x: e.clientX - base.left, y: e.clientY - base.top };
  };

  // Werkzeugwechsel oder Modus aus: Auswahl aufheben.
  useEffect(() => {
    if (tool !== 'select' || !drawingMode) setSelected(new Set());
  }, [tool, drawingMode]);

  /** Einstellungen der Leiste (Farbe, Spitzen, Strich, Größe, Handschrift) auf die Auswahl anwenden. */
  useEffect(() =>
    useInk.subscribe((state, prev) => {
      if (!selected.size || state.tool !== 'select') return;
      const changedColor = (Object.keys(state.color) as ColorTool[]).find((k) => state.color[k] !== prev.color[k]);
      const changes = new Map<string, Stroke | null>();
      for (const id of selected) {
        const found = find(id);
        if (!found) continue;
        const s = found.stroke;
        let next: Stroke = s;
        if (changedColor) next = { ...next, color: state.color[changedColor] };
        if (s.tool === 'arrow' && state.heads !== prev.heads) next = { ...next, heads: state.heads };
        if (s.tool === 'arrow' && state.dash !== prev.dash) next = { ...next, dash: state.dash };
        if (s.tool === 'text' && state.size !== prev.size) next = { ...next, size: state.size };
        if (s.tool === 'text' && state.hand !== prev.hand) next = { ...next, hand: state.hand };
        if (next !== s) changes.set(id, next);
      }
      if (changes.size) commit(changes);
    }),
  );

  const startText = (edit: TextEdit) => {
    setSelected(new Set());
    setEditing(edit);
  };

  const finishText = (edit: TextEdit | null) => {
    setEditing(null);
    if (!edit) return;
    const text = edit.text.replace(/\s+$/, '');
    if (edit.id) {
      const found = find(edit.id);
      if (found) commit(new Map([[edit.id, text ? { ...found.stroke, text } : null]]));
    } else if (text.trim()) {
      const stroke: Stroke = { id: newId(), tool: 'text', color: edit.color, points: [edit.x, edit.y, 0.5], text, size: edit.size, hand: edit.hand };
      commit(new Map(), [{ pos: edit.pos, stroke }]);
    }
  };

  // Tastatur: Löschen, Duplizieren, Esc.
  useEffect(() => {
    if (!drawingMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (editing || (e.target instanceof HTMLElement && e.target.closest('textarea, input'))) return;
      if (e.key === 'Escape') {
        if (gesture.current) return;
        e.preventDefault();
        if (selected.size) setSelected(new Set());
        else toggleInk(false);
        return;
      }
      if (!selected.size) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        commit(new Map([...selected].map((id) => [id, null])));
        setSelected(new Set());
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        e.stopPropagation();
        const added: { pos: number; stroke: Stroke }[] = [];
        for (const id of selected) {
          const found = find(id);
          if (found) added.push({ pos: found.block.pos, stroke: { ...moveStroke(found.stroke, 16, 16), id: newId() } });
        }
        commit(new Map(), added);
        setSelected(new Set(added.map((a) => a.stroke.id)));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const erase = (x: number, y: number) => {
    const before = erasedRef.current;
    const next = new Set(before);
    for (const b of blocksRef.current) {
      for (const s of b.strokes) {
        if (next.has(s.id)) continue;
        const hit = s.tool === 'text' ? hitAt(x, y)?.stroke.id === s.id : hitsStroke(s, x - b.x, y - b.y);
        if (hit) next.add(s.id);
      }
    }
    if (next.size !== before.size) setErased(next);
  };

  const editText = (block: Placed, s: Stroke) =>
    startText({ id: s.id, pos: block.pos, x: s.points[0], y: s.points[1], text: s.text ?? '', color: s.color, size: s.size ?? 'm', hand: !!s.hand });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !wrapper.current) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ohne Zeiger-Fang geht das Zeichnen trotzdem, nur nicht über den Fensterrand hinaus.
    }
    remeasure();
    const { x, y } = local(e);
    const state = useInk.getState();
    if (editing) {
      // Klick daneben übernimmt das offene Textfeld; mit dem Textwerkzeug entsteht dabei kein neues.
      finishText(editing);
      if (tool === 'text') return;
    }

    if (tool === 'eraser') {
      gesture.current = { kind: 'erase' };
      erase(x, y);
      return;
    }

    if (tool === 'text') {
      const hit = hitAt(x, y);
      if (hit?.stroke.tool === 'text') return editText(hit.block, hit.stroke);
      const anchor = anchorAt(blocksRef.current, y);
      if (!anchor) return;
      const lift = TEXT_SIZES[state.size] * 0.7;
      startText({ id: null, pos: anchor.pos, x: x - anchor.x, y: y - anchor.y - lift, text: '', color: state.color.text, size: state.size, hand: state.hand });
      return;
    }

    if (tool === 'select') {
      const arrow = singleArrow();
      if (arrow) {
        const [x1, y1, , x2, y2] = arrow.stroke.points;
        const [mx, my] = arrowMid(arrow.stroke);
        const near = (px: number, py: number) => Math.hypot(px + arrow.block.x - x, py + arrow.block.y - y) <= HANDLE;
        const which = near(mx, my) ? 'bend' : near(x1, y1) ? 'start' : near(x2, y2) ? 'end' : null;
        if (which) {
          gesture.current = { kind: 'handle', id: arrow.stroke.id, which };
          return;
        }
      }
      const hit = hitAt(x, y);
      if (hit) {
        let ids = selectedRef.current;
        if (!ids.has(hit.stroke.id)) {
          ids = e.shiftKey ? new Set([...ids, hit.stroke.id]) : new Set([hit.stroke.id]);
          setSelected(ids);
        }
        gesture.current = { kind: 'move', x, y, ids };
        return;
      }
      if (!e.shiftKey) setSelected(new Set());
      gesture.current = { kind: 'marquee', x, y };
      setMarquee({ left: x, top: y, right: x, bottom: y });
      return;
    }

    const anchor = anchorAt(blocksRef.current, y);
    if (!anchor) return;
    const pressure = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5;
    const stroke: Stroke = {
      id: newId(),
      tool,
      color: state.color[tool],
      points: [x - anchor.x, y - anchor.y, pressure],
      ...(tool === 'arrow' ? { heads: state.heads, ...(state.dash ? { dash: true } : {}) } : {}),
    };
    gesture.current = { kind: 'draw', stroke, anchor };
    setPreview({ stroke, anchor });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    const { x, y } = local(e);
    switch (g.kind) {
      case 'erase':
        erase(x, y);
        return;
      case 'move':
        setMoveBy({ dx: x - g.x, dy: y - g.y });
        return;
      case 'marquee':
        setMarquee({ left: Math.min(g.x, x), top: Math.min(g.y, y), right: Math.max(g.x, x), bottom: Math.max(g.y, y) });
        return;
      case 'handle': {
        const found = find(g.id);
        if (!found) return;
        const px = x - found.block.x;
        const py = y - found.block.y;
        const s = found.stroke;
        const points = [...s.points];
        let bend = s.bend ?? null;
        if (g.which === 'start') [points[0], points[1]] = [px, py];
        else if (g.which === 'end') [points[3], points[4]] = [px, py];
        else {
          // Nahe an der Geraden: wieder gerade.
          const mid = [(s.points[0] + s.points[3]) / 2, (s.points[1] + s.points[4]) / 2];
          bend = Math.hypot(px - mid[0], py - mid[1]) < 6 ? null : [px, py];
        }
        if (g.which !== 'bend' && s.bend) {
          // Beim Ziehen eines Endes wandert die Biegung mit der Mitte mit.
          const oldMid = [(s.points[0] + s.points[3]) / 2, (s.points[1] + s.points[4]) / 2];
          const newMid = [(points[0] + points[3]) / 2, (points[1] + points[4]) / 2];
          bend = [s.bend[0] + newMid[0] - oldMid[0], s.bend[1] + newMid[1] - oldMid[1]];
        }
        setOverride({ ...s, points, bend });
        return;
      }
      case 'draw': {
        const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
        for (const ev of events.length ? events : [e.nativeEvent]) {
          const p = local(ev);
          const point = [p.x - g.anchor.x, p.y - g.anchor.y, ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5];
          if (g.stroke.tool === 'arrow') g.stroke.points = [...g.stroke.points.slice(0, 3), ...point];
          else g.stroke.points.push(...point);
        }
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => setPreview({ stroke: { ...g.stroke }, anchor: g.anchor }));
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    cancelAnimationFrame(frame.current);
    if (!g) return;
    switch (g.kind) {
      case 'erase':
        commit(new Map([...erasedRef.current].map((id) => [id, null])));
        setErased(new Set());
        return;
      case 'move': {
        const { x, y } = local(e);
        const dx = x - g.x;
        const dy = y - g.y;
        setMoveBy(null);
        if (Math.hypot(dx, dy) < 2) return;
        const changes = new Map<string, Stroke | null>();
        for (const id of g.ids) {
          const found = find(id);
          if (found) changes.set(id, moveStroke(found.stroke, dx, dy));
        }
        commit(changes);
        return;
      }
      case 'marquee': {
        const box = marqueeRef.current;
        setMarquee(null);
        if (!box || (box.right - box.left < 3 && box.bottom - box.top < 3)) return;
        const ids = new Set(e.shiftKey ? selectedRef.current : []);
        for (const block of blocksRef.current) for (const s of block.strokes) if (intersects(boxOf(block, s), box)) ids.add(s.id);
        setSelected(ids);
        return;
      }
      case 'handle': {
        const next = overrideRef.current;
        if (next) commit(new Map([[next.id, next]]));
        setOverride(null);
        return;
      }
      case 'draw': {
        setPreview(null);
        const stroke = g.stroke;
        let points = stroke.points;
        if (stroke.tool === 'arrow') {
          if (points.length < 6 || Math.hypot(points[3] - points[0], points[4] - points[1]) < 6) return;
        } else {
          // Ein einzelner Tipp wird zum Punkt.
          if (points.length === 3) points = [...points, points[0] + 0.5, points[1] + 0.5, points[2]];
          points = simplify(points);
        }
        if (!editor.state.doc.nodeAt(g.anchor.pos)) return;
        commit(new Map(), [{ pos: g.anchor.pos, stroke: { ...stroke, points } }]);
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool !== 'select' || !wrapper.current) return;
    const { x, y } = local(e);
    const hit = hitAt(x, y);
    if (hit?.stroke.tool === 'text') editText(hit.block, hit.stroke);
  };

  /** Wie ein Element gerade gezeigt wird (verschoben, gezogen, ausgeblendet). */
  const shown = (s: Stroke): Stroke | null => {
    if (erased.has(s.id) || editing?.id === s.id) return null;
    if (override?.id === s.id) return override;
    if (moveBy && selected.has(s.id)) return moveStroke(s, moveBy.dx, moveBy.dy);
    return s;
  };

  const arrow = singleArrow();
  const arrowShown = arrow ? (shown(arrow.stroke) ?? arrow.stroke) : null;
  const selection = [...selected].map((id) => find(id)?.stroke).filter((s): s is Stroke => !!s);

  return (
    <>
      <svg className="ink-layer" aria-hidden="true">
        {blocks.map((b) => {
          const list = b.strokes.map(shown).filter((s): s is Stroke => !!s && s.tool !== 'text');
          return list.length ? (
            <g key={b.pos} transform={`translate(${b.x} ${b.y})`}>
              {list.map((s) => (
                <StrokeView key={s.id} stroke={s} />
              ))}
            </g>
          ) : null;
        })}
        {preview && (
          <g transform={`translate(${preview.anchor.x} ${preview.anchor.y})`}>
            <StrokeView stroke={preview.stroke} done={false} />
          </g>
        )}
        {drawingMode &&
          blocks.flatMap((b) =>
            b.strokes
              .filter((s) => selected.has(s.id))
              .map((s) => {
                const box = boxOf(b, shown(s) ?? s);
                return <rect key={`sel-${s.id}`} className="ink-selection" x={box.left - 4} y={box.top - 4} width={box.right - box.left + 8} height={box.bottom - box.top + 8} />;
              }),
          )}
        {drawingMode && arrow && arrowShown && (
          <g transform={`translate(${arrow.block.x} ${arrow.block.y})`}>
            {[[arrowShown.points[0], arrowShown.points[1]], [arrowShown.points[3], arrowShown.points[4]], arrowMid(arrowShown)].map(([hx, hy], i) => (
              <circle key={i} className={cx('ink-handle', i === 2 && 'is-bend')} cx={hx} cy={hy} r={5.5} />
            ))}
          </g>
        )}
        {marquee && <rect className="ink-marquee" x={marquee.left} y={marquee.top} width={marquee.right - marquee.left} height={marquee.bottom - marquee.top} />}
      </svg>
      <div className="ink-texts">
        {blocks.flatMap((b) =>
          b.strokes
            .map(shown)
            .filter((s): s is Stroke => !!s && s.tool === 'text')
            .map((s) => (
              <div
                key={s.id}
                ref={(el) => {
                  if (el) textEls.current.set(s.id, el);
                  else textEls.current.delete(s.id);
                }}
                className={cx('ink-text', s.hand && 'is-hand')}
                style={{ left: b.x + s.points[0], top: b.y + s.points[1], color: colorVar(s.color), fontSize: TEXT_SIZES[s.size ?? 'm'] }}
              >
                {s.text}
              </div>
            )),
        )}
      </div>
      {drawingMode && (
        <div
          className={cx('ink-capture', `is-${tool}`)}
          style={{ left: -GUTTER, right: -GUTTER }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
        />
      )}
      {editing && (
        <TextField
          edit={editing}
          block={blocks.find((b) => b.pos === editing.pos) ?? null}
          onChange={(text) => setEditing((prev) => (prev ? { ...prev, text } : prev))}
          onDone={() => finishText(editing)}
        />
      )}
      {drawingMode && createPortal(<InkToolbar selection={selection} />, document.body)}
    </>
  );
}

/** Eingabefeld für ein schwebendes Textfeld, wächst mit dem Inhalt. */
function TextField({ edit, block, onChange, onDone }: { edit: TextEdit; block: Placed | null; onChange: (text: string) => void; onDone: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.width = '0px';
    el.style.height = '0px';
    el.style.width = `${Math.max(el.scrollWidth + 4, 40)}px`;
    el.style.height = `${el.scrollHeight}px`;
  }, [edit.text, edit.size, edit.hand]);
  if (!block) return null;
  return (
    <textarea
      ref={ref}
      value={edit.text}
      rows={1}
      wrap="off"
      spellCheck
      placeholder="Text"
      onChange={(e) => onChange(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          onDone();
        }
      }}
      className={cx('ink-text ink-text-input', edit.hand && 'is-hand')}
      style={{ left: block.x + edit.x, top: block.y + edit.y, color: colorVar(edit.color), fontSize: TEXT_SIZES[edit.size] }}
    />
  );
}

const TOOLS: [InkTool, LucideIcon, string][] = [
  ['select', MousePointer2, 'Auswählen und verschieben (Pfeile am mittleren Punkt biegen)'],
  ['pen', PenLine, 'Stift'],
  ['marker', Highlighter, 'Textmarker'],
  ['arrow', MoveUpRight, 'Pfeil'],
  ['text', Type, 'Textfeld'],
  ['eraser', Eraser, 'Radierer'],
];

const HEADS: [ArrowHeads, LucideIcon, string][] = [
  ['end', MoveRight, 'Spitze am Ende'],
  ['both', MoveHorizontal, 'Spitzen an beiden Enden'],
  ['none', Minus, 'Linie ohne Spitze'],
];

function InkToolbar({ selection }: { selection: Stroke[] }) {
  const state = useInk();
  const { tool } = state;
  // Es gelten die Einstellungen des Werkzeugs oder, im Auswahlmodus, die der ausgewählten Elemente.
  const target: ColorTool | null = isColorTool(tool) ? tool : null;
  const showColors = !!target || selection.length > 0;
  const showArrow = tool === 'arrow' || selection.some((s) => s.tool === 'arrow');
  const showText = tool === 'text' || selection.some((s) => s.tool === 'text');
  const current = selection.length ? selection[0].color : target ? state.color[target] : null;
  const firstArrow = selection.find((s) => s.tool === 'arrow');
  const firstText = selection.find((s) => s.tool === 'text');
  const heads = firstArrow ? (firstArrow.heads ?? 'end') : state.heads;
  const dash = firstArrow ? !!firstArrow.dash : state.dash;
  const size = firstText ? (firstText.size ?? 'm') : state.size;
  const hand = firstText ? !!firstText.hand : state.hand;
  const button = (on: boolean) => cx('flex h-8 w-8 items-center justify-center rounded-lg hover:bg-hover', on ? 'bg-accent-soft text-accent' : 'text-muted');

  /** Im Auswahlmodus wirkt die Änderung über useInk.subscribe auf die Auswahl. */
  const setColor = (c: InkColor) => {
    const tools: ColorTool[] = target ? [target] : [...new Set(selection.map((s) => s.tool))];
    useInk.setState((s) => ({ color: { ...s.color, ...Object.fromEntries(tools.map((t) => [t, c])) } }));
  };

  return (
    <div className="ink-toolbar fixed bottom-5 left-1/2 z-40 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-xl bg-surface p-1.5 shadow-popover [&>*]:shrink-0">
      {TOOLS.map(([id, Icon, label]) => (
        <button key={id} title={label} aria-label={label} aria-pressed={tool === id} onClick={() => useInk.setState({ tool: id })} className={button(tool === id)}>
          <Icon size={17} />
        </button>
      ))}
      {showColors && (
        <>
          <div className="mx-1 h-6 w-px bg-border" />
          {INK_COLORS.map((c) => (
            <button
              key={c}
              title={INK_COLOR_LABELS[c]}
              aria-label={`Farbe ${INK_COLOR_LABELS[c]}`}
              aria-pressed={current === c}
              onClick={() => setColor(c)}
              className={cx('flex h-7 w-7 items-center justify-center rounded-full border-2', current === c ? 'border-accent' : 'border-transparent')}
            >
              <span className="h-4 w-4 rounded-full" style={{ background: colorVar(c) }} />
            </button>
          ))}
        </>
      )}
      {showArrow && (
        <>
          <div className="mx-1 h-6 w-px bg-border" />
          {HEADS.map(([value, Icon, label]) => (
            <button key={value} title={label} aria-label={label} aria-pressed={heads === value} onClick={() => useInk.setState({ heads: value })} className={button(heads === value)}>
              <Icon size={17} />
            </button>
          ))}
          <button title="Gestrichelt" aria-label="Gestrichelt" aria-pressed={dash} onClick={() => useInk.setState({ dash: !dash })} className={button(dash)}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 12h3M10.5 12h3M18 12h3" />
            </svg>
          </button>
        </>
      )}
      {showText && (
        <>
          <div className="mx-1 h-6 w-px bg-border" />
          {(['s', 'm', 'l'] as TextSize[]).map((value) => (
            <button
              key={value}
              title={{ s: 'Klein', m: 'Mittel', l: 'Groß' }[value]}
              aria-label={`Schriftgröße ${{ s: 'klein', m: 'mittel', l: 'groß' }[value]}`}
              aria-pressed={size === value}
              onClick={() => useInk.setState({ size: value })}
              className={cx(button(size === value), 'font-semibold')}
              style={{ fontSize: { s: 11, m: 14, l: 17 }[value] }}
            >
              A
            </button>
          ))}
          <button
            title="Handschrift"
            aria-label="Handschrift"
            aria-pressed={hand}
            onClick={() => useInk.setState({ hand: !hand })}
            className={cx(button(hand), 'ink-hand w-auto px-2 text-base')}
          >
            Hand
          </button>
        </>
      )}
      <div className="mx-1 h-6 w-px bg-border" />
      <button onClick={() => toggleInk(false)} className="h-8 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg" title="Zeichnen beenden (Esc)">
        Fertig
      </button>
    </div>
  );
}
