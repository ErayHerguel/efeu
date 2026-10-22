import type { SqlValue } from '../src/db/driver';
import { Replica, type Applied, type ReplicaHooks } from '../src/sync/replica';
import { loadTables, PAGE_COLUMN } from '../src/sync/tables';
import { allowedFrom, teamVisible, visibleTo, type Visible } from './scope';
import type { BoardElement, Change } from '../src/sync/types';
import { transaction, type Store } from './store';

/** Höchstens so viele Änderungen je Abruf. */
const PULL_LIMIT = 500;
/** Ab so vielen Einträgen wird das Protokoll durch einen Schnappschuss des Stands ersetzt. */
const COMPACT_AT = 5000;
/** Zeitstempel für Spalten ohne bekannten Zeitpunkt (verliert gegen jede echte Änderung). */
const ANCIENT = '000000000000000-';

const isValue = (v: unknown): v is SqlValue => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const isHlc = (v: unknown): v is string => typeof v === 'string' && /^\d{15}-[\w.-]{1,80}$/.test(v);

/** Prüft die Form einer Änderung von einem Gerät. Unbrauchbares wird verworfen, nicht angewendet. */
export function validChange(c: unknown): c is Change {
  if (!c || typeof c !== 'object') return false;
  const x = c as Record<string, unknown>;
  if (x.kind === 'row') {
    if (typeof x.tbl !== 'string' || typeof x.pk !== 'string' || !isHlc(x.hlc)) return false;
    if (x.cols === null) return true;
    return typeof x.cols === 'object' && !Array.isArray(x.cols) && Object.values(x.cols as object).every(isValue);
  }
  if (x.kind === 'doc') return typeof x.page === 'string' && typeof x.update === 'string';
  if (x.kind === 'board') {
    const bg = x.background as Record<string, unknown> | null;
    return (
      typeof x.page === 'string' &&
      Array.isArray(x.elements) &&
      x.elements.every((e) => e && typeof e === 'object' && typeof (e as BoardElement).id === 'string') &&
      typeof x.files === 'object' &&
      x.files !== null &&
      (bg === null || (typeof bg === 'object' && typeof bg.value === 'string' && isHlc(bg.hlc)))
    );
  }
  return false;
}

/**
 * Die Cloud: eine Kopie des Workspace und ein fortlaufendes Protokoll aller Änderungen.
 * Geräte laden ihre Änderungen hoch (push) und holen ab einer Nummer alles Neue ab (pull).
 */
export class Cloud {
  readonly replica: Replica;
  private listeners = new Set<(seq: number) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  /** onApplied: nach übernommenen Änderungen eines Geräts (zum Nachführen der Gast-Ansichten). */
  constructor(
    private store: Store,
    hooks: ReplicaHooks = {},
    private onApplied: (applied: Applied) => void = () => undefined,
  ) {
    this.replica = new Replica(store, hooks);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async start(): Promise<void> {
    await this.replica.enable('server');
    await this.drainLocal();
    await this.compactIfLarge();
  }

  latest(): number {
    const row = this.store.raw.prepare('SELECT max(seq) AS seq FROM cloud_log').get() as { seq: number | null };
    return Number(row.seq ?? 0);
  }

  onChange(listener: (seq: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private append(origin: string, changes: Change[]): number {
    if (!changes.length) return this.latest();
    const insert = this.store.raw.prepare('INSERT INTO cloud_log (origin, change) VALUES (?, ?)');
    transaction(this.store.raw, () => {
      for (const change of changes) insert.run(origin, JSON.stringify(change));
    });
    const seq = this.latest();
    for (const l of this.listeners) l(seq);
    return seq;
  }

  /** Änderungen eines Geräts übernehmen und für die anderen bereitstellen. */
  push(origin: string, changes: unknown[], memberId: string | null = null): Promise<number> {
    return this.serial(async () => {
      let valid = changes.filter(validChange);
      if (memberId) {
        // Team-Mitglieder dürfen nur im Team-Bereich ändern; alles andere wird verworfen.
        const visible = teamVisible(this.store);
        const created = new Set<string>();
        valid = valid.filter((c) => allowedFrom(this.store, c, visible, created));
      }
      const applied = await this.replica.apply(valid);
      const seq = this.append(origin, valid);
      const name = this.editorName(memberId);
      this.stampEditor(valid, name);
      const docs = valid.filter((c) => c.kind === 'doc').map((c) => (c as { page: string }).page);
      if (docs.length) this.afterDocs?.(docs, memberId ?? 'owner', name);
      this.onApplied(applied);
      return seq;
    }).finally(() => void this.drainLocal().catch(() => undefined));
  }

  /** Nach übernommenen Seiteninhalten eines Geräts (z. B. für Erwähnungen): Seiten, wer, Anzeigename. */
  afterDocs: ((pages: string[], byId: string, byName: string) => void) | null = null;

  /** Anzeigename für „Zuletzt bearbeitet von …“: Team-Mitglied oder der Inhaber. */
  editorName(memberId: string | null): string {
    if (memberId) {
      const row = this.store.raw.prepare('SELECT name FROM share_members WHERE id = ?').get(memberId) as { name: string } | undefined;
      if (row) return row.name;
    }
    const owner = this.store.raw.prepare("SELECT value FROM cloud_meta WHERE key = 'owner_name'").get() as { value: string } | undefined;
    return owner?.value || 'Inhaber';
  }

  setOwnerName(name: string) {
    this.store.raw.prepare("INSERT INTO cloud_meta (key, value) VALUES ('owner_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name);
  }

  /** Vermerkt bei den betroffenen Seiten, wer zuletzt geändert hat (wird wie jede Änderung abgeglichen). */
  stampEditor(changes: Change[], name: string) {
    const pages = new Set<string>();
    for (const c of changes) {
      if (c.kind === 'doc' || c.kind === 'board') pages.add(c.page);
      else if (c.kind === 'row' && c.cols && (c.tbl === 'pages' || c.tbl === 'db_values')) {
        // Nur echte Bearbeitungen, nicht der Vermerk selbst oder bloßes Verschieben.
        const keys = Object.keys(c.cols).filter((k) => !['updated_by', 'sort_order', 'updated_at', 'space', 'category_id', 'parent_id'].includes(k));
        if (keys.length) pages.add(String((JSON.parse(c.pk) as string[])[0]));
      }
    }
    if (!pages.size) return;
    this.store.raw
      .prepare('UPDATE pages SET updated_by = ? WHERE id IN (SELECT value FROM json_each(?)) AND updated_by IS NOT ?')
      .run(name, JSON.stringify([...pages]), name);
  }

  /** Änderungen, die auf dem Server selbst entstanden sind (z. B. im Browser), ins Protokoll übernehmen. */
  drainLocal(): Promise<void> {
    return this.serial(async () => {
      for (;;) {
        const outbox = await this.replica.collect();
        if (!outbox) return;
        this.append('server', outbox.changes);
        await this.replica.ack(outbox);
      }
    });
  }

  pull(origin: string, since: number, limit = PULL_LIMIT): { changes: Change[]; next: number; more: boolean } {
    const rows = this.store.raw
      .prepare('SELECT seq, origin, change FROM cloud_log WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(since, limit + 1) as { seq: number; origin: string; change: string }[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const next = page.length ? Number(page[page.length - 1].seq) : Math.max(since, 0);
    return {
      changes: page.filter((r) => r.origin !== origin).map((r) => JSON.parse(r.change) as Change),
      next,
      more,
    };
  }

  /**
   * Abruf eines Geräts. Geräte von Team-Mitgliedern bekommen nur den Team-Bereich: Was neu sichtbar ist,
   * wird als Schnappschuss nachgeliefert, was nicht mehr sichtbar ist, mit „forget“ entfernt.
   */
  async pullFor(device: { id: string; memberId: string | null }, since: number): Promise<{ changes: Change[]; next: number; more: boolean }> {
    const result = this.pull(device.id, since);
    if (!device.memberId) return result;
    const now = teamVisible(this.store);
    const row = this.store.raw.prepare('SELECT pages, categories FROM cloud_scope WHERE device_id = ?').get(device.id) as
      | { pages: string; categories: string }
      | undefined;
    const before: Visible = {
      pages: new Set(row ? (JSON.parse(row.pages) as string[]) : []),
      categories: new Set(row ? (JSON.parse(row.categories) as string[]) : []),
    };
    const fresh: Visible = {
      pages: new Set([...now.pages].filter((id) => !before.pages.has(id))),
      categories: new Set([...now.categories].filter((id) => !before.categories.has(id))),
    };
    const gone = {
      pages: [...before.pages].filter((id) => !now.pages.has(id)),
      categories: [...before.categories].filter((id) => !now.categories.has(id)),
    };
    const extra: Change[] = [];
    if (fresh.pages.size || fresh.categories.size) extra.push(...(await this.snapshot(fresh)));
    if (gone.pages.length || gone.categories.length) extra.push({ kind: 'forget', pages: gone.pages, categories: gone.categories });
    this.store.raw
      .prepare('INSERT INTO cloud_scope (device_id, pages, categories) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET pages = excluded.pages, categories = excluded.categories')
      .run(device.id, JSON.stringify([...now.pages]), JSON.stringify([...now.categories]));
    return { ...result, changes: [...extra, ...result.changes.filter((c) => visibleTo(this.store, c, now, before))] };
  }

  compactIfLarge(): Promise<void> {
    const { n } = this.store.raw.prepare('SELECT count(*) AS n FROM cloud_log').get() as { n: number };
    return Number(n) > COMPACT_AT ? this.compact() : Promise.resolve();
  }

  /**
   * Ersetzt das Protokoll durch den aktuellen Stand. Geräte, die danach abrufen, bekommen diesen
   * Schnappschuss; weil sich alle Änderungen beliebig oft anwenden lassen, schadet das niemandem.
   */
  compact(): Promise<void> {
    return this.serial(async () => {
      const changes = await this.snapshot();
      transaction(this.store.raw, () => {
        this.store.raw.exec('DELETE FROM cloud_log');
        const insert = this.store.raw.prepare('INSERT INTO cloud_log (origin, change) VALUES (?, ?)');
        for (const change of changes) insert.run('snapshot', JSON.stringify(change));
      });
      const seq = this.latest();
      for (const l of this.listeners) l(seq);
    });
  }

  /** Aktueller Stand als Änderungen; mit `only` nur diese Seiten und Kategorien (für Team-Geräte). */
  private async snapshot(only?: Visible): Promise<Change[]> {
    const raw = this.store.raw;
    const changes: Change[] = [];
    const meta = new Map<string, Map<string, string>>();
    for (const m of raw.prepare('SELECT tbl, pk, col, hlc FROM sync_meta').all() as { tbl: string; pk: string; col: string; hlc: string }[]) {
      const key = `${m.tbl}\u0000${m.pk}`;
      if (!meta.has(key)) meta.set(key, new Map());
      meta.get(key)!.set(m.col, m.hlc);
    }
    const tables = await loadTables(this.store);
    for (const t of tables.values()) {
      const scopeColumn = t.name === 'categories' ? 'id' : PAGE_COLUMN[t.name];
      if (only && !scopeColumn && t.name !== 'cover_credits') continue;
      const rows = raw.prepare(`SELECT ${t.columns.map((c) => `"${c}"`).join(', ')} FROM "${t.name}"`).all() as Record<string, SqlValue>[];
      for (const row of rows) {
        if (only && scopeColumn && !(t.name === 'categories' ? only.categories : only.pages).has(String(row[scopeColumn]))) continue;
        const pk = JSON.stringify(t.key.map((k) => row[k]));
        const hlcs = meta.get(`${t.name}\u0000${pk}`);
        // Spalten mit gleichem Zeitstempel zusammenfassen.
        const groups = new Map<string, Record<string, SqlValue>>();
        for (const col of t.columns) {
          if (t.key.includes(col)) continue;
          const hlc = hlcs?.get(col) ?? `${ANCIENT}snapshot`;
          if (!groups.has(hlc)) groups.set(hlc, {});
          groups.get(hlc)![col] = row[col];
        }
        const sorted = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
        if (!sorted.length) continue;
        // Erst die ganze Zeile mit dem ältesten Zeitstempel (so lässt sie sich anlegen, ohne Neueres zu
        // überschreiben), dann jede neuere Gruppe mit ihrem eigenen.
        const data = Object.fromEntries(t.columns.filter((c) => !t.key.includes(c)).map((c) => [c, row[c]]));
        changes.push({ kind: 'row', tbl: t.name, pk, cols: data, hlc: sorted[0][0] });
        for (const [hlc, cols] of sorted.slice(1)) changes.push({ kind: 'row', tbl: t.name, pk, cols, hlc });
      }
    }
    // Endgültig Gelöschtes bleibt als Grabstein, damit alte Stände es nicht zurückbringen.
    for (const [key, cols] of meta) {
      if (only) break;
      const tomb = cols.get('');
      if (!tomb) continue;
      const [tbl, pk] = key.split('\u0000');
      changes.push({ kind: 'row', tbl, pk, cols: null, hlc: tomb });
    }
    for (const d of raw.prepare('SELECT page_id, state FROM sync_docs').all() as { page_id: string; state: string }[]) {
      if (only && !only.pages.has(d.page_id)) continue;
      changes.push({ kind: 'doc', page: d.page_id, update: d.state });
    }
    const boards = raw
      .prepare('SELECT b.page_id, b.scene, s.background_hlc FROM boards b LEFT JOIN sync_boards s ON s.page_id = b.page_id')
      .all() as { page_id: string; scene: string; background_hlc: string | null }[];
    for (const b of boards) {
      if (only && !only.pages.has(b.page_id)) continue;
      const scene = JSON.parse(b.scene) as { elements?: BoardElement[]; files?: Record<string, { asset: string; mimeType: string }>; appState?: { viewBackgroundColor?: string } };
      const hlc = b.background_hlc || `${ANCIENT}snapshot`;
      changes.push({
        kind: 'board',
        page: b.page_id,
        elements: scene.elements ?? [],
        files: scene.files ?? {},
        background: { value: scene.appState?.viewBackgroundColor ?? '#ffffff', hlc },
      });
    }
    return changes;
  }
}
