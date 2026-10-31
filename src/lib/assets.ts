import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { chooseFile, uploadFile, uploadImage } from '../features/collab/guest/uploads';
import { GUEST } from './mode';

/*
 * Bilder und Anhänge. In der App liegen sie im Asset-Ordner (asset:-Protokoll, kein Netzwerk);
 * als Gast kommen sie vom Gastgeber und werden dorthin hochgeladen.
 */

export interface AppPaths {
  dataDir: string;
  assetsDir: string;
  backupsDir: string;
}

let paths: AppPaths | null = null;

export async function initPaths(): Promise<void> {
  paths = await invoke<AppPaths>('app_paths');
}

function appPaths(): AppPaths {
  if (!paths) throw new Error('App-Pfade sind noch nicht geladen');
  return paths;
}

/** URL eines gespeicherten Bildes über das lokale asset:-Protokoll (kein Netzwerk). */
export function assetUrl(name: string): string {
  if (GUEST) return `/files/${encodeURIComponent(name)}`;
  return convertFileSrc(`${appPaths().assetsDir}/${name}`);
}

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'];

export function importImageFile(path: string): Promise<string> {
  return invoke<string>('asset_import_file', { path });
}

export async function importImageBlob(file: Blob, name: string): Promise<string> {
  if (GUEST) return uploadImage(file, name);
  const ext = name.includes('.') ? name.split('.').pop()! : (file.type.split('/')[1] ?? 'png');
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke<string>('asset_import_bytes', bytes, { headers: { 'x-ext': ext.replace('+xml', '') } });
}

/** Öffnet den Dateidialog und importiert ein Bild. Liefert null bei Abbruch. */
export async function pickImage(): Promise<string | null> {
  if (GUEST) {
    const file = await chooseFile('image/*');
    return file ? uploadImage(file, file.name) : null;
  }
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Bilder', extensions: IMAGE_EXTENSIONS }],
  });
  if (typeof selected !== 'string') return null;
  return importImageFile(selected);
}

export async function openExternal(url: string): Promise<void> {
  if (GUEST) {
    if (/^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  return invoke('open_external', { url });
}

export interface StoredFile {
  src: string;
  size: number;
}

/** Beliebige Datei als Anhang kopieren (inhaltsadressiert). */
export function importFile(path: string): Promise<StoredFile> {
  return invoke<StoredFile>('file_import', { path });
}

export async function importFileBlob(file: Blob, name: string): Promise<StoredFile> {
  if (GUEST) return uploadFile(file, name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke<StoredFile>('file_import_bytes', bytes, { headers: { 'x-name': encodeURIComponent(name) } });
}

/** Dateidialog für Anhänge; die gewählte Datei wird gespeichert. Liefert null bei Abbruch. */
export async function pickAndStoreFile(extensions?: string[]): Promise<(StoredFile & { name: string }) | null> {
  if (GUEST) {
    const file = await chooseFile(extensions?.map((e) => `.${e}`).join(','));
    return file ? { ...(await uploadFile(file, file.name)), name: file.name } : null;
  }
  const selected = await open({ multiple: false, directory: false, ...(extensions ? { filters: [{ name: extensions.join(', ').toUpperCase(), extensions }] } : {}) });
  if (typeof selected !== 'string') return null;
  return { ...(await importFile(selected)), name: selected.split(/[\\/]/).pop() ?? selected };
}

/** Öffnet einen Anhang mit dem Standardprogramm des Systems; als Gast wird er heruntergeladen. */
export async function openAsset(name: string, fileName?: string): Promise<void> {
  if (GUEST) {
    const link = document.createElement('a');
    link.href = assetUrl(name);
    link.download = fileName ?? name;
    link.click();
    return;
  }
  return invoke('open_asset', { name });
}
