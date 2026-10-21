import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveContent } from '../db/content';
import { flush } from '../db/saveQueue';
import { freshDatabase } from '../test/setup';
import { groupRoots, usePages } from './pages';

const store = () => usePages.getState();
const roots = () => store().children.get(null) ?? [];

let driver: Awaited<ReturnType<typeof freshDatabase>>;

beforeEach(async () => {
  driver = await freshDatabase();
});

async function reload() {
  await flush();
  await store().load();
}

describe('Seiten-Store', () => {
  it('legt Seiten an definierter Position an und speichert die Reihenfolge', async () => {
    const a = await store().create({ title: 'A' });
    const b = await store().create({ title: 'B' });
    const c = await store().create({ title: 'C', index: 0 });
    expect(roots()).toEqual([c, a, b]);
    await reload();
    expect(roots()).toEqual([c, a, b]);
  });

  it('verschiebt und verschachtelt, verhindert aber Zyklen', async () => {
    const a = await store().create({ title: 'A' });
    const b = await store().create({ title: 'B' });
    await store().move(b, a, 0);
    expect(store().children.get(a)).toEqual([b]);
    await store().move(a, b, 0);
    expect(store().pages[a].parentId).toBeNull();
    await reload();
    expect(store().children.get(a)).toEqual([b]);
    expect(roots()).toEqual([a]);
  });

  it('sortiert innerhalb derselben Ebene', async () => {
    const ids = [];
    for (const t of ['1', '2', '3', '4']) ids.push(await store().create({ title: t }));
    await store().move(ids[0], null, 3);
    expect(roots()).toEqual([ids[1], ids[2], ids[3], ids[0]]);
    await reload();
    expect(roots()).toEqual([ids[1], ids[2], ids[3], ids[0]]);
  });

  it('legt Teilbäume in den Papierkorb und stellt sie wieder her', async () => {
    const parent = await store().create({ title: 'P' });
    const child = await store().create({ title: 'C', parentId: parent });
    await store().trash(parent);
    expect(store().pages[child].deletedAt).not.toBeNull();
    expect(roots()).toEqual([]);
    await store().restore(parent);
    await reload();
    expect(store().pages[child].deletedAt).toBeNull();
    expect(store().children.get(parent)).toEqual([child]);
  });

  it('stellt ein Kind ohne lebenden Elternteil auf oberster Ebene wieder her', async () => {
    const parent = await store().create({ title: 'P' });
    const child = await store().create({ title: 'C', parentId: parent });
    await store().trash(child);
    await store().trash(parent);
    await store().restore(child);
    await reload();
    expect(store().pages[child].parentId).toBeNull();
    expect(roots()).toEqual([child]);
  });

  it('löscht endgültig samt Unterseiten, Inhalt und Links', async () => {
    const a = await store().create({ title: 'A' });
    const child = await store().create({ title: 'Kind', parentId: a });
    const b = await store().create({ title: 'B' });
    await driver.tx(saveContent(b, { type: 'doc' }, '', [a], 1));
    await driver.tx(saveContent(child, { type: 'doc' }, 'x', [], 1));
    await store().trash(a);
    await store().deleteForever(a);
    await reload();
    expect(Object.keys(store().pages)).toEqual([b]);
    expect(await driver.select('SELECT * FROM page_links')).toEqual([]);
    expect(await driver.select('SELECT page_id FROM page_content')).toEqual([{ page_id: b }]);
  });

  it('übernimmt Titeländerungen gebündelt', async () => {
    const a = await store().create({ title: '' });
    store().update(a, { title: 'H' });
    store().update(a, { title: 'Hallo', icon: '👋' });
    await reload();
    expect(store().pages[a]).toMatchObject({ title: 'Hallo', icon: '👋' });
  });

  it('rollt den Zustand zurück, wenn die Transaktion scheitert', async () => {
    const a = await store().create({ title: 'A' });
    const spy = vi.spyOn(driver, 'tx').mockRejectedValueOnce(new Error('Platte voll'));
    await expect(store().trash(a)).rejects.toThrow('Platte voll');
    expect(store().pages[a].deletedAt).toBeNull();
    spy.mockRestore();
  });
});

describe('Versionsverlauf', () => {
  it('legt höchstens eine Version je 10 Minuten an und behält 50', async () => {
    const a = await store().create({ title: 'A' });
    const t0 = 1_000_000_000;
    await driver.tx(saveContent(a, { type: 'doc', content: [] }, 'v1', [], t0));
    await driver.tx(saveContent(a, { type: 'doc', content: [] }, 'v1b', [], t0 + 60_000));
    expect((await driver.select<{ text: string }>('SELECT text FROM page_versions')).map((r) => r.text)).toEqual(['v1']);
    for (let i = 1; i <= 60; i++) await driver.tx(saveContent(a, { type: 'doc' }, `v${i + 1}`, [], t0 + i * 11 * 60_000));
    const rows = await driver.select<{ text: string }>('SELECT text FROM page_versions ORDER BY created_at DESC');
    expect(rows).toHaveLength(50);
    expect(rows[0].text).toBe('v61');
  });
});

describe('Bereiche und Kategorien', () => {
  const rows = () => driver.select<{ id: string; space: string; category_id: string | null; sort_order: number }>(
    'SELECT id, space, category_id, sort_order FROM pages WHERE parent_id IS NULL ORDER BY space, category_id, sort_order',
  );
  it('legt Seiten in Kategorien an und sortiert je Gruppe', async () => {
    const uni = await store().createCategory('private', 'Uni');
    const a = await store().create({ title: 'A', categoryId: uni });
    const b = await store().create({ title: 'B', categoryId: uni, index: 0 });
    const c = await store().create({ title: 'C' });
    const { pages, children, categories } = store();
    expect(groupRoots(pages, children, categories, { space: 'private', categoryId: uni })).toEqual([b, a]);
    expect(groupRoots(pages, children, categories, { space: 'private', categoryId: null })).toEqual([c]);
    await store().load();
    expect(groupRoots(store().pages, store().children, store().categories, { space: 'private', categoryId: uni })).toEqual([b, a]);
  });

  it('verschiebt Seiten samt Unterseiten zwischen Bereichen und Kategorien', async () => {
    const team = await store().createCategory('team', 'Projekte');
    const a = await store().create({ title: 'A' });
    const child = await store().create({ title: 'Kind', parentId: a });
    await store().moveToGroup(a, { space: 'team', categoryId: team }, 0);
    expect(store().pages[a]).toMatchObject({ space: 'team', categoryId: team, parentId: null });
    expect(store().pages[child].parentId).toBe(a);
    // Unterseite nach oben ziehen: landet in der Gruppe ihrer bisherigen obersten Seite.
    await store().move(child, null, 0);
    expect(store().pages[child]).toMatchObject({ space: 'team', categoryId: team, parentId: null });
    expect(await rows()).toEqual([
      { id: child, space: 'team', category_id: team, sort_order: 0 },
      { id: a, space: 'team', category_id: team, sort_order: 1 },
    ]);
  });

  it('nimmt beim Verschieben einer Kategorie ihre Seiten mit und räumt beim Entfernen auf', async () => {
    const cat = await store().createCategory('private', 'Projekte');
    const a = await store().create({ title: 'A', categoryId: cat });
    const loose = await store().create({ title: 'Lose', space: 'team' });
    await store().moveCategory(cat, 'team', 0);
    expect(store().categories[cat].space).toBe('team');
    expect(store().pages[a].space).toBe('team');
    await store().deleteCategory(cat);
    expect(store().categories[cat]).toBeUndefined();
    const { pages, children, categories } = store();
    expect(groupRoots(pages, children, categories, { space: 'team', categoryId: null })).toEqual([loose, a]);
    expect(await driver.select('SELECT * FROM categories')).toEqual([]);
  });
});
