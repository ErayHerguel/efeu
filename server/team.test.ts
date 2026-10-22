import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { saveContent } from '../src/db/content';
import { SyncClient, type Transport } from '../src/sync/client';
import { Replica } from '../src/sync/replica';
import { createTestDriver } from '../src/test/sqliteDriver';
import { createApp } from './app';
import { Cloud } from './cloud';
import { Devices } from './devices';
import { checkPassword, hashPassword, Team } from './team';
import { Mentions } from './mentions';
import { openStore } from './store';

const closers: (() => void)[] = [];
afterAll(() => closers.forEach((c) => c()));

async function start() {
  const store = openStore(mkdtempSync(join(tmpdir(), 'efeu-team-')));
  const devices = new Devices(store);
  const cloud = new Cloud(store);
  await cloud.start();
  const team = new Team(store);
  const mentions = new Mentions(store);
  cloud.afterDocs = (pages, byId, byName) => mentions.scan(pages, byId, byName);
  const server = createApp({ store, cloud, devices, team, mentions, teamChanged: () => void cloud.drainLocal() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => server.close());
  return { store, devices, cloud, team, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function device(url: string, token: string) {
  const driver = createTestDriver();
  const replica = new Replica(driver);
  const assets = mkdtempSync(join(tmpdir(), 'efeu-team-assets-'));
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(url + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res;
  };
  const transport: Transport = {
    push: async (changes) => (await call('/api/sync/push', { method: 'POST', body: JSON.stringify({ changes }) })).json(),
    pull: async (since) => (await call(`/api/sync/pull?since=${since}`)).json(),
    listAssets: async () => ((await (await call('/api/assets')).json()) as { names: string[] }).names,
    uploadAsset: async (name) => void (await call(`/api/assets/${name}`, { method: 'PUT', body: readFileSync(join(assets, name)) })),
    downloadAsset: async (name) => writeFileSync(join(assets, name), Buffer.from(await (await call(`/api/assets/${name}`)).arrayBuffer())),
    localAssets: async () => readdirSync(assets),
  };
  const titles = async () => (await driver.select<{ title: string }>('SELECT title FROM pages ORDER BY title')).map((r) => r.title);
  return { driver, replica, assets, call, titles, client: new SyncClient(driver, replica, transport) };
}

const page = (id: string, title: string, space: string, parent: string | null = null) => ({
  sql: "INSERT INTO pages (id, workspace_id, parent_id, type, title, created_at, updated_at, space) VALUES (?, 'default', ?, 'page', ?, 1, 1, ?)",
  params: [id, parent, title, space],
});

const post = (url: string, path: string, body: unknown) => fetch(url + path, { method: 'POST', body: JSON.stringify(body) });

describe('Team', () => {
  it('speichert Passwörter nur als scrypt-Hash', () => {
    const stored = hashPassword('ein langes Passwort');
    expect(stored).not.toContain('ein langes Passwort');
    expect(checkPassword('ein langes Passwort', stored)).toBe(true);
    expect(checkPassword('falsch', stored)).toBe(false);
  });

  it('zeigt Mitgliedern nur den Team-Bereich, liefert nach und entzieht wieder', async () => {
    const { url, devices, team } = await start();
    const owner = device(url, devices.add('Mac').token);
    await owner.replica.enable('mac');
    const bytes = Buffer.from('privates Bild');
    const secretImage = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.png`;
    writeFileSync(join(owner.assets, secretImage), bytes);
    await owner.driver.tx([
      page('team1', 'Projektplan', 'team'),
      page('team1kind', 'Aufgaben', 'private', 'team1'),
      page('privat', 'Tagebuch', 'private'),
      ...saveContent('privat', { type: 'doc', content: [{ type: 'image', attrs: { src: secretImage } }] }, '', [], 1),
      { sql: "INSERT INTO categories (id, space, name, created_at) VALUES ('ct', 'team', 'Projekte', 1), ('cp', 'private', 'Uni', 1)" },
    ]);
    await owner.client.sync();

    // Einladen und beitreten (wie in der App: mit Geräteschlüssel)
    const invite = (await (await owner.call('/api/team/invites', { method: 'POST' })).json()) as { code: string };
    expect((await post(url, '/api/team/join', { code: invite.code, name: 'Lena', login: 'lena', password: 'kurz' })).status).toBe(400);
    const joined = await post(url, '/api/team/join', { code: invite.code, name: 'Lena', login: 'lena', password: 'ganz-geheim-123', device: 'Lenas Mac' });
    expect(joined.status).toBe(200);
    const access = (await joined.json()) as { deviceToken: string; token: string };
    expect((await post(url, '/api/team/join', { code: invite.code, name: 'Max', login: 'max', password: 'ganz-geheim-456' })).status).toBe(400);
    expect(team.list().map((m) => m.login)).toEqual(['lena']);

    const lena = device(url, access.deviceToken);
    await lena.replica.enable('lena');
    await lena.client.sync();
    expect(await lena.titles()).toEqual(['Aufgaben', 'Projektplan']);
    expect(await lena.driver.select('SELECT name FROM categories')).toEqual([{ name: 'Projekte' }]);
    expect(await lena.driver.select('SELECT * FROM share_members')).toEqual([]);
    expect(readdirSync(lena.assets)).toEqual([]);
    await expect(lena.call(`/api/assets/${secretImage}`)).rejects.toThrow('404');
    await expect(lena.call('/api/devices')).rejects.toThrow('403');

    // Lena darf im Team schreiben, aber nichts Privates anfassen und nichts aus dem Team nehmen.
    await lena.driver.tx([
      { sql: "UPDATE pages SET title = 'Projektplan 2027' WHERE id = 'team1'" },
      page('neu', 'Von Lena', 'team'),
    ]);
    await lena.client.sync();
    await lena.replica.apply([]);
    await lena.client.sync();
    await owner.client.sync();
    expect(await owner.titles()).toEqual(['Aufgaben', 'Projektplan 2027', 'Tagebuch', 'Von Lena']);
    // Der Server vermerkt, wer zuletzt geändert hat; das kommt beim Inhaber an.
    for (let i = 0; i < 20; i++) {
      await owner.client.sync();
      const [row] = await owner.driver.select<{ updated_by: string | null }>("SELECT updated_by FROM pages WHERE id = 'team1'");
      if (row.updated_by) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await owner.driver.select("SELECT updated_by FROM pages WHERE id = 'team1'")).toEqual([{ updated_by: 'Lena' }]);
    await lena.client['transport'].push([{ kind: 'row', tbl: 'pages', pk: '["privat"]', cols: { title: 'Gehackt' }, hlc: '999999999999998-lena' }]);
    await lena.client['transport'].push([{ kind: 'row', tbl: 'pages', pk: '["team1"]', cols: { space: 'private' }, hlc: '999999999999998-lena' }]);
    await lena.client['transport'].push([{ kind: 'row', tbl: 'pages', pk: '["team1"]', cols: null, hlc: '999999999999998-lena' }]);
    await owner.client.sync();
    expect(await owner.titles()).toEqual(['Aufgaben', 'Projektplan 2027', 'Tagebuch', 'Von Lena']);
    expect(await owner.driver.select("SELECT space FROM pages WHERE id = 'team1'")).toEqual([{ space: 'team' }]);

    // Inhaber gibt das Tagebuch fürs Team frei: Lena bekommt es samt Bild nachgeliefert.
    await owner.driver.tx([{ sql: "UPDATE pages SET space = 'team' WHERE id = 'privat'" }]);
    await owner.client.sync();
    await lena.client.sync();
    expect(await lena.titles()).toContain('Tagebuch');
    expect(readdirSync(lena.assets)).toEqual([secretImage]);

    // … und nimmt das Projekt wieder aus dem Team: verschwindet bei Lena, bleibt beim Inhaber.
    await owner.driver.tx([{ sql: "UPDATE pages SET space = 'private' WHERE id = 'team1'" }]);
    await owner.client.sync();
    await lena.client.sync();
    expect(await lena.titles()).toEqual(['Tagebuch', 'Von Lena']);
    expect(await owner.titles()).toContain('Projektplan 2027');
    expect(await lena.replica.pendingCount()).toBe(0);
  });

  it('meldet per Passwort an, setzt zurück und entfernt Mitglieder samt Geräten', async () => {
    const { url, devices, team } = await start();
    const owner = device(url, devices.add('Mac').token);
    const { code } = (await (await owner.call('/api/team/invites', { method: 'POST' })).json()) as { code: string };
    await post(url, '/api/team/join', { code, name: 'Lena', login: 'Lena', password: 'ganz-geheim-123' });
    expect((await post(url, '/api/team/login', { login: 'lena', password: 'falsch-falsch' })).status).toBe(401);
    const login = await post(url, '/api/team/login', { login: 'lena', password: 'ganz-geheim-123', device: 'iPad' });
    expect(login.status).toBe(200);
    const { deviceToken, memberId } = (await login.json()) as { deviceToken: string; memberId: string };

    const { code: reset } = (await (await owner.call(`/api/team/members/${memberId}/reset`, { method: 'POST' })).json()) as { code: string };
    expect((await post(url, '/api/team/reset', { code: reset, password: 'ein-neues-passwort' })).status).toBe(200);
    expect((await post(url, '/api/team/login', { login: 'lena', password: 'ganz-geheim-123' })).status).toBe(401);
    expect((await post(url, '/api/team/login', { login: 'lena', password: 'ein-neues-passwort' })).status).toBe(200);

    await owner.call(`/api/team/members/${memberId}`, { method: 'DELETE' });
    expect(team.list()).toEqual([]);
    expect((await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(401);
  });

  it('benachrichtigt bei neuen Erwähnungen, nur wer die Seite sehen darf, ohne Doppelte', async () => {
    const { url, devices } = await start();
    const owner = device(url, devices.add('Mac').token);
    await owner.replica.enable('mac');
    const { code } = (await (await owner.call('/api/team/invites', { method: 'POST' })).json()) as { code: string };
    const joined = (await (await post(url, '/api/team/join', { code, name: 'Lena', login: 'lena', password: 'ganz-geheim-123', device: 'Lenas Mac' })).json()) as {
      memberId: string;
      deviceToken: string;
    };
    const lena = device(url, joined.deviceToken);
    const people = (await (await lena.call('/api/team/people')).json()) as { people: { id: string; name: string }[]; me: string };
    expect(people.people.map((p) => p.name)).toEqual(['Inhaber', 'Lena']);
    expect(people.me).toBe(joined.memberId);

    const mention = (id: string, label: string, text = 'schau mal') => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id, label } }, { type: 'text', text: ` ${text}` }] }],
    });
    await owner.driver.tx([
      page('t', 'Plan', 'team'),
      page('p', 'Geheim', 'private'),
      ...saveContent('t', mention(joined.memberId, 'Lena'), '', [], 1),
      ...saveContent('p', mention(joined.memberId, 'Lena'), '', [], 1),
    ]);
    await owner.client.sync();
    const list = async () => ((await (await lena.call('/api/notifications')).json()) as { notifications: { title: string; byName: string; read: boolean }[] }).notifications;
    expect(await list()).toEqual([expect.objectContaining({ title: 'Plan', byName: 'Inhaber', read: false })]);

    // Weiterschreiben erwähnt nicht erneut; gelesen markieren.
    await owner.driver.tx(saveContent('t', mention(joined.memberId, 'Lena', 'schau mal bitte'), '', [], 2));
    await owner.client.sync();
    expect(await list()).toHaveLength(1);
    await lena.call('/api/notifications/read', { method: 'POST', body: JSON.stringify({ ids: 'all' }) });
    expect((await list())[0].read).toBe(true);
  });
});

