import { readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store';

const KEEP = 14;
const PATTERN = /^efeu-\d{4}-\d{2}-\d{2}\.db$/;

/**
 * Tägliche Sicherung der Datenbank in den Ordner backups (die letzten 14 Tage).
 * Anhänge werden nie gelöscht und brauchen deshalb keine eigene Sicherung.
 */
export function backupNow(store: Store, now = new Date()): string | null {
  const name = `efeu-${now.toISOString().slice(0, 10)}.db`;
  const existing = readdirSync(store.backups).filter((f) => PATTERN.test(f)).sort();
  if (existing.includes(name)) return null;
  const tmp = join(store.backups, `.${name}.tmp`);
  rmSync(tmp, { force: true });
  store.raw.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
  renameSync(tmp, join(store.backups, name));
  for (const old of [...existing, name].sort().slice(0, -KEEP)) rmSync(join(store.backups, old), { force: true });
  return name;
}
