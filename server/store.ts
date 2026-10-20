import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Driver, SqlValue } from '../src/db/driver';

/** Dieselben Migrationen wie in der App, beim Bauen in die Server-Datei eingebettet. */
const MIGRATIONS = import.meta.glob<string>('../src-tauri/migrations/*.sql', { query: '?raw', import: 'default', eager: true });

/** Tabellen, die es nur auf dem Server gibt. */
const SERVER_SCHEMA = `
CREATE TABLE IF NOT EXISTS cloud_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
-- Alle angenommenen Änderungen in Reihenfolge; Geräte holen ab ihrer letzten Nummer ab.
CREATE TABLE IF NOT EXISTS cloud_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  change TEXT NOT NULL
);
-- Einmalige Kopplungscodes für weitere Geräte (nur der Hash, kurz gültig).
CREATE TABLE IF NOT EXISTS cloud_pairing (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const toSql = (v: SqlValue) => (typeof v === 'boolean' ? Number(v) : v);

export interface Store extends Driver {
  raw: DatabaseSync;
  dir: string;
  assets: string;
  backups: string;
}

/** Öffnet (oder legt an) die Datenbank im Datenordner und bringt sie auf den Stand der App. */
export function openStore(dir: string): Store {
  const assets = join(dir, 'assets');
  const backups = join(dir, 'backups');
  for (const d of [dir, assets, backups]) mkdirSync(d, { recursive: true });
  const raw = new DatabaseSync(join(dir, 'efeu.db'));
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(raw);
  raw.exec(SERVER_SCHEMA);
  return {
    raw,
    dir,
    assets,
    backups,
    async select<T>(sql: string, params: SqlValue[] = []) {
      return raw.prepare(sql).all(...params.map(toSql)) as T[];
    },
    async tx(statements) {
      transaction(raw, () => {
        for (const s of statements) raw.prepare(s.sql).run(...(s.params ?? []).map(toSql));
      });
    },
  };
}

export function transaction<T>(raw: DatabaseSync, work: () => T): T {
  raw.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    raw.exec('COMMIT');
    return result;
  } catch (err) {
    raw.exec('ROLLBACK');
    throw err;
  }
}

/** Migrationen nach Nummer; der Stand steht in user_version. */
function migrate(raw: DatabaseSync) {
  const files = Object.entries(MIGRATIONS)
    .map(([path, sql]) => ({ version: Number(/(\d+)_[^/]+\.sql$/.exec(path)?.[1]), sql }))
    .filter((m) => m.version > 0)
    .sort((a, b) => a.version - b.version);
  const current = Number((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (const m of files) {
    if (m.version <= current) continue;
    transaction(raw, () => {
      raw.exec(m.sql);
      raw.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
}
