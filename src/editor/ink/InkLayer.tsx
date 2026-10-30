import type { Editor } from '@tiptap/core';
import { Eraser, Highlighter, MoveUpRight, PenLine, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx';
import { newId } from '../../lib/ids';
import {
  hitsStroke,
  INK_COLOR_LABELS,
  INK_COLORS,
  simplify,
  strokeShapes,
  strokesOf,
  toggleInk,
  useInk,
  type InkColor,
  type InkTool,
  type Stroke,
} from './ink';

/** Ein Block der obersten Ebene mit Lage relativ zum Editor und seinen Strichen. */
interface Placed {
  pos: number;
  x: number;
  y: number;
  bottom: number;
  strokes: Stroke[];
}

/** Wie weit man links und rechts neben dem Text noch zeichnen kann. */
const GUTTER = 48;

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

/** Block, an dem ein neuer Strich bei Höhe y hängt: der Block an dieser Stelle, sonst der nächstgelegene. */
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

function StrokeView({ stroke, done = true }: { stroke: Pick<Stroke, 'tool' | 'points' | 'color'>; done?: boolean }) {
  const color = colorVar(stroke.color);
  return (
    <g className={stroke.tool === 'marker' ? 'ink-marker' : undefined}>
      {strokeShapes(stroke, done).map((shape, i) =>
        shape.kind === 'fill' ? (
          <path key={i} d={shape.d} fill={color} />
        ) : (
          <path key={i} d={shape.d} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        ),
      )}
    </g>
  );
}

interface Drawing {
  tool: 'pen' | 'marker' | 'arrow';
  color: InkColor;
  anchor: Placed;
  points: number[];
}

/**
 * Zeichnungen über dem Text. Ohne Zeichenmodus nur sichtbar (Klicks gehen an den Text),
 * im Zeichenmodus fängt eine Fläche über der Seite Stift, Maus und Finger ab.
 */
export function InkLayer({ editor, wrapper }: { editor: Editor; wrapper: RefObject<HTMLDivElement | null> }) {
  const [blocks, setBlocks] = useState<Placed[]>([]);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [erased, setErased] = useState<Set<string>>(new Set());
  const { active, tool, color } = useInk();
  const [editable, setEditable] = useState(editor.isEditable);
  const drawingRef = useRef<Drawing | null>(null);
  const erasedRef = useRef<Set<string>>(new Set());
  const erasing = useRef(false);
  const blocksRef = useRef<Placed[]>([]);
  const frame = useRef(0);

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

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !drawingRef.current && !erasing.current) {
        e.preventDefault();
        toggleInk(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const drawingMode = active && editable;

  const local = (e: React.PointerEvent | PointerEvent) => {
    const base = wrapper.current!.getBoundingClientRect();
    return { x: e.clientX - base.left, y: e.clientY - base.top };
  };

  const erase = (x: number, y: number) => {
    let changed = false;
    for (const b of blocksRef.current) {
      for (const s of b.strokes) {
        const key = `${b.pos}:${s.id}`;
        if (!erasedRef.current.has(key) && hitsStroke(s, x - b.x, y - b.y)) {
          erasedRef.current.add(key);
          changed = true;
        }
      }
    }
    if (changed) setErased(new Set(erasedRef.current));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !wrapper.current) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ohne Zeiger-Fang geht das Zeichnen trotzdem, nur nicht über den Fensterrand hinaus.
    }
    const { x, y } = local(e);
    if (tool === 'eraser') {
      erasedRef.current = new Set();
      erasing.current = true;
      erase(x, y);
      return;
    }
    const anchor = anchorAt(blocksRef.current, y);
    if (!anchor) return;
    const pressure = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5;
    const next: Drawing = { tool, color: color[tool], anchor, points: [x - anchor.x, y - anchor.y, pressure] };
    drawingRef.current = next;
    setDrawing(next);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (erasing.current) {
      const { x, y } = local(e);
      erase(x, y);
      return;
    }
    const current = drawingRef.current;
    if (!current) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const { x, y } = local(ev);
      const point = [x - current.anchor.x, y - current.anchor.y, ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5];
      if (current.tool === 'arrow') current.points = [...current.points.slice(0, 3), ...point];
      else current.points.push(...point);
    }
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setDrawing({ ...current }));
  };

  const onPointerUp = () => {
    const current = drawingRef.current;
    drawingRef.current = null;
    cancelAnimationFrame(frame.current);
    if (erasing.current) {
      erasing.current = false;
      const byPos = new Map<number, Set<string>>();
      for (const key of erasedRef.current) {
        const [pos, id] = key.split(':');
        byPos.set(Number(pos), (byPos.get(Number(pos)) ?? new Set()).add(id));
      }
      if (byPos.size) {
        const chain = editor.chain();
        for (const [pos, ids] of byPos) chain.setInk(pos, strokesOf(editor.state.doc.nodeAt(pos)).filter((s) => !ids.has(s.id)));
        chain.run();
      }
      erasedRef.current = new Set();
      setErased(new Set());
      return;
    }
    if (!current) return;
    setDrawing(null);
    let points = current.points;
    if (current.tool === 'arrow') {
      if (points.length < 6 || Math.hypot(points[3] - points[0], points[4] - points[1]) < 6) return;
    } else {
      // Ein einzelner Tipp wird zum Punkt.
      if (points.length === 3) points = [...points, points[0] + 0.5, points[1] + 0.5, points[2]];
      points = simplify(points);
    }
    const node = editor.state.doc.nodeAt(current.anchor.pos);
    if (!node) return;
    const stroke: Stroke = { id: newId(), tool: current.tool, color: current.color, points };
    editor.chain().setInk(current.anchor.pos, [...strokesOf(node), stroke]).run();
  };

  return (
    <>
      <svg className="ink-layer" aria-hidden="true">
        {blocks.map((b) =>
          b.strokes.length ? (
            <g key={b.pos} transform={`translate(${b.x} ${b.y})`}>
              {b.strokes
                .filter((s) => !erased.has(`${b.pos}:${s.id}`))
                .map((s) => (
                  <StrokeView key={s.id} stroke={s} />
                ))}
            </g>
          ) : null,
        )}
        {drawing && (
          <g transform={`translate(${drawing.anchor.x} ${drawing.anchor.y})`}>
            <StrokeView stroke={drawing} done={false} />
          </g>
        )}
      </svg>
      {drawingMode && (
        <div
          className={cx('ink-capture', tool === 'eraser' && 'is-eraser')}
          style={{ left: -GUTTER, right: -GUTTER }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      )}
      {drawingMode && createPortal(<InkToolbar />, document.body)}
    </>
  );
}

const TOOLS: [InkTool, LucideIcon, string][] = [
  ['pen', PenLine, 'Stift'],
  ['marker', Highlighter, 'Textmarker'],
  ['arrow', MoveUpRight, 'Pfeil'],
  ['eraser', Eraser, 'Radierer'],
];

function InkToolbar() {
  const { tool, color } = useInk();
  const current = tool === 'eraser' ? null : color[tool];
  return (
    <div className="ink-toolbar fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-xl bg-surface p-1.5 shadow-popover">
      {TOOLS.map(([id, Icon, label]) => (
        <button
          key={id}
          title={label}
          aria-label={label}
          aria-pressed={tool === id}
          onClick={() => useInk.setState({ tool: id })}
          className={cx('flex h-8 w-8 items-center justify-center rounded-lg hover:bg-hover', tool === id ? 'bg-accent-soft text-accent' : 'text-muted')}
        >
          <Icon size={17} />
        </button>
      ))}
      {tool !== 'eraser' && (
        <>
          <div className="mx-1 h-6 w-px bg-border" />
          {INK_COLORS.map((c) => (
            <button
              key={c}
              title={INK_COLOR_LABELS[c]}
              aria-label={`Farbe ${INK_COLOR_LABELS[c]}`}
              aria-pressed={current === c}
              onClick={() => useInk.setState((s) => ({ color: { ...s.color, [tool]: c } }))}
              className={cx('flex h-7 w-7 items-center justify-center rounded-full border-2', current === c ? 'border-accent' : 'border-transparent')}
            >
              <span className="h-4 w-4 rounded-full" style={{ background: colorVar(c) }} />
            </button>
          ))}
        </>
      )}
      <div className="mx-1 h-6 w-px bg-border" />
      <button onClick={() => toggleInk(false)} className="h-8 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg" title="Zeichnen beenden (Esc)">
        Fertig
      </button>
    </div>
  );
}
