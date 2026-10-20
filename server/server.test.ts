import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveContent } from '../src/db/content';
import { SyncClient, type Transport } from '../src/sync/client';
import { Replica } from '../src/sync/replica';
import { createTestDriver } from '../src/test/sqliteDriver';
import { createApp } from './app';
import { Cloud } from './cloud';
import { Devices } from './devices';
import { openStore } from './store';

const servers: { close(): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function startCloud() {
  const store = openStore(mkdtempSync(join(tmpdir(), 'efeu-cloud-')));
  const devices = new Devices(store);
  const cloud = new Cloud(store);
  await cloud.start();
  const server = createApp({ store, cloud, devices });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, devices, cloud, url };
}

function device(url: string, token: string) {
  const driver = createTestDriver();
  const replica = new Replica(driver);
  const assets = mkdtempSync(join(tmpdir(), 'efeu-assets-'));
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
  return { driver, replica, assets, client: new SyncClient(driver, replica, transport), call };
}

const newPage = (id: string, title: string) => ({
  sql: "INSERT INTO pages (id, workspace_id, type, title, created_at, updated_at) VALUES (?, 'default', 'page', ?, 1, 1)",
  params: [id, title],
});

describe('Cloud-Server', () => {
  it('gleicht zwei Geräte über HTTP ab, samt Anhängen', async () => {
    const { devices, url } = await startCloud();
    const a = device(url, devices.add('Mac').token);
    const b = device(url, devices.add('Laptop').token);
    await a.replica.enable('mac');
    await b.replica.enable('laptop');

    const bytes = Buffer.from('ein Bild');
    const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.png`;
    writeFileSync(join(a.assets, name), bytes);
    await a.driver.tx([
      newPage('p1', 'Reise'),
      ...saveContent('p1', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Koffer packen' }] }] }, 'Koffer packen', [], 1),
    ]);
    expect((await a.client.sync()).pushed).toBeGreaterThan(0);
    const report = await b.client.sync();
    expect(report.applied.docs.has('p1')).toBe(true);
    expect(await b.driver.select("SELECT title FROM pages WHERE id = 'p1'")).toEqual([{ title: 'Reise' }]);
    expect(readFileSync(join(b.assets, name)).toString()).toBe('ein Bild');

    // Zurück: B ändert, A bekommt es.
    await b.driver.tx([{ sql: "UPDATE pages SET title = 'Reise nach Rom' WHERE id = 'p1'" }]);
    await b.client.sync();
    await a.client.sync();
    expect(await a.driver.select("SELECT title FROM pages WHERE id = 'p1'")).toEqual([{ title: 'Reise nach Rom' }]);
  });

  it('lässt ohne gültigen Schlüssel niemanden hinein und koppelt per Einmal-Code', async () => {
    const { devices, url } = await startCloud();
    expect((await fetch(`${url}/api/sync/pull?since=0`)).status).toBe(401);
    expect((await fetch(`${url}/api/sync/pull?since=0`, { headers: { authorization: `Bearer ${'0'.repeat(64)}` } })).status).toBe(401);

    const owner = device(url, devices.add('Mac').token);
    const { code } = (await (await owner.call('/api/pairing', { method: 'POST' })).json()) as { code: string };
    const pair = (body: unknown) => fetch(`${url}/api/pair`, { method: 'POST', body: JSON.stringify(body) });
    const first = await pair({ code, name: 'iPhone' });
    expect(first.status).toBe(200);
    const { token } = (await first.json()) as { token: string };
    expect((await pair({ code, name: 'Nochmal' })).status).toBe(403);
    expect((await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

    const list = (await (await owner.call('/api/devices')).json()) as { devices: { id: string; name: string }[] };
    const phone = list.devices.find((d) => d.name === 'iPhone')!;
    await owner.call(`/api/devices/${phone.id}`, { method: 'DELETE' });
    expect((await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('weist Anhänge zurück, deren Inhalt nicht zum Namen passt', async () => {
    const { devices, url } = await startCloud();
    const a = device(url, devices.add('Mac').token);
    await expect(a.call(`/api/assets/${'a'.repeat(32)}.png`, { method: 'PUT', body: 'falsch' })).rejects.toThrow('400');
    await expect(a.call('/api/assets/..%2Fefeu.db')).rejects.toThrow('404');
  });

  it('gibt nach dem Aufräumen neuen Geräten den vollständigen Stand', async () => {
    const { devices, cloud, url } = await startCloud();
    const a = device(url, devices.add('Mac').token);
    await a.replica.enable('mac');
    await a.driver.tx([newPage('p1', 'Eins'), newPage('p2', 'Zwei')]);
    await a.client.sync();
    for (let i = 0; i < 5; i++) {
      await a.driver.tx([{ sql: 'UPDATE pages SET title = ? WHERE id = ?', params: [`Eins v${i}`, 'p1'] }]);
      await a.client.sync();
    }
    await a.driver.tx([{ sql: "DELETE FROM pages WHERE id = 'p2'" }]);
    await a.client.sync();
    await cloud.compact();

    const b = device(url, devices.add('Neu').token);
    await b.replica.enable('neu');
    await b.client.sync();
    expect(await b.driver.select('SELECT id, title FROM pages ORDER BY id')).toEqual([{ id: 'p1', title: 'Eins v4' }]);
    // Das alte Gerät bekommt den Schnappschuss ebenfalls und bleibt unverändert.
    await a.client.sync();
    expect(await a.driver.select('SELECT id, title FROM pages ORDER BY id')).toEqual([{ id: 'p1', title: 'Eins v4' }]);
    expect(await a.replica.pendingCount()).toBe(0);
  });
});
