import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { db } from '../../db/driver';
import { commit, schedule } from '../../db/saveQueue';
import { setSetting } from '../../db/settings';
import { importImageBlob } from '../../lib/assets';
import { GUEST } from '../../lib/mode';

export interface CoverCredit {
  author: string;
  authorUrl: string;
  source: string;
  sourceUrl: string;
}

export interface UnsplashPhoto {
  id: string;
  thumb: string;
  raw: string;
  color: string;
  description: string;
  author: string;
  authorUrl: string;
  photoUrl: string;
  download: string;
}

/** Unsplash ist eingerichtet (der Schlüssel selbst liegt im Schlüsselbund) */
export const useUnsplash = create<{ keySet: boolean }>(() => ({ keySet: false }));

export function hydrateUnsplash(settings: Record<string, string>): void {
  useUnsplash.setState({ keySet: !GUEST && settings['unsplash.keySet'] === '1' });
}

export async function setUnsplashKey(key: string | null): Promise<void> {
  if (key === null) await invoke('unsplash_key_delete');
  else await invoke('unsplash_key_set', { key });
  useUnsplash.setState({ keySet: key !== null });
  schedule('setting:unsplash.keySet', () => [setSetting('unsplash.keySet', key === null ? '0' : '1')]);
}

export function searchUnsplash(query: string, page = 1): Promise<UnsplashPhoto[]> {
  return invoke<UnsplashPhoto[]>('unsplash_search', { query, page });
}

/** Foto herunterladen, als Asset speichern und den Bildnachweis merken. */
export async function useUnsplashPhoto(photo: UnsplashPhoto): Promise<string> {
  const asset = await invoke<string>('unsplash_use', { photo: { raw: photo.raw, download: photo.download } });
  await commit([
    {
      sql: `INSERT INTO cover_credits (asset, author, author_url, source, source_url) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(asset) DO UPDATE SET author = excluded.author, author_url = excluded.author_url, source_url = excluded.source_url`,
      params: [asset, photo.author, photo.authorUrl, 'Unsplash', photo.photoUrl],
    },
  ]);
  credits.delete(asset);
  return asset;
}

const credits = new Map<string, Promise<CoverCredit | null>>();

export function coverCredit(asset: string): Promise<CoverCredit | null> {
  if (GUEST) return Promise.resolve(null);
  let entry = credits.get(asset);
  if (!entry) {
    entry = db()
      .select<CoverCredit>('SELECT author, author_url AS authorUrl, source, source_url AS sourceUrl FROM cover_credits WHERE asset = ?', [asset])
      .then((rows) => rows[0] ?? null)
      .catch(() => null);
    credits.set(asset, entry);
  }
  return entry;
}

/** Ruhige Farbverläufe, lokal erzeugt (kein Netz, kein Schlüssel nötig) */
export const GRADIENTS: { name: string; stops: string[]; angle: number }[] = [
  { name: 'Morgen', stops: ['#ffecd2', '#fcb69f'], angle: 120 },
  { name: 'Meer', stops: ['#a1c4fd', '#c2e9fb'], angle: 120 },
  { name: 'Wiese', stops: ['#d4fc79', '#96e6a1'], angle: 120 },
  { name: 'Lavendel', stops: ['#e0c3fc', '#8ec5fc'], angle: 120 },
  { name: 'Sonnenuntergang', stops: ['#fa709a', '#fee140'], angle: 120 },
  { name: 'Nebel', stops: ['#e6e9f0', '#eef1f5'], angle: 180 },
  { name: 'Pfirsich', stops: ['#ffd1ff', '#fad0c4'], angle: 120 },
  { name: 'Wald', stops: ['#0ba360', '#3cba92'], angle: 120 },
  { name: 'Nacht', stops: ['#30cfd0', '#330867'], angle: 120 },
  { name: 'Glut', stops: ['#f83600', '#f9d423'], angle: 120 },
  { name: 'Schiefer', stops: ['#485563', '#29323c'], angle: 120 },
  { name: 'Himmel', stops: ['#89f7fe', '#66a6ff'], angle: 120 },
];

export const gradientCss = (g: (typeof GRADIENTS)[number]) => `linear-gradient(${g.angle}deg, ${g.stops.join(', ')})`;

/** Verlauf als PNG-Asset (breit genug für jedes Fenster) */
export async function gradientAsset(g: (typeof GRADIENTS)[number]): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 2400;
  canvas.height = 560;
  const ctx = canvas.getContext('2d')!;
  const rad = ((g.angle - 90) * Math.PI) / 180;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const len = Math.abs(canvas.width * Math.cos(rad)) / 2 + Math.abs(canvas.height * Math.sin(rad)) / 2;
  const gradient = ctx.createLinearGradient(cx - Math.cos(rad) * len, cy - Math.sin(rad) * len, cx + Math.cos(rad) * len, cy + Math.sin(rad) * len);
  g.stops.forEach((stop, i) => gradient.addColorStop(i / (g.stops.length - 1), stop));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht erzeugt werden'))), 'image/png'));
  return importImageBlob(blob, `verlauf-${g.name}.png`);
}
