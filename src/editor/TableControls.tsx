import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { BubbleMenu } from '@tiptap/react/menus';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpAZ,
  Combine,
  Copy,
  PanelLeft,
  PanelTop,
  Plus,
  Split,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Popover, type Anchor } from '../components/Popover';
import { cx } from '../lib/cx';
import { toast } from '../store/toast';
import { ColorSwatches } from './ColorSwatches';
import { colorName, type ColorName } from './colors';
import { gridOp, lineSelection, type CellAlign, type GridOp } from './nodes/table';

/** Ist gerade ein Zeilen-/Spaltenmenü offen? Dann bleibt die Zellen-Leiste weg. */
const useLineMenu = create<{ open: boolean }>(() => ({ open: false }));

interface Hover {
  tablePos: number;
  row: number;
  col: number;
  rows: number;
  cols: number;
  cell: HTMLElement;
  tr: HTMLElement;
  table: HTMLElement;
  wrapper: HTMLElement;
}

interface LineMenu {
  line: 'row' | 'column';
  index: number;
  tablePos: number;
  anchor: Anchor;
  /** Anzahl Zeilen bzw. Spalten, für „nach oben/unten“ am Rand */
  count: number;
}

/** Tabelle und Zelle zu einem Zellen-Element im Editor. */
function locate(editor: Editor, cell: HTMLElement): Hover | null {
  const view = editor.view;
  let pos: number;
  try {
    pos = view.posAtDOM(cell, 0);
  } catch {
    return null;
  }
  const $pos = view.state.doc.resolve(pos);
  for (let d = $pos.depth; d > 2; d--) {
    const role = $pos.node(d).type.spec.tableRole;
    if (role !== 'cell' && role !== 'header_cell') continue;
    const table = $pos.node(d - 2);
    const tablePos = $pos.before(d - 2);
    const map = TableMap.get(table);
    const rect = map.findCell($pos.before(d) - tablePos - 1);
    const tableEl = cell.closest('table');
    const tr = cell.closest('tr');
    if (!tableEl || !tr) return null;
    return {
      tablePos,
      row: rect.top,
      col: rect.left,
      rows: map.height,
      cols: map.width,
      cell,
      tr,
      table: tableEl,
      wrapper: tableEl.parentElement ?? tableEl,
    };
  }
  return null;
}

/** Griffe an Zeilen und Spalten, „+“-Leisten am Rand und die Leiste für ausgewählte Zellen. */
export function TableControls({ editor }: { editor: Editor }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [menu, setMenu] = useState<LineMenu | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const onMove = (event: MouseEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (useLineMenu.getState().open) return;
        const target = event.target as HTMLElement | null;
        if (!target || root.current?.contains(target)) return;
        if (!editor.isEditable || editor.isDestroyed) return setHover(null);
        const cell = target.closest<HTMLElement>('td, th');
        if (cell && editor.view.dom.contains(cell)) {
          const next = locate(editor, cell);
          setHover((prev) => (prev && next && prev.cell === next.cell && prev.tablePos === next.tablePos ? prev : next));
          return;
        }
        // Kleiner Rand um die Tabelle, damit man die Griffe erreicht.
        setHover((prev) => {
          if (!prev || !prev.table.isConnected) return null;
          const r = prev.table.getBoundingClientRect();
          const inside = event.clientX > r.left - 24 && event.clientX < r.right + 28 && event.clientY > r.top - 24 && event.clientY < r.bottom + 28;
          return inside ? prev : null;
        });
      });
    };
    const onScroll = () => rerender();
    // Nach Änderungen können Zellen-Elemente ersetzt sein: neu bestimmen, sobald die Maus sich bewegt.
    const onTransaction = () => {
      if (!useLineMenu.getState().open) setHover((prev) => (prev && prev.cell.isConnected ? locate(editor, prev.cell) : null));
    };
    document.addEventListener('mousemove', onMove);
    window.addEventListener('scroll', onScroll, true);
    editor.on('transaction', onTransaction);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('mousemove', onMove);
      window.removeEventListener('scroll', onScroll, true);
      editor.off('transaction', onTransaction);
    };
  }, [editor]);

  const openMenu = (line: 'row' | 'column', target: HTMLElement) => {
    if (!hover) return;
    const selection = lineSelection(editor.state, hover.tablePos, line, line === 'row' ? hover.row : hover.col);
    if (!selection) return;
    useLineMenu.setState({ open: true });
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    editor.view.focus();
    const r = target.getBoundingClientRect();
    setMenu({
      line,
      index: line === 'row' ? hover.row : hover.col,
      tablePos: hover.tablePos,
      count: line === 'row' ? hover.rows : hover.cols,
      anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    });
  };

  const closeMenu = useCallback(() => {
    useLineMenu.setState({ open: false });
    setMenu(null);
    setHover(null);
  }, []);

  /** Neue Zeile am Ende oder neue Spalte rechts, Cursor in die erste neue Zelle. */
  const append = (line: 'row' | 'column') => {
    if (!hover) return;
    const last = (line === 'row' ? hover.rows : hover.cols) - 1;
    const selection = lineSelection(editor.state, hover.tablePos, line, last);
    if (!selection) return;
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    const ok = line === 'row' ? editor.chain().focus().addRowAfter().run() : editor.chain().focus().addColumnAfter().run();
    if (!ok) return;
    const table = editor.state.doc.nodeAt(hover.tablePos);
    if (!table) return;
    const map = TableMap.get(table);
    const cellPos = hover.tablePos + 1 + (line === 'row' ? map.map[(map.height - 1) * map.width] : map.map[map.width - 1]);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(cellPos + 1))));
  };

  const visible = hover && hover.table.isConnected && editor.isEditable;
  const t = visible ? hover.table.getBoundingClientRect() : null;
  const w = visible ? hover.wrapper.getBoundingClientRect() : null;
  const c = visible ? hover.cell.getBoundingClientRect() : null;
  const r = visible ? hover.tr.getBoundingClientRect() : null;
  const right = t && w ? Math.min(t.right, w.right) : 0;

  return (
    <>
      {t && w && c && r &&
        createPortal(
          <div ref={root} className="table-controls">
            <button
              className={cx('table-grip is-column', menu?.line === 'column' && 'is-active')}
              style={{ left: Math.max(c.left, w.left) + Math.min(c.width, w.right - c.left) / 2 - 12, top: t.top - 7 }}
              title="Spalte: Menü öffnen"
              aria-label="Spaltenmenü"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => openMenu('column', e.currentTarget)}
            />
            <button
              className={cx('table-grip is-row', menu?.line === 'row' && 'is-active')}
              style={{ left: t.left - 7, top: r.top + r.height / 2 - 12 }}
              title="Zeile: Menü öffnen"
              aria-label="Zeilenmenü"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => openMenu('row', e.currentTarget)}
            />
            <button
              className="table-add is-row"
              style={{ left: t.left, top: t.bottom + 3, width: right - t.left }}
              title="Zeile hinzufügen"
              aria-label="Zeile hinzufügen"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => append('row')}
            >
              <Plus size={12} />
            </button>
            <button
              className="table-add is-column"
              style={{ left: right + 3, top: t.top, height: t.height }}
              title="Spalte hinzufügen"
              aria-label="Spalte hinzufügen"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => append('column')}
            >
              <Plus size={12} />
            </button>
          </div>,
          document.body,
        )}
      {menu && (
        <Popover anchor={menu.anchor} onClose={closeMenu}>
          <LineMenuContent editor={editor} menu={menu} onDone={closeMenu} />
        </Popover>
      )}
      <CellMenu editor={editor} />
    </>
  );
}

interface Item {
  label: string;
  icon: LucideIcon;
  run: () => void;
  danger?: boolean;
}

/** Wert eines Zellattributs, wenn alle ausgewählten Zellen ihn teilen, sonst null. */
function sharedAttr(editor: Editor, name: 'background' | 'align'): string | null {
  const { selection } = editor.state;
  if (!(selection instanceof CellSelection)) {
    const $from = selection.$from;
    for (let d = $from.depth; d > 0; d--) {
      const role = $from.node(d).type.spec.tableRole;
      if (role === 'cell' || role === 'header_cell') return ($from.node(d).attrs[name] as string | null) ?? null;
    }
    return null;
  }
  const values = new Set<string | null>();
  selection.forEachCell((cell) => values.add((cell.attrs[name] as string | null) ?? null));
  return values.size === 1 ? [...values][0] : null;
}

function AlignButtons({ editor, onDone }: { editor: Editor; onDone?: () => void }) {
  const current = sharedAttr(editor, 'align') ?? 'left';
  const options: [CellAlign, LucideIcon, string][] = [
    ['left', AlignLeft, 'Links'],
    ['center', AlignCenter, 'Zentriert'],
    ['right', AlignRight, 'Rechts'],
  ];
  return (
    <div className="flex gap-0.5">
      {options.map(([value, Icon, label]) => (
        <button
          key={value}
          title={label}
          aria-label={`Ausrichtung ${label}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            editor.chain().focus().setCellAttribute('align', value === 'left' ? null : value).run();
            onDone?.();
          }}
          className={cx('flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover', current === value ? 'text-accent' : 'text-muted')}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}

function LineMenuContent({ editor, menu, onDone }: { editor: Editor; menu: LineMenu; onDone: () => void }) {
  const { line, index, tablePos, count } = menu;
  const row = line === 'row';

  /** Zeile/Spalte wieder auswählen (falls die Auswahl sich verschoben hat) und Befehl ausführen. */
  const withLine = (run: () => unknown) => () => {
    const selection = lineSelection(editor.state, tablePos, line, index);
    if (!selection) return;
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    run();
  };
  const grid = (op: GridOp, after?: { line: 'row' | 'column'; index: number }) => () => {
    const tr = gridOp(editor.state, tablePos, op);
    if (!tr) return toast('Das geht nicht bei verbundenen Zellen. Teile sie zuerst.');
    editor.view.dispatch(tr);
    // Cursor in die erste Zelle der (verschobenen) Zeile bzw. Spalte, damit man sieht, wo sie gelandet ist.
    const target = lineSelection(editor.state, tablePos, after?.line ?? line, after?.index ?? index);
    if (target) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(target.$anchorCell, 1)));
    editor.commands.focus();
  };
  const chain = () => editor.chain().focus();

  const items: Item[] = row
    ? [
        { label: 'Oberhalb einfügen', icon: ArrowUp, run: withLine(() => chain().addRowBefore().run()) },
        { label: 'Unterhalb einfügen', icon: ArrowDown, run: withLine(() => chain().addRowAfter().run()) },
        { label: 'Duplizieren', icon: Copy, run: grid({ kind: 'duplicateRow', index }) },
        ...(index > 0 ? [{ label: 'Nach oben', icon: ArrowUp, run: grid({ kind: 'moveRow', index, by: -1 }, { line: 'row', index: index - 1 }) }] : []),
        ...(index < count - 1 ? [{ label: 'Nach unten', icon: ArrowDown, run: grid({ kind: 'moveRow', index, by: 1 }, { line: 'row', index: index + 1 }) }] : []),
        ...(index === 0 ? [{ label: 'Kopfzeile ein/aus', icon: PanelTop, run: withLine(() => chain().toggleHeaderRow().run()) }] : []),
      ]
    : [
        { label: 'Links einfügen', icon: ArrowLeft, run: withLine(() => chain().addColumnBefore().run()) },
        { label: 'Rechts einfügen', icon: ArrowRight, run: withLine(() => chain().addColumnAfter().run()) },
        { label: 'Duplizieren', icon: Copy, run: grid({ kind: 'duplicateColumn', index }) },
        ...(index > 0 ? [{ label: 'Nach links', icon: ArrowLeft, run: grid({ kind: 'moveColumn', index, by: -1 }, { line: 'column', index: index - 1 }) }] : []),
        ...(index < count - 1
          ? [{ label: 'Nach rechts', icon: ArrowRight, run: grid({ kind: 'moveColumn', index, by: 1 }, { line: 'column', index: index + 1 }) }]
          : []),
        { label: 'Sortieren A → Z', icon: ArrowDownAZ, run: grid({ kind: 'sort', column: index, descending: false }) },
        { label: 'Sortieren Z → A', icon: ArrowUpAZ, run: grid({ kind: 'sort', column: index, descending: true }) },
        ...(index === 0 ? [{ label: 'Kopfspalte ein/aus', icon: PanelLeft, run: withLine(() => chain().toggleHeaderColumn().run()) }] : []),
      ];
  items.push({
    label: row ? 'Zeile löschen' : 'Spalte löschen',
    icon: Trash2,
    danger: true,
    run: withLine(() => (row ? chain().deleteRow().run() : chain().deleteColumn().run()) || chain().deleteTable().run()),
  });

  return (
    <div className="w-[230px] p-1" role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            item.run();
            onDone();
          }}
          className={cx('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover', item.danger ? 'text-danger' : 'text-text')}
        >
          <item.icon size={15} className={item.danger ? '' : 'text-muted'} />
          <span className="flex-1 truncate">{item.label}</span>
        </button>
      ))}
      <div className="my-1 h-px bg-border" />
      <div className="px-2 pb-1 pt-0.5 text-2xs text-faint">Hintergrund</div>
      <div className="px-2 pb-1">
        <ColorSwatches
          kind="bg"
          value={colorName(sharedAttr(editor, 'background'))}
          onPick={(color) => {
            withLine(() => chain().setCellAttribute('background', color).run())();
            onDone();
          }}
        />
      </div>
      <div className="px-2 pb-1 pt-1 text-2xs text-faint">Ausrichtung</div>
      <div className="px-1.5 pb-1">
        <AlignButtons editor={editor} onDone={onDone} />
      </div>
    </div>
  );
}

const inMergedCell = (editor: Editor) => {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    const role = node.type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') return node.attrs.colspan > 1 || node.attrs.rowspan > 1;
  }
  return false;
};

type ShouldShow = NonNullable<React.ComponentProps<typeof BubbleMenu>['shouldShow']>;
const cellMenuShow: ShouldShow = ({ editor, state }) =>
  editor.isEditable && !useLineMenu.getState().open && (state.selection instanceof CellSelection || inMergedCell(editor));

/** Leiste für mehrere ausgewählte Zellen: verbinden, teilen, Farbe, Ausrichtung. */
function CellMenu({ editor }: { editor: Editor }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [colors, setColors] = useState(false);
  const options = useMemo(() => ({ placement: 'top' as const, offset: 8, onHide: () => setColors(false) }), []);
  useEffect(() => {
    editor.on('transaction', rerender);
    return () => {
      editor.off('transaction', rerender);
    };
  }, [editor]);
  const multi = editor.state.selection instanceof CellSelection && editor.state.selection.ranges.length > 1;
  const button = 'flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-hover';
  const background = colorName(sharedAttr(editor, 'background'));
  return (
    <BubbleMenu editor={editor} pluginKey="cellMenu" shouldShow={cellMenuShow} options={options} className="z-30">
      <div className="flex flex-col gap-1 rounded-lg bg-surface p-1 shadow-popover">
        <div className="flex items-center gap-0.5">
          {multi && editor.can().mergeCells() && (
            <button className={button} onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().mergeCells().run()}>
              <Combine size={14} /> Verbinden
            </button>
          )}
          {editor.can().splitCell() && (
            <button className={button} onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().splitCell().run()}>
              <Split size={14} /> Teilen
            </button>
          )}
          <AlignButtons editor={editor} />
          <div className="mx-0.5 h-5 w-px bg-border" />
          <button
            className={cx(button, colors && 'bg-hover')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setColors((v) => !v)}
            title="Hintergrundfarbe"
          >
            <span className="h-3.5 w-3.5 rounded-sm border border-border" style={background ? { background: `var(--c-tag-${background}-bg)` } : undefined} />
            Farbe
          </button>
        </div>
        {colors && (
          <div className="px-1 pb-0.5">
            <ColorSwatches kind="bg" value={background} onPick={(color: ColorName | null) => editor.chain().focus().setCellAttribute('background', color).run()} />
          </div>
        )}
      </div>
    </BubbleMenu>
  );
}
