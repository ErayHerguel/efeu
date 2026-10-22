import type { Driver, SqlValue, Statement } from '../db/driver';
import type { RowChange } from './types';

/**
 * Tabellen, die mit der Cloud abgeglichen werden. Spalten und Fremdschlüssel liest die App aus der
 * Datenbank selbst, neue Spalten aus späteren Migrationen werden also automatisch mitgenommen.
 * Gerätebezogenes (Einstellungen, Versionsverlauf, KI-Kosten) bleibt lokal.
 */
const ROW_TABLES: Record<string, { key?: string[]; exclude?: string[] }> = {
  pages: { key: ['id'], exclude: ['rid'] },
  db_properties: {},
  db_values: {},
  db_views: {},
  cover_credits: {},
  // Freigaben (Personen und eigene Geräte mit ihren Rechten): mit eigener Cloud teilt der Server.
  share_members: {},
  share_grants: {},
  categories: {},
  // Lernstand der Karteikarten: nur die eigenen Geräte (der Server gibt ihn nie an Team-Mitglieder)
  card_reviews: {},
};

/** Seiteninhalt und Boards werden nicht spaltenweise, sondern inhaltlich zusammengeführt. */
export const DOC_TABLE = 'page_content';
export const BOARD_TABLE = 'boards';

export interface TableInfo {
  name: string;
  key: string[];
  /** Alle abgeglichenen Spalten einschließlich der Schlüssel */
  columns: string[];
  /** Pflichtspalten ohne Vorgabewert: ohne sie lässt sich keine Zeile anlegen */
  required: string[];
  foreignKeys: { column: string; table: string; to: string }[];
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Ungültiger Name: ${name}`);
  return `"${name}"`;
};

export async function loadTables(driver: Driver): Promise<Map<string, TableInfo>> {
  const tables = new Map<string, TableInfo>();
  for (const [name, config] of Object.entries(ROW_TABLES)) {
    const cols = await driver.select<{ name: string; pk: number; notnull: number; dflt_value: unknown }>(
      `SELECT name, pk, "notnull", dflt_value FROM pragma_table_info('${name}')`,
    );
    const fks = await driver.select<{ table: string; from: string; to: string }>(
      `SELECT "table", "from", "to" FROM pragma_foreign_key_list('${name}')`,
    );
    const exclude = new Set(config.exclude ?? []);
    const columns = cols.map((c) => c.name).filter((c) => !exclude.has(c));
    const key =
      config.key ??
      cols
        .filter((c) => Number(c.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((c) => c.name);
    tables.set(name, {
      name,
      key,
      columns,
      required: cols.filter((c) => Number(c.notnull) && c.dflt_value === null && !exclude.has(c.name)).map((c) => c.name),
      foreignKeys: fks.map((f) => ({ column: f.from, table: f.table, to: f.to })),
    });
  }
  return tables;
}

// ---------------------------------------------------------------------------------------------
// Erfassen: Trigger schreiben jede lokale Änderung ins Protokoll (sync_log) und merken sich je
// Spalte den Zeitstempel (sync_meta). Solange Änderungen aus der Cloud übernommen werden
// (sync_clock.applying), schweigen sie. Ohne eingerichtete Cloud gibt es keine Trigger.

const ACTIVE = '(SELECT applying FROM sync_clock) = 0';
const TICK = "UPDATE sync_clock SET ms = max(ms + 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));";
const HLC = "printf('%015d-%s', ms, device)";
const META_FROM_LOG =
  'INSERT OR REPLACE INTO sync_meta (tbl, pk, col, hlc) SELECT l.tbl, l.pk, j.key, l.hlc FROM sync_log l, json_each(l.cols) j WHERE l.seq = last_insert_rowid();';

const triggerName = (table: string, event: string) => `sync_capture_${table}_${event}`;

function rowTriggers(t: TableInfo): string[] {
  const name = ident(t.name);
  const pk = (row: 'NEW' | 'OLD') => `json_array(${t.key.map((k) => `${row}.${ident(k)}`).join(', ')})`;
  const data = t.columns.filter((c) => !t.key.includes(c));
  const all = `json_object(${t.columns.map((c) => `'${c}', NEW.${ident(c)}`).join(', ')})`;
  const changed = data.map((c) => `OLD.${ident(c)} IS NOT NEW.${ident(c)}`).join(' OR ');
  const changedCols = `(SELECT json_group_object(k, v) FROM (${data
    .map((c) => `SELECT '${c}' AS k, NEW.${ident(c)} AS v WHERE OLD.${ident(c)} IS NOT NEW.${ident(c)}`)
    .join(' UNION ALL ')}))`;
  return [
    `CREATE TRIGGER ${triggerName(t.name, 'insert')} AFTER INSERT ON ${name} WHEN ${ACTIVE} BEGIN
      ${TICK}
      INSERT INTO sync_log (kind, tbl, pk, cols, hlc) SELECT 'row', '${t.name}', ${pk('NEW')}, ${all}, ${HLC} FROM sync_clock;
      ${META_FROM_LOG}
      DELETE FROM sync_meta WHERE tbl = '${t.name}' AND pk = ${pk('NEW')} AND col = '';
    END`,
    `CREATE TRIGGER ${triggerName(t.name, 'update')} AFTER UPDATE ON ${name} WHEN ${ACTIVE} AND (${changed || '0'}) BEGIN
      ${TICK}
      INSERT INTO sync_log (kind, tbl, pk, cols, hlc) SELECT 'row', '${t.name}', ${pk('NEW')}, ${changedCols}, ${HLC} FROM sync_clock;
      ${META_FROM_LOG}
    END`,
    `CREATE TRIGGER ${triggerName(t.name, 'delete')} AFTER DELETE ON ${name} WHEN ${ACTIVE} BEGIN
      ${TICK}
      INSERT INTO sync_log (kind, tbl, pk, cols, hlc) SELECT 'row', '${t.name}', ${pk('OLD')}, NULL, ${HLC} FROM sync_clock;
      DELETE FROM sync_meta WHERE tbl = '${t.name}' AND pk = ${pk('OLD')};
      INSERT OR REPLACE INTO sync_meta (tbl, pk, col, hlc) SELECT tbl, pk, '', hlc FROM sync_log WHERE seq = last_insert_rowid();
    END`,
  ];
}

/** Seiteninhalt und Boards: nur vermerken, dass sich etwas geändert hat (ein Eintrag je Seite). */
function markTriggers(table: string, kind: 'doc' | 'board', column: string): string[] {
  const body = `
      ${TICK}
      DELETE FROM sync_log WHERE kind = '${kind}' AND pk = NEW.page_id;
      INSERT INTO sync_log (kind, tbl, pk, cols, hlc) SELECT '${kind}', '${table}', NEW.page_id, NULL, ${HLC} FROM sync_clock;`;
  return [
    `CREATE TRIGGER ${triggerName(table, 'insert')} AFTER INSERT ON ${table} WHEN ${ACTIVE} BEGIN${body}
    END`,
    `CREATE TRIGGER ${triggerName(table, 'update')} AFTER UPDATE OF ${column} ON ${table} WHEN ${ACTIVE} AND OLD.${column} IS NOT NEW.${column} BEGIN${body}
    END`,
  ];
}

/** Trigger neu anlegen (beim Einrichten und bei jedem Start, damit neue Spalten dabei sind). */
export async function installCapture(driver: Driver, tables: Map<string, TableInfo>): Promise<void> {
  const existing = await driver.select<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_capture\\_%' ESCAPE '\\'",
  );
  const statements: Statement[] = existing.map((t) => ({ sql: `DROP TRIGGER ${ident(t.name)}` }));
  for (const t of tables.values()) for (const sql of rowTriggers(t)) statements.push({ sql });
  for (const sql of markTriggers(DOC_TABLE, 'doc', 'doc')) statements.push({ sql });
  for (const sql of markTriggers(BOARD_TABLE, 'board', 'scene')) statements.push({ sql });
  await driver.tx(statements);
}

export async function removeCapture(driver: Driver): Promise<void> {
  const existing = await driver.select<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_capture\\_%' ESCAPE '\\'",
  );
  await driver.tx(existing.map((t) => ({ sql: `DROP TRIGGER ${ident(t.name)}` })));
}

/** Spalte, über die eine Zeile zu einer Seite gehört (für Bereiche und Teilabgleich). */
export const PAGE_COLUMN: Record<string, string> = {
  pages: 'id',
  db_values: 'page_id',
  db_properties: 'database_id',
  db_views: 'database_id',
  card_reviews: 'page_id',
};

/**
 * Vorhandene Zeilen als Änderungen vormerken: beim ersten Hochladen alles, sonst nur die Seiten `pages`
 * (z. B. wenn sie „Nur auf diesem Computer“ verlassen) bzw. die Kategorien `categories`.
 */
export function seedStatements(tables: Map<string, TableInfo>, subset?: { pages: string[]; categories: string[] }): Statement[] {
  const statements: Statement[] = [{ sql: TICK }];
  const docFilter = subset ? ' WHERE page_id IN (SELECT value FROM json_each(?))' : '';
  const docParams = subset ? [JSON.stringify(subset.pages)] : [];
  for (const t of tables.values()) {
    const name = ident(t.name);
    let where = '';
    let params: SqlValue[] = [];
    if (subset) {
      const column = t.name === 'categories' ? 'id' : PAGE_COLUMN[t.name];
      if (!column) continue;
      where = ` WHERE r.${ident(column)} IN (SELECT value FROM json_each(?))`;
      params = [JSON.stringify(t.name === 'categories' ? subset.categories : subset.pages)];
    }
    statements.push({
      sql: `INSERT INTO sync_log (kind, tbl, pk, cols, hlc)
            SELECT 'row', '${t.name}', json_array(${t.key.map((k) => `r.${ident(k)}`).join(', ')}),
                   json_object(${t.columns.map((c) => `'${c}', r.${ident(c)}`).join(', ')}),
                   (SELECT ${HLC} FROM sync_clock)
            FROM ${name} r${where}`,
      params,
    });
  }
  statements.push(
    {
      sql: `INSERT INTO sync_meta (tbl, pk, col, hlc) SELECT l.tbl, l.pk, j.key, l.hlc FROM sync_log l, json_each(l.cols) j
            WHERE l.kind = 'row' AND l.hlc = (SELECT ${HLC} FROM sync_clock) ON CONFLICT DO UPDATE SET hlc = excluded.hlc`,
    },
    { sql: `INSERT INTO sync_log (kind, tbl, pk, hlc) SELECT 'doc', '${DOC_TABLE}', page_id, (SELECT ${HLC} FROM sync_clock) FROM ${DOC_TABLE}${docFilter}`, params: docParams },
    { sql: `INSERT INTO sync_log (kind, tbl, pk, hlc) SELECT 'board', '${BOARD_TABLE}', page_id, (SELECT ${HLC} FROM sync_clock) FROM ${BOARD_TABLE}${docFilter}`, params: docParams },
  );
  return statements;
}

/** Löschung einer Zeile vormerken, ohne sie lokal zu löschen (sie verlässt nur die Cloud). */
export function forgetStatement(tbl: string, pk: string): Statement {
  return {
    sql: `INSERT INTO sync_log (kind, tbl, pk, cols, hlc) SELECT 'row', ?, ?, NULL, ${HLC} FROM sync_clock`,
    params: [tbl, pk],
  };
}

// ---------------------------------------------------------------------------------------------
// Anwenden: Änderungen aus der Cloud. Jede Spalte wird nur übernommen, wenn ihr Zeitstempel neuer ist
// als der lokale. Fremdschlüssel werden vorher geprüft, damit eine Änderung zu einer anderswo
// endgültig gelöschten Zeile nicht den ganzen Abgleich blockiert.

function fkGuard(t: TableInfo, column: string, value: SqlValue): { sql: string; params: SqlValue[] } | null {
  const fk = t.foreignKeys.find((f) => f.column === column);
  if (!fk || value === null) return null;
  return { sql: `EXISTS (SELECT 1 FROM ${ident(fk.table)} WHERE ${ident(fk.to)} = ?)`, params: [value] };
}

export function applyRowStatements(t: TableInfo, change: RowChange): Statement[] {
  const keyValues = JSON.parse(change.pk) as SqlValue[];
  if (!Array.isArray(keyValues) || keyValues.length !== t.key.length) return [];
  const name = ident(t.name);
  const where = t.key.map((k) => `${ident(k)} = ?`).join(' AND ');
  const meta = (col: string) => ({
    sql: 'EXISTS (SELECT 1 FROM sync_meta WHERE tbl = ? AND pk = ? AND col = ? AND hlc >= ?)',
    params: [t.name, change.pk, col, change.hlc] as SqlValue[],
  });
  const rowExists = { sql: `EXISTS (SELECT 1 FROM ${name} WHERE ${where})`, params: keyValues };

  if (change.cols === null) {
    const newer = {
      sql: 'EXISTS (SELECT 1 FROM sync_meta WHERE tbl = ? AND pk = ? AND hlc >= ?)',
      params: [t.name, change.pk, change.hlc],
    };
    const won = {
      sql: "EXISTS (SELECT 1 FROM sync_meta WHERE tbl = ? AND pk = ? AND col = '' AND hlc = ?)",
      params: [t.name, change.pk, change.hlc],
    };
    return [
      {
        sql: `INSERT OR REPLACE INTO sync_meta (tbl, pk, col, hlc) SELECT ?, ?, '', ? WHERE NOT ${newer.sql}`,
        params: [t.name, change.pk, change.hlc, ...newer.params],
      },
      { sql: `DELETE FROM ${name} WHERE ${where} AND ${won.sql}`, params: [...keyValues, ...won.params] },
      {
        sql: `DELETE FROM sync_meta WHERE tbl = ? AND pk = ? AND col <> '' AND hlc < ? AND ${won.sql}`,
        params: [t.name, change.pk, change.hlc, ...won.params],
      },
    ];
  }

  const cols = Object.entries(change.cols).filter(([c]) => t.columns.includes(c));
  const statements: Statement[] = [];
  const values = Object.fromEntries(cols);
  t.key.forEach((k, i) => (values[k] = keyValues[i]));

  // Zeile anlegen, falls sie fehlt und alle Pflichtspalten mitkommen.
  if (t.required.every((c) => c in values)) {
    const insertCols = Object.keys(values);
    const guards = insertCols.map((c) => fkGuard(t, c, values[c])).filter((g) => g !== null);
    const tomb = meta('');
    statements.push({
      sql: `INSERT INTO ${name} (${insertCols.map(ident).join(', ')})
            SELECT ${insertCols.map(() => '?').join(', ')}
            WHERE NOT ${rowExists.sql} AND NOT ${tomb.sql}${guards.map((g) => ` AND ${g.sql}`).join('')}`,
      params: [...insertCols.map((c) => values[c]), ...rowExists.params, ...tomb.params, ...guards.flatMap((g) => g.params)],
    });
  }

  for (const [col, value] of cols) {
    if (t.key.includes(col)) continue;
    const newer = meta(col);
    const guard = fkGuard(t, col, value);
    statements.push(
      {
        sql: `UPDATE ${name} SET ${ident(col)} = ? WHERE ${where} AND NOT ${newer.sql}${guard ? ` AND ${guard.sql}` : ''}`,
        params: [value, ...keyValues, ...newer.params, ...(guard?.params ?? [])],
      },
      {
        sql: `INSERT OR REPLACE INTO sync_meta (tbl, pk, col, hlc) SELECT ?, ?, ?, ? WHERE ${rowExists.sql} AND NOT ${newer.sql}${guard ? ` AND ${guard.sql}` : ''}`,
        params: [t.name, change.pk, col, change.hlc, ...rowExists.params, ...newer.params, ...(guard?.params ?? [])],
      },
    );
  }
  statements.push({
    sql: `DELETE FROM sync_meta WHERE tbl = ? AND pk = ? AND col = '' AND hlc < ? AND ${rowExists.sql}`,
    params: [t.name, change.pk, change.hlc, ...rowExists.params],
  });
  return statements;
}
