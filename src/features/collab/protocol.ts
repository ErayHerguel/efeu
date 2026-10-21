import { fromBase64, toBase64 } from 'lib0/buffer';
import { TAG_COLORS, type CellValue, type PropertyType, type ViewType } from '../../db/database';
import type { Category } from '../../db/categories';
import type { PagePatch, PageType } from '../../db/pages';
import type { SearchHit } from '../../db/search';
import type { DatabaseData } from '../../store/databases';
import type { Access, GuestPage } from './access';

/**
 * Nachrichten zwischen Gästen und dem Hauptfenster des Gastgebers (JSON über WebSocket).
 * Alles, was von Gästen kommt, wird beim Gastgeber geprüft: Form hier, Rechte im Hub.
 */

export interface Person {
  /** 'host' oder 'c<Verbindung>' */
  id: string;
  /** Eingeladene Person (fehlt beim Gastgeber) */
  memberId: string | null;
  name: string;
  color: string;
  /** Geöffnete Seite, sofern der Empfänger sie sehen darf */
  pageId: string | null;
}

export interface Welcome {
  conn: number;
  /** device: eigenes Gerät mit vollem Zugriff */
  me: { memberId: string; name: string; color: string; kind: 'person' | 'device'; team?: boolean };
  host: { name: string; color: string };
  pages: GuestPage[];
  /** Kategorien der Seitenleiste, die die Person sehen darf */
  categories?: Category[];
}

export interface BoardFile {
  asset: string;
  mimeType: string;
}

export interface BoardSnapshot {
  elements: Record<string, unknown>[];
  files: Record<string, BoardFile>;
  background: string;
  access: Access;
}

export interface DocSnapshot {
  /** Wechselt, wenn der Gastgeber das Dokument neu aufbaut; dann muss der Gast neu beginnen. */
  session: string;
  update: string;
  /** Zustandsvektor des Gastgebers, damit der Gast Offline-Änderungen nachreichen kann. */
  sv: string;
  awareness: string | null;
  access: Access;
}

export const DB_METHODS = [
  'createRow',
  'setValue',
  'addProperty',
  'updateProperty',
  'changePropertyType',
  'deleteOption',
  'deleteProperty',
  'addView',
  'updateView',
  'deleteView',
] as const;
export type DbMethod = (typeof DB_METHODS)[number];

export type Request =
  | { op: 'hello' }
  | { op: 'page.create'; parentId: string | null; type: PageType; title: string; index: number | null }
  | { op: 'page.update'; id: string; patch: PagePatch }
  | { op: 'page.move'; id: string; parentId: string | null; index: number }
  | { op: 'page.trash'; id: string }
  | { op: 'doc.open'; pageId: string; clientId: number }
  | { op: 'board.open'; pageId: string; subscribe: boolean }
  | { op: 'board.files'; pageId: string; files: Record<string, BoardFile> }
  | { op: 'db.open'; databaseId: string }
  | { op: 'db.call'; databaseId: string; method: DbMethod; args: unknown[] }
  | { op: 'search'; query: string };

export type PointerTool = 'pointer' | 'laser';

export type ClientMessage =
  | { t: 'req'; id: number; req: Request }
  | { t: 'view'; pageId: string | null }
  | { t: 'leave'; kind: 'doc' | 'board' | 'db'; id: string }
  | { t: 'doc.update'; pageId: string; update: string }
  | { t: 'doc.awareness'; pageId: string; update: string }
  | { t: 'board.update'; pageId: string; elements: Record<string, unknown>[] }
  | { t: 'board.pointer'; pageId: string; x: number; y: number; tool: PointerTool; button: 'up' | 'down' };

export type ServerMessage =
  | { t: 'res'; id: number; ok: true; value: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'pages'; upsert: GuestPage[]; remove: string[] }
  | { t: 'presence'; people: Person[] }
  | { t: 'doc.update'; pageId: string; update: string }
  | { t: 'doc.awareness'; pageId: string; update: string }
  | { t: 'board.update'; pageId: string; elements: Record<string, unknown>[] }
  | { t: 'board.files'; pageId: string; files: Record<string, BoardFile> }
  | {
      t: 'board.pointer';
      pageId: string;
      person: string;
      name: string;
      color: string;
      x: number;
      y: number;
      tool: PointerTool;
      button: 'up' | 'down';
    }
  | { t: 'board.leave'; pageId: string; person: string }
  | { t: 'db'; databaseId: string; data: DatabaseData }
  | { t: 'categories'; categories: Category[] };

export type SearchResult = SearchHit[];

export const encodeBinary = (bytes: Uint8Array): string => toBase64(bytes);
export const decodeBinary = (text: string): Uint8Array => fromBase64(text);

/* ---------- Prüfung eingehender Nachrichten ---------- */

const MAX_ID = 64;
const MAX_TEXT = 100_000;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;
export const isText = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max;
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isBase64 = (v: unknown): v is string => typeof v === 'string' && v.length <= 16_000_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(v);

export const PAGE_TYPES: PageType[] = ['page', 'database', 'board'];
export const PROPERTY_TYPES: PropertyType[] = [
  'text',
  'number',
  'select',
  'multi_select',
  'date',
  'checkbox',
  'url',
  'relation',
  'rollup',
  'formula',
];
export const VIEW_TYPES: ViewType[] = ['table', 'board', 'calendar', 'gallery', 'list'];

export function isCellValue(v: unknown): v is CellValue {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= MAX_TEXT;
  return Array.isArray(v) && v.length <= 500 && v.every(isId);
}

export function isPagePatch(v: unknown): v is PagePatch {
  if (!isRecord(v)) return false;
  for (const [key, value] of Object.entries(v)) {
    if (key === 'title' && isText(value, 2000)) continue;
    if ((key === 'icon' || key === 'cover') && (value === null || isText(value, 200))) continue;
    if (key === 'fullWidth' && typeof value === 'boolean') continue;
    return false;
  }
  return true;
}

export function isBoardFiles(v: unknown): v is Record<string, BoardFile> {
  if (!isRecord(v) || Object.keys(v).length > 500) return false;
  return Object.entries(v).every(
    ([id, f]) => isId(id) && isRecord(f) && isText(f.asset, 100) && /^[0-9a-f]{32}\.[a-z0-9]{1,10}$/.test(f.asset) && isText(f.mimeType, 100),
  );
}

const isElement = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) && isId(v.id) && typeof v.type === 'string' && isFiniteNumber(v.version) && isFiniteNumber(v.versionNonce);

function parseRequest(v: unknown): Request | null {
  if (!isRecord(v)) return null;
  switch (v.op) {
    case 'hello':
      return { op: 'hello' };
    case 'page.create':
      if (!(v.parentId === null || isId(v.parentId)) || !PAGE_TYPES.includes(v.type as PageType)) return null;
      return {
        op: 'page.create',
        parentId: v.parentId,
        type: v.type as PageType,
        title: isText(v.title, 2000) ? v.title : '',
        index: isIndex(v.index) ? v.index : null,
      };
    case 'page.update':
      return isId(v.id) && isPagePatch(v.patch) ? { op: 'page.update', id: v.id, patch: v.patch } : null;
    case 'page.move':
      return isId(v.id) && (v.parentId === null || isId(v.parentId)) && isIndex(v.index)
        ? { op: 'page.move', id: v.id, parentId: v.parentId, index: v.index }
        : null;
    case 'page.trash':
      return isId(v.id) ? { op: 'page.trash', id: v.id } : null;
    case 'doc.open':
      return isId(v.pageId) && isIndex(v.clientId) ? { op: 'doc.open', pageId: v.pageId, clientId: v.clientId } : null;
    case 'board.open':
      return isId(v.pageId) ? { op: 'board.open', pageId: v.pageId, subscribe: v.subscribe === true } : null;
    case 'board.files':
      return isId(v.pageId) && isBoardFiles(v.files) ? { op: 'board.files', pageId: v.pageId, files: v.files } : null;
    case 'db.open':
      return isId(v.databaseId) ? { op: 'db.open', databaseId: v.databaseId } : null;
    case 'db.call':
      if (!isId(v.databaseId) || !DB_METHODS.includes(v.method as DbMethod) || !Array.isArray(v.args) || v.args.length > 4) return null;
      return { op: 'db.call', databaseId: v.databaseId, method: v.method as DbMethod, args: v.args };
    case 'search':
      return isText(v.query, 500) ? { op: 'search', query: v.query } : null;
    default:
      return null;
  }
}

/** Liefert eine geprüfte Nachricht oder null, wenn Form oder Typen nicht stimmen. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  switch (v.t) {
    case 'req': {
      const req = parseRequest(v.req);
      return req && isIndex(v.id) ? { t: 'req', id: v.id, req } : null;
    }
    case 'view':
      return v.pageId === null || isId(v.pageId) ? { t: 'view', pageId: v.pageId } : null;
    case 'leave':
      return (v.kind === 'doc' || v.kind === 'board' || v.kind === 'db') && isId(v.id) ? { t: 'leave', kind: v.kind, id: v.id } : null;
    case 'doc.update':
    case 'doc.awareness':
      return isId(v.pageId) && isBase64(v.update) ? { t: v.t, pageId: v.pageId, update: v.update } : null;
    case 'board.update':
      return isId(v.pageId) && Array.isArray(v.elements) && v.elements.length <= 20_000 && v.elements.every(isElement)
        ? { t: 'board.update', pageId: v.pageId, elements: v.elements }
        : null;
    case 'board.pointer':
      return isId(v.pageId) &&
        isFiniteNumber(v.x) &&
        isFiniteNumber(v.y) &&
        (v.tool === 'pointer' || v.tool === 'laser') &&
        (v.button === 'up' || v.button === 'down')
        ? { t: 'board.pointer', pageId: v.pageId, x: v.x, y: v.y, tool: v.tool, button: v.button }
        : null;
    default:
      return null;
  }
}

/** Prüfungen der Argumente von Datenbank-Aufrufen (Werte, Optionen, Konfiguration). */
export const isTagColor = (v: unknown): boolean => TAG_COLORS.includes(v as (typeof TAG_COLORS)[number]);
