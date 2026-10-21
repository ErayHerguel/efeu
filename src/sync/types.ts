import type { SqlValue } from '../db/driver';
import type { BoardElement } from '../features/collab/sources';

export type { BoardElement };

/**
 * Eine Änderung, wie sie zwischen Gerät und Cloud wandert. Alle Arten lassen sich beliebig oft und in
 * beliebiger Reihenfolge anwenden und ergeben am Ende überall denselben Stand:
 * - row: Spalten einer Tabellenzeile, die neuere Änderung je Spalte gewinnt (cols null = Zeile gelöscht)
 * - doc: Yjs-Update eines Seiteninhalts, wird zeichengenau zusammengeführt
 * - board: Board-Elemente, die höhere Version je Element gewinnt
 * - forget: Seiten und Kategorien, die das Gerät nicht mehr sehen darf (nur von der Cloud an Team-Geräte);
 *   sie werden lokal entfernt, ohne dass das als Löschung zurückgeht
 */
export type Change = RowChange | DocChange | BoardChange | ForgetChange;

export interface RowChange {
  kind: 'row';
  tbl: string;
  /** JSON-Array der Schlüsselwerte */
  pk: string;
  cols: Record<string, SqlValue> | null;
  hlc: string;
}

export interface DocChange {
  kind: 'doc';
  page: string;
  /** Yjs-Update (Base64) */
  update: string;
}

export interface BoardChange {
  kind: 'board';
  page: string;
  elements: BoardElement[];
  files: Record<string, { asset: string; mimeType: string }>;
  background: { value: string; hlc: string } | null;
}

export interface ForgetChange {
  kind: 'forget';
  pages: string[];
  categories: string[];
}
