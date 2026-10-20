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
  bmp: 'image/bmp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
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

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'];

/** Speichert Bytes inhaltsadressiert (wie die App) und liefert den Namen. */
export function storeBytes(dir: string, bytes: Buffer, ext: string): string {
  if (!bytes.length) throw new Error('Leere Datei');
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
  storeAsset(dir, name, bytes);
  return name;
}

export function imageExt(ext: string): string | null {
  const clean = ext.replace(/^\./, '').toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(clean)) return null;
  return clean === 'jpeg' ? 'jpg' : clean;
}

/** Endung beliebiger Anhänge: nur Buchstaben/Ziffern, sonst "bin". */
export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return ext && ext.length <= 10 && /^[a-z0-9]+$/.test(ext) ? ext : 'bin';
}

export function assetStream(path: string) {
  return { size: statSync(path).size, stream: createReadStream(path) };
}
