import { describe, expect, it } from 'vitest';
import type { PageMeta } from '../db/pages';
import { ancestorIds, buildChildIndex, descendantIds, insertAt, isSelfOrDescendant, trashRoots, type PageMap } from './tree';

const page = (id: string, parentId: string | null, sortOrder = 0, deletedAt: number | null = null): PageMeta => ({
  id,
  parentId,
  type: 'page',
  title: id,
  icon: null,
  cover: null,
  fullWidth: false,
  sortOrder,
  createdAt: 0,
  updatedAt: 0,
  deletedAt,
  space: 'private',
  categoryId: null,
  updatedBy: null,
});

const map = (...pages: PageMeta[]): PageMap => Object.fromEntries(pages.map((p) => [p.id, p]));

describe('tree', () => {
  const pages = map(page('a', null, 1), page('b', null, 0), page('a1', 'a', 0), page('a1x', 'a1', 0), page('gone', null, 2, 5));

  it('baut den Kinder-Index sortiert und ohne gelöschte Seiten', () => {
    const index = buildChildIndex(pages);
    expect(index.get(null)).toEqual(['b', 'a']);
    expect(index.get('a')).toEqual(['a1']);
  });

  it('findet Nachfahren und Vorfahren', () => {
    expect(descendantIds(pages, 'a').sort()).toEqual(['a1', 'a1x']);
    expect(ancestorIds(pages, 'a1x')).toEqual(['a', 'a1']);
    expect(isSelfOrDescendant(pages, 'a', 'a1x')).toBe(true);
    expect(isSelfOrDescendant(pages, 'a1', 'a')).toBe(false);
    expect(isSelfOrDescendant(pages, 'a', null)).toBe(false);
  });

  it('übersteht Zyklen in kaputten Daten', () => {
    const broken = map(page('x', 'y'), page('y', 'x'));
    expect(ancestorIds(broken, 'x')).toEqual(['y']);
  });

  it('fügt an einer Position ein', () => {
    expect(insertAt(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(insertAt(['a', 'b'], 'n', 0)).toEqual(['n', 'a', 'b']);
    expect(insertAt(['a', 'b'], 'n', 99)).toEqual(['a', 'b', 'n']);
  });

  it('zeigt im Papierkorb nur die Wurzeln eines gemeinsamen Löschvorgangs', () => {
    const trashed = map(page('p', null, 0, 10), page('c', 'p', 0, 10), page('older', 'p', 1, 5), page('live', null));
    expect(trashRoots(trashed).map((p) => p.id)).toEqual(['p', 'older']);
  });
});
