import { teamVisible } from './scope';
import type { Store } from './store';

const SCHEMA = `
-- Mitteilungen über Erwähnungen (@Name), je Person. member_id 'owner' = Inhaber der Cloud.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  by_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_member ON notifications(member_id, created_at);
-- Wer in einer Seite schon erwähnt ist (nur neue Erwähnungen lösen eine Mitteilung aus).
CREATE TABLE IF NOT EXISTS mention_seen (
  page_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY (page_id, member_id)
) WITHOUT ROWID;
`;

export interface Notification {
  id: number;
  pageId: string;
  title: string;
  byName: string;
  createdAt: number;
  read: boolean;
}

/** Erwähnte Personen in einem gespeicherten Seiteninhalt. */
export function mentionedIn(doc: string): Set<string> {
  const ids = new Set<string>();
  const walk = (node: { type?: string; attrs?: { id?: unknown }; content?: unknown[] }) => {
    if (node.type === 'mention' && typeof node.attrs?.id === 'string') ids.add(node.attrs.id);
    for (const child of node.content ?? []) walk(child as typeof node);
  };
  try {
    walk(JSON.parse(doc));
  } catch {
    // Unlesbarer Inhalt: keine Erwähnungen
  }
  return ids;
}

/**
 * Erwähnungen: Nach Änderungen an Seiten schaut der Server, wer neu erwähnt wurde, und legt für diese
 * Personen eine Mitteilung an. Erwähnt wird nur, wer die Seite auch sehen darf.
 */
export class Mentions {
  private listeners = new Set<(memberId: string) => void>();

  constructor(private store: Store) {
    store.raw.exec(SCHEMA);
  }

  onNotify(listener: (memberId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** `byId`: wer geändert hat (eigene Erwähnung löst nichts aus), `byName` für die Anzeige. */
  scan(pages: Iterable<string>, byId: string, byName: string): void {
    const ids = [...new Set(pages)];
    if (!ids.length) return;
    const members = new Set(
      (this.store.raw.prepare("SELECT id FROM share_members WHERE team_role = 'member'").all() as { id: string }[]).map((m) => m.id),
    );
    let visible: Set<string> | null = null;
    const notified = new Set<string>();
    const now = Date.now();
    for (const pageId of ids) {
      const row = this.store.raw.prepare('SELECT doc FROM page_content WHERE page_id = ?').get(pageId) as { doc: string } | undefined;
      const mentioned = row ? mentionedIn(row.doc) : new Set<string>();
      const seen = new Set(
        (this.store.raw.prepare('SELECT member_id FROM mention_seen WHERE page_id = ?').all(pageId) as { member_id: string }[]).map((r) => r.member_id),
      );
      for (const id of mentioned) {
        if (seen.has(id) || id === byId) continue;
        // Nur wer die Seite sehen darf: der Inhaber immer, Mitglieder im Team-Bereich.
        if (id !== 'owner') {
          if (!members.has(id)) continue;
          visible ??= teamVisible(this.store).pages;
          if (!visible.has(pageId)) continue;
        }
        this.store.raw
          .prepare('INSERT INTO notifications (member_id, page_id, by_name, created_at) VALUES (?, ?, ?, ?)')
          .run(id, pageId, byName, now);
        notified.add(id);
      }
      this.store.raw.prepare('DELETE FROM mention_seen WHERE page_id = ?').run(pageId);
      const insert = this.store.raw.prepare('INSERT OR IGNORE INTO mention_seen (page_id, member_id) VALUES (?, ?)');
      for (const id of mentioned) insert.run(pageId, id);
    }
    for (const id of notified) for (const l of this.listeners) l(id);
  }

  list(memberId: string): Notification[] {
    const rows = this.store.raw
      .prepare(
        `SELECT n.id, n.page_id, n.by_name, n.created_at, n.read_at, p.title
         FROM notifications n JOIN pages p ON p.id = n.page_id
         WHERE n.member_id = ? AND p.deleted_at IS NULL ORDER BY n.created_at DESC LIMIT 50`,
      )
      .all(memberId) as { id: number; page_id: string; by_name: string; created_at: number; read_at: number | null; title: string }[];
    return rows.map((r) => ({
      id: Number(r.id),
      pageId: r.page_id,
      title: r.title,
      byName: r.by_name,
      createdAt: Number(r.created_at),
      read: r.read_at !== null,
    }));
  }

  markRead(memberId: string, ids: number[] | 'all'): void {
    const now = Date.now();
    if (ids === 'all') this.store.raw.prepare('UPDATE notifications SET read_at = ? WHERE member_id = ? AND read_at IS NULL').run(now, memberId);
    else {
      this.store.raw
        .prepare('UPDATE notifications SET read_at = ? WHERE member_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))')
        .run(now, memberId, JSON.stringify(ids));
    }
    for (const l of this.listeners) l(memberId);
  }
}
