import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bilder und Anhänge. Der Dateiname beginnt mit dem SHA-256 des Inhalts (wie in der App), deshalb
 * lässt sich jede Datei prüfen und muss nie zweimal übertragen werden.
 */
const NAME = /^([0-9a-f]{32})\.[a-z0-9]{1,10}$/;

export const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  pdf: 'application/pdf',
};

export const validName = (name: string): boolean => NAME.test(name);

export function listAssets(dir: string): string[] {
  return readdirSync(dir).filter(validName).sort();
}

export function assetPath(dir: string, name: string): string | null {
  if (!validName(name)) return null;
  const path = join(dir, name);
  return existsSync(path) ? path : null;
}

/** Speichert eine Datei, wenn der Inhalt zum Namen passt. */
export function storeAsset(dir: string, name: string, bytes: Buffer): boolean {
  const match = NAME.exec(name);
  if (!match) return false;
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  if (hash !== match[1]) return false;
  const target = join(dir, name);
  if (existsSync(target)) return true;
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, target);
  return true;
}

export function assetStream(path: string) {
  return { size: statSync(path).size, stream: createReadStream(path) };
}
