import { db, type Statement } from './driver';
import type { Space } from './pages';

/** Kategorie in der Seitenleiste (wie ein Kanal-Ordner bei Discord). */
export interface Category {
  id: string;
  space: Space;
  name: string;
  sortOrder: number;
  createdAt: number;
}

export async function loadCategories(): Promise<Category[]> {
  const rows = await db().select<{ id: string; space: Space; name: string; sort_order: number; created_at: number }>(
    'SELECT id, space, name, sort_order, created_at FROM categories ORDER BY sort_order, created_at',
  );
  return rows.map((r) => ({ id: r.id, space: r.space, name: r.name, sortOrder: Number(r.sort_order), createdAt: Number(r.created_at) }));
}

export function insertCategory(c: Category): Statement {
  return {
    sql: 'INSERT INTO categories (id, space, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
    params: [c.id, c.space, c.name, c.sortOrder, c.createdAt],
  };
}

export function placeCategory(id: string, space: Space, sortOrder: number): Statement {
  return { sql: 'UPDATE categories SET space = ?, sort_order = ? WHERE id = ?', params: [space, sortOrder, id] };
}

export function renameCategory(id: string, name: string): Statement {
  return { sql: 'UPDATE categories SET name = ? WHERE id = ?', params: [name, id] };
}

export function deleteCategory(id: string): Statement {
  return { sql: 'DELETE FROM categories WHERE id = ?', params: [id] };
}
