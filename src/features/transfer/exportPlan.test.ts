import { describe, expect, it } from 'vitest';
import type { Property } from '../../db/database';
import type { PageMeta } from '../../db/pages';
import { buildChildIndex } from '../../lib/tree';
import { planExport, relativeHref, sanitizeName } from './exportPlan';

const page = (id: string, title: string, parentId: string | null = null, extra: Partial<PageMeta> = {}): PageMeta => ({
  id,
  title,
  parentId,
  type: 'page',
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

describe('Export-Planung', () => {
  it('bereinigt Dateinamen', () => {
    expect(sanitizeName('A/B: C?')).toBe('A B C');
    expect(sanitizeName('   ')).toBe('Ohne Titel');
    expect(sanitizeName('..versteckt')).toBe('versteckt');
  });

  it('berechnet relative Links', () => {
    expect(relativeHref('', 'Ein Projekt/Notiz.md')).toBe('Ein%20Projekt/Notiz.md');
    expect(relativeHref('A/B', 'A/C.md')).toBe('../C.md');
    expect(relativeHref('A', 'X/Y.md')).toBe('../X/Y.md');
  });

  it('erzeugt Ordnerstruktur, eindeutige Namen, Links und Bilder', () => {
    const pages = Object.fromEntries(
      [
        page('a', 'Projekt'),
        page('b', 'Notiz', 'a', { sortOrder: 0 }),
        page('c', 'Notiz', 'a', { sortOrder: 1 }),
        page('d', 'Gelöscht', 'a', { deletedAt: 1 }),
      ].map((p) => [p.id, p]),
    );
    const plan = planExport(['a'], {
      pages,
      children: buildChildIndex(pages),
      docs: {
        a: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'pageLink', attrs: { pageId: 'c' } }] }] },
        b: { type: 'doc', content: [{ type: 'image', attrs: { src: 'x.png', alt: '' } }] },
        c: null,
      },
      databases: {},
    });
    expect(plan.files.map((f) => f.path)).toEqual(['Projekt.md', 'Projekt/Notiz.md', 'Projekt/Notiz (2).md']);
    expect(plan.files[0].content).toBe('# Projekt\n\n[Notiz](Projekt/Notiz%20(2).md)\n');
    expect(plan.files[1].content).toBe('# Notiz\n\n![](../assets/x.png)\n');
    expect(plan.assets).toEqual([{ name: 'x.png', path: 'assets/x.png' }]);
  });

  it('exportiert Datenbanken als Tabelle und Einträge mit Front-Matter', () => {
    const status: Property = {
      id: 's',
      databaseId: 'db',
      name: 'Status',
      type: 'select',
      config: {},
      sortOrder: 0,
      options: [{ id: 'o1', name: 'Offen', color: 'gray' }],
    };
    const done: Property = { id: 'x', databaseId: 'db', name: 'Fertig', type: 'checkbox', sortOrder: 1, options: [], config: {} };
    const pages = Object.fromEntries(
      [page('db', 'Aufgaben', null, { type: 'database' }), page('r', 'A | B', 'db')].map((p) => [p.id, p]),
    );
    const plan = planExport(['db'], {
      pages,
      children: buildChildIndex(pages),
      docs: {},
      databases: { db: { properties: [status, done], values: { r: { s: 'o1', x: true } } } },
    });
    expect(plan.files[0].content).toBe(
      '# Aufgaben\n\n| Name | Status | Fertig |\n| --- | --- | --- |\n| [A \\| B](Aufgaben/A%20B.md) | Offen | ✓ |\n',
    );
    expect(plan.files[1].content.startsWith('---\n"Status": "Offen"\n"Fertig": true\n---\n\n# A \\| B\n')).toBe(true);
  });
});

describe('Board-Export', () => {
  it('schreibt Boards als .excalidraw-Datei mit Verweis im Markdown', () => {
    const pages = { b: page('b', 'Ideen / Mai', null, { type: 'board' }) };
    const scene = {
      type: 'excalidraw' as const,
      version: 2 as const,
      source: 'efeu',
      elements: [{ id: 'e1', type: 'text', text: 'Hallo' }],
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    };
    const plan = planExport(['b'], { pages, children: buildChildIndex(pages), docs: {}, databases: {}, boards: { b: scene } });
    const byPath = Object.fromEntries(plan.files.map((f) => [f.path, f.content]));
    expect(Object.keys(byPath).sort()).toEqual(['Ideen Mai.excalidraw', 'Ideen Mai.md']);
    expect(byPath['Ideen Mai.md']).toBe('# Ideen / Mai\n\n[Board öffnen (Excalidraw-Datei)](Ideen%20Mai.excalidraw)\n');
    expect(JSON.parse(byPath['Ideen Mai.excalidraw']).elements[0].text).toBe('Hallo');
  });
});
