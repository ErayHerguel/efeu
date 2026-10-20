import type { Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import { Bold, Check, Code, ExternalLink, Highlighter, Italic, Link2, MessageSquare, PenLine, Shapes, Sparkles, Strikethrough, Underline, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { openExternal } from '../lib/assets';
import { newId } from '../lib/ids';
import { cx } from '../lib/cx';
import { formatCombo } from '../features/shortcuts/keys';
import { reportError } from '../store/toast';
import { useAiReady } from '../features/ai/store';
import { REWRITE_ACTIONS } from '../features/ai/write';
import { startWrite } from '../features/ai/writeSession';
import { convertToBoard } from '../features/ai/edit/toBoard';

interface MarkButton {
  mark: string;
  icon: LucideIcon;
  label: string;
  toggle: (editor: Editor) => boolean;
}

const MARKS: MarkButton[] = [
  { mark: 'bold', icon: Bold, label: `Fett (${formatCombo('Mod+B')})`, toggle: (e) => e.chain().focus().toggleBold().run() },
  { mark: 'italic', icon: Italic, label: `Kursiv (${formatCombo('Mod+I')})`, toggle: (e) => e.chain().focus().toggleItalic().run() },
  { mark: 'underline', icon: Underline, label: `Unterstrichen (${formatCombo('Mod+U')})`, toggle: (e) => e.chain().focus().toggleUnderline().run() },
  { mark: 'strike', icon: Strikethrough, label: `Durchgestrichen (${formatCombo('Mod+Shift+S')})`, toggle: (e) => e.chain().focus().toggleStrike().run() },
  { mark: 'code', icon: Code, label: `Code (${formatCombo('Mod+E')})`, toggle: (e) => e.chain().focus().toggleCode().run() },
  { mark: 'highlight', icon: Highlighter, label: `Hervorheben (${formatCombo('Mod+Shift+H')})`, toggle: (e) => e.chain().focus().toggleHighlight().run() },
];

type ShouldShow = NonNullable<React.ComponentProps<typeof BubbleMenu>['shouldShow']>;

const shouldShow: ShouldShow = ({ editor, state }) => {
  const { selection } = state;
  if (selection.empty || !editor.isEditable) return false;
  if (editor.isActive('codeBlock') || editor.isActive('image') || editor.isActive('pageRef')) return false;
  return state.doc.textBetween(selection.from, selection.to).length > 0;
};

/** Schwebende Leiste bei Textauswahl. Mod+Shift+K öffnet direkt die Link-Eingabe. */
export function Toolbar({ editor }: { editor: Editor }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [mode, setMode] = useState<'marks' | 'link' | 'comment' | 'ai'>('marks');
  const aiReady = useAiReady();
  const options = useMemo(() => ({ placement: 'top' as const, offset: 8, onHide: () => setMode('marks') }), []);
  const setLinkMode = (on: boolean) => setMode(on ? 'link' : 'marks');

  useEffect(() => {
    const update = () => rerender();
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    editor.storage.toolbar.openLink = () => setMode('link');
    editor.storage.toolbar.openComment = () => setMode('comment');
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
      editor.storage.toolbar.openLink = null;
      editor.storage.toolbar.openComment = null;
    };
  }, [editor]);

  return (
    <BubbleMenu
      editor={editor}
      options={options}
      shouldShow={shouldShow}
      className="z-40"
    >
      <div className="flex items-center gap-0.5 rounded-lg bg-surface p-1 shadow-popover">
        {mode === 'ai' ? (
          <AiMenu
            onPick={(action, instruction) => {
              setMode('marks');
              startWrite(editor, action, instruction);
            }}
            onBoard={() => {
              setMode('marks');
              void convertToBoard(editor, 'selection');
            }}
            onCancel={() => {
              setMode('marks');
              editor.commands.focus();
            }}
          />
        ) : mode === 'link' ? (
          <LinkInput editor={editor} onDone={() => setLinkMode(false)} />
        ) : mode === 'comment' ? (
          <CommentInput
            initial=""
            onDone={(text) => {
              setMode('marks');
              if (text) editor.chain().focus().setMark('comment', { id: newId(), text, createdAt: Date.now() }).run();
              else editor.commands.focus();
            }}
          />
        ) : (
          <>
            {aiReady && editor.isEditable && (
              <>
                <button
                  title="KI: Text überarbeiten"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setMode('ai')}
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-sm text-accent hover:bg-hover"
                >
                  <Sparkles size={15} /> KI
                </button>
                <div className="mx-0.5 h-5 w-px bg-border" />
              </>
            )}
            {MARKS.map(({ mark, icon: Icon, label, toggle }) => (
              <button
                key={mark}
                title={label}
                aria-label={label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggle(editor)}
                className={cx(
                  'flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover',
                  editor.isActive(mark) ? 'text-accent' : 'text-muted',
                )}
              >
                <Icon size={15} />
              </button>
            ))}
            <div className="mx-0.5 h-5 w-px bg-border" />
            <button
              title={`Link (${formatCombo('Mod+Shift+K')})`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setLinkMode(true)}
              className={cx(
                'flex h-7 items-center gap-1 rounded-md px-2 text-sm hover:bg-hover',
                editor.isActive('link') ? 'text-accent' : 'text-muted',
              )}
            >
              <Link2 size={15} /> Link
            </button>
            <button
              title={`Kommentar (${formatCombo('Mod+Shift+M')})`}
              aria-label="Kommentar"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMode('comment')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover"
            >
              <MessageSquare size={15} />
            </button>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}

const commentShow: ShouldShow = ({ editor, state }) => state.selection.empty && editor.isActive('comment');
const tableShow: ShouldShow = ({ editor }) => editor.isEditable && editor.isActive('table');

/** Zeigt den Kommentar, wenn der Cursor in kommentiertem Text steht. */
export function CommentBubble({ editor }: { editor: Editor }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    editor.on('selectionUpdate', rerender);
    return () => {
      editor.off('selectionUpdate', rerender);
    };
  }, [editor]);
  const attrs = editor.getAttributes('comment') as { text?: string; createdAt?: number };
  const options = useMemo(() => ({ placement: 'bottom' as const, offset: 6, onHide: () => setEditing(false) }), []);
  return (
    <BubbleMenu editor={editor} pluginKey="commentBubble" shouldShow={commentShow} options={options} className="z-40">
      <div className="w-[280px] rounded-lg bg-surface p-2 text-sm shadow-popover">
        {editing ? (
          <CommentInput
            initial={attrs.text ?? ''}
            onDone={(text) => {
              setEditing(false);
              if (text) editor.chain().focus().extendMarkRange('comment').updateAttributes('comment', { text }).run();
            }}
          />
        ) : (
          <>
            <div className="mb-1 text-2xs text-faint">
              {attrs.createdAt ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(attrs.createdAt) : 'Kommentar'}
            </div>
            <p className="whitespace-pre-wrap">{attrs.text}</p>
            <div className="mt-2 flex justify-end gap-1">
              <button onClick={() => setEditing(true)} className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-hover">
                <PenLine size={13} /> Bearbeiten
              </button>
              <button
                onClick={() => editor.chain().focus().extendMarkRange('comment').unsetMark('comment').run()}
                className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-hover"
              >
                <Check size={13} /> Erledigt
              </button>
            </div>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}

/** Zeilen und Spalten einer Tabelle bearbeiten. */
export function TableMenu({ editor }: { editor: Editor }) {
  const options = useMemo(() => ({ placement: 'top-start' as const, offset: 8 }), []);
  const action = (label: string, run: () => boolean, danger = false) => (
    <button
      key={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={cx('h-7 rounded-md px-2 text-xs hover:bg-hover', danger ? 'text-danger' : 'text-muted')}
    >
      {label}
    </button>
  );
  return (
    <BubbleMenu editor={editor} pluginKey="tableMenu" shouldShow={tableShow} options={options} className="z-30">
      <div className="flex items-center gap-0.5 rounded-lg bg-surface p-1 shadow-popover">
        {action('+ Zeile', () => editor.chain().focus().addRowAfter().run())}
        {action('+ Spalte', () => editor.chain().focus().addColumnAfter().run())}
        {action('Zeile löschen', () => editor.chain().focus().deleteRow().run())}
        {action('Spalte löschen', () => editor.chain().focus().deleteColumn().run())}
        {action('Kopfzeile', () => editor.chain().focus().toggleHeaderRow().run())}
        {action('Tabelle löschen', () => editor.chain().focus().deleteTable().run(), true)}
      </div>
    </BubbleMenu>
  );
}

/** Aktionen der Schreibhilfe für die Auswahl, plus eigene Anweisung. */
function AiMenu({ onPick, onCancel, onBoard }: {
  onBoard: () => void; onPick: (action: (typeof REWRITE_ACTIONS)[number]['id'] | 'custom' | 'explain', instruction?: string) => void; onCancel: () => void }) {
  const [instruction, setInstruction] = useState('');
  return (
    <div className="flex w-[300px] flex-col gap-1 p-0.5">
      <input
        autoFocus
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && instruction.trim()) {
            e.preventDefault();
            onPick('custom', instruction);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Was soll Claude tun? (↩)"
        className="h-8 rounded-md bg-bg px-2 text-sm outline-none placeholder:text-faint"
      />
      <div className="grid grid-cols-2 gap-0.5">
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={onBoard}
          className="col-span-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-left text-sm text-accent hover:bg-hover"
        >
          <Shapes size={14} /> Als Board darunter einfügen
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick('explain')}
          className="h-7 rounded-md px-2 text-left text-sm text-muted hover:bg-hover hover:text-text"
        >
          Erklären
        </button>
        {REWRITE_ACTIONS.map((a) => (
          <button
            key={a.id}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(a.id)}
            className="h-7 rounded-md px-2 text-left text-sm text-muted hover:bg-hover hover:text-text"
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CommentInput({ initial, onDone }: { initial: string; onDone: (text: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="flex w-[280px] flex-col gap-1">
      <textarea
        autoFocus
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onDone(value.trim());
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onDone('');
          }
        }}
        placeholder="Kommentar … (↩ speichern, ⇧↩ neue Zeile)"
        className="resize-none rounded-md bg-bg p-2 text-sm outline-none placeholder:text-faint"
      />
    </div>
  );
}

function LinkInput({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const existing = String(editor.getAttributes('link').href ?? '');
  const [value, setValue] = useState(existing);

  const apply = () => {
    const href = value.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!href) chain.unsetLink().run();
    else chain.setLink({ href: /^[a-z]+:/i.test(href) ? href : `https://${href}` }).run();
    onDone();
  };

  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onDone();
            editor.commands.focus();
          }
        }}
        placeholder="Link einfügen …"
        className="h-7 w-[240px] rounded-md bg-bg px-2 text-sm outline-none placeholder:text-faint"
      />
      {existing && (
        <button
          title="Im Browser öffnen"
          onClick={() => openExternal(existing).catch((err) => reportError('Link konnte nicht geöffnet werden', err))}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover"
        >
          <ExternalLink size={14} />
        </button>
      )}
      <button onClick={apply} className="h-7 rounded-md bg-accent px-2 text-xs font-medium text-accent-fg">
        Übernehmen
      </button>
    </div>
  );
}
