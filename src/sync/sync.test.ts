import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { insertBoard, saveBoard, type StoredScene } from '../db/boards';
import { saveContent } from '../db/content';
import { deletePage, insertPage, setDeleted, updatePage } from '../db/pages';
import { createTestDriver } from '../test/sqliteDriver';
import { Replica } from './replica';
import type { Change } from './types';

type Driver = ReturnType<typeof createTestDriver>;

/** Eine Cloud im Speicher: eigene Kopie plus Protokoll aller angenommenen Änderungen. */
class Cloud {
  driver = createTestDriver();
  replica = new Replica(this.driver);
  log: { origin: string; change: Change }[] = [];
  ready = this.replica.enable('cloud');
}

class Device {
  driver: Driver = createTestDriver();
  replica = new Replica(this.driver);
  cursor = 0;
  ready: Promise<void>;
  constructor(public name: string, private cloud: Cloud, before?: (d: Driver) => Promise<void>) {
    this.ready = (async () => {
      if (before) await before(this.driver);
      await this.replica.enable(name);
    })();
  }

  async push() {
    await this.ready;
    await this.cloud.ready;
    for (;;) {
      const outbox = await this.replica.collect();
      if (!outbox) return;
      await this.cloud.replica.apply(outbox.changes);
      for (const change of outbox.changes) this.cloud.log.push({ origin: this.name, change });
      await this.replica.ack(outbox);
    }
  }

  async pull() {
    await this.ready;
    const fresh = this.cloud.log.slice(this.cursor).filter((e) => e.origin !== this.name);
    this.cursor = this.cloud.log.length;
    if (fresh.length) await this.replica.apply(fresh.map((e) => e.change));
  }

  async sync() {
    await this.push();
    await this.pull();
  }

  write = (statements: Parameters<Driver['tx']>[0]) => this.driver.tx(statements);
  query = <T>(sql: string, params: (string | number | null)[] = []) => this.driver.select<T>(sql, params);
}

const page = (id: string, title: string, parentId: string | null = null) =>
  insertPage({
    id, parentId, type: 'page', title, icon: null, cover: null, fullWidth: false,
    sortOrder: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
  } as Parameters<typeof insertPage>[0]);

const paragraphs = (...texts: string[]): JSONContent => ({
  type: 'doc',
  content: texts.map((text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })),
});

const content = (id: string, doc: JSONContent) => saveContent(id, doc, '', [], Date.now());

const textOf = async (d: Device, id: string) => {
  const [row] = await d.query<{ doc: string }>('SELECT doc FROM page_content WHERE page_id = ?', [id]);
  const doc = JSON.parse(row.doc) as JSONContent;
  return (doc.content ?? []).map((p) => (p.content ?? []).map((t) => t.text).join(''));
};

const title = async (d: Device, id: string) =>
  (await d.query<{ title: string }>('SELECT title FROM pages WHERE id = ?', [id]))[0]?.title;

function setup() {
  const cloud = new Cloud();
  return { cloud, a: new Device('a', cloud), b: new Device('b', cloud) };
}

describe('Abgleich mit der Cloud', () => {
  it('bringt neue Seiten mit Inhalt auf das andere Gerät', async () => {
    const { a, b } = setup();
    await a.ready;
    await a.write([page('p1', 'Einkauf'), ...content('p1', paragraphs('Milch', 'Brot'))]);
    await a.sync();
    await b.sync();
    expect(await title(b, 'p1')).toBe('Einkauf');
    expect(await textOf(b, 'p1')).toEqual(['Milch', 'Brot']);
    const [fts] = await b.query<{ n: number }>("SELECT count(*) AS n FROM pages_fts WHERE pages_fts MATCH 'brot'");
    expect(fts.n).toBe(1);
  });

  it('lädt beim Einrichten vorhandene Daten hoch', async () => {
    const cloud = new Cloud();
    const a = new Device('a', cloud, async (d) => {
      await d.tx([page('alt', 'Von früher'), ...content('alt', paragraphs('schon da'))]);
    });
    const b = new Device('b', cloud);
    await a.sync();
    await b.sync();
    expect(await textOf(b, 'alt')).toEqual(['schon da']);
  });

  it('erzeugt nach dem Abgleich keine neuen Änderungen (kein Ping-Pong)', async () => {
    const { a, b } = setup();
    await a.ready;
    await a.write([page('p1', 'Notiz'), ...content('p1', paragraphs('Hallo'))]);
    await a.sync();
    await b.sync();
    await a.sync();
    expect(await a.replica.pendingCount()).toBe(0);
    expect(await b.replica.pendingCount()).toBe(0);
    expect(await b.replica.collect()).toBeNull();
  });

  it('führt gleichzeitige Änderungen verschiedener Spalten zusammen, sonst gewinnt die neuere', async () => {
    const { a, b } = setup();
    await a.ready;
    await a.write([page('p1', 'Alt')]);
    await a.sync();
    await b.sync();
    await a.write([updatePage('p1', { title: 'Von A' }, 2)]);
    await b.write([updatePage('p1', { icon: '🌿' }, 3)]);
    await a.sync();
    await b.sync();
    await a.sync();
    for (const d of [a, b]) {
      const [row] = await d.query<{ title: string; icon: string }>("SELECT title, icon FROM pages WHERE id = 'p1'");
      expect(row).toEqual({ title: 'Von A', icon: '🌿' });
    }
    await a.write([updatePage('p1', { title: 'Erst A' }, 4)]);
    await new Promise((r) => setTimeout(r, 5));
    await b.write([updatePage('p1', { title: 'Dann B' }, 5)]);
    await a.sync();
    await b.sync();
    await a.sync();
    expect(await title(a, 'p1')).toBe('Dann B');
    expect(await title(b, 'p1')).toBe('Dann B');
  });

  it('führt gleichzeitiges Schreiben im selben Absatz zeichengenau zusammen', async () => {
    const { a, b } = setup();
    await a.ready;
    await a.write([page('p1', 'Text'), ...content('p1', paragraphs('Der Hund bellt', 'Zweiter Absatz'))]);
    await a.sync();
    await b.sync();
    // Offline auf beiden Geräten
    await a.write(content('p1', paragraphs('Der große Hund bellt', 'Zweiter Absatz')));
    await b.write(content('p1', paragraphs('Der Hund bellt laut', 'Zweiter Absatz', 'Neu von B')));
    await a.sync();
    await b.sync();
    await a.sync();
    const expected = ['Der große Hund bellt laut', 'Zweiter Absatz', 'Neu von B'];
    expect(await textOf(a, 'p1')).toEqual(expected);
    expect(await textOf(b, 'p1')).toEqual(expected);
  });

  it('überträgt Papierkorb und endgültiges Löschen', async () => {
    const { a, b } = setup();
    await a.ready;
    await a.write([page('p1', 'Weg damit'), page('kind', 'Unterseite', 'p1'), ...content('p1', paragraphs('x'))]);
    await a.sync();
    await b.sync();
    await a.write(setDeleted(['p1'], 99));
    await a.sync();
    await b.sync();
    expect((await b.query<{ deleted_at: number }>("SELECT deleted_at FROM pages WHERE id = 'p1'"))[0].deleted_at).toBe(99);
    await b.write([deletePage('p1')]);
    await b.sync();
    await a.sync();
    expect(await a.query("SELECT id FROM pages WHERE id IN ('p1', 'kind')")).toEqual([]);
    expect(await a.query("SELECT page_id FROM page_content WHERE page_id = 'p1'")).toEqual([]);
  });

  it('bleibt nicht hängen, wenn eine Zeile anderswo endgültig gelöscht wurde', async () => {
    const { a, b } = setup();
    await a.ready;
    await a.write([
      { sql: "INSERT INTO pages (id, workspace_id, type, title, created_at, updated_at) VALUES ('db', 'default', 'database', 'DB', 1, 1)" },
      { sql: "INSERT INTO pages (id, workspace_id, parent_id, type, title, created_at, updated_at) VALUES ('r', 'default', 'db', 'page', 'Zeile', 1, 1)" },
      { sql: "INSERT INTO db_properties (id, database_id, name, type) VALUES ('prop', 'db', 'Status', 'text')" },
    ]);
    await a.sync();
    await b.sync();
    await a.write([{ sql: "DELETE FROM db_properties WHERE id = 'prop'" }]);
    await b.write([{ sql: `INSERT INTO db_values (page_id, property_id, value) VALUES ('r', 'prop', '"offen"')` }]);
    await a.sync();
    await b.sync();
    await a.sync();
    expect(await a.query('SELECT * FROM db_values')).toEqual([]);
    expect(await b.query('SELECT * FROM db_properties')).toEqual([]);
    expect(await b.query('SELECT * FROM db_values')).toEqual([]);
  });

  it('führt Boards je Element zusammen und lässt Gelöschtes gelöscht', async () => {
    const { a, b } = setup();
    await a.ready;
    const el = (id: string, version: number, x = 0) => ({ id, type: 'rectangle', version, versionNonce: version, index: `a${id}`, x });
    const scene = (elements: ReturnType<typeof el>[], bg = '#ffffff'): StoredScene => ({
      elements,
      files: {},
      appState: { viewBackgroundColor: bg },
    });
    const board = (d: Device, s: StoredScene) => d.write(saveBoard('brd', s, '', Date.now()));
    const elementsOf = async (d: Device) => {
      const [row] = await d.query<{ scene: string }>("SELECT scene FROM boards WHERE page_id = 'brd'");
      const s = JSON.parse(row.scene) as StoredScene;
      return { ids: s.elements.map((e) => `${e.id}@${e.version}:${e.x}`), bg: s.appState?.viewBackgroundColor };
    };

    await a.write([page('brd', 'Board'), insertBoard('brd', 1)]);
    await board(a, scene([el('1', 1), el('2', 1)]));
    await a.sync();
    await b.sync();
    expect((await elementsOf(b)).ids).toEqual(['1@1:0', '2@1:0']);

    await board(a, scene([el('1', 2, 50), el('2', 1)])); // A verschiebt 1
    await board(b, scene([el('1', 1), el('3', 1)], '#fef3c7')); // B löscht 2, fügt 3 hinzu, färbt
    await a.sync();
    await b.sync();
    await a.sync();
    const expected = { ids: ['1@2:50', '3@1:0'], bg: '#fef3c7' };
    expect(await elementsOf(a)).toEqual(expected);
    expect(await elementsOf(b)).toEqual(expected);
    expect(await a.replica.pendingCount()).toBe(0);
  });
});
