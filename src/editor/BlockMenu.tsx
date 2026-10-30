import type { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Copy, Palette, Repeat, Trash2, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Popover } from '../components/Popover';
import { cx } from '../lib/cx';
import { closeBlockMenu, useBlockMenu } from './blockMenuStore';
import { ColorSwatches } from './ColorSwatches';
import { colorName } from './colors';
import { moveBlock } from './dragHandle';
import { blockColor, COLORABLE } from './format/blockAttrs';
import { BLOCK_TYPES, blockTypeAt, turnInto } from './format/blockTypes';

/** Blöcke mit Text, die sich in andere Blocktypen umwandeln lassen. */
const CONVERTIBLE = new Set(['paragraph', 'heading', 'listItem', 'taskItem', 'blockquote', 'callout', 'toggle', 'codeBlock']);

/** Menü am Greifer: umwandeln, färben, duplizieren, verschieben, löschen. */
export function BlockMenu({ editor }: { editor: Editor }) {
  const { pos, anchor } = useBlockMenu();
  const [view, setView] = useState<'main' | 'turn' | 'color'>('main');
  const node = pos === null || editor.isDestroyed ? null : editor.state.doc.nodeAt(pos);
  if (pos === null || !anchor || !node || !editor.isEditable) return null;

  const close = () => {
    setView('main');
    closeBlockMenu();
  };
  /** Cursor in den Block setzen (für Befehle, die auf der Auswahl arbeiten). */
  const cursorInBlock = () => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1))));
  const selectBlock = () => editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));

  const items: { label: string; icon: LucideIcon; run: () => void; more?: boolean; danger?: boolean }[] = [
    ...(CONVERTIBLE.has(node.type.name) ? [{ label: 'Umwandeln in', icon: Repeat, run: () => setView('turn'), more: true }] : []),
    ...(COLORABLE.includes(node.type.name) ? [{ label: 'Farbe', icon: Palette, run: () => setView('color'), more: true }] : []),
    {
      label: 'Duplizieren',
      icon: Copy,
      run: () => {
        const end = pos + node.nodeSize;
        const tr = editor.state.tr.insert(end, node.copy(node.content));
        editor.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, end)));
        editor.commands.focus();
        close();
      },
    },
    {
      label: 'Nach oben',
      icon: ArrowUp,
      run: () => {
        selectBlock();
        moveBlock(editor, -1);
        close();
      },
    },
    {
      label: 'Nach unten',
      icon: ArrowDown,
      run: () => {
        selectBlock();
        moveBlock(editor, 1);
        close();
      },
    },
    {
      label: 'Löschen',
      icon: Trash2,
      danger: true,
      run: () => {
        editor.view.dispatch(editor.state.tr.deleteRange(pos, pos + node.nodeSize));
        editor.commands.focus();
        close();
      },
    },
  ];

  const color = blockColor(node.attrs.blockColor);
  const textColor = color && !color.endsWith('-bg') ? colorName(color) : null;
  const bgColor = color?.endsWith('-bg') ? colorName(color.slice(0, -3)) : null;
  const setColor = (value: string | null) => {
    editor.chain().focus().setBlockColor(pos, value).run();
    close();
  };
  const current = CONVERTIBLE.has(node.type.name) ? blockTypeAt(editor.state.doc.resolve(pos + 1)) : null;
  const back = (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setView('main')}
      className="mb-1 flex h-7 w-full items-center gap-1 rounded-md px-1.5 text-xs text-muted hover:bg-hover"
    >
      <ChevronLeft size={14} /> Zurück
    </button>
  );

  return (
    <Popover anchor={anchor} onClose={close} placement="bottom-start">
      <div className={cx('p-1', view === 'color' ? 'w-[300px]' : 'w-[240px]')} role="menu">
        {view === 'main' &&
          items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={item.run}
              className={cx('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover', item.danger ? 'text-danger' : 'text-text')}
            >
              <item.icon size={15} className={item.danger ? '' : 'text-muted'} />
              <span className="flex-1">{item.label}</span>
              {item.more && <ChevronRight size={14} className="text-faint" />}
            </button>
          ))}
        {view === 'turn' && (
          <>
            {back}
            {BLOCK_TYPES.map((type) => (
              <button
                key={type.id}
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  cursorInBlock();
                  turnInto(editor, type.id);
                  close();
                }}
                className={cx('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover', current === type.id ? 'text-accent' : 'text-text')}
              >
                <type.icon size={15} className={current === type.id ? '' : 'text-muted'} />
                {type.label}
              </button>
            ))}
          </>
        )}
        {view === 'color' && (
          <div className="flex flex-col gap-1 px-1 pb-1">
            {back}
            <div className="text-2xs text-faint">Textfarbe</div>
            <ColorSwatches kind="text" value={textColor} onPick={(c) => setColor(c)} />
            <div className="mt-1 text-2xs text-faint">Hintergrund</div>
            <ColorSwatches kind="bg" value={bgColor} onPick={(c) => setColor(c ? `${c}-bg` : null)} />
          </div>
        )}
      </div>
    </Popover>
  );
}
