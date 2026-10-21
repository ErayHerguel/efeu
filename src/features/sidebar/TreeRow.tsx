import { useDraggable, useDroppable } from '@dnd-kit/core';
import { ChevronRight, CopyPlus, House, MoreHorizontal, PenLine, Plus, Star, Trash2 } from 'lucide-react';
import { memo, useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { MenuList } from '../../components/MenuList';
import { PageIcon, pageTitle } from '../../components/PageIcon';
import { Popover, pointAnchor, type Anchor } from '../../components/Popover';
import { cx } from '../../lib/cx';
import { usePages } from '../../store/pages';
import { useUI } from '../../store/ui';
import { createPageAndOpen, duplicateAndOpen } from '../actions';
import { GUEST } from '../../lib/mode';
import { useCanEdit } from '../collab/sources';
import { usePresence } from '../collab/presence';
import { useShallow } from 'zustand/react/shallow';

export type DropPosition = 'before' | 'after' | 'inside';

interface TreeRowProps {
  id: string;
  depth: number;
  drop: DropPosition | null;
  dimmed: boolean;
}

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

export const TreeRow = memo(function TreeRow({ id, depth, drop, dimmed }: TreeRowProps) {
  const page = usePages((s) => s.pages[id]);
  const active = useUI((s) => s.currentId === id);
  const expanded = useUI((s) => Boolean(s.expanded[id]));
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const editable = useCanEdit(id);
  const drag = useDraggable({ id, disabled: !editable });
  const dropZone = useDroppable({ id });
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      drag.setNodeRef(node);
      dropZone.setNodeRef(node);
    },
    [drag.setNodeRef, dropZone.setNodeRef],
  );

  if (!page) return null;
  const expandable = page.type === 'page';

  const openMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(pointAnchor(e.clientX, e.clientY));
  };

  return (
    <>
      <div
        ref={setRef}
        {...drag.listeners}
        {...drag.attributes}
        data-tree-id={id}
        onKeyDown={(e) => {
          if (renaming) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            useUI.getState().open(id);
            useUI.getState().requestFocus('editor');
          } else if (e.key === 'F2' && editable) {
            e.preventDefault();
            setRenaming(true);
          }
        }}
        role="treeitem"
        aria-selected={active}
        aria-expanded={expandable ? expanded : undefined}
        onClick={() => useUI.getState().open(id)}
        onDoubleClick={() => editable && setRenaming(true)}
        onContextMenu={openMenu}
        className={cx(
          'group relative flex h-7 shrink-0 items-center gap-1 rounded-md pr-1 text-sm outline-none',
          active ? 'bg-active font-medium text-text' : 'text-muted hover:bg-hover',
          drop === 'inside' && 'bg-accent-soft',
          dimmed && 'opacity-40',
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {drop === 'before' && <div className="absolute inset-x-1 -top-px h-0.5 rounded-full bg-accent" />}
        {drop === 'after' && <div className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent" />}

        <span className="relative flex h-5 w-[22px] shrink-0 items-center justify-center">
          <span className={cx('flex', expandable && 'group-hover:invisible')}>
            <PageIcon page={page} />
          </span>
          {expandable && (
            <button
              aria-label={expanded ? 'Zuklappen' : 'Aufklappen'}
              onPointerDown={stop}
              onClick={(e) => {
                e.stopPropagation();
                useUI.getState().setExpanded(id, !expanded);
              }}
              className="absolute inset-0 hidden items-center justify-center rounded-sm text-muted hover:bg-active group-hover:flex"
            >
              <ChevronRight size={14} className={cx('transition-transform', expanded && 'rotate-90')} />
            </button>
          )}
        </span>

        {renaming ? (
          <RenameInput
            initial={page.title}
            onDone={(title) => {
              setRenaming(false);
              if (title !== null) usePages.getState().update(id, { title });
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{pageTitle(page)}</span>
        )}
        {!renaming && <Viewers pageId={id} />}

        {!renaming && (
          <span className="touch-flex hidden shrink-0 items-center gap-0.5 group-hover:flex" onPointerDown={stop}>
            <button
              aria-label="Optionen"
              onClick={openMenu}
              className="flex h-5 w-5 items-center justify-center rounded-sm text-muted hover:bg-active"
            >
              <MoreHorizontal size={14} />
            </button>
            {expandable && editable && (
              <button
                aria-label="Unterseite hinzufügen"
                onClick={(e) => {
                  e.stopPropagation();
                  void createPageAndOpen(id);
                }}
                className="flex h-5 w-5 items-center justify-center rounded-sm text-muted hover:bg-active"
              >
                <Plus size={14} />
              </button>
            )}
          </span>
        )}
      </div>

      {menu && (
        <Popover anchor={menu} onClose={closeMenu}>
          <MenuList
            onDone={closeMenu}
            items={[
              ...(expandable && editable
                ? [{ label: 'Unterseite hinzufügen', icon: Plus, onSelect: () => void createPageAndOpen(id) }]
                : []),
              ...(editable ? [{ label: 'Umbenennen', icon: PenLine, onSelect: () => setRenaming(true) }] : []),
              ...(GUEST ? [] : [{ label: 'Duplizieren', icon: CopyPlus, onSelect: () => void duplicateAndOpen(id) }]),
              {
                label: useUI.getState().favorites.includes(id) ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen',
                icon: Star,
                onSelect: () => useUI.getState().toggleFavorite(id),
              },
              {
                label: useUI.getState().homeId === id ? 'Startseite entfernen' : 'Als Startseite festlegen',
                icon: House,
                onSelect: () => useUI.getState().setHome(useUI.getState().homeId === id ? null : id),
              },
              ...(editable
                ? [
                    {
                      label: 'In den Papierkorb',
                      icon: Trash2,
                      danger: true,
                      onSelect: () => void usePages.getState().trash(id),
                    },
                  ]
                : []),
            ]}
          />
        </Popover>
      )}
    </>
  );
});

function RenameInput({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onPointerDown={stop}
      onClick={stop}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(value);
        if (e.key === 'Escape') onDone(null);
      }}
      onBlur={() => onDone(value)}
      className="h-6 min-w-0 flex-1 rounded-sm border border-border-strong bg-bg px-1 text-sm text-text outline-none"
    />
  );
}

/** Kleine Punkte für die anderen, die gerade auf dieser Seite sind. */
function Viewers({ pageId }: { pageId: string }) {
  const people = usePresence(useShallow((s) => s.people.filter((p) => p.pageId === pageId && p.id !== s.me)));
  if (!people.length) return null;
  return (
    <span className="flex shrink-0 -space-x-1 group-hover:hidden" title={people.map((p) => p.name).join(', ')}>
      {people.slice(0, 3).map((p) => (
        <span key={p.id} className="h-2 w-2 rounded-full ring-2 ring-sidebar" style={{ background: p.color }} />
      ))}
    </span>
  );
}
