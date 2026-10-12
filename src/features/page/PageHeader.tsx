import { ImageIcon, Smile } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Popover, type Anchor } from '../../components/Popover';
import type { PageMeta } from '../../db/pages';
import { getActiveEditor } from '../../editor/active';
import { usePages } from '../../store/pages';
import { useUI } from '../../store/ui';
import { cx } from '../../lib/cx';
import { useCanEdit } from '../collab/sources';
import { chooseCover } from './Cover';
import { EmojiPicker } from './EmojiPicker';

export function PageHeader({ page }: { page: PageMeta }) {
  const editable = useCanEdit(page.id);
  const [iconPicker, setIconPicker] = useState<Anchor | null>(null);
  const closePicker = useCallback(() => setIconPicker(null), []);
  const update = usePages((s) => s.update);

  const pickIcon = (emoji: string | null) => {
    update(page.id, { icon: emoji });
    setIconPicker(null);
  };

  return (
    <div className={page.cover ? 'group/header pt-6' : 'group/header pt-8 md:pt-16'}>
      {page.icon && (
        <button
          disabled={!editable}
          onClick={(e) => setIconPicker(e.currentTarget.getBoundingClientRect())}
          className="-ml-1 mb-2 flex h-[72px] w-[72px] items-center justify-center rounded-lg text-[56px] leading-none enabled:hover:bg-hover"
          aria-label="Icon ändern"
        >
          {page.icon}
        </button>
      )}
      <div
        className={cx(
          'touch-reveal flex h-7 items-center gap-1 opacity-0 transition-opacity group-hover/header:opacity-100 focus-within:opacity-100',
          !editable && 'invisible',
        )}
      >
        {!page.icon && (
          <button
            onClick={(e) => setIconPicker(e.currentTarget.getBoundingClientRect())}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-faint hover:bg-hover hover:text-muted"
          >
            <Smile size={15} /> Icon hinzufügen
          </button>
        )}
        {!page.cover && (
          <button
            onClick={() => chooseCover(page.id)}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-faint hover:bg-hover hover:text-muted"
          >
            <ImageIcon size={15} /> Titelbild hinzufügen
          </button>
        )}
      </div>
      <TitleInput page={page} editable={editable} />
      {iconPicker && (
        <Popover anchor={iconPicker} onClose={closePicker}>
          <EmojiPicker onPick={pickIcon} onRemove={page.icon ? () => pickIcon(null) : undefined} />
        </Popover>
      )}
    </div>
  );
}

/** Kompakter Kopf über einem Board: Icon und Titel in einer Zeile. */
export function BoardHeader({ page }: { page: PageMeta }) {
  const editable = useCanEdit(page.id);
  const [iconPicker, setIconPicker] = useState<Anchor | null>(null);
  const closePicker = useCallback(() => setIconPicker(null), []);
  const update = usePages((s) => s.update);
  const pendingFocus = useUI((s) => s.pendingFocus);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (useUI.getState().consumeFocus(page.id, 'title')) ref.current?.select();
  }, [pendingFocus, page.id]);
  return (
    <div className="flex items-center gap-2 px-6 py-2">
      <button
        disabled={!editable}
        onClick={(e) => setIconPicker(e.currentTarget.getBoundingClientRect())}
        className="flex h-8 w-8 items-center justify-center rounded-md text-xl enabled:hover:bg-hover"
        aria-label="Icon ändern"
      >
        {page.icon ?? <Smile size={16} className="text-faint" />}
      </button>
      <input
        ref={ref}
        readOnly={!editable}
        value={page.title}
        placeholder="Ohne Titel"
        onChange={(e) => update(page.id, { title: e.target.value })}
        className="keep-size min-w-0 flex-1 bg-transparent text-lg font-semibold outline-none placeholder:text-faint"
      />
      {iconPicker && (
        <Popover anchor={iconPicker} onClose={closePicker}>
          <EmojiPicker
            onPick={(emoji) => {
              update(page.id, { icon: emoji });
              setIconPicker(null);
            }}
            onRemove={page.icon ? () => (update(page.id, { icon: null }), setIconPicker(null)) : undefined}
          />
        </Popover>
      )}
    </div>
  );
}

function TitleInput({ page, editable }: { page: PageMeta; editable: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const update = usePages((s) => s.update);
  const pendingFocus = useUI((s) => s.pendingFocus);

  // Höhe an den Inhalt anpassen: bei Textänderung und wenn sich die Breite ändert (Fenster, Seitenleiste).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = '0px';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [page.title, page.fullWidth]);

  useEffect(() => {
    if (!useUI.getState().consumeFocus(page.id, 'title')) return;
    const el = ref.current;
    el?.focus();
    el?.select();
  }, [pendingFocus, page.id]);

  const toEditor = () => getActiveEditor()?.commands.focus('start');

  return (
    <textarea
      ref={ref}
      rows={1}
      value={page.title}
      readOnly={!editable}
      placeholder="Ohne Titel"
      spellCheck={false}
      onChange={(e) => update(page.id, { title: e.target.value.replace(/\n/g, ' ') })}
      onKeyDown={(e) => {
        const el = e.currentTarget;
        const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          toEditor();
        } else if (e.key === 'ArrowDown' && atEnd) {
          e.preventDefault();
          toEditor();
        }
      }}
      className="keep-size mt-1 block w-full resize-none overflow-hidden bg-transparent text-title font-bold tracking-tight text-text outline-none placeholder:text-faint"
    />
  );
}
