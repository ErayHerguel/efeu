import { create } from 'zustand';
import type { Statement } from '../db/driver';
import {
  deleteCategory as deleteCategoryRow,
  insertCategory,
  loadCategories,
  placeCategory,
  renameCategory as renameCategoryRow,
  type Category,
} from '../db/categories';
import {
  deletePage,
  insertPage,
  loadPages,
  placePage,
  placeRoot,
  setDeleted,
  updatePage,
  type PageMeta,
  type PagePatch,
  type PageType,
  type Space,
} from '../db/pages';
import { commit, discard, schedule } from '../db/saveQueue';
import { newId } from '../lib/ids';
import {
  buildChildIndex,
  descendantIds,
  rootOf,
  insertAt,
  isSelfOrDescendant,
  trashRoots,
  type ChildIndex,
  type PageMap,
} from '../lib/tree';
import { reportError } from './toast';

export interface CreateOptions {
  parentId?: string | null;
  type?: PageType;
  title?: string;
  icon?: string | null;
  index?: number;
  /** Nur für oberste Seiten: Bereich und Kategorie (sonst der Standardbereich, ohne Kategorie) */
  space?: Space;
  categoryId?: string | null;
  /** Zusätzliche Anweisungen, die in derselben Transaktion laufen (z. B. Inhalt oder Datenbank-Werte). */
  extra?: (page: PageMeta) => Statement[];
}

/** Wo eine oberste Seite steht: Bereich und Kategorie (null = ohne Kategorie). */
export interface Group {
  space: Space;
  categoryId: string | null;
}

interface PagesState {
  pages: PageMap;
  children: ChildIndex;
  categories: Record<string, Category>;
  /** Bereich für neue oberste Seiten ohne Angabe (mit eigener Cloud „privat“, als Team-Mitglied „Team“) */
  defaultSpace: Space;
  load(): Promise<void>;
  create(options?: CreateOptions): Promise<string>;
  update(id: string, patch: PagePatch): void;
  move(id: string, parentId: string | null, index: number): Promise<void>;
  /** Als oberste Seite in einen Bereich und eine Kategorie verschieben (samt Unterseiten). */
  moveToGroup(id: string, group: Group, index: number): Promise<void>;
  createCategory(space: Space, name: string): Promise<string>;
  renameCategory(id: string, name: string): Promise<void>;
  /** Kategorie umsortieren oder in einen anderen Bereich verschieben (ihre Seiten ziehen mit). */
  moveCategory(id: string, space: Space, index: number): Promise<void>;
  /** Kategorie entfernen; ihre Seiten bleiben ohne Kategorie im selben Bereich. */
  deleteCategory(id: string): Promise<void>;
  trash(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  deleteForever(id: string): Promise<void>;
  emptyTrash(): Promise<void>;
}

/**
 * Darf eine Seite dieses Typs unter `parent` liegen? Normale Seiten nehmen alles auf, Datenbanken nur Seiten
 * (sie werden zu Einträgen), Boards haben keine Unterseiten.
 */
export function canContain(parent: PageType | undefined, child: PageType | undefined): boolean {
  if (parent === 'page') return true;
  return parent === 'database' && child === 'page';
}

/** Kategorie einer obersten Seite; verweist sie auf eine fehlende Kategorie, gilt sie als ohne. */
export function groupOf(page: PageMeta, categories: Record<string, Category>): Group {
  const category = page.categoryId ? categories[page.categoryId] : undefined;
  return { space: page.space, categoryId: category && category.space === page.space ? category.id : null };
}

/** Oberste Seiten einer Gruppe in Reihenfolge. */
export function groupRoots(pages: PageMap, children: ChildIndex, categories: Record<string, Category>, group: Group): string[] {
  return (children.get(null) ?? []).filter((id) => {
    const g = groupOf(pages[id], categories);
    return g.space === group.space && g.categoryId === group.categoryId;
  });
}

/** Kategorien eines Bereichs in Reihenfolge. */
export function spaceCategories(categories: Record<string, Category>, space: Space): Category[] {
  return Object.values(categories)
    .filter((c) => c.space === space)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Vergibt fortlaufende sort_order-Werte innerhalb einer Gruppe oberster Seiten. */
function reorderRoots(pages: PageMap, group: Group, ordered: string[]) {
  const next = { ...pages };
  const statements: Statement[] = [];
  ordered.forEach((id, sortOrder) => {
    const page = next[id];
    if (page.parentId === null && page.space === group.space && page.categoryId === group.categoryId && page.sortOrder === sortOrder) return;
    next[id] = { ...page, parentId: null, space: group.space, categoryId: group.categoryId, sortOrder };
    statements.push(placeRoot(id, group.space, group.categoryId, sortOrder));
  });
  return { next, statements };
}

/** Vergibt fortlaufende sort_order-Werte und liefert nur die nötigen UPDATEs. */
function reorder(pages: PageMap, parentId: string | null, ordered: string[]) {
  const next = { ...pages };
  const statements: Statement[] = [];
  ordered.forEach((id, sortOrder) => {
    const page = next[id];
    if (page.parentId === parentId && page.sortOrder === sortOrder) return;
    next[id] = { ...page, parentId, sortOrder };
    statements.push(placePage(id, parentId, sortOrder));
  });
  return { next, statements };
}

export const usePages = create<PagesState>((set, get) => {
  const apply = (pages: PageMap) => set({ pages, children: buildChildIndex(pages) });

  /** Optimistisch anwenden, dann transaktional schreiben; bei Fehler zurückrollen. */
  async function mutate(next: PageMap, statements: Statement[], context: string) {
    const previous = get().pages;
    apply(next);
    try {
      await commit(statements);
    } catch (err) {
      apply(previous);
      reportError(context, err);
      throw err;
    }
  }

  /** Kategorien optimistisch ändern, dann schreiben; bei Fehler zurückrollen. */
  async function mutateAll(nextPages: PageMap, nextCategories: Record<string, Category>, statements: Statement[], context: string) {
    const previous = { pages: get().pages, categories: get().categories };
    set({ categories: nextCategories });
    apply(nextPages);
    try {
      await commit(statements);
    } catch (err) {
      set({ categories: previous.categories });
      apply(previous.pages);
      reportError(context, err);
      throw err;
    }
  }

  return {
    pages: {},
    children: new Map(),
    categories: {},
    defaultSpace: 'private',

    async load() {
      const [list, categories] = await Promise.all([loadPages(), loadCategories()]);
      set({ categories: Object.fromEntries(categories.map((c) => [c.id, c])) });
      apply(Object.fromEntries(list.map((p) => [p.id, p])));
    },

    async create({ parentId = null, type = 'page', title = '', icon = null, index, extra, space, categoryId }: CreateOptions = {}) {
      const now = Date.now();
      const id = newId();
      const { pages, children, categories, defaultSpace } = get();
      const group: Group = { space: space ?? defaultSpace, categoryId: categoryId ?? null };
      const siblings = parentId === null ? groupRoots(pages, children, categories, group) : (children.get(parentId) ?? []);
      const ordered = insertAt(siblings, id, index ?? Number.MAX_SAFE_INTEGER);
      const page: PageMeta = {
        id,
        parentId,
        type,
        title,
        icon,
        cover: null,
        fullWidth: false,
        sortOrder: ordered.indexOf(id),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        space: group.space,
        categoryId: parentId === null ? group.categoryId : null,
        updatedBy: null,
      };
      // Die neue Seite steht bereits an ihrer Position; reorder liefert nur Updates für verschobene Geschwister.
      const { next, statements } =
        parentId === null ? reorderRoots({ ...pages, [id]: page }, group, ordered) : reorder({ ...pages, [id]: page }, parentId, ordered);
      await mutate(next, [insertPage(page), ...statements, ...(extra?.(page) ?? [])], 'Seite anlegen');
      return id;
    },

    update(id, patch) {
      const page = get().pages[id];
      if (!page) return;
      apply({ ...get().pages, [id]: { ...page, ...patch, updatedAt: Date.now() } });
      schedule(`page:${id}`, () => {
        const current = get().pages[id];
        if (!current) return [];
        const { title, icon, cover, fullWidth } = current;
        return [updatePage(id, { title, icon, cover, fullWidth }, current.updatedAt)];
      });
    },

    async move(id, parentId, index) {
      const { pages, children, categories } = get();
      if (!pages[id] || isSelfOrDescendant(pages, id, parentId)) return;
      if (parentId === null) {
        // Nach oben: in die Gruppe der bisherigen obersten Seite (Bereich und Kategorie bleiben).
        const root = rootOf(pages, id);
        return get().moveToGroup(id, groupOf(pages[root], categories), index);
      }
      if (!canContain(pages[parentId]?.type, pages[id].type)) return;
      const siblings = children.get(parentId) ?? [];
      const { next, statements } = reorder(pages, parentId, insertAt(siblings, id, index));
      if (statements.length === 0) return;
      await mutate(next, statements, 'Seite verschieben');
    },

    async moveToGroup(id, group, index) {
      const { pages, children, categories } = get();
      if (!pages[id]) return;
      const ordered = insertAt(groupRoots(pages, children, categories, group), id, index);
      const { next, statements } = reorderRoots(pages, group, ordered);
      if (statements.length === 0) return;
      await mutate(next, statements, 'Seite verschieben');
    },

    async createCategory(space, name) {
      const { pages, categories } = get();
      const id = newId();
      const category: Category = { id, space, name: name.trim() || 'Neue Kategorie', sortOrder: spaceCategories(categories, space).length, createdAt: Date.now() };
      await mutateAll(pages, { ...categories, [id]: category }, [insertCategory(category)], 'Kategorie anlegen');
      return id;
    },

    async renameCategory(id, name) {
      const { pages, categories } = get();
      const category = categories[id];
      const clean = name.trim();
      if (!category || !clean || clean === category.name) return;
      await mutateAll(pages, { ...categories, [id]: { ...category, name: clean } }, [renameCategoryRow(id, clean)], 'Kategorie umbenennen');
    },

    async moveCategory(id, space, index) {
      const { pages, categories } = get();
      const category = categories[id];
      if (!category) return;
      const ordered = insertAt(spaceCategories(categories, space).map((c) => c.id), id, index);
      const nextCategories = { ...categories };
      const statements: Statement[] = [];
      ordered.forEach((cid, sortOrder) => {
        const c = nextCategories[cid];
        if (c.space === space && c.sortOrder === sortOrder) return;
        nextCategories[cid] = { ...c, space, sortOrder };
        statements.push(placeCategory(cid, space, sortOrder));
      });
      let nextPages = pages;
      if (category.space !== space) {
        // Die Seiten der Kategorie wechseln mit in den neuen Bereich.
        nextPages = { ...pages };
        for (const page of Object.values(pages)) {
          if (page.parentId !== null || page.categoryId !== id) continue;
          nextPages[page.id] = { ...page, space };
          statements.push(placeRoot(page.id, space, id, page.sortOrder));
        }
      }
      if (statements.length === 0) return;
      await mutateAll(nextPages, nextCategories, statements, 'Kategorie verschieben');
    },

    async deleteCategory(id) {
      const { pages, children, categories } = get();
      const category = categories[id];
      if (!category) return;
      const nextCategories = { ...categories };
      delete nextCategories[id];
      const inside = groupRoots(pages, children, categories, { space: category.space, categoryId: id });
      const group: Group = { space: category.space, categoryId: null };
      const { next, statements } = reorderRoots(pages, group, [...groupRoots(pages, children, categories, group), ...inside]);
      await mutateAll(next, nextCategories, [...statements, deleteCategoryRow(id)], 'Kategorie entfernen');
    },

    async trash(id) {
      const { pages } = get();
      if (!pages[id]) return;
      const now = Date.now();
      const ids = [id, ...descendantIds(pages, id).filter((d) => pages[d].deletedAt === null)];
      const next = { ...pages };
      for (const d of ids) next[d] = { ...next[d], deletedAt: now };
      await mutate(next, setDeleted(ids, now), 'In den Papierkorb legen');
    },

    async restore(id) {
      const { pages, children } = get();
      const page = pages[id];
      if (!page || page.deletedAt === null) return;
      const ids = [id, ...descendantIds(pages, id).filter((d) => pages[d].deletedAt === page.deletedAt)];
      let next = { ...pages };
      for (const d of ids) next[d] = { ...next[d], deletedAt: null };
      const statements = setDeleted(ids, null);
      const parent = page.parentId ? pages[page.parentId] : undefined;
      if (page.parentId && (!parent || parent.deletedAt !== null)) {
        // Elternteil fehlt: als oberste Seite in den Bereich der früheren obersten Seite.
        const { categories } = get();
        const group = groupOf(pages[rootOf(pages, page.parentId)] ?? page, categories);
        const placed = reorderRoots(next, group, [...groupRoots(pages, children, categories, group), id]);
        next = placed.next;
        statements.push(...placed.statements);
      }
      await mutate(next, statements, 'Wiederherstellen');
    },

    async deleteForever(id) {
      const { pages } = get();
      if (!pages[id]) return;
      const ids = new Set([id, ...descendantIds(pages, id)]);
      discard((key) => ids.has(key.slice(key.indexOf(':') + 1)));
      const next = { ...pages };
      for (const d of ids) delete next[d];
      await mutate(next, [deletePage(id)], 'Endgültig löschen');
    },

    async emptyTrash() {
      const { pages } = get();
      const roots = trashRoots(pages);
      if (roots.length === 0) return;
      const doomed = new Set<string>();
      for (const root of roots) {
        doomed.add(root.id);
        for (const d of descendantIds(pages, root.id)) doomed.add(d);
      }
      discard((key) => doomed.has(key.slice(key.indexOf(':') + 1)));
      const next = { ...pages };
      for (const d of doomed) delete next[d];
      await mutate(next, roots.map((r) => deletePage(r.id)), 'Papierkorb leeren');
    },
  };
});
