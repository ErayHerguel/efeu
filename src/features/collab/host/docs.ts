import { getSchema, type JSONContent } from '@tiptap/core';
import { Node as PMNode, type Schema } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as decoding from 'lib0/decoding';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { loadDoc, saveContent } from '../../../db/content';
import { flush, schedule } from '../../../db/saveQueue';
import { createExtensions } from '../../../editor/extensions';
import { docText } from '../../../editor/text';
import { collectLinkTargets } from '../../../lib/doc';
import { newId } from '../../../lib/ids';
import { usePages } from '../../../store/pages';
import { decodeBinary, encodeBinary, type DocSnapshot, type ServerMessage } from '../protocol';
import type { Access } from '../access';

/** Name des Yjs-Fragments, das die Collaboration-Erweiterung von TipTap verwendet. */
export const FIELD = 'default';
/** Nicht mehr benutzte Dokumente bleiben kurz im Speicher (schnelles Wiederöffnen). */
const IDLE_MS = 30_000;

let schema: Schema | null = null;
export const editorSchema = (): Schema => (schema ??= getSchema(createExtensions('schema')));

const titleOf = (id: string) => usePages.getState().pages[id]?.title ?? '';

interface Entry {
  pageId: string;
  doc: Y.Doc;
  awareness: Awareness;
  session: string;
  /** Offene Editoren beim Gastgeber */
  hostRefs: number;
  /** Verbindung → Yjs-Client-ID des Gastes */
  guests: Map<number, number>;
  idle: ReturnType<typeof setTimeout> | null;
}

/** Ursprung einer Änderung: Verbindungsnummer eines Gastes oder der Gastgeber selbst. */
type Origin = number | 'host';

/** Liest die Client-IDs aus einem Awareness-Update (für die Prüfung, wem es gehört). */
function awarenessClients(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }
  return ids;
}

/**
 * Gemeinsame Seiten-Dokumente beim Gastgeber. Quelle der Wahrheit ist ein Y.Doc pro Seite, das aus dem
 * gespeicherten Inhalt aufgebaut wird; jede Änderung (vom Gastgeber oder von Gästen) wird wie gewohnt
 * gebündelt in die Datenbank geschrieben.
 */
export class DocHub {
  private entries = new Map<string, Promise<Entry>>();
  private loaded = new Map<string, Entry>();

  /**
   * `load` liefert das Y.Doc einer Seite. Ohne eigene Cloud wird es aus dem gespeicherten Inhalt neu
   * aufgebaut; mit Cloud kommt es aus dem abgeglichenen Yjs-Zustand (sonst passten die Stände nicht zusammen).
   */
  constructor(
    private send: (targets: number[], message: ServerMessage) => void,
    private load?: (pageId: string) => Promise<Y.Doc>,
  ) {}

  /**
   * Dokument einer Seite, die gerade bearbeitet wird (für den Cloud-Abgleich). Ein nur noch
   * zwischengespeichertes wird verworfen: In die Seite kann inzwischen direkt geschrieben worden sein.
   */
  peek(pageId: string): Y.Doc | undefined {
    const entry = this.loaded.get(pageId);
    if (!entry) return undefined;
    if (entry.hostRefs > 0 || entry.guests.size > 0) return entry.doc;
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = null;
    this.entries.delete(pageId);
    this.loaded.delete(pageId);
    entry.awareness.destroy();
    entry.doc.destroy();
    return undefined;
  }

  private open(pageId: string): Promise<Entry> {
    let entry = this.entries.get(pageId);
    if (!entry) {
      entry = this.create(pageId);
      this.entries.set(pageId, entry);
      entry.catch(() => this.entries.delete(pageId));
    }
    return entry.then((e) => {
      if (e.idle) clearTimeout(e.idle);
      e.idle = null;
      return e;
    });
  }

  private async create(pageId: string): Promise<Entry> {
    // Ausstehende Änderungen aus dem normalen Editor zuerst schreiben, dann den Stand laden.
    await flush();
    let doc: Y.Doc;
    if (this.load) doc = await this.load(pageId);
    else doc = prosemirrorJSONToYDoc(editorSchema(), (await loadDoc(pageId)) ?? { type: 'doc', content: [{ type: 'paragraph' }] }, FIELD);
    const awareness = new Awareness(doc);
    awareness.setLocalState(null);
    const entry: Entry = { pageId, doc, awareness, session: newId(), hostRefs: 0, guests: new Map(), idle: null };

    this.loaded.set(pageId, entry);
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Änderungen aus der Cloud hat der Abgleich schon gespeichert.
      if (origin !== 'cloud') this.persist(entry);
      const targets = [...entry.guests.keys()].filter((conn) => conn !== origin);
      if (targets.length) this.send(targets, { t: 'doc.update', pageId, update: encodeBinary(update) });
    });
    awareness.on('update', ({ added, updated, removed }: Record<'added' | 'updated' | 'removed', number[]>, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const targets = [...entry.guests.keys()].filter((conn) => conn !== origin);
      if (!changed.length || !targets.length) return;
      this.send(targets, { t: 'doc.awareness', pageId, update: encodeBinary(encodeAwarenessUpdate(awareness, changed)) });
    });
    return entry;
  }

  private persist(entry: Entry) {
    const { pageId, doc } = entry;
    schedule(`content:${pageId}`, () => {
      const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(FIELD)) as JSONContent;
      let node: PMNode;
      try {
        node = PMNode.fromJSON(editorSchema(), json);
      } catch (err) {
        // Ein ungültiges Dokument wird nicht gespeichert; der letzte gültige Stand bleibt erhalten.
        console.error('Gemeinsames Dokument ungültig, nicht gespeichert', err);
        return [];
      }
      return saveContent(pageId, json, docText(node, titleOf), collectLinkTargets(json, pageId), Date.now());
    });
  }

  private releaseIfUnused(entry: Entry) {
    if (entry.hostRefs > 0 || entry.guests.size > 0 || entry.idle) return;
    entry.idle = setTimeout(() => {
      entry.idle = null;
      if (entry.hostRefs > 0 || entry.guests.size > 0) return;
      this.entries.delete(entry.pageId);
      this.loaded.delete(entry.pageId);
      entry.awareness.destroy();
      entry.doc.destroy();
    }, IDLE_MS);
  }

  /** Für den Editor des Gastgebers. */
  async acquire(pageId: string): Promise<{ doc: Y.Doc; awareness: Awareness; release(): void }> {
    const entry = await this.open(pageId);
    // Ohne Grundzustand setzt die Cursor-Erweiterung keine Felder (setLocalStateField braucht einen Zustand).
    if (entry.hostRefs === 0) entry.awareness.setLocalState({});
    entry.hostRefs += 1;
    let released = false;
    return {
      doc: entry.doc,
      awareness: entry.awareness,
      release: () => {
        if (released) return;
        released = true;
        entry.hostRefs -= 1;
        if (entry.hostRefs === 0) entry.awareness.setLocalState(null);
        this.releaseIfUnused(entry);
      },
    };
  }

  async subscribe(pageId: string, conn: number, clientId: number, access: Access): Promise<DocSnapshot> {
    const entry = await this.open(pageId);
    const previous = entry.guests.get(conn);
    if (previous !== undefined && previous !== clientId) removeAwarenessStates(entry.awareness, [previous], conn);
    entry.guests.set(conn, clientId);
    const states = [...entry.awareness.getStates().keys()];
    return {
      session: entry.session,
      update: encodeBinary(Y.encodeStateAsUpdate(entry.doc)),
      sv: encodeBinary(Y.encodeStateVector(entry.doc)),
      awareness: states.length ? encodeBinary(encodeAwarenessUpdate(entry.awareness, states)) : null,
      access,
    };
  }

  async unsubscribe(pageId: string, conn: number) {
    const entry = await this.entries.get(pageId)?.catch(() => null);
    if (!entry) return;
    const clientId = entry.guests.get(conn);
    if (clientId === undefined) return;
    entry.guests.delete(conn);
    removeAwarenessStates(entry.awareness, [clientId], conn);
    this.releaseIfUnused(entry);
  }

  /** Alle Abos einer Verbindung beenden (Verbindung getrennt). */
  dropConnection(conn: number) {
    for (const pageId of this.entries.keys()) void this.unsubscribe(pageId, conn);
  }

  /** Seiten, die eine Verbindung abonniert hat. */
  async subscriptions(conn: number): Promise<string[]> {
    const entries = await Promise.all([...this.entries.values()].map((e) => e.catch(() => null)));
    return entries.filter((e): e is Entry => e !== null && e.guests.has(conn)).map((e) => e.pageId);
  }

  async applyUpdate(pageId: string, conn: number, update: string) {
    const entry = await this.entries.get(pageId)?.catch(() => null);
    if (!entry || !entry.guests.has(conn)) return;
    try {
      Y.applyUpdate(entry.doc, decodeBinary(update), conn);
    } catch (err) {
      console.error('Ungültige Änderung eines Gastes verworfen', err);
    }
  }

  async applyAwareness(pageId: string, conn: number, update: string) {
    const entry = await this.entries.get(pageId)?.catch(() => null);
    const clientId = entry?.guests.get(conn);
    if (!entry || clientId === undefined) return;
    try {
      const bytes = decodeBinary(update);
      // Jeder Gast darf nur seinen eigenen Cursor setzen.
      if (awarenessClients(bytes).some((id) => id !== clientId)) return;
      applyAwarenessUpdate(entry.awareness, bytes, conn as Origin);
    } catch (err) {
      console.error('Ungültiger Cursor eines Gastes verworfen', err);
    }
  }

  /** Beim Beenden der Freigabe, nachdem alles geschrieben ist und die Editoren lokal arbeiten. */
  async destroy() {
    const entries = await Promise.all([...this.entries.values()].map((e) => e.catch(() => null)));
    for (const entry of entries) {
      if (!entry) continue;
      if (entry.idle) clearTimeout(entry.idle);
      entry.awareness.destroy();
      entry.doc.destroy();
    }
    this.entries.clear();
    this.loaded.clear();
  }
}
