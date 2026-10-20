import type { JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { emptyScene, saveBoard, sceneText, type StoredScene } from '../db/boards';
import { saveContent } from '../db/content';
import type { Driver, Statement } from '../db/driver';
import { docText } from '../editor/text';
import { collectLinkTargets } from '../lib/doc';
import { ackedOf, boardChanges, mergeBoard, type Acked } from './boards';
import { decode, docJson, encode, foldJson, isEmptyUpdate, openDoc, pendingUpdate } from './docs';
import { applyRowStatements, installCapture, loadTables, seedStatements, type TableInfo } from './tables';
import type { BoardChange, Change, DocChange, RowChange } from './types';

/** Was beim Hochladen verschickt wurde und nach der Bestätigung als erledigt gilt. */
export interface Outbox {
  changes: Change[];
  upTo: number;
  docs: Record<string, string>;
  boards: Record<string, Acked>;
}

/** Seiten, deren Daten sich durch übernommene Änderungen geändert haben (zum Neuladen der Ansicht). */
export interface Applied {
  rows: boolean;
  docs: Set<string>;
  boards: Set<string>;
}

const BATCH = 500;

const parse = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

/**
 * Eine Kopie des Workspace, die mit anderen abgeglichen wird: das Gerät selbst oder die Cloud.
 * Lokale Änderungen erfassen Trigger im Protokoll; `collect` macht daraus Änderungen zum Verschicken,
 * `apply` übernimmt Änderungen von anderswo. Beide laufen nacheinander, nie gleichzeitig.
 */
export class Replica {
  private tables = new Map<string, TableInfo>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private driver: Driver) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Abgleich einschalten: Gerätekennung festlegen, Trigger anlegen. Beim ersten Mal alles vormerken. */
  enable(device: string): Promise<void> {
    return this.serial(async () => {
      const [clock] = await this.driver.select<{ device: string }>('SELECT device FROM sync_clock');
      this.tables = await loadTables(this.driver);
      await installCapture(this.driver, this.tables);
      if (!clock) {
        await this.driver.tx([
          { sql: 'INSERT INTO sync_clock (id, device) VALUES (1, ?)', params: [device] },
          ...seedStatements(this.tables),
        ]);
      }
    });
  }

  async device(): Promise<string | null> {
    const [clock] = await this.driver.select<{ device: string }>('SELECT device FROM sync_clock');
    return clock?.device ?? null;
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.driver.select<{ n: number }>('SELECT count(*) AS n FROM sync_log');
    return Number(row?.n ?? 0);
  }

  collect(limit = BATCH): Promise<Outbox | null> {
    return this.serial(async () => {
      const log = await this.driver.select<{ seq: number; kind: string; tbl: string; pk: string; cols: string | null; hlc: string }>(
        'SELECT seq, kind, tbl, pk, cols, hlc FROM sync_log ORDER BY seq LIMIT ?',
        [limit],
      );
      if (!log.length) return null;
      const outbox: Outbox = { changes: [], upTo: Number(log[log.length - 1].seq), docs: {}, boards: {} };
      const statements: Statement[] = [];
      for (const entry of log) {
        if (entry.kind === 'row') {
          outbox.changes.push({ kind: 'row', tbl: entry.tbl, pk: entry.pk, cols: parse(entry.cols, null), hlc: entry.hlc });
        } else if (entry.kind === 'doc') {
          const change = await this.collectDoc(entry.pk, statements, outbox);
          if (change) outbox.changes.push(change);
        } else if (entry.kind === 'board') {
          const change = await this.collectBoard(entry.pk, entry.hlc, statements, outbox);
          if (change) outbox.changes.push(change);
        }
      }
      if (statements.length) await this.driver.tx(statements);
      return outbox;
    });
  }

  private async docState(page: string): Promise<{ doc: Y.Doc; acked: string; known: boolean }> {
    const [row] = await this.driver.select<{ state: string; acked: string }>('SELECT state, acked FROM sync_docs WHERE page_id = ?', [page]);
    return { doc: openDoc(row?.state ?? null), acked: row?.acked ?? '', known: Boolean(row) };
  }

  /** Den gespeicherten Inhalt ins Y.Doc übertragen (falls er sich seit dem letzten Mal geändert hat). */
  private async fold(page: string, doc: Y.Doc): Promise<void> {
    const [content] = await this.driver.select<{ doc: string }>('SELECT doc FROM page_content WHERE page_id = ?', [page]);
    const json = parse<JSONContent | null>(content?.doc, null);
    if (json) foldJson(doc, json);
  }

  private async collectDoc(page: string, statements: Statement[], outbox: Outbox): Promise<DocChange | null> {
    const { doc, acked } = await this.docState(page);
    await this.fold(page, doc);
    statements.push(storeDoc(page, doc));
    const update = pendingUpdate(doc, acked);
    outbox.docs[page] = encode(Y.encodeStateVector(doc));
    doc.destroy();
    return isEmptyUpdate(update) ? null : { kind: 'doc', page, update: encode(update) };
  }

  private async boardState(page: string): Promise<{ scene: StoredScene | null; acked: Acked; backgroundHlc: string }> {
    const [board] = await this.driver.select<{ scene: string }>('SELECT scene FROM boards WHERE page_id = ?', [page]);
    const [meta] = await this.driver.select<{ acked: string; background_hlc: string }>(
      'SELECT acked, background_hlc FROM sync_boards WHERE page_id = ?',
      [page],
    );
    return {
      scene: board ? { ...emptyScene(), ...parse<StoredScene>(board.scene, emptyScene()) } : null,
      acked: parse<Acked>(meta?.acked, {}),
      backgroundHlc: meta?.background_hlc ?? '',
    };
  }

  private async collectBoard(page: string, hlc: string, statements: Statement[], outbox: Outbox): Promise<BoardChange | null> {
    const { scene, acked, backgroundHlc } = await this.boardState(page);
    if (!scene) return null;
    const value = scene.appState?.viewBackgroundColor ?? '#ffffff';
    // Der Hintergrund trägt den Zeitstempel der Änderung; ein neuerer aus der Cloud bleibt bestehen.
    const background = hlc > backgroundHlc ? { value, hlc } : null;
    if (background) statements.push(storeBoardMeta(page, null, background.hlc));
    outbox.boards[page] = ackedOf(scene);
    return { kind: 'board', page, elements: boardChanges(scene, acked), files: scene.files, background };
  }

  /** Nach Bestätigung durch die Cloud: verschickte Einträge entfernen, Stand der Cloud merken. */
  ack(outbox: Outbox): Promise<void> {
    return this.serial(async () => {
      const statements: Statement[] = [{ sql: 'DELETE FROM sync_log WHERE seq <= ?', params: [outbox.upTo] }];
      for (const [page, sv] of Object.entries(outbox.docs)) {
        statements.push({ sql: 'UPDATE sync_docs SET acked = ? WHERE page_id = ?', params: [sv, page] });
      }
      for (const [page, acked] of Object.entries(outbox.boards)) statements.push(storeBoardMeta(page, acked, null));
      await this.driver.tx(statements);
    });
  }

  /** Änderungen von anderswo übernehmen. Alles geschieht in einer Transaktion. */
  apply(changes: Change[]): Promise<Applied> {
    return this.serial(async () => {
      const applied: Applied = { rows: false, docs: new Set(), boards: new Set() };
      if (!this.tables.size) this.tables = await loadTables(this.driver);
      const statements: Statement[] = [{ sql: 'UPDATE sync_clock SET applying = 1' }];
      let latest = 0;
      for (const change of changes) {
        if (change.kind !== 'row') continue;
        const table = this.tables.get(change.tbl);
        if (!table) continue;
        statements.push(...applyRowStatements(table, change));
        latest = Math.max(latest, clockOf(change));
        applied.rows = true;
      }

      const titles = new Map(
        (await this.driver.select<{ id: string; title: string }>('SELECT id, title FROM pages')).map((p) => [p.id, p.title]),
      );
      for (const change of changes) {
        if (change.kind === 'row' && change.tbl === 'pages' && change.cols && typeof change.cols.title === 'string') {
          titles.set(JSON.parse(change.pk)[0] as string, change.cols.title);
        }
      }
      const now = Date.now();

      const docs = groupBy(changes.filter((c): c is DocChange => c.kind === 'doc'), (c) => c.page);
      for (const [page, updates] of docs) {
        const { doc } = await this.docState(page);
        // Was lokal gespeichert, aber noch nicht im Y.Doc ist, zuerst übernehmen: sonst ginge es verloren.
        await this.fold(page, doc);
        for (const u of updates) {
          try {
            Y.applyUpdate(doc, decode(u.update));
          } catch (err) {
            console.error('Ungültige Änderung aus der Cloud verworfen', err);
          }
        }
        const result = docJson(doc);
        statements.push(storeDoc(page, doc));
        if (result) {
          const text = docText(result.node, (id) => titles.get(id) ?? '');
          statements.push(...saveContent(page, result.json, text, collectLinkTargets(result.json, page), now));
          applied.docs.add(page);
        }
        doc.destroy();
      }

      const boards = groupBy(changes.filter((c): c is BoardChange => c.kind === 'board'), (c) => c.page);
      for (const [page, updates] of boards) {
        const state = await this.boardState(page);
        let scene = state.scene ?? emptyScene();
        let acked = state.acked;
        let backgroundHlc = state.backgroundHlc;
        for (const u of updates) {
          const merged = mergeBoard(scene, Array.isArray(u.elements) ? u.elements : [], acked);
          scene = merged.scene;
          acked = merged.acked;
          scene = { ...scene, files: { ...(u.files ?? {}), ...scene.files } };
          if (u.background && u.background.hlc > backgroundHlc) {
            backgroundHlc = u.background.hlc;
            scene = { ...scene, appState: { ...scene.appState, viewBackgroundColor: u.background.value } };
            latest = Math.max(latest, msOf(u.background.hlc));
          }
        }
        if (!state.scene) {
          statements.push({
            sql: `INSERT INTO boards (page_id, scene, updated_at) SELECT ?, '{"elements":[],"files":{}}', ?
                  WHERE EXISTS (SELECT 1 FROM pages WHERE id = ?) ON CONFLICT DO NOTHING`,
            params: [page, now, page],
          });
        }
        statements.push(...saveBoard(page, scene, sceneText(scene.elements), now), storeBoardMeta(page, acked, backgroundHlc));
        applied.boards.add(page);
      }

      // Die eigene Uhr nie hinter einer gesehenen Änderung zurückbleiben lassen.
      if (latest) statements.push({ sql: 'UPDATE sync_clock SET ms = max(ms, ?)', params: [latest] });
      statements.push({ sql: 'UPDATE sync_clock SET applying = 0' });
      await this.driver.tx(statements);
      return applied;
    });
  }
}

const msOf = (hlc: string): number => Number(hlc.slice(0, hlc.indexOf('-'))) || 0;
const clockOf = (change: RowChange): number => msOf(change.hlc);

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function storeDoc(page: string, doc: Y.Doc): Statement {
  return {
    sql: `INSERT INTO sync_docs (page_id, state) VALUES (?, ?) ON CONFLICT(page_id) DO UPDATE SET state = excluded.state`,
    params: [page, encode(Y.encodeStateAsUpdate(doc))],
  };
}

function storeBoardMeta(page: string, acked: Acked | null, backgroundHlc: string | null): Statement {
  return {
    sql: `INSERT INTO sync_boards (page_id, acked, background_hlc) VALUES (?, COALESCE(?, '{}'), COALESCE(?, ''))
          ON CONFLICT(page_id) DO UPDATE SET acked = COALESCE(?, acked), background_hlc = COALESCE(?, background_hlc)`,
    params: [page, acked && JSON.stringify(acked), backgroundHlc, acked && JSON.stringify(acked), backgroundHlc],
  };
}

