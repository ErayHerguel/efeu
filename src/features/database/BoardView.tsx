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
} from '@dnd-kit/core';
import { ArrowLeft, ArrowRight, ArrowUpRight, Eye, EyeOff, ListChecks, MoreHorizontal, Pencil, Plus, Trash2, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { pageTitle } from '../../components/PageIcon';
import { TAG_COLORS, type CellValue, type Property, type SelectOption, type TagColor, type View } from '../../db/database';
import { Popover, type Anchor } from '../../components/Popover';
import { COLOR_LABELS } from '../../editor/colors';
import { newId } from '../../lib/ids';
import { confirmDialog } from '../../store/confirm';
import { cx } from '../../lib/cx';
import { nextColor, useDatabases, type DatabaseData } from '../../store/databases';
import { usePages } from '../../store/pages';
import { useUI } from '../../store/ui';
import { BoundCell } from './cells';
import { OptionTag } from './OptionTag';
import { addSubtask, loadSubtasks, toggleSubtask, useSubtasks } from './subtasks';
import { groupRows, type Row } from './query';
import { RowTitle } from './RowTitle';
import { useCanEdit } from '../collab/sources';

interface BoardViewProps {
  databaseId: string;
  view: View;
  data: DatabaseData;
  rows: Row[];
  editingId: string | null;
  onEditingDone: () => void;
  onCreate: (initial: Record<string, CellValue>) => void;
}

const NONE = '__none__';
const columnId = (optionId: string | null) => `column:${optionId ?? NONE}`;

export function BoardView({ databaseId, view, data, rows, editingId, onEditingDone, onCreate }: BoardViewProps) {
  const groupBy = data.properties.find((p) => p.id === view.config.groupBy && p.type === 'select');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const editable = useCanEdit(databaseId);
  const [dragging, setDragging] = useState<string | null>(null);
  const rowKey = rows.map((r) => r.id).join(',');
  // Unteraufgaben (To-dos in den Einträgen) laden, und wieder, wenn man zurück ins Fenster kommt.
  useEffect(() => {
    const ids = rowKey ? rowKey.split(',') : [];
    const load = () => void loadSubtasks(ids).catch(() => undefined);
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [rowKey]);

  if (!groupBy) {
    return <GroupByHint databaseId={databaseId} view={view} data={data} />;
  }

  const hiddenGroups = view.config.hiddenGroups ?? [];
  const allGroups = groupRows(rows, groupBy);
  // „Ohne …“ nur zeigen, wenn dort etwas liegt oder es keine anderen Spalten gibt.
  const groups = allGroups.filter(
    (g) => !hiddenGroups.includes(g.option?.id ?? NONE) && (g.option || g.rows.length > 0 || groupBy.options.length === 0),
  );
  const hidden = allGroups.filter((g) => hiddenGroups.includes(g.option?.id ?? NONE));
  const setHidden = (id: string, hide: boolean) => {
    const current = useDatabases.getState().data[databaseId]?.views.find((v) => v.id === view.id) ?? view;
    const list = current.config.hiddenGroups ?? [];
    useDatabases.getState().updateView({ ...current, config: { ...current.config, hiddenGroups: hide ? [...list, id] : list.filter((x) => x !== id) } });
  };
  const cardProps = data.properties.filter((p) => p.id !== groupBy.id && !view.config.hidden.includes(p.id));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const rowId = String(active.id);
    const overId = String(over.id);
    let optionId: string | null;
    let beforeRow: string | null = null;
    if (overId.startsWith('column:')) {
      const raw = overId.slice('column:'.length);
      optionId = raw === NONE ? null : raw;
    } else {
      beforeRow = overId.slice('card:'.length);
      if (beforeRow === rowId) return;
      const target = rows.find((r) => r.id === beforeRow);
      const value = target?.values[groupBy.id];
      optionId = typeof value === 'string' && groupBy.options.some((o) => o.id === value) ? value : null;
    }
    useDatabases.getState().setValue(databaseId, rowId, groupBy.id, optionId);
    // Manuelle Reihenfolge: vor der Zielkarte einordnen (wirkt, solange keine Sortierung aktiv ist).
    if (beforeRow) {
      const siblings = (usePages.getState().children.get(databaseId) ?? []).filter((id) => id !== rowId);
      void usePages.getState().move(rowId, databaseId, siblings.indexOf(beforeRow));
    }
  };

  const draggedPage = dragging ? usePages.getState().pages[dragging] : undefined;


  return (
    <DndContext
      sensors={editable ? sensors : []}
      collisionDetection={pointerWithin}
      onDragStart={({ active }) => setDragging(String(active.id))}
      onDragCancel={() => setDragging(null)}
      onDragEnd={onDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-4">
        {groups.map((group) => (
          <Column key={group.option?.id ?? NONE} id={columnId(group.option?.id ?? null)} color={group.option?.color ?? null}>
            <ColumnHeader
              property={groupBy}
              option={group.option}
              count={group.rows.length}
              editable={editable}
              onHide={() => setHidden(group.option?.id ?? NONE, true)}
            />
            <div className="flex flex-col gap-1.5">
              {group.rows.map((row) => (
                <Card key={row.id} row={row} dimmed={dragging === row.id}>
                  <RowTitle rowId={row.id} editing={editingId === row.id} onEditingDone={onEditingDone} className="-mx-2 w-[calc(100%+16px)]" />
                  {cardProps.map((p) => (
                    <div key={p.id} className="-mx-2">
                      <BoundCell databaseId={databaseId} rowId={row.id} property={p} variant="card" />
                    </div>
                  ))}
                  <Subtasks rowId={row.id} editable={editable} />
                </Card>
              ))}
            </div>
            <button
              onClick={() => onCreate({ [groupBy.id]: group.option?.id ?? null })}
              className="db-edit mt-1 flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-sm text-faint hover:bg-hover hover:text-muted"
            >
              <Plus size={14} /> Neu
            </button>
          </Column>
        ))}
        {editable && <AddColumn property={groupBy} />}
        {hidden.length > 0 && (
          <div className="w-[180px] shrink-0 px-1 pt-1.5">
            <div className="mb-1.5 text-xs text-faint">Ausgeblendet</div>
            {hidden.map((g) => (
              <button
                key={g.option?.id ?? NONE}
                title="Wieder anzeigen"
                onClick={() => setHidden(g.option?.id ?? NONE, false)}
                className="flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-hover"
              >
                <Eye size={14} className="shrink-0 text-faint" />
                {g.option ? <OptionTag option={g.option} /> : <span className="truncate text-xs text-muted">Ohne {groupBy.name}</span>}
                <span className="ml-auto text-xs text-faint">{g.rows.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <DragOverlay dropAnimation={null}>
        {draggedPage && (
          <div className="w-[248px] rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium shadow-popover">
            {pageTitle(draggedPage)}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function Column({ id, color, children }: { id: string; color: TagColor | null; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      style={!isOver && color ? { background: `color-mix(in srgb, var(--c-tag-${color}-bg) 45%, transparent)` } : undefined}
      className={cx('w-[264px] shrink-0 rounded-lg p-1.5 transition-colors', isOver ? 'bg-accent-soft' : 'bg-hover/60')}
    >
      {children}
    </div>
  );
}

/** Spaltenkopf: Name (Doppelklick benennt um), Anzahl und Menü mit Farbe, Reihenfolge, Ausblenden, Löschen. */
function ColumnHeader({
  property,
  option,
  count,
  editable,
  onHide,
}: {
  property: Property;
  option: SelectOption | null;
  count: number;
  editable: boolean;
  onHide: () => void;
}) {
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [renaming, setRenaming] = useState(false);
  const store = useDatabases.getState;
  const current = () => store().data[property.databaseId]?.properties.find((p) => p.id === property.id) ?? property;
  const update = (options: SelectOption[]) => store().updateProperty({ ...current(), options });
  const index = option ? property.options.findIndex((o) => o.id === option.id) : -1;

  const rename = (name: string) => {
    setRenaming(false);
    const clean = name.trim();
    if (!option || !clean || clean === option.name) return;
    update(current().options.map((o) => (o.id === option.id ? { ...o, name: clean } : o)));
  };
  const move = (by: -1 | 1) => {
    const options = [...current().options];
    const from = options.findIndex((o) => o.id === option?.id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= options.length) return;
    [options[from], options[to]] = [options[to], options[from]];
    update(options);
  };
  const remove = async () => {
    if (!option) return;
    const ok = await confirmDialog({
      title: `Spalte „${option.name}“ löschen?`,
      message: count ? `Die ${count} Einträge darin landen unter „Ohne ${property.name}“.` : 'Die Spalte ist leer.',
      confirmLabel: 'Löschen',
      danger: true,
    });
    if (ok) await store().deleteOption(current(), option.id);
  };

  return (
    <div className="group/head mb-2 flex h-7 items-center gap-2 px-1">
      {renaming && option ? (
        <input
          autoFocus
          defaultValue={option.name}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => rename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') rename(e.currentTarget.value);
            if (e.key === 'Escape') setRenaming(false);
          }}
          className="h-6 min-w-0 flex-1 rounded-sm bg-bg px-1.5 text-xs outline-none ring-1 ring-accent"
        />
      ) : option ? (
        <button className="min-w-0 truncate" title={editable ? 'Doppelklick: umbenennen' : undefined} onDoubleClick={() => editable && setRenaming(true)}>
          <OptionTag option={option} />
        </button>
      ) : (
        <span className="truncate text-xs text-muted">Ohne {property.name}</span>
      )}
      <span className="text-xs text-faint">{count}</span>
      {editable && (
        <button
          aria-label="Spaltenmenü"
          title="Spalte bearbeiten"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
          }}
          className="db-edit ml-auto flex h-6 w-6 items-center justify-center rounded-md text-faint opacity-0 hover:bg-hover hover:text-text group-hover/head:opacity-100 focus-visible:opacity-100"
        >
          <MoreHorizontal size={15} />
        </button>
      )}
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} placement="bottom-end">
          <div className="w-[220px] p-1">
            {option && (
              <>
                <MenuButton icon={Pencil} label="Umbenennen" onClick={() => (setMenu(null), setRenaming(true))} />
                {index > 0 && <MenuButton icon={ArrowLeft} label="Nach links" onClick={() => (setMenu(null), move(-1))} />}
                {index < property.options.length - 1 && <MenuButton icon={ArrowRight} label="Nach rechts" onClick={() => (setMenu(null), move(1))} />}
              </>
            )}
            <MenuButton icon={EyeOff} label="Ausblenden" onClick={() => (setMenu(null), onHide())} />
            {option && (
              <>
                <div className="px-2 pb-1 pt-2 text-2xs text-faint">Farbe</div>
                <div className="flex flex-wrap gap-1 px-2 pb-2">
                  {TAG_COLORS.map((color) => (
                    <button
                      key={color}
                      title={COLOR_LABELS[color]}
                      aria-label={`Farbe ${COLOR_LABELS[color]}`}
                      onClick={() => update(current().options.map((o) => (o.id === option.id ? { ...o, color } : o)))}
                      className={cx('h-6 w-6 rounded-md border', option.color === color ? 'border-accent' : 'border-transparent')}
                      style={{ background: `var(--c-tag-${color}-bg)` }}
                    />
                  ))}
                </div>
                <MenuButton icon={Trash2} label="Spalte löschen" danger onClick={() => (setMenu(null), void remove())} />
              </>
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}

function MenuButton({ icon: Icon, label, onClick, danger }: { icon: LucideIcon; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cx('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-hover', danger ? 'text-danger' : 'text-text')}>
      <Icon size={15} className={danger ? '' : 'text-muted'} />
      {label}
    </button>
  );
}

/** Neue Spalte = neue Option der Auswahl-Property. */
function AddColumn({ property }: { property: Property }) {
  const [adding, setAdding] = useState(false);
  const add = (name: string) => {
    const clean = name.trim();
    setAdding(false);
    if (!clean) return;
    const current = useDatabases.getState().data[property.databaseId]?.properties.find((p) => p.id === property.id) ?? property;
    if (current.options.some((o) => o.name.toLowerCase() === clean.toLowerCase())) return;
    useDatabases.getState().updateProperty({ ...current, options: [...current.options, { id: newId(), name: clean, color: nextColor(current.options.length) }] });
  };
  return (
    <div className="w-[220px] shrink-0 pt-1.5">
      {adding ? (
        <input
          autoFocus
          placeholder="Name der Spalte"
          onBlur={(e) => add(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add(e.currentTarget.value);
            if (e.key === 'Escape') setAdding(false);
          }}
          className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-border-strong"
        />
      ) : (
        <button onClick={() => setAdding(true)} className="db-edit flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-sm text-faint hover:bg-hover hover:text-muted">
          <Plus size={14} /> Spalte hinzufügen
        </button>
      )}
    </div>
  );
}

function Card({ row, dimmed, children }: { row: Row; dimmed: boolean; children: React.ReactNode }) {
  const drag = useDraggable({ id: row.id });
  const drop = useDroppable({ id: `card:${row.id}` });
  return (
    <div
      ref={(node) => {
        drag.setNodeRef(node);
        drop.setNodeRef(node);
      }}
      {...drag.listeners}
      {...drag.attributes}
      className={cx(
        'group relative flex flex-col gap-0.5 rounded-md border border-border bg-bg px-2 py-1 shadow-[0_1px_2px_rgb(0_0_0/0.04)]',
        dimmed && 'opacity-40',
        drop.isOver && !dimmed && 'before:absolute before:inset-x-0 before:-top-1 before:h-0.5 before:rounded-full before:bg-accent',
      )}
    >
      {children}
      <button
        aria-label="Seite öffnen"
        title="Seite öffnen"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => useUI.getState().open(row.id)}
        className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface text-muted opacity-0 hover:text-text group-hover:opacity-100 focus-visible:opacity-100"
      >
        <ArrowUpRight size={13} />
      </button>
    </div>
  );
}

function GroupByHint({ databaseId, view, data }: { databaseId: string; view: View; data: DatabaseData }) {
  const selects = data.properties.filter((p: Property) => p.type === 'select');
  const store = useDatabases.getState();
  return (
    <div className="rounded-lg border border-dashed border-border-strong px-6 py-8 text-center text-sm text-muted">
      <p>Ein Board gruppiert Einträge nach einer Auswahl-Property.</p>
      <div className="mt-3 flex justify-center gap-2">
        {selects.map((p) => (
          <button
            key={p.id}
            onClick={() => store.updateView({ ...view, config: { ...view.config, groupBy: p.id } })}
            className="h-8 rounded-md border border-border px-3 hover:bg-hover"
          >
            Nach „{p.name}“ gruppieren
          </button>
        ))}
        {selects.length === 0 && (
          <button
            onClick={async () => {
              const id = await store.addProperty(databaseId, 'select');
              const current = useDatabases.getState().data[databaseId]?.views.find((v) => v.id === view.id) ?? view;
              store.updateView({ ...current, config: { ...current.config, groupBy: id } });
            }}
            className="h-8 rounded-md bg-accent px-3 font-medium text-accent-fg"
          >
            Auswahl-Property anlegen
          </button>
        )}
      </div>
    </div>
  );
}

/** Unteraufgaben auf der Karte: Fortschritt, aufklappbar zum Abhaken und Ergänzen. */
function Subtasks({ rowId, editable }: { rowId: string; editable: boolean }) {
  const tasks = useSubtasks((s) => s.byRow[rowId]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  if (!tasks) return null;
  const done = tasks.filter((t) => t.checked).length;
  const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();
  const add = (text: string) => {
    void addSubtask(rowId, text);
  };
  if (!tasks.length && !open) {
    return editable ? (
      <button
        onPointerDown={stop}
        onClick={() => {
          setOpen(true);
          setAdding(true);
        }}
        className="db-edit -mx-1 flex h-6 items-center gap-1 rounded px-1 text-xs text-faint opacity-0 hover:bg-hover hover:text-muted group-hover:opacity-100"
      >
        <Plus size={12} /> Unteraufgabe
      </button>
    ) : null;
  }
  return (
    <div className="-mx-1 mt-0.5" onPointerDown={stop}>
      {tasks.length > 0 && (
        <button onClick={() => setOpen((v) => !v)} className="flex h-6 w-full items-center gap-1.5 rounded px-1 text-xs text-muted hover:bg-hover" title="Unteraufgaben">
          <ListChecks size={13} className={done === tasks.length ? 'text-[#30a46c]' : 'text-faint'} />
          <span>
            {done}/{tasks.length}
          </span>
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-hover">
            <span className="block h-full rounded-full bg-[#30a46c]" style={{ width: `${(done / tasks.length) * 100}%` }} />
          </span>
        </button>
      )}
      {open && (
        <div className="mt-0.5 flex flex-col">
          {tasks.map((t, i) => (
            <label key={i} className="flex min-h-6 cursor-pointer items-start gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-hover">
              <input
                type="checkbox"
                checked={t.checked}
                disabled={!editable}
                onChange={(e) => void toggleSubtask(rowId, i, e.target.checked)}
                className="mt-0.5 accent-[var(--c-accent)]"
              />
              <span className={cx('min-w-0 flex-1 break-words', t.checked && 'text-faint line-through')}>{t.text || 'Ohne Text'}</span>
            </label>
          ))}
          {editable &&
            (adding ? (
              <input
                autoFocus
                placeholder="Unteraufgabe …"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                    add(e.currentTarget.value);
                    e.currentTarget.value = '';
                  }
                  if (e.key === 'Escape') setAdding(false);
                }}
                onBlur={(e) => {
                  if (e.target.value.trim()) add(e.target.value);
                  setAdding(false);
                }}
                className="mx-1 h-6 rounded border border-border bg-surface px-1.5 text-xs outline-none focus:border-border-strong"
              />
            ) : (
              <button onClick={() => setAdding(true)} className="flex h-6 items-center gap-1 rounded px-1 text-xs text-faint hover:bg-hover hover:text-muted">
                <Plus size={12} /> Unteraufgabe
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
