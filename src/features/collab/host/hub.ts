import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  COMPUTED_TYPES,
  emptyConfig,
  type CellValue,
  type Filter,
  type FilterOperator,
  type PropertyConfig,
  type RollupAggregate,
  type SelectOption,
  type Sort,
  type ViewConfig,
} from '../../../db/database';
import { flush } from '../../../db/saveQueue';
import { searchPages } from '../../../db/search';
import { importImageBlob } from '../../../lib/assets';
import { useDatabases } from '../../../store/databases';
import { canContain, usePages } from '../../../store/pages';
import { rootOf } from '../../../lib/tree';
import { useUI } from '../../../store/ui';
import { createBoard } from '../../board/create';
import { accessMap, grantsOf, guestPages, type Access } from '../access';
import {
  isCellValue,
  isId,
  isRecord,
  isTagColor,
  isText,
  parseClientMessage,
  PROPERTY_TYPES,
  VIEW_TYPES,
  type ClientMessage,
  type DbMethod,
  type Person,
  type Request,
  type ServerMessage,
  type Welcome,
} from '../protocol';
import { usePresence } from '../presence';
import { useCollab, type BoardElement } from '../sources';
import type * as Y from 'yjs';
import { BoardHub } from './boards';
import { DocHub } from './docs';
import { HOST_COLOR, useHosting } from './hosting';

/** Fehler, deren Text der Gast sehen darf. */
class HubError extends Error {}

interface Connection {
  conn: number;
  memberId: string;
  ready: boolean;
  view: string | null;
  /** Zuletzt gesendete Seiten (als JSON), für Änderungslisten */
  sentPages: Map<string, string>;
  dbs: Set<string>;
  sentDb: Map<string, unknown>;
  /** Nachrichten einer Verbindung werden der Reihe nach verarbeitet. */
  queue: Promise<void>;
}

/**
 * Wo der Hub läuft: in der App (Verbindungen kommen über Rust und den Tunnel) oder auf dem
 * Cloud-Server (eigene WebSocket-Verbindungen, ohne Gastgeber-Fenster).
 */
export interface HubTransport {
  send(targets: number[], data: string): void;
  /** Meldet neue, getrennte Verbindungen und eingehende Nachrichten; liefert das Abmelden. */
  listen(handlers: {
    open(conn: number, memberId: string): void;
    close(conn: number): void;
    message(conn: number, memberId: string, data: string): void;
  }): Promise<() => void>;
  /** Der Gastgeber erscheint selbst in der Präsenz (in der App ja, auf dem Server nicht). */
  host: boolean;
  /** Wie die Seiten-Dokumente geladen werden (Cloud: aus dem abgeglichenen Yjs-Zustand). */
  loadDoc?: (pageId: string) => Promise<Y.Doc>;
}

const tauriTransport: HubTransport = {
  send: (targets, data) =>
    void invoke('share_send', { targets, data }).catch((err) => console.error('Senden an Gäste fehlgeschlagen', err)),
  async listen(handlers) {
    const offs: UnlistenFn[] = await Promise.all([
      listen<ConnPayload>('share:open', (e) => handlers.open(e.payload.conn, e.payload.memberId)),
      listen<ConnPayload>('share:close', (e) => handlers.close(e.payload.conn)),
      listen<ConnPayload & { data: string }>('share:message', (e) => handlers.message(e.payload.conn, e.payload.memberId, e.payload.data)),
    ]);
    return () => offs.forEach((off) => off());
  },
  host: true,
};

const conns = new Map<number, Connection>();
const accessCache = new Map<string, Map<string, Access>>();
let docs: DocHub | null = null;
let boards: BoardHub | null = null;
let cleanup: (() => void)[] = [];
let transport: HubTransport = tauriTransport;

function send(targets: number[], message: ServerMessage) {
  if (!targets.length) return;
  transport.send(targets, JSON.stringify(message));
}

/** Für den Cloud-Abgleich: offene Dokumente und Boards des Hubs. */
export const hubDocs = () => docs;
export const hubBoards = () => boards;

const memberOf = (memberId: string) => useHosting.getState().members.find((m) => m.id === memberId);

const isDevice = (memberId: string) => memberOf(memberId)?.kind === 'device';
const isTeam = (memberId: string) => memberOf(memberId)?.teamRole === 'member';

function accessOf(memberId: string): Map<string, Access> {
  let access = accessCache.get(memberId);
  if (!access) {
    const pages = usePages.getState().pages;
    const live = Object.values(pages).filter((p) => p.deletedAt === null);
    // Eigene Geräte sehen und bearbeiten alles außerhalb des Papierkorbs, Team-Mitglieder den Team-Bereich
    // (dazu einzeln freigegebene Seiten).
    access = isDevice(memberId)
      ? new Map(live.map((p) => [p.id, 'edit' as const]))
      : accessMap(pages, grantsOf(useHosting.getState().grants, memberId));
    if (isTeam(memberId)) {
      for (const p of live) if (pages[rootOf(pages, p.id)]?.space === 'team') access.set(p.id, 'edit');
    }
    accessCache.set(memberId, access);
  }
  return access;
}

/** Ziel einer neuen oder verschobenen Seite: oberste Ebene nur für eigene Geräte. */
function requireParent(c: Connection, parentId: string | null) {
  if (parentId === null) {
    if (!isDevice(c.memberId) && !isTeam(c.memberId)) throw new HubError('Kein Zugriff auf die oberste Ebene');
    return;
  }
  requireAccess(c, parentId, 'edit');
}

function requireAccess(c: Connection, pageId: string, level: Access): Access {
  const access = accessOf(c.memberId).get(pageId);
  if (!access) throw new HubError('Kein Zugriff auf diese Seite');
  if (level === 'edit' && access !== 'edit') throw new HubError('Nur Lesezugriff');
  return access;
}

/* ---------- Abgleich: Seitenliste, Präsenz, Datenbanken ---------- */

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let dbTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSync() {
  syncTimer ??= setTimeout(() => {
    syncTimer = null;
    syncPages();
    syncPresence();
  }, 40);
}

function scheduleDbSync() {
  dbTimer ??= setTimeout(() => {
    dbTimer = null;
    syncDbs();
  }, 60);
}

/** Rechte haben sich geändert (Freigaben, Personen). */
export function syncAccess() {
  accessCache.clear();
  scheduleSync();
}

function syncPages() {
  const pages = usePages.getState().pages;
  for (const c of conns.values()) {
    if (!c.ready) continue;
    const access = accessOf(c.memberId);
    const upsert = [];
    const seen = new Set<string>();
    for (const page of guestPages(pages, access)) {
      seen.add(page.id);
      const json = JSON.stringify(page);
      if (c.sentPages.get(page.id) === json) continue;
      c.sentPages.set(page.id, json);
      upsert.push(page);
    }
    const remove = [...c.sentPages.keys()].filter((id) => !seen.has(id));
    for (const id of remove) c.sentPages.delete(id);
    if (upsert.length || remove.length) send([c.conn], { t: 'pages', upsert, remove });
    if (remove.length) void dropInaccessible(c, access);
  }
}

/** Abos auf Seiten, die jemand nicht mehr sehen darf, beenden. */
async function dropInaccessible(c: Connection, access: Map<string, Access>) {
  for (const id of [...c.dbs]) if (!access.has(id)) c.dbs.delete(id);
  for (const id of (await docs?.subscriptions(c.conn)) ?? []) if (!access.has(id)) void docs?.unsubscribe(id, c.conn);
  for (const id of (await boards?.subscriptions(c.conn)) ?? []) if (!access.has(id)) void boards?.unsubscribe(id, c.conn, `c${c.conn}`);
}

function people(): Person[] {
  const { hostName } = useHosting.getState();
  const host: Person = { id: 'host', memberId: null, name: hostName, color: HOST_COLOR, pageId: useUI.getState().currentId };
  const guests = [...conns.values()]
    .filter((c) => c.ready)
    .map((c) => {
      const member = memberOf(c.memberId);
      return { id: `c${c.conn}`, memberId: c.memberId, name: member?.name ?? 'Gast', color: member?.color ?? '#888888', pageId: c.view };
    });
  return transport.host ? [host, ...guests] : guests;
}

function syncPresence() {
  const all = people();
  usePresence.setState({ people: all, me: 'host' });
  for (const c of conns.values()) {
    if (!c.ready) continue;
    const access = accessOf(c.memberId);
    const visible = all.map((p) => ({ ...p, pageId: p.pageId && access.has(p.pageId) ? p.pageId : null }));
    send([c.conn], { t: 'presence', people: visible });
  }
}

function syncDbs() {
  const data = useDatabases.getState().data;
  for (const c of conns.values()) {
    for (const id of c.dbs) {
      const current = data[id];
      if (!current || c.sentDb.get(id) === current) continue;
      c.sentDb.set(id, current);
      send([c.conn], { t: 'db', databaseId: id, data: current });
    }
  }
}

/* ---------- Anfragen ---------- */

const FILTER_OPERATORS: FilterOperator[] = [
  'contains',
  'not_contains',
  'is',
  'is_not',
  'is_empty',
  'is_not_empty',
  'gt',
  'lt',
  'gte',
  'lte',
  'before',
  'after',
  'is_checked',
  'is_unchecked',
];
const AGGREGATES: RollupAggregate[] = ['count', 'sum', 'avg', 'min', 'max', 'show'];
const ASSET_NAME = /^[0-9a-f]{32}\.[a-z0-9]{1,10}$/;

function invalid(): never {
  throw new HubError('Ungültige Anfrage');
}

const idOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : isId(v) ? v : invalid());

function sanitizeOptions(v: unknown): SelectOption[] {
  if (!Array.isArray(v) || v.length > 500) invalid();
  return v.map((o) =>
    isRecord(o) && isId(o.id) && isText(o.name, 200) && isTagColor(o.color)
      ? { id: o.id, name: o.name, color: o.color as SelectOption['color'] }
      : invalid(),
  );
}

function sanitizePropertyConfig(v: unknown): PropertyConfig {
  if (!isRecord(v)) invalid();
  const config: PropertyConfig = {};
  if (v.targetDatabaseId !== undefined) config.targetDatabaseId = isId(v.targetDatabaseId) ? v.targetDatabaseId : invalid();
  if (v.relationPropertyId !== undefined) config.relationPropertyId = isId(v.relationPropertyId) ? v.relationPropertyId : invalid();
  if (v.targetPropertyId !== undefined) config.targetPropertyId = isId(v.targetPropertyId) ? v.targetPropertyId : invalid();
  if (v.aggregate !== undefined) config.aggregate = AGGREGATES.includes(v.aggregate as RollupAggregate) ? (v.aggregate as RollupAggregate) : invalid();
  if (v.expression !== undefined) config.expression = isText(v.expression, 5000) ? v.expression : invalid();
  if (v.remind !== undefined) config.remind = typeof v.remind === 'boolean' ? v.remind : invalid();
  return config;
}

function sanitizeViewConfig(v: unknown): ViewConfig {
  if (!isRecord(v) || JSON.stringify(v).length > 50_000) invalid();
  const list = <T>(value: unknown, max: number, item: (x: unknown) => T): T[] =>
    value === undefined ? [] : Array.isArray(value) && value.length <= max ? value.map(item) : invalid();
  const filter = (f: unknown): Filter =>
    isRecord(f) && isId(f.id) && isId(f.propertyId) && FILTER_OPERATORS.includes(f.operator as FilterOperator) && isCellValue(f.value)
      ? { id: f.id, propertyId: f.propertyId, operator: f.operator as FilterOperator, value: f.value }
      : invalid();
  const sort = (s: unknown): Sort =>
    isRecord(s) && isId(s.propertyId) && (s.direction === 'asc' || s.direction === 'desc')
      ? { propertyId: s.propertyId, direction: s.direction }
      : invalid();
  const widths: Record<string, number> = {};
  if (v.widths !== undefined) {
    if (!isRecord(v.widths)) invalid();
    for (const [key, width] of Object.entries(v.widths)) {
      if (!isId(key) || typeof width !== 'number' || !Number.isFinite(width)) invalid();
      widths[key] = Math.max(40, Math.min(2000, width));
    }
  }
  return {
    ...emptyConfig(),
    filters: list(v.filters, 50, filter),
    filterMode: v.filterMode === 'or' ? 'or' : 'and',
    dateBy: idOrNull(v.dateBy),
    sorts: list(v.sorts, 20, sort),
    widths,
    hidden: list(v.hidden, 500, (id) => (isId(id) ? id : invalid())),
    groupBy: idOrNull(v.groupBy),
  };
}

async function databaseData(databaseId: string) {
  const store = useDatabases.getState();
  if (!store.data[databaseId]) await store.load(databaseId);
  const data = useDatabases.getState().data[databaseId];
  if (!data) throw new HubError('Datenbank nicht gefunden');
  return data;
}

async function dbCall(databaseId: string, method: DbMethod, args: unknown[]): Promise<unknown> {
  const data = await databaseData(databaseId);
  const store = useDatabases.getState();
  const property = (id: unknown) => data.properties.find((p) => p.id === id) ?? invalid();
  const view = (id: unknown) => data.views.find((v) => v.id === id) ?? invalid();
  const editable = (id: unknown) => {
    const p = property(id);
    return COMPUTED_TYPES.includes(p.type) ? invalid() : p;
  };
  switch (method) {
    case 'createRow': {
      const [initial, index] = args;
      if (!isRecord(initial)) invalid();
      const values: Record<string, CellValue> = {};
      for (const [id, value] of Object.entries(initial)) values[editable(id).id] = isCellValue(value) ? value : invalid();
      return store.createRow(databaseId, values, Number.isInteger(index) && (index as number) >= 0 ? (index as number) : undefined);
    }
    case 'setValue': {
      const [rowId, propertyId, value] = args;
      if (!isId(rowId) || usePages.getState().pages[rowId]?.parentId !== databaseId || !isCellValue(value)) invalid();
      store.setValue(databaseId, rowId, editable(propertyId).id, value);
      return null;
    }
    case 'addProperty': {
      const [type] = args;
      return PROPERTY_TYPES.includes(type as never) ? store.addProperty(databaseId, type as never) : invalid();
    }
    case 'updateProperty': {
      const [next] = args;
      if (!isRecord(next) || !isText(next.name, 200)) invalid();
      store.updateProperty({ ...property(next.id), name: next.name, options: sanitizeOptions(next.options), config: sanitizePropertyConfig(next.config) });
      return null;
    }
    case 'changePropertyType': {
      const [id, type] = args;
      if (!PROPERTY_TYPES.includes(type as never)) invalid();
      await store.changePropertyType(property(id), type as never);
      return null;
    }
    case 'deleteOption': {
      const [id, optionId] = args;
      if (!isId(optionId)) invalid();
      await store.deleteOption(property(id), optionId);
      return null;
    }
    case 'deleteProperty':
      await store.deleteProperty(property(args[0]));
      return null;
    case 'addView': {
      const [type] = args;
      return VIEW_TYPES.includes(type as never) ? store.addView(databaseId, type as never) : invalid();
    }
    case 'updateView': {
      const [next] = args;
      if (!isRecord(next) || !isText(next.name, 200)) invalid();
      store.updateView({ ...view(next.id), name: next.name, config: sanitizeViewConfig(next.config) });
      return null;
    }
    case 'deleteView':
      await store.deleteView(view(args[0]));
      return null;
  }
}

async function handle(c: Connection, req: Request): Promise<unknown> {
  const pages = usePages.getState().pages;
  switch (req.op) {
    case 'hello': {
      const member = memberOf(c.memberId);
      if (!member) throw new HubError('Zugang wurde entfernt');
      c.ready = true;
      c.sentPages.clear();
      const visible = guestPages(pages, accessOf(c.memberId));
      for (const page of visible) c.sentPages.set(page.id, JSON.stringify(page));
      scheduleSync();
      const { hostName } = useHosting.getState();
      const welcome: Welcome = {
        conn: c.conn,
        me: { memberId: member.id, name: member.name, color: member.color, kind: member.kind },
        host: { name: hostName, color: HOST_COLOR },
        pages: visible,
      };
      return welcome;
    }
    case 'page.create': {
      requireParent(c, req.parentId);
      if (req.parentId !== null && !canContain(pages[req.parentId]?.type, req.type)) throw new HubError('Hier kann nichts angelegt werden');
      const intoTeam = async (id: string) => {
        if (req.parentId === null && isTeam(c.memberId)) await usePages.getState().moveToGroup(id, { space: 'team', categoryId: null }, Number.MAX_SAFE_INTEGER);
      };
      if (req.type === 'database') {
        const id = await useDatabases.getState().createDatabase(req.parentId);
        await intoTeam(id);
        if (req.title) usePages.getState().update(id, { title: req.title });
        return id;
      }
      if (req.type === 'board') {
        const id = await createBoard(req.parentId);
        await intoTeam(id);
        if (req.title) usePages.getState().update(id, { title: req.title });
        return id;
      }
      // Team-Mitglieder legen oberste Seiten im Team-Bereich an.
      const space = req.parentId === null && isTeam(c.memberId) ? ('team' as const) : undefined;
      return usePages.getState().create({ parentId: req.parentId, title: req.title, index: req.index ?? undefined, space });
    }
    case 'page.update':
      requireAccess(c, req.id, 'edit');
      if (req.patch.cover !== undefined && req.patch.cover !== null && !ASSET_NAME.test(req.patch.cover)) invalid();
      usePages.getState().update(req.id, req.patch);
      return null;
    case 'page.move':
      requireAccess(c, req.id, 'edit');
      requireParent(c, req.parentId);
      await usePages.getState().move(req.id, req.parentId, req.index);
      return null;
    case 'page.trash':
      requireAccess(c, req.id, 'edit');
      await usePages.getState().trash(req.id);
      return null;
    case 'doc.open': {
      const access = requireAccess(c, req.pageId, 'read');
      if (pages[req.pageId]?.type !== 'page') invalid();
      return docs!.subscribe(req.pageId, c.conn, req.clientId, access);
    }
    case 'board.open': {
      const access = requireAccess(c, req.pageId, 'read');
      if (pages[req.pageId]?.type !== 'board') invalid();
      return req.subscribe ? boards!.subscribe(req.pageId, c.conn, access) : boards!.snapshot(req.pageId, access);
    }
    case 'board.files':
      requireAccess(c, req.pageId, 'edit');
      await boards!.addFiles(req.pageId, c.conn, req.files);
      return null;
    case 'db.open': {
      requireAccess(c, req.databaseId, 'read');
      if (pages[req.databaseId]?.type !== 'database') invalid();
      const data = await databaseData(req.databaseId);
      c.dbs.add(req.databaseId);
      c.sentDb.set(req.databaseId, data);
      return data;
    }
    case 'db.call':
      requireAccess(c, req.databaseId, 'edit');
      if (pages[req.databaseId]?.type !== 'database') invalid();
      return dbCall(req.databaseId, req.method, req.args);
    case 'search': {
      const access = accessOf(c.memberId);
      const hits = await searchPages(req.query, 80);
      return hits.filter((h) => access.has(h.id)).slice(0, 30);
    }
  }
}

async function process(c: Connection, message: ClientMessage) {
  switch (message.t) {
    case 'req':
      try {
        const value = await handle(c, message.req);
        send([c.conn], { t: 'res', id: message.id, ok: true, value: value ?? null });
      } catch (err) {
        if (!(err instanceof HubError)) console.error('Anfrage eines Gastes fehlgeschlagen', err);
        send([c.conn], { t: 'res', id: message.id, ok: false, error: err instanceof HubError ? err.message : 'Fehler beim Gastgeber' });
      }
      return;
    case 'view':
      c.view = message.pageId && accessOf(c.memberId).has(message.pageId) ? message.pageId : null;
      syncPresence();
      return;
    case 'leave':
      if (message.kind === 'doc') await docs?.unsubscribe(message.id, c.conn);
      else if (message.kind === 'board') await boards?.unsubscribe(message.id, c.conn, `c${c.conn}`);
      else c.dbs.delete(message.id);
      return;
    case 'doc.update':
      if (accessOf(c.memberId).get(message.pageId) === 'edit') await docs?.applyUpdate(message.pageId, c.conn, message.update);
      return;
    case 'doc.awareness':
      if (accessOf(c.memberId).has(message.pageId)) await docs?.applyAwareness(message.pageId, c.conn, message.update);
      return;
    case 'board.update':
      if (accessOf(c.memberId).get(message.pageId) === 'edit') await boards?.remote(message.pageId, c.conn, message.elements as BoardElement[]);
      return;
    case 'board.pointer': {
      if (!accessOf(c.memberId).has(message.pageId)) return;
      const member = memberOf(c.memberId);
      const { pageId, x, y, tool, button } = message;
      await boards?.pointer(pageId, c.conn, { person: `c${c.conn}`, name: member?.name ?? 'Gast', color: member?.color ?? '#888888', x, y, tool, button });
      return;
    }
  }
}

/* ---------- Verbindungen ---------- */

interface ConnPayload {
  conn: number;
  memberId: string;
}

function onOpen(conn: number, memberId: string) {
  conns.set(conn, {
    conn,
    memberId,
    ready: false,
    view: null,
    sentPages: new Map(),
    dbs: new Set(),
    sentDb: new Map(),
    queue: Promise.resolve(),
  });
}

function onClose(conn: number) {
  if (!conns.delete(conn)) return;
  docs?.dropConnection(conn);
  boards?.dropConnection(conn);
  syncPresence();
}

function onMessage(conn: number, memberId: string, data: string) {
  const c = conns.get(conn);
  if (!c || c.memberId !== memberId) return;
  const message = parseClientMessage(data);
  if (!message) return;
  c.queue = c.queue.then(() => process(c, message)).catch((err) => console.error('Nachricht eines Gastes', err));
}

/* ---------- Anbindung von Editor und Board des Gastgebers ---------- */

const hostUser = () => ({ name: useHosting.getState().hostName, color: HOST_COLOR });

function installSources() {
  useCollab.setState({
    docs: async (pageId) => {
      const binding = await docs!.acquire(pageId);
      return { ...binding, user: hostUser() };
    },
    boards: async (pageId, events) => {
      const hub = boards!;
      const attached = await hub.attach(pageId, events);
      return {
        snapshot: attached.snapshot,
        change: attached.change,
        storeImage: (blob, name) => importImageBlob(blob, name),
        addFiles: (files) => void hub.addFiles(pageId, 'host', files),
        pointer: (x, y, tool, button) => void hub.pointer(pageId, 'host', { person: 'host', ...hostUser(), x, y, tool, button }),
        release: attached.detach,
      };
    },
  });
}

export async function startHub(using: HubTransport = tauriTransport) {
  transport = using;
  docs = new DocHub(send, using.loadDoc);
  boards = new BoardHub(send);
  const unlisten = await using.listen({ open: onOpen, close: onClose, message: onMessage });
  cleanup = [
    unlisten,
    usePages.subscribe((s, prev) => {
      if (s.pages === prev.pages) return;
      accessCache.clear();
      scheduleSync();
    }),
    useDatabases.subscribe((s, prev) => {
      if (s.data !== prev.data) scheduleDbSync();
    }),
    useUI.subscribe((s, prev) => {
      if (s.currentId !== prev.currentId) scheduleSync();
    }),
    useHosting.subscribe((s, prev) => {
      if (s.hostName !== prev.hostName || s.members !== prev.members) scheduleSync();
    }),
  ];
  if (using.host) installSources();
}

export async function stopHub() {
  for (const off of cleanup) off();
  cleanup = [];
  conns.clear();
  accessCache.clear();
  // Erst alles schreiben, dann auf lokale Editoren umschalten (sie laden den gespeicherten Stand),
  // zuletzt die gemeinsamen Dokumente freigeben.
  await flush();
  useCollab.setState({ docs: null, boards: null });
  usePresence.setState({ people: [], me: null });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await docs?.destroy();
  boards?.destroy();
  docs = null;
  boards = null;
}
