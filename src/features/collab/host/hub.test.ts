// @vitest-environment jsdom
import { Node as PMNode } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { loadDoc, saveContent } from '../../../db/content';
import { commit, flush } from '../../../db/saveQueue';
import { useDatabases } from '../../../store/databases';
import { usePages } from '../../../store/pages';
import { freshDatabase } from '../../../test/setup';
import { decodeBinary, encodeBinary, type DocSnapshot, type ServerMessage, type Welcome } from '../protocol';
import { editorSchema, FIELD } from './docs';
import { useHosting } from './hosting';
import { startHub, stopHub, syncAccess } from './hub';

const sent: { targets: number[]; message: ServerMessage }[] = [];
const handlers: Record<string, (event: { payload: unknown }) => void> = {};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args: { targets: number[]; data: string }) => {
    if (command === 'share_send') sent.push({ targets: args.targets, message: JSON.parse(args.data) as ServerMessage });
    return null;
  }),
  convertFileSrc: (path: string) => path,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers[name] = handler;
    return () => delete handlers[name];
  }),
}));

const MEMBER = 'm1';
let nextId = 1;

async function until<T>(find: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = find();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Zeitüberschreitung');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const DEVICE = 'd1';

function message(conn: number, data: unknown, memberId = MEMBER) {
  handlers['share:message']({ payload: { conn, memberId, data: JSON.stringify(data) } });
}

/** Schickt eine Anfrage als Gast und wartet auf die Antwort. */
async function call<T>(conn: number, req: unknown, memberId = MEMBER): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const id = nextId++;
  message(conn, { t: 'req', id, req }, memberId);
  const res = await until(() => sent.find((s) => s.message.t === 'res' && s.message.id === id)?.message);
  if (res.t !== 'res') throw new Error('keine Antwort');
  return res.ok ? { ok: true, value: res.value as T } : { ok: false, error: res.error };
}

let pages: Record<string, string>;

beforeEach(async () => {
  await freshDatabase();
  sent.length = 0;
  const create = usePages.getState().create;
  const projekt = await create({ title: 'Projekt' });
  const plan = await create({ parentId: projekt, title: 'Plan' });
  const privat = await create({ title: 'Privat' });
  const aufgaben = await useDatabases.getState().createDatabase(projekt);
  await commit(saveContent(plan, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Start' }] }] }, 'Start', [], 1));
  pages = { projekt, plan, privat, aufgaben };
  useHosting.setState({
    members: [
      { id: MEMBER, name: 'Mia', token: 'x'.repeat(64), color: '#e5484d', createdAt: 0, kind: 'person', teamRole: null },
      { id: DEVICE, name: 'iPhone', token: 'y'.repeat(64), color: '#0090ff', createdAt: 0, kind: 'device', teamRole: null },
    ],
    grants: [{ memberId: MEMBER, pageId: projekt, role: 'edit' }],
    hostName: 'Eray',
  });
  await startHub();
  handlers['share:open']({ payload: { conn: 1, memberId: MEMBER } });
});

afterEach(async () => {
  await stopHub();
});

describe('Gastgeber-Hub', () => {
  it('zeigt Gästen nur freigegebene Seiten', async () => {
    const res = await call<Welcome>(1, { op: 'hello' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.value.pages.map((p) => p.id).sort();
    expect(ids).toEqual([pages.projekt, pages.plan, pages.aufgaben].sort());
    expect(res.value.pages.find((p) => p.id === pages.projekt)?.parentId).toBeNull();
    expect(res.value.me.name).toBe('Mia');
  });

  it('prüft Rechte bei jeder Änderung', async () => {
    await call(1, { op: 'hello' });
    expect(await call(1, { op: 'page.update', id: pages.privat, patch: { title: 'gehackt' } })).toEqual({
      ok: false,
      error: 'Kein Zugriff auf diese Seite',
    });
    expect(usePages.getState().pages[pages.privat].title).toBe('Privat');

    expect((await call(1, { op: 'page.update', id: pages.plan, patch: { title: 'Plan 2' } })).ok).toBe(true);
    expect(usePages.getState().pages[pages.plan].title).toBe('Plan 2');

    useHosting.setState({ grants: [...useHosting.getState().grants, { memberId: MEMBER, pageId: pages.plan, role: 'read' }] });
    syncAccess();
    expect(await call(1, { op: 'page.update', id: pages.plan, patch: { title: 'Plan 3' } })).toEqual({ ok: false, error: 'Nur Lesezugriff' });
  });

  it('meldet geänderte Seiten und entzogene Rechte', async () => {
    await call(1, { op: 'hello' });
    usePages.getState().update(pages.plan, { title: 'Umbenannt' });
    await until(() => sent.find((s) => s.message.t === 'pages' && s.message.upsert.some((p) => p.title === 'Umbenannt')));
    useHosting.setState({ grants: [] });
    syncAccess();
    const removal = await until(() => sent.find((s) => s.message.t === 'pages' && s.message.remove.length > 0)?.message);
    expect(removal.t === 'pages' && removal.remove.sort()).toEqual([pages.projekt, pages.plan, pages.aufgaben].sort());
  });

  it('gleicht Seiteninhalte über Yjs ab und speichert sie', async () => {
    await call(1, { op: 'hello' });
    const guest = new Y.Doc();
    const res = await call<DocSnapshot>(1, { op: 'doc.open', pageId: pages.plan, clientId: guest.clientID });
    if (!res.ok) throw new Error(res.error);
    Y.applyUpdate(guest, decodeBinary(res.value.update), 'remote');
    expect(JSON.stringify(yXmlFragmentToProsemirrorJSON(guest.getXmlFragment(FIELD)))).toContain('Start');

    guest.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') message(1, { t: 'doc.update', pageId: pages.plan, update: encodeBinary(update) });
    });
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Hallo vom Gast');
    paragraph.insert(0, [text]);
    guest.getXmlFragment(FIELD).push([paragraph]);

    await new Promise((resolve) => setTimeout(resolve, 30));
    await flush();
    const saved = await loadDoc(pages.plan);
    expect(JSON.stringify(saved)).toContain('Hallo vom Gast');
    expect(JSON.stringify(saved)).toContain('Start');
  });

  it('ignoriert Änderungen von Lesenden', async () => {
    useHosting.setState({ grants: [{ memberId: MEMBER, pageId: pages.projekt, role: 'read' }] });
    syncAccess();
    await call(1, { op: 'hello' });
    const guest = new Y.Doc();
    const res = await call<DocSnapshot>(1, { op: 'doc.open', pageId: pages.plan, clientId: guest.clientID });
    if (!res.ok) throw new Error(res.error);
    Y.applyUpdate(guest, decodeBinary(res.value.update));
    const before = Y.encodeStateVector(guest);
    guest.getXmlFragment(FIELD).push([new Y.XmlElement('paragraph')]);
    message(1, { t: 'doc.update', pageId: pages.plan, update: encodeBinary(Y.encodeStateAsUpdate(guest, before)) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flush();
    const saved = await loadDoc(pages.plan);
    expect(saved?.content).toHaveLength(1);
  });

  it('führt Datenbank-Aufrufe nur mit gültigen Argumenten aus', async () => {
    await call(1, { op: 'hello' });
    const open = await call<{ properties: { id: string; type: string; options: { id: string }[] }[] }>(1, { op: 'db.open', databaseId: pages.aufgaben });
    if (!open.ok) throw new Error(open.error);
    const status = open.value.properties.find((p) => p.type === 'select')!;
    const row = await call<string>(1, { op: 'db.call', databaseId: pages.aufgaben, method: 'createRow', args: [{ [status.id]: status.options[0].id }, null] });
    if (!row.ok) throw new Error(row.error);
    expect(usePages.getState().pages[row.value].parentId).toBe(pages.aufgaben);
    expect(useDatabases.getState().data[pages.aufgaben].values[row.value][status.id]).toBe(status.options[0].id);

    expect((await call(1, { op: 'db.call', databaseId: pages.aufgaben, method: 'setValue', args: [pages.privat, status.id, 'x'] })).ok).toBe(false);
    expect((await call(1, { op: 'db.call', databaseId: pages.aufgaben, method: 'updateView', args: [{ id: 'gibt-es-nicht', name: 'x', config: {} }] })).ok).toBe(false);
  });

  it('gibt eigenen Geräten den ganzen Workspace, auch die oberste Ebene', async () => {
    handlers['share:open']({ payload: { conn: 2, memberId: DEVICE } });
    const hello = await call<Welcome>(2, { op: 'hello' }, DEVICE);
    if (!hello.ok) throw new Error(hello.error);
    expect(hello.value.me.kind).toBe('device');
    expect(hello.value.pages.map((p) => p.id).sort()).toEqual(Object.values(pages).sort());

    const created = await call<string>(2, { op: 'page.create', parentId: null, type: 'page', title: 'Vom iPhone' }, DEVICE);
    if (!created.ok) throw new Error(created.error);
    expect(usePages.getState().pages[created.value]).toMatchObject({ parentId: null, title: 'Vom iPhone' });

    await call(1, { op: 'hello' });
    expect(await call(1, { op: 'page.create', parentId: null, type: 'page', title: 'Gast' })).toEqual({
      ok: false,
      error: 'Kein Zugriff auf die oberste Ebene',
    });
  });

  it('findet in der Suche nur freigegebene Seiten', async () => {
    await call(1, { op: 'hello' });
    await flush();
    const all = await call<{ id: string }[]>(1, { op: 'search', query: 'Privat' });
    expect(all.ok && all.value).toEqual([]);
    const own = await call<{ id: string }[]>(1, { op: 'search', query: 'Plan' });
    expect(own.ok && own.value.map((h) => h.id)).toEqual([pages.plan]);
  });
});

describe('Yjs-Umwandlung', () => {
  it('überführt Seiteninhalte verlustfrei in ein geteiltes Dokument und zurück', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Titel' }] },
        { type: 'callout', attrs: { icon: '💡' }, content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Wichtig' }] }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fertig' }] }] }] },
        { type: 'columns', content: [{ type: 'column', content: [{ type: 'paragraph' }] }, { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rechts' }] }] }] },
      ],
    };
    const normalized = PMNode.fromJSON(editorSchema(), json).toJSON();
    const doc = prosemirrorJSONToYDoc(editorSchema(), json, FIELD);
    const back = PMNode.fromJSON(editorSchema(), yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(FIELD))).toJSON();
    expect(back).toEqual(normalized);
  });
});
