import { create } from 'zustand';
import { LAUNCHER_URL } from '../../../app.config';
import type { CellValue, Property, View } from '../../../db/database';
import type { PageMeta } from '../../../db/pages';
import { buildChildIndex, type PageMap } from '../../../lib/tree';
import { useDatabases, type DatabaseData } from '../../../store/databases';
import { usePages, type CreateOptions } from '../../../store/pages';
import { reportError, toast } from '../../../store/toast';
import { guestSettings, useUI } from '../../../store/ui';
import type { Access, GuestPage } from '../access';
import type { DbMethod, Request, ServerMessage, Welcome } from '../protocol';
import { canEdit, useAccess, useCollab } from '../sources';
import { usePresence } from '../presence';
import { guestBoard } from './boards';
import { connection, HostError } from './connection';
import { guestDoc } from './docs';

const TOKEN_KEY = 'efeu-token';
/** So viele erfolglose Versuche, dann sucht ein eigenes Gerät die neue Adresse über die Startseite. */
const LAUNCHER_AFTER_ATTEMPTS = 4;

export type GuestProblem = 'missing' | 'invalid' | 'unreachable';

export class GuestStartError extends Error {
  constructor(readonly problem: GuestProblem) {
    super(problem);
  }
}

interface GuestState {
  me: Welcome['me'] | null;
  host: Welcome['host'] | null;
}

export const useGuest = create<GuestState>(() => ({ me: null, host: null }));

/* ---------- Anmeldung ---------- */

/** Kanal der Startseite (nur bei eigenen Geräten, die über den festen Link kommen). */
let topic: string | null = null;

function readToken(): string | null {
  const match = /(?:^#|&)join=([0-9a-f]{64})/.exec(location.hash) ?? /^\/join\/([0-9a-f]{64})\/?$/.exec(location.pathname);
  const fromLauncher = /(?:^#|&)topic=([A-Za-z0-9_-]{24,64})/.exec(location.hash);
  if (fromLauncher) {
    topic = fromLauncher[1];
    try {
      sessionStorage.setItem('efeu-topic', topic);
    } catch {
      // nur für diese Sitzung nötig
    }
  } else {
    try {
      topic = sessionStorage.getItem('efeu-topic');
    } catch {
      topic = null;
    }
  }
  if (match) {
    try {
      localStorage.setItem(TOKEN_KEY, match[1]);
    } catch {
      // Ohne Speicher gilt die Anmeldung bis zum Schließen.
    }
    // Der Schlüssel muss in der Adresse bleiben: Beim „Zum Home-Bildschirm“ merkt sich das iPhone die
    // aktuelle Adresse (ohne den Teil hinter #), und die Home-Bildschirm-App hat einen eigenen Speicher.
    // Deshalb steht er im Pfad; der Server liefert für /join/… die App aus.
    if (location.pathname !== `/join/${match[1]}`) history.replaceState(null, '', `/join/${match[1]}`);
    return match[1];
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token: string | null = null;

/** Meldet sich mit dem Token aus dem Einladungslink an. false = Zugang ungültig oder entfernt. */
async function signIn(): Promise<boolean> {
  if (!token) return false;
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    credentials: 'same-origin',
  });
  if (response.status === 401) return false;
  if (!response.ok) throw new Error(`Anmeldung fehlgeschlagen (${response.status})`);
  return true;
}

/* ---------- Seiten ---------- */

/** Eigene, noch nicht bestätigte Änderungen an Seiten (bleiben bis zur Antwort über den Daten des Gastgebers). */
const pendingPatches = new Map<string, { patch: Partial<PageMeta>; seq: number }>();
let patchSeq = 0;

const isDevice = () => useGuest.getState().me?.kind === 'device';

function applyPages(upsert: GuestPage[], remove: string[], reset = false) {
  const pages: PageMap = reset ? {} : { ...usePages.getState().pages };
  const access: Record<string, Access> = reset ? {} : { ...(useAccess.getState().access ?? {}) };
  for (const id of remove) {
    delete pages[id];
    delete access[id];
  }
  for (const page of upsert) {
    const { access: level, ...meta } = page;
    pages[page.id] = { ...meta, ...pendingPatches.get(page.id)?.patch };
    access[page.id] = level;
  }
  // Eigene Geräte haben vollen Zugriff wie der Gastgeber selbst.
  useAccess.setState({ access: isDevice() ? null : access });
  usePages.setState({ pages, children: buildChildIndex(pages) });
}

/** Wartet, bis eine neu angelegte Seite vom Gastgeber gemeldet wurde. */
function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  if (check()) return Promise.resolve();
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check() || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 30);
  });
}

function readOnly(): never {
  toast('Hier hast du nur Lesezugriff');
  throw new HostError('Nur Lesezugriff');
}

async function request<T>(req: Request, context: string): Promise<T> {
  try {
    return await connection.request<T>(req);
  } catch (err) {
    reportError(context, err);
    throw err;
  }
}

function installPageActions() {
  usePages.setState({
    load: async () => undefined,

    async create({ parentId = null, type = 'page', title = '', index }: CreateOptions = {}) {
      if (!parentId && !isDevice()) {
        toast('Neue Seiten kannst du nur innerhalb geteilter Seiten anlegen');
        throw new HostError('Keine oberste Ebene');
      }
      if (parentId && !canEdit(parentId)) readOnly();
      const id = await request<string>({ op: 'page.create', parentId, type, title, index: index ?? null }, 'Seite anlegen');
      await waitFor(() => Boolean(usePages.getState().pages[id]));
      return id;
    },

    update(id, patch) {
      const page = usePages.getState().pages[id];
      if (!page) return;
      if (!canEdit(id)) return void toast('Hier hast du nur Lesezugriff');
      const seq = ++patchSeq;
      const merged = { ...pendingPatches.get(id)?.patch, ...patch };
      pendingPatches.set(id, { patch: merged, seq });
      const pages = { ...usePages.getState().pages, [id]: { ...page, ...patch } };
      usePages.setState({ pages, children: buildChildIndex(pages) });
      connection
        .request({ op: 'page.update', id, patch })
        .catch((err) => reportError('Änderung nicht gespeichert', err))
        .finally(() => {
          if (pendingPatches.get(id)?.seq === seq) pendingPatches.delete(id);
        });
    },

    async move(id, parentId, index) {
      if (!parentId && !isDevice()) return void toast('Auf die oberste Ebene kann nur der Gastgeber verschieben');
      if (!canEdit(id) || (parentId && !canEdit(parentId))) readOnly();
      await request({ op: 'page.move', id, parentId, index }, 'Seite verschieben');
    },

    async trash(id) {
      if (!canEdit(id)) readOnly();
      await request({ op: 'page.trash', id }, 'In den Papierkorb legen');
    },

    restore: async () => undefined,
    deleteForever: async () => undefined,
    emptyTrash: async () => undefined,
  });
}

/* ---------- Datenbanken ---------- */

interface DbPending {
  values: Map<string, { value: CellValue; seq: number }>;
  properties: Map<string, { property: Property; seq: number }>;
  views: Map<string, { view: View; seq: number }>;
}

const dbPending = new Map<string, DbPending>();
const pendingOf = (databaseId: string): DbPending => {
  let pending = dbPending.get(databaseId);
  if (!pending) {
    pending = { values: new Map(), properties: new Map(), views: new Map() };
    dbPending.set(databaseId, pending);
  }
  return pending;
};
let dbSeq = 0;

/** Daten des Gastgebers plus eigene, noch unbestätigte Änderungen. */
function withPending(databaseId: string, data: DatabaseData): DatabaseData {
  const pending = dbPending.get(databaseId);
  if (!pending) return data;
  const values = { ...data.values };
  for (const [key, { value }] of pending.values) {
    const [rowId, propertyId] = key.split('\u0000');
    values[rowId] = { ...values[rowId], [propertyId]: value };
  }
  return {
    ...data,
    values,
    properties: data.properties.map((p) => pending.properties.get(p.id)?.property ?? p),
    views: data.views.map((v) => pending.views.get(v.id)?.view ?? v),
  };
}

function setDb(databaseId: string, data: DatabaseData) {
  useDatabases.setState((s) => ({ data: { ...s.data, [databaseId]: withPending(databaseId, data) } }));
}

/** Zuletzt vom Gastgeber erhaltener Stand je Datenbank (ohne eigene offene Änderungen). */
const serverDb = new Map<string, DatabaseData>();
const openDbs = new Set<string>();

function dbCall<T>(databaseId: string, method: DbMethod, args: unknown[]): Promise<T> {
  if (!canEdit(databaseId)) readOnly();
  return request<T>({ op: 'db.call', databaseId, method, args }, 'Datenbank ändern');
}

/** Für optimistische Änderungen: Antwort abwarten, dann die eigene Überlagerung entfernen. */
function settle<K>(map: Map<K, { seq: number }>, key: K, seq: number, databaseId: string, promise: Promise<unknown>) {
  promise
    .catch(() => undefined)
    .finally(() => {
      if (map.get(key)?.seq !== seq) return;
      map.delete(key);
      const server = serverDb.get(databaseId);
      if (server) setDb(databaseId, server);
    });
}

function installDatabaseActions() {
  useDatabases.setState({
    async load(databaseId) {
      const data = await connection.request<DatabaseData>({ op: 'db.open', databaseId });
      openDbs.add(databaseId);
      serverDb.set(databaseId, data);
      setDb(databaseId, data);
    },

    async createDatabase(parentId) {
      return usePages.getState().create({ parentId, type: 'database' });
    },

    async createRow(databaseId, initial = {}, index) {
      const id = await dbCall<string>(databaseId, 'createRow', [initial, index ?? null]);
      await waitFor(() => Boolean(usePages.getState().pages[id]));
      return id;
    },

    setValue(databaseId, rowId, propertyId, value) {
      if (!canEdit(databaseId)) return void toast('Hier hast du nur Lesezugriff');
      const key = `${rowId}\u0000${propertyId}`;
      const seq = ++dbSeq;
      const pending = pendingOf(databaseId);
      pending.values.set(key, { value, seq });
      const current = useDatabases.getState().data[databaseId];
      if (current) setDb(databaseId, current);
      settle(pending.values, key, seq, databaseId, dbCall(databaseId, 'setValue', [rowId, propertyId, value]));
    },

    async addProperty(databaseId, type) {
      const id = await dbCall<string>(databaseId, 'addProperty', [type]);
      await waitFor(() => Boolean(useDatabases.getState().data[databaseId]?.properties.some((p) => p.id === id)));
      return id;
    },

    updateProperty(property) {
      if (!canEdit(property.databaseId)) return void toast('Hier hast du nur Lesezugriff');
      const seq = ++dbSeq;
      const pending = pendingOf(property.databaseId);
      pending.properties.set(property.id, { property, seq });
      const current = useDatabases.getState().data[property.databaseId];
      if (current) setDb(property.databaseId, current);
      const { id, name, options, config } = property;
      settle(pending.properties, property.id, seq, property.databaseId, dbCall(property.databaseId, 'updateProperty', [{ id, name, options, config }]));
    },

    async changePropertyType(property, type) {
      await dbCall(property.databaseId, 'changePropertyType', [property.id, type]);
    },

    async deleteOption(property, optionId) {
      await dbCall(property.databaseId, 'deleteOption', [property.id, optionId]);
    },

    async deleteProperty(property) {
      await dbCall(property.databaseId, 'deleteProperty', [property.id]);
    },

    async addView(databaseId, type) {
      const id = await dbCall<string>(databaseId, 'addView', [type]);
      await waitFor(() => Boolean(useDatabases.getState().data[databaseId]?.views.some((v) => v.id === id)));
      return id;
    },

    updateView(view) {
      if (!canEdit(view.databaseId)) {
        // Lesende dürfen Ansichten nur für sich anpassen (Filter, Sortierung) – ohne Speichern beim Gastgeber.
        useDatabases.setState((s) => {
          const data = s.data[view.databaseId];
          if (!data) return s;
          return { data: { ...s.data, [view.databaseId]: { ...data, views: data.views.map((v) => (v.id === view.id ? view : v)) } } };
        });
        return;
      }
      const seq = ++dbSeq;
      const pending = pendingOf(view.databaseId);
      pending.views.set(view.id, { view, seq });
      const current = useDatabases.getState().data[view.databaseId];
      if (current) setDb(view.databaseId, current);
      const { id, name, config } = view;
      settle(pending.views, view.id, seq, view.databaseId, dbCall(view.databaseId, 'updateView', [{ id, name, config }]));
    },

    async deleteView(view) {
      await dbCall(view.databaseId, 'deleteView', [view.id]);
    },
  });
}

/* ---------- Nachrichten und Start ---------- */

function onMessage(message: ServerMessage) {
  switch (message.t) {
    case 'pages':
      applyPages(message.upsert, message.remove);
      return;
    case 'presence':
      usePresence.setState({ people: message.people });
      return;
    case 'db':
      serverDb.set(message.databaseId, message.data);
      setDb(message.databaseId, message.data);
      return;
  }
}

/** Nach jedem Verbinden: begrüßen, Seiten neu laden und geöffnete Datenbanken neu abonnieren. */
async function greet() {
  const welcome = await connection.request<Welcome>({ op: 'hello' });
  useGuest.setState({ me: welcome.me, host: welcome.host });
  usePresence.setState({ me: `c${welcome.conn}` });
  applyPages(welcome.pages, [], true);
  for (const id of openDbs) {
    if (!usePages.getState().pages[id]) continue;
    void useDatabases.getState().load(id).catch((err) => console.error('Datenbank neu laden', err));
  }
  connection.send({ t: 'view', pageId: useUI.getState().currentId });
}

const firstRoot = () => {
  const roots = usePages.getState().children.get(null) ?? [];
  return roots[0] ?? null;
};

let starting: Promise<void> | null = null;

/** Start als Gast: anmelden, verbinden, Seiten laden, Aktionen auf den Gastgeber umleiten. Nur einmal. */
export function startGuest(): Promise<void> {
  starting ??= start();
  return starting;
}

async function start(): Promise<void> {
  token = readToken();
  if (!token) throw new GuestStartError('missing');
  let valid: boolean;
  try {
    valid = await signIn();
  } catch {
    throw new GuestStartError('unreachable');
  }
  if (!valid) throw new GuestStartError('invalid');

  installPageActions();
  installDatabaseActions();
  useUI.getState().hydrate(guestSettings());
  connection.listen(onMessage);

  const first = new Promise<void>((resolve, reject) => {
    let initial = true;
    connection.onOpen(() => {
      greet()
        .then(() => {
          if (!initial) return;
          initial = false;
          resolve();
        })
        .catch((err) => (initial ? reject(err) : console.error('Neu verbinden', err)));
    });
  });
  // Eigenes Gerät über den festen Link: bleibt der Mac weg (z. B. neue Adresse nach Neustart),
  // zurück zur Startseite, die die aktuelle Adresse findet.
  connection.start(signIn, (attempt) => {
    if (topic && token && attempt >= LAUNCHER_AFTER_ATTEMPTS) location.replace(`${LAUNCHER_URL}#d=${topic}.${token}`);
  });
  await first;

  useCollab.setState({
    docs: (pageId) => guestDoc(pageId, { name: useGuest.getState().me?.name ?? 'Gast', color: useGuest.getState().me?.color ?? '#888888' }),
    boards: guestBoard,
  });

  // Geöffnete Seite: zuletzt besuchte, sonst die erste geteilte.
  const { currentId } = useUI.getState();
  if (!currentId || !usePages.getState().pages[currentId]) useUI.setState({ currentId: firstRoot(), back: [], forward: [] });
  connection.send({ t: 'view', pageId: useUI.getState().currentId });

  // Seite verschwunden (Zugriff entzogen, gelöscht): zur ersten geteilten Seite.
  usePages.subscribe((state) => {
    const { currentId: open } = useUI.getState();
    if (open && !state.pages[open]) useUI.setState({ currentId: firstRoot() });
  });
  useUI.subscribe((state, prev) => {
    if (state.currentId !== prev.currentId) connection.send({ t: 'view', pageId: state.currentId });
  });
}
