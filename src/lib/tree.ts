import type { PageMeta } from '../db/pages';

export type PageMap = Record<string, PageMeta>;
export type ChildIndex = Map<string | null, string[]>;

const byOrder = (a: PageMeta, b: PageMeta) =>
  a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/** Kinder-Index aller nicht gelöschten Seiten, sortiert nach sort_order. */
export function buildChildIndex(pages: PageMap): ChildIndex {
  const index: ChildIndex = new Map();
  const live = Object.values(pages).filter((p) => p.deletedAt === null).sort(byOrder);
  for (const p of live) {
    const list = index.get(p.parentId);
    if (list) list.push(p.id);
    else index.set(p.parentId, [p.id]);
  }
  return index;
}

/** Alle Nachfahren (unabhängig vom Papierkorb-Status), ohne die Seite selbst. */
export function descendantIds(pages: PageMap, rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const p of Object.values(pages)) {
    if (!p.parentId) continue;
    const list = children.get(p.parentId);
    if (list) list.push(p.id);
    else children.set(p.parentId, [p.id]);
  }
  const result: string[] = [];
  const stack = [...(children.get(rootId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    result.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return result;
}

/** Kette der Vorfahren von der Wurzel bis zum direkten Elternteil. */
export function ancestorIds(pages: PageMap, id: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([id]);
  let parent = pages[id]?.parentId ?? null;
  while (parent && pages[parent] && !seen.has(parent)) {
    chain.unshift(parent);
    seen.add(parent);
    parent = pages[parent].parentId;
  }
  return chain;
}

/** Oberste Seite über `id` (oder `id` selbst). Ihr Bereich gilt für den ganzen Teilbaum. */
export function rootOf(pages: PageMap, id: string): string {
  return ancestorIds(pages, id)[0] ?? id;
}

export function isSelfOrDescendant(pages: PageMap, ancestorId: string, id: string | null): boolean {
  if (id === null) return false;
  return id === ancestorId || ancestorIds(pages, id).includes(ancestorId);
}

/** Entfernt `id` aus `list` und fügt es an `index` (bezogen auf die Liste ohne `id`) wieder ein. */
export function insertAt(list: string[], id: string, index: number): string[] {
  const without = list.filter((x) => x !== id);
  const clamped = Math.max(0, Math.min(index, without.length));
  return [...without.slice(0, clamped), id, ...without.slice(clamped)];
}

/** Wurzeln des Papierkorbs: gelöschte Seiten, die nicht zusammen mit ihrem Elternteil gelöscht wurden. */
export function trashRoots(pages: PageMap): PageMeta[] {
  return Object.values(pages)
    .filter((p) => {
      if (p.deletedAt === null) return false;
      const parent = p.parentId ? pages[p.parentId] : undefined;
      return !parent || parent.deletedAt !== p.deletedAt;
    })
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
}
