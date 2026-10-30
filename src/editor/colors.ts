import { TAG_COLORS } from '../db/database';

/** Farben für Text, Hintergründe, Blöcke und Tabellenzellen; dieselbe Palette wie bei Datenbank-Optionen. */
export const COLORS = TAG_COLORS;
export type ColorName = (typeof COLORS)[number];

export const COLOR_LABELS: Record<ColorName, string> = {
  gray: 'Grau',
  brown: 'Braun',
  orange: 'Orange',
  yellow: 'Gelb',
  green: 'Grün',
  blue: 'Blau',
  purple: 'Lila',
  pink: 'Rosa',
  red: 'Rot',
};

/** Nur bekannte Farbnamen übernehmen (Inhalt kann aus Einfügen oder fremden Geräten stammen). */
export const colorName = (value: unknown): ColorName | null =>
  typeof value === 'string' && (COLORS as readonly string[]).includes(value) ? (value as ColorName) : null;
