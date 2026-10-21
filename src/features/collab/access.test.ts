import { describe, expect, it } from 'vitest';
import type { PageMeta } from '../../db/pages';
import type { PageMap } from '../../lib/tree';
import { accessMap, grantSource, guestPages, type Role } from './access';

const page = (id: string, parentId: string | null, extra: Partial<PageMeta> = {}): PageMeta => ({
  id,
  parentId,
  type: 'page',
  title: id,
  icon: null,
  cover: null,
  fullWidth: false,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  space: 'private',
  categoryId: null,
  updatedBy: null,
  ...extra,
});

const tree: PageMap = Object.fromEntries(
  [
    page('projekt', null),
    page('plan', 'projekt'),
    page('intern', 'projekt'),
    page('notiz', 'intern'),
    page('privat', null),
    page('alt', 'projekt', { deletedAt: 5 }),
  ].map((p) => [p.id, p]),
);

describe('Rechte pro Seite', () => {
  it('vererbt Freigaben an Unterseiten, die nächste Freigabe gewinnt', () => {
    const grants = new Map<string, Role>([
      ['projekt', 'edit'],
      ['intern', 'none'],
    ]);
    const access = accessMap(tree, grants);
    expect(Object.fromEntries(access)).toEqual({ projekt: 'edit', plan: 'edit' });
  });

  it('kann einen Teilbaum enger oder weiter fassen', () => {
    const access = accessMap(tree, new Map<string, Role>([['projekt', 'read'], ['plan', 'edit']]));
    expect(access.get('projekt')).toBe('read');
    expect(access.get('plan')).toBe('edit');
    expect(access.get('notiz')).toBe('read');
    expect(access.has('privat')).toBe(false);
  });

  it('zeigt keine Seiten aus dem Papierkorb', () => {
    expect(accessMap(tree, new Map<string, Role>([['projekt', 'edit']])).has('alt')).toBe(false);
  });

  it('hängt Seiten ohne sichtbare Elternseite oben ein', () => {
    const access = accessMap(tree, new Map<string, Role>([['notiz', 'read']]));
    const [notiz] = guestPages(tree, access);
    expect(notiz).toMatchObject({ id: 'notiz', parentId: null, access: 'read' });
  });

  it('übersteht kaputte Bäume ohne Endlosschleife', () => {
    const loop: PageMap = { a: page('a', 'b'), b: page('b', 'a') };
    expect(accessMap(loop, new Map()).size).toBe(0);
  });

  it('nennt die Seite, von der der Zugriff stammt', () => {
    const grants = new Map<string, Role>([['projekt', 'edit']]);
    expect(grantSource(tree, grants, 'notiz')).toEqual({ pageId: 'projekt', role: 'edit' });
    expect(grantSource(tree, grants, 'privat')).toBeNull();
  });
});
