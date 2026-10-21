import type { SqlValue } from '../src/db/driver';
import type { Change } from '../src/sync/types';
import type { Store } from './store';

/** Was ein Team-Mitglied sehen darf: alle Seiten im Team-Bereich (samt Unterseiten) und die Team-Kategorien. */
export interface Visible {
  pages: Set<string>;
  categories: Set<string>;
}

interface PageRow {
  id: string;
  parent_id: string | null;
  space: string;
}

/** Aktueller Stand: Seiten, deren oberste Seite im Team-Bereich liegt, und Kategorien des Teams. */
export function teamVisible(store: Store): Visible {
  const rows = store.raw.prepare('SELECT id, parent_id, space FROM pages').all() as unknown as PageRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const space = new Map<string, string>();
  const spaceOf = (id: string): string => {
    const chain: string[] = [];
    let current = byId.get(id);
    while (current) {
      const known = space.get(current.id);
      if (known) {
        for (const c of chain) space.set(c, known);
        return known;
      }
      chain.push(current.id);
      if (!current.parent_id || !byId.has(current.parent_id) || chain.includes(current.parent_id)) break;
      current = byId.get(current.parent_id);
    }
    const result = current?.space ?? 'private';
    for (const c of chain) space.set(c, result);
    return result;
  };
  const pages = new Set(rows.filter((r) => spaceOf(r.id) === 'team').map((r) => r.id));
  const categories = new Set(
    (store.raw.prepare("SELECT id FROM categories WHERE space = 'team'").all() as { id: string }[]).map((c) => c.id),
  );
  return { pages, categories };
}

/** Datenbank, zu der eine Eigenschaft oder Ansicht gehört (aus der Änderung oder dem gespeicherten Stand). */
function databaseOf(store: Store, tbl: string, id: string, cols: Record<string, SqlValue> | null): string | null {
  if (cols && typeof cols.database_id === 'string') return cols.database_id;
  const row = store.raw.prepare(`SELECT database_id FROM "${tbl}" WHERE id = ?`).get(id) as { database_id: string } | undefined;
  return row?.database_id ?? null;
}

/**
 * Darf ein Team-Gerät diese Änderung bekommen? `before` ist, was es zuvor sehen durfte: Löschungen von
 * Dingen, die es kannte, gehen noch an das Gerät.
 */
export function visibleTo(store: Store, change: Change, now: Visible, before: Visible): boolean {
  if (change.kind === 'forget') return false;
  if (change.kind === 'doc' || change.kind === 'board') return now.pages.has(change.page);
  const key = String((JSON.parse(change.pk) as SqlValue[])[0]);
  const known = (set: keyof Visible, id: string) => now[set].has(id) || (change.cols === null && before[set].has(id));
  switch (change.tbl) {
    case 'pages':
    case 'db_values':
      return known('pages', key);
    case 'db_properties':
    case 'db_views': {
      const database = databaseOf(store, change.tbl, key, change.cols);
      return database !== null && known('pages', database);
    }
    case 'categories':
      return known('categories', key);
    case 'cover_credits':
      return true;
    default:
      // Freigaben und Geräte bleiben beim Inhaber.
      return false;
  }
}

/**
 * Darf ein Team-Mitglied diese Änderung machen? Erlaubt ist alles im Team-Bereich; nicht erlaubt ist,
 * Seiten aus dem Team zu nehmen, endgültig zu löschen oder Freigaben zu ändern.
 * `created` sammelt Seiten, die in derselben Sendung im Team angelegt werden.
 */
export function allowedFrom(store: Store, change: Change, visible: Visible, created: Set<string>): boolean {
  const seen = (id: string) => visible.pages.has(id) || created.has(id);
  if (change.kind === 'forget') return false;
  if (change.kind === 'doc' || change.kind === 'board') return seen(change.page);
  const key = String((JSON.parse(change.pk) as SqlValue[])[0]);
  const cols = change.cols;
  switch (change.tbl) {
    case 'pages': {
      if (cols === null) return false;
      if ('space' in cols && cols.space !== 'team') return false;
      if (seen(key)) return !('parent_id' in cols) || cols.parent_id === null || seen(String(cols.parent_id));
      // Neue Seite: als oberste Seite im Team oder unter einer Team-Seite.
      const exists = store.raw.prepare('SELECT 1 FROM pages WHERE id = ?').get(key);
      if (exists) return false;
      const ok = typeof cols.parent_id === 'string' ? seen(cols.parent_id) : cols.space === 'team';
      if (ok) created.add(key);
      return ok;
    }
    case 'db_values':
      return seen(key);
    case 'db_properties':
    case 'db_views': {
      const database = databaseOf(store, change.tbl, key, cols);
      return database !== null && seen(database);
    }
    case 'categories': {
      if (cols && 'space' in cols && cols.space !== 'team') return false;
      if (visible.categories.has(key)) return true;
      const exists = store.raw.prepare('SELECT 1 FROM categories WHERE id = ?').get(key);
      return !exists && cols !== null && cols.space === 'team';
    }
    case 'cover_credits':
      return cols !== null;
    default:
      return false;
  }
}

const ASSET = /[0-9a-f]{32}\.[a-z0-9]{1,10}/g;

/** Bilder und Anhänge, auf die sichtbare Seiten verweisen (Inhalt, Boards, Titelbilder). */
export function visibleAssets(store: Store, visible: Visible): Set<string> {
  const names = new Set<string>();
  const ids = JSON.stringify([...visible.pages]);
  const texts = store.raw
    .prepare(
      `SELECT doc AS t FROM page_content WHERE page_id IN (SELECT value FROM json_each(?1))
       UNION ALL SELECT scene FROM boards WHERE page_id IN (SELECT value FROM json_each(?1))
       UNION ALL SELECT cover FROM pages WHERE cover IS NOT NULL AND id IN (SELECT value FROM json_each(?1))`,
    )
    .all(ids) as { t: string }[];
  for (const { t } of texts) for (const m of t.matchAll(ASSET)) names.add(m[0]);
  return names;
}
