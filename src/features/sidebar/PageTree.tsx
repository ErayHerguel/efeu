import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { ChevronRight, FolderPlus, MoreHorizontal, PenLine, Plus, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { MenuList } from '../../components/MenuList';
import { PageIcon, pageTitle } from '../../components/PageIcon';
import { Popover, pointAnchor, type Anchor } from '../../components/Popover';
import type { Category } from '../../db/categories';
import type { Space } from '../../db/pages';
import { cx } from '../../lib/cx';
import { GUEST } from '../../lib/mode';
import { isSelfOrDescendant, rootOf, type ChildIndex, type PageMap } from '../../lib/tree';
import { confirmDialog } from '../../store/confirm';
import { toast } from '../../store/toast';
import { useCloud } from '../cloud/cloud';
import { canContain, groupOf, groupRoots, spaceCategories, usePages, type Group } from '../../store/pages';
import { useUI } from '../../store/ui';
import { createPageAndOpen } from '../actions';
import { TreeRow, type DropPosition } from './TreeRow';

export const SPACE_LABEL: Record<Space, string> = {
  team: 'Team',
  private: 'Privat',
  local: 'Nur auf diesem Computer',
};

const SPACE_HINT: Record<Space, string> = {
  team: 'Sehen alle im Team',
  private: 'Nur du, auf all deinen Geräten',
  local: 'Verlässt diesen Computer nie',
};

type Row =
  | { kind: 'section'; space: Space }
  | { kind: 'category'; category: Category }
  | { kind: 'page'; id: string; depth: number }
  | { kind: 'empty'; parentId: string; depth: number }
  | { kind: 'emptyGroup'; group: Group };

export interface DropTarget {
  id: string;
  position: DropPosition;
}

const ROOT_END = '__root_end__';
const catKey = (id: string) => `cat:${id}`;
const spaceKey = (space: Space) => `space:${space}`;
const groupKey = (g: Group) => `group:${g.space}:${g.categoryId ?? ''}`;

function parseGroupKey(key: string): Group | null {
  const m = /^group:(team|private|local):(.*)$/.exec(key);
  return m ? { space: m[1] as Space, categoryId: m[2] || null } : null;
}

function flatten(
  spaces: Space[],
  headers: boolean,
  children: ChildIndex,
  pages: PageMap,
  categories: Record<string, Category>,
  expanded: Record<string, true>,
  collapsed: Record<string, true>,
): Row[] {
  const rows: Row[] = [];
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      rows.push({ kind: 'page', id, depth });
      // Einträge einer Datenbank erscheinen nicht im Baum, sondern in der Datenbank selbst.
      if (!expanded[id] || pages[id]?.type !== 'page') continue;
      const kids = children.get(id) ?? [];
      if (kids.length) walk(kids, depth + 1);
      else rows.push({ kind: 'empty', parentId: id, depth: depth + 1 });
    }
  };
  for (const space of spaces) {
    if (headers) {
      rows.push({ kind: 'section', space });
      if (collapsed[spaceKey(space)]) continue;
    }
    walk(groupRoots(pages, children, categories, { space, categoryId: null }), 0);
    for (const category of spaceCategories(categories, space)) {
      rows.push({ kind: 'category', category });
      if (collapsed[catKey(category.id)]) continue;
      const inside = groupRoots(pages, children, categories, { space, categoryId: category.id });
      if (inside.length) walk(inside, 0);
      else rows.push({ kind: 'emptyGroup', group: { space, categoryId: category.id } });
    }
  }
  return rows;
}

/** Fragt nach, bevor Seiten für andere sichtbar werden oder Geräte verlassen. */
async function confirmSpaceChange(from: Space, to: Space, what: string): Promise<boolean> {
  if (from === to) return true;
  if (from === 'team' && useCloud.getState().role === 'member') {
    toast('Seiten aus dem Team bleiben im Team. Nur wer die Cloud betreibt, kann sie herausnehmen.');
    return false;
  }
  if (to === 'team') {
    return confirmDialog({ title: `${what} fürs Team freigeben?`, message: 'Alle im Team können es dann sehen und bearbeiten.', confirmLabel: 'Freigeben' });
  }
  if (from === 'team') {
    return confirmDialog({ title: `${what} aus dem Team nehmen?`, message: 'Die anderen im Team sehen es danach nicht mehr.', confirmLabel: 'Verschieben' });
  }
  if (to === 'local') {
    return confirmDialog({
      title: `${what} nur auf diesem Computer behalten?`,
      message: 'Es verschwindet von deinen anderen Geräten und aus der Cloud, bleibt hier aber erhalten.',
      confirmLabel: 'Verschieben',
    });
  }
  return true;
}

/**
 * Seitenbaum der Seitenleiste. Mit `headers` in Bereiche (Team, Privat, nur hier) gegliedert; in jedem
 * Bereich gibt es Kategorien wie Kanäle bei Discord. Seiten und Kategorien lassen sich frei verschieben.
 */
export function PageTree({ spaces, headers }: { spaces: Space[]; headers: boolean }) {
  const pages = usePages((s) => s.pages);
  const children = usePages((s) => s.children);
  const categories = usePages((s) => s.categories);
  const expanded = useUI((s) => s.expanded);
  const collapsed = useUI((s) => s.collapsed);
  const rows = useMemo(
    () => flatten(spaces, headers, children, pages, categories, expanded, collapsed),
    [spaces, headers, children, pages, categories, expanded, collapsed],
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const computeTarget = useCallback(
    (e: DragMoveEvent): DropTarget | null => {
      const { over, active } = e;
      if (!over) return null;
      const overId = String(over.id);
      const dragged = String(active.id);
      const pointerY = (e.activatorEvent as PointerEvent).clientY + e.delta.y;
      const rel = (pointerY - over.rect.top) / over.rect.height;

      if (dragged.startsWith('cat:')) {
        // Kategorien: vor/nach anderen Kategorien oder ans Ende eines Bereichs.
        if (overId.startsWith('space:')) return { id: overId, position: 'inside' };
        if (overId.startsWith('cat:') && overId !== dragged) return { id: overId, position: rel < 0.5 ? 'before' : 'after' };
        return null;
      }
      if (overId === ROOT_END || overId.startsWith('space:') || overId.startsWith('cat:') || overId.startsWith('group:')) {
        return { id: overId, position: 'inside' };
      }
      if (overId === dragged) return null;
      const overPage = pages[overId];
      if (!overPage) return null;
      let position: DropPosition = rel < 0.28 ? 'before' : rel > 0.72 ? 'after' : 'inside';
      if (position === 'inside' && !canContain(overPage.type, pages[dragged]?.type)) position = rel < 0.5 ? 'before' : 'after';
      const parentId = position === 'inside' ? overId : overPage.parentId;
      if (isSelfOrDescendant(pages, dragged, parentId)) return null;
      return { id: overId, position };
    },
    [pages],
  );

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragMove = (e: DragMoveEvent) => setTarget(computeTarget(e));
  const reset = () => {
    setActiveId(null);
    setTarget(null);
  };

  const dropCategory = async (id: string, drop: DropTarget) => {
    const category = categories[id];
    if (!category) return;
    let space: Space;
    let index: number;
    if (drop.id.startsWith('space:')) {
      space = drop.id.slice(6) as Space;
      index = Number.MAX_SAFE_INTEGER;
    } else {
      const over = categories[drop.id.slice(4)];
      if (!over) return;
      space = over.space;
      const list = spaceCategories(categories, space).filter((c) => c.id !== id);
      index = list.findIndex((c) => c.id === over.id) + (drop.position === 'after' ? 1 : 0);
    }
    if (!(await confirmSpaceChange(category.space, space, `„${category.name}“`))) return;
    await usePages.getState().moveCategory(id, space, index);
  };

  const dropPage = async (dragged: string, drop: DropTarget) => {
    const { move, moveToGroup } = usePages.getState();
    const { setExpanded, setCollapsed } = useUI.getState();
    const from = pages[rootOf(pages, dragged)]?.space ?? 'private';
    const what = `„${pageTitle(pages[dragged])}“`;
    const toGroup = async (group: Group, index: number) => {
      if (!(await confirmSpaceChange(from, group.space, what))) return;
      await moveToGroup(dragged, group, index);
    };
    if (drop.id === ROOT_END) return toGroup({ space: spaces[spaces.length - 1], categoryId: null }, Number.MAX_SAFE_INTEGER);
    if (drop.id.startsWith('space:')) {
      const space = drop.id.slice(6) as Space;
      setCollapsed(spaceKey(space), false);
      return toGroup({ space, categoryId: null }, Number.MAX_SAFE_INTEGER);
    }
    if (drop.id.startsWith('cat:')) {
      const category = categories[drop.id.slice(4)];
      if (!category) return;
      setCollapsed(drop.id, false);
      return toGroup({ space: category.space, categoryId: category.id }, Number.MAX_SAFE_INTEGER);
    }
    const group = parseGroupKey(drop.id);
    if (group) return toGroup(group, 0);

    const over = pages[drop.id];
    if (!over) return;
    const overHasVisibleChildren = expanded[drop.id] && (children.get(drop.id)?.length ?? 0) > 0;
    const to = pages[rootOf(pages, drop.id)]?.space ?? 'private';
    if (drop.position === 'inside' || (drop.position === 'after' && overHasVisibleChildren)) {
      // "Nach" einer aufgeklappten Seite heißt optisch: als erstes Kind.
      if (!(await confirmSpaceChange(from, to, what))) return;
      await move(dragged, drop.id, drop.position === 'inside' ? Number.MAX_SAFE_INTEGER : 0);
      setExpanded(drop.id, true);
      return;
    }
    if (over.parentId === null) {
      const target = groupOf(over, categories);
      const siblings = groupRoots(pages, children, categories, target).filter((id) => id !== dragged);
      return toGroup(target, siblings.indexOf(drop.id) + (drop.position === 'after' ? 1 : 0));
    }
    if (!(await confirmSpaceChange(from, to, what))) return;
    const siblings = (children.get(over.parentId) ?? []).filter((id) => id !== dragged);
    await move(dragged, over.parentId, siblings.indexOf(drop.id) + (drop.position === 'after' ? 1 : 0));
  };

  const onDragEnd = (e: DragEndEvent) => {
    const dragged = String(e.active.id);
    const drop = target;
    reset();
    if (!drop) return;
    if (dragged.startsWith('cat:')) void dropCategory(dragged.slice(4), drop);
    else void dropPage(dragged, drop);
  };

  const newCategory = async (space: Space) => {
    useUI.getState().setCollapsed(spaceKey(space), false);
    const id = await usePages.getState().createCategory(space, 'Neue Kategorie');
    setRenaming(id);
  };

  const draggedPage = activeId && !activeId.startsWith('cat:') ? pages[activeId] : undefined;
  const draggedCategory = activeId?.startsWith('cat:') ? categories[activeId.slice(4)] : undefined;

  /** Pfeiltasten: hoch/runter wandern, rechts aufklappen bzw. ins Kind, links zuklappen bzw. zum Elternteil. */
  const onTreeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const current = (e.target as HTMLElement).closest<HTMLElement>('[data-tree-id]');
    if (!current || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    const id = current.dataset.treeId!;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-tree-id]')];
    const index = all.indexOf(current);
    const focus = (el: HTMLElement | undefined) => el?.focus();
    const page = pages[id];
    const canExpand = page?.type === 'page';
    if (e.key === 'Escape') useUI.getState().requestFocus('editor');
    else if (e.key === 'ArrowDown') focus(all[index + 1]);
    else if (e.key === 'ArrowUp') focus(all[index - 1]);
    else if (e.key === 'ArrowRight') {
      if (canExpand && !expanded[id]) useUI.getState().setExpanded(id, true);
      else focus(all[index + 1]);
    } else if (e.key === 'ArrowLeft') {
      if (expanded[id]) useUI.getState().setExpanded(id, false);
      else if (page?.parentId) focus(all.find((el) => el.dataset.treeId === page.parentId));
    }
  };

  const pageCount = rows.filter((r) => r.kind === 'page').length;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
    >
      <div role="tree" className="flex flex-col" onKeyDown={onTreeKey}>
        {rows.map((row) => {
          if (row.kind === 'section') {
            return (
              <SectionHeader
                key={spaceKey(row.space)}
                space={row.space}
                drop={target?.id === spaceKey(row.space)}
                onNewCategory={() => void newCategory(row.space)}
              />
            );
          }
          if (row.kind === 'category') {
            return (
              <CategoryHeader
                key={catKey(row.category.id)}
                category={row.category}
                drop={target?.id === catKey(row.category.id) ? target.position : null}
                dimmed={activeId === catKey(row.category.id)}
                renaming={renaming === row.category.id}
                onRenamed={() => setRenaming(null)}
                onRename={() => setRenaming(row.category.id)}
              />
            );
          }
          if (row.kind === 'page') {
            return (
              <TreeRow key={row.id} id={row.id} depth={row.depth} drop={target?.id === row.id ? target.position : null} dimmed={activeId === row.id} />
            );
          }
          if (row.kind === 'emptyGroup') {
            return <EmptyGroup key={groupKey(row.group)} group={row.group} active={target?.id === groupKey(row.group)} />;
          }
          return (
            <div key={`empty-${row.parentId}`} className="flex h-7 items-center text-xs text-faint" style={{ paddingLeft: 30 + row.depth * 14 }}>
              Keine Unterseiten
            </div>
          );
        })}
        {pageCount === 0 && !headers && <div className="px-2 py-1 text-xs text-faint">Noch keine Seiten</div>}
        <RootDropZone active={target?.id === ROOT_END} />
      </div>
      <DragOverlay dropAnimation={null}>
        {draggedPage && (
          <div className="flex h-7 w-[220px] items-center gap-2 rounded-md bg-surface px-2 text-sm shadow-popover">
            <PageIcon page={draggedPage} />
            <span className="truncate">{pageTitle(draggedPage)}</span>
          </div>
        )}
        {draggedCategory && (
          <div className="flex h-7 w-[220px] items-center gap-1 rounded-md bg-surface px-2 text-xs font-medium text-muted shadow-popover">
            <ChevronRight size={12} className="rotate-90" />
            <span className="truncate">{draggedCategory.name}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

function useMenu() {
  const [menu, setMenu] = useState<Anchor | null>(null);
  const open = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(pointAnchor(e.clientX, e.clientY));
  };
  return { menu, open, close: () => setMenu(null) };
}

function SectionHeader({ space, drop, onNewCategory }: { space: Space; drop: boolean; onNewCategory: () => void }) {
  const collapsed = useUI((s) => Boolean(s.collapsed[spaceKey(space)]));
  const { setNodeRef } = useDroppable({ id: spaceKey(space) });
  const { menu, open, close } = useMenu();
  const newPage = () => void createPageAndOpen(null, { space, categoryId: null });
  return (
    <>
      <div
        ref={setNodeRef}
        title={SPACE_HINT[space]}
        onClick={() => useUI.getState().setCollapsed(spaceKey(space), !collapsed)}
        onContextMenu={open}
        className={cx(
          'group mt-3 flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 text-2xs font-semibold tracking-wide text-faint uppercase first:mt-0 hover:text-muted',
          drop && 'bg-accent-soft text-text',
        )}
      >
        <ChevronRight size={12} className={cx('shrink-0 transition-transform', !collapsed && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate">{SPACE_LABEL[space]}</span>
        <span className="touch-flex hidden items-center gap-0.5 group-hover:flex" onPointerDown={stop}>
          <button
            aria-label="Kategorie anlegen"
            title="Kategorie anlegen"
            onClick={(e) => {
              stop(e);
              onNewCategory();
            }}
            className="flex h-5 w-5 items-center justify-center rounded-sm hover:bg-active"
          >
            <FolderPlus size={13} />
          </button>
          <button
            aria-label={`Neue Seite in „${SPACE_LABEL[space]}“`}
            title="Neue Seite"
            onClick={(e) => {
              stop(e);
              newPage();
            }}
            className="flex h-5 w-5 items-center justify-center rounded-sm hover:bg-active"
          >
            <Plus size={14} />
          </button>
        </span>
      </div>
      {menu && (
        <Popover anchor={menu} onClose={close}>
          <MenuList
            onDone={close}
            items={[
              { label: 'Neue Seite', icon: Plus, onSelect: newPage },
              { label: 'Kategorie anlegen', icon: FolderPlus, onSelect: onNewCategory },
            ]}
          />
        </Popover>
      )}
    </>
  );
}

function CategoryHeader({
  category,
  drop,
  dimmed,
  renaming,
  onRename,
  onRenamed,
}: {
  category: Category;
  drop: DropPosition | null;
  dimmed: boolean;
  renaming: boolean;
  onRename: () => void;
  onRenamed: () => void;
}) {
  const key = catKey(category.id);
  const collapsed = useUI((s) => Boolean(s.collapsed[key]));
  // Im Browser (Gast, Team-Mitglied) ordnet der Inhaber die Kategorien.
  const drag = useDraggable({ id: key, disabled: renaming || GUEST });
  const dropZone = useDroppable({ id: key });
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      drag.setNodeRef(node);
      dropZone.setNodeRef(node);
    },
    [drag.setNodeRef, dropZone.setNodeRef],
  );
  const { menu, open, close } = useMenu();
  const group: Group = { space: category.space, categoryId: category.id };
  const newPage = () => void createPageAndOpen(null, group);
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Kategorie „${category.name}“ entfernen?`,
      message: 'Die Seiten darin bleiben erhalten und stehen danach ohne Kategorie im selben Bereich.',
      confirmLabel: 'Entfernen',
    });
    if (ok) await usePages.getState().deleteCategory(category.id);
  };
  return (
    <>
      <div
        ref={setRef}
        {...drag.listeners}
        {...drag.attributes}
        role="button"
        aria-expanded={!collapsed}
        onClick={() => useUI.getState().setCollapsed(key, !collapsed)}
        onDoubleClick={GUEST ? undefined : onRename}
        onContextMenu={GUEST ? undefined : open}
        className={cx(
          'group relative mt-1.5 flex h-7 shrink-0 items-center gap-1 rounded-md pr-1 pl-1 text-xs font-medium text-faint outline-none hover:bg-hover hover:text-muted',
          drop === 'inside' && 'bg-accent-soft text-text',
          dimmed && 'opacity-40',
        )}
      >
        {drop === 'before' && <div className="absolute inset-x-1 -top-px h-0.5 rounded-full bg-accent" />}
        {drop === 'after' && <div className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent" />}
        <ChevronRight size={12} className={cx('shrink-0 transition-transform', !collapsed && 'rotate-90')} />
        {renaming ? (
          <input
            autoFocus
            defaultValue={category.name}
            aria-label="Name der Kategorie"
            onFocus={(e) => e.currentTarget.select()}
            onPointerDown={stop}
            onClick={stop}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') onRenamed();
            }}
            onBlur={(e) => {
              void usePages.getState().renameCategory(category.id, e.currentTarget.value);
              onRenamed();
            }}
            className="h-6 min-w-0 flex-1 rounded-sm border border-border-strong bg-bg px-1 text-sm text-text outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{category.name}</span>
        )}
        {!renaming && (
          <span className="touch-flex hidden shrink-0 items-center gap-0.5 group-hover:flex" onPointerDown={stop}>
            {!GUEST && (
              <button aria-label="Optionen" onClick={open} className="flex h-5 w-5 items-center justify-center rounded-sm hover:bg-active">
                <MoreHorizontal size={14} />
              </button>
            )}
            <button
              aria-label={`Neue Seite in „${category.name}“`}
              onClick={(e) => {
                stop(e);
                newPage();
              }}
              className="flex h-5 w-5 items-center justify-center rounded-sm hover:bg-active"
            >
              <Plus size={14} />
            </button>
          </span>
        )}
      </div>
      {menu && (
        <Popover anchor={menu} onClose={close}>
          <MenuList
            onDone={close}
            items={[
              { label: 'Neue Seite', icon: Plus, onSelect: newPage },
              { label: 'Umbenennen', icon: PenLine, onSelect: onRename },
              { label: 'Kategorie entfernen', icon: Trash2, danger: true, onSelect: () => void remove() },
            ]}
          />
        </Popover>
      )}
    </>
  );
}

function EmptyGroup({ group, active }: { group: Group; active: boolean }) {
  const { setNodeRef } = useDroppable({ id: groupKey(group) });
  return (
    <div ref={setNodeRef} className={cx('flex h-7 items-center rounded-md pl-[26px] text-xs text-faint', active && 'bg-accent-soft text-text')}>
      Seiten hierher ziehen
    </div>
  );
}

function RootDropZone({ active }: { active: boolean }) {
  const { setNodeRef } = useDroppable({ id: ROOT_END });
  return (
    <div ref={setNodeRef} className="relative h-8">
      {active && <div className="absolute inset-x-1 top-0 h-0.5 rounded-full bg-accent" />}
    </div>
  );
}
