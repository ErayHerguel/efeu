import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { flush } from '../src/db/saveQueue';
import { usePages } from '../src/store/pages';
import { createApp } from './app';
import { Devices } from './devices';
import { startHost } from './host';
import { Sharing } from './share';
import { Team } from './team';
import { openStore } from './store';

const TOKEN = 'a'.repeat(64);
const closers: (() => void)[] = [];
afterAll(() => closers.forEach((c) => c()));

async function start() {
  const store = openStore(mkdtempSync(join(tmpdir(), 'efeu-share-')));
  const web = mkdtempSync(join(tmpdir(), 'efeu-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>efeu</title></head><body></body></html>');
  store.raw.exec(`INSERT INTO pages (id, workspace_id, type, title, created_at, updated_at) VALUES ('p1', 'default', 'page', 'Geteilt', 1, 1), ('p2', 'default', 'page', 'Privat', 1, 1);
    INSERT INTO share_members (id, name, token, color, created_at, kind) VALUES ('m1', 'Lena', '${TOKEN}', '#30a46c', 1, 'person');
    INSERT INTO share_grants (member_id, page_id, role) VALUES ('m1', 'p1', 'edit');`);
  const devices = new Devices(store);
  const sharing = new Sharing(store, web, devices);
  const team = new Team(store);
  const { cloud, teamChanged } = await startHost(store, sharing, team);
  const server = createApp({ store, cloud, devices, sharing, team, teamChanged });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => server.close());
  return { store, cloud, devices, host: `127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('Teilen über die Cloud', () => {
  it('meldet Gäste per Einladungslink an und lässt sie live nur Freigegebenes bearbeiten', async () => {
    const { store, cloud, host } = await start();
    const page = await (await fetch(`http://${host}/irgendwo`)).text();
    expect(page).toContain('<meta name="efeu-mode" content="guest">');

    expect((await fetch(`http://${host}/api/session`, { method: 'POST', body: JSON.stringify({ token: 'b'.repeat(64) }) })).status).toBe(401);
    const session = await fetch(`http://${host}/api/session`, { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
    expect(session.status).toBe(200);
    const cookie = session.headers.get('set-cookie')!.split(';')[0];

    // Ohne passende Herkunft keine Verbindung (Schutz vor fremden Seiten).
    const foreign = new WebSocket(`ws://${host}/api/ws`, { headers: { cookie, origin: 'https://evil.example' } });
    await expect(new Promise((resolve, reject) => (foreign.on('open', resolve), foreign.on('error', reject)))).rejects.toThrow('403');

    const ws = new WebSocket(`ws://${host}/api/ws`, { headers: { cookie, origin: `http://${host}` } });
    const messages: Record<string, unknown>[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    await new Promise((resolve) => ws.on('open', resolve));
    const request = (id: number, req: unknown) => ws.send(JSON.stringify({ t: 'req', id, req }));
    const response = async (id: number) => {
      for (let i = 0; i < 100; i++) {
        const found = messages.find((m) => m.t === 'res' && m.id === id);
        if (found) return found as { ok: boolean; value: { pages: { id: string }[] }; error?: string };
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('keine Antwort');
    };

    request(1, { op: 'hello' });
    const welcome = await response(1);
    expect(welcome.value.pages.map((p) => p.id)).toEqual(['p1']);

    request(2, { op: 'page.update', id: 'p2', patch: { title: 'Gehackt' } });
    expect((await response(2)).error).toBe('Kein Zugriff auf diese Seite');

    request(3, { op: 'page.update', id: 'p1', patch: { title: 'Von Lena' } });
    expect((await response(3)).ok).toBe(true);
    await flush();
    await cloud.drainLocal();
    expect(store.raw.prepare("SELECT title FROM pages WHERE id = 'p1'").get()).toEqual({ title: 'Von Lena' });
    // Die Änderung steht im Protokoll und erreicht so die eigenen Geräte.
    const log = cloud.pull('mac', 0).changes;
    expect(log.some((c) => c.kind === 'row' && c.tbl === 'pages' && c.cols?.title === 'Von Lena')).toBe(true);

    // Ein Gerät benennt die Seite um: die Gast-Ansicht bekommt es mit.
    await cloud.push('mac', [{ kind: 'row', tbl: 'pages', pk: '["p1"]', cols: { title: 'Vom Mac' }, hlc: '999999999999999-mac' }]);
    for (let i = 0; i < 50 && usePages.getState().pages.p1?.title !== 'Vom Mac'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(usePages.getState().pages.p1?.title).toBe('Vom Mac');
    for (let i = 0; i < 50 && !messages.some((m) => m.t === 'pages' && JSON.stringify(m).includes('Vom Mac')); i++) await new Promise((r) => setTimeout(r, 20));
    expect(messages.some((m) => m.t === 'pages' && JSON.stringify(m).includes('Vom Mac'))).toBe(true);
    ws.close();
  });

  it('lässt die efeu-App des Inhabers mit ihrem Geräteschlüssel live mitarbeiten', async () => {
    const { devices, host } = await start();
    const { token } = devices.add('Mac');
    expect(await new Promise((resolve) => {
      const bad = new WebSocket(`ws://${host}/api/ws`, { headers: { authorization: `Bearer ${'0'.repeat(64)}`, origin: `http://${host}` } });
      bad.on('error', () => resolve('abgelehnt'));
      bad.on('open', () => resolve('offen'));
    })).toBe('abgelehnt');
    const ws = new WebSocket(`ws://${host}/api/ws?name=Eray`, { headers: { authorization: `Bearer ${token}`, origin: `http://${host}` } });
    const messages: Record<string, unknown>[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ t: 'req', id: 1, req: { op: 'hello' } }));
    for (let i = 0; i < 100 && !messages.some((m) => m.t === 'res'); i++) await new Promise((r) => setTimeout(r, 20));
    const welcome = messages.find((m) => m.t === 'res') as { ok: boolean; value: { me: { name: string; kind: string }; pages: { id: string }[] } };
    expect(welcome.ok).toBe(true);
    expect(welcome.value.me).toMatchObject({ name: 'Eray', kind: 'device' });
    expect(welcome.value.pages.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    ws.close();
  });
});

