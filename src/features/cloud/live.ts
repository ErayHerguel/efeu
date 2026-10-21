import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { applyAwarenessUpdate, encodeAwarenessUpdate, type Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { useUI } from '../../store/ui';
import { decodeBinary, encodeBinary, type ClientMessage, type DocSnapshot, type Request, type ServerMessage, type Welcome } from '../collab/protocol';
import { usePresence } from '../collab/presence';

/** Ursprung von Änderungen, die über die Live-Verbindung kamen (werden nicht zurückgeschickt). */
export const LIVE = 'cloud-live';

interface Attached {
  doc: Y.Doc;
  awareness: Awareness;
  off: () => void;
}

/**
 * Live-Verbindung der App zur eigenen Cloud: für geöffnete Seiten Tippen, Cursor und Präsenz der anderen
 * sofort, über denselben Hub wie im Browser. Die Seiten selbst bleiben lokal (Y.Doc aus dem Abgleich);
 * hier werden nur Änderungen in beide Richtungen weitergereicht.
 */
class LiveBridge {
  private open = false;
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private docs = new Map<string, Attached>();
  private subscribed = new Set<string>();
  private cleanup: UnlistenFn[] = [];
  private unsubscribeView: (() => void) | null = null;
  me: Welcome['me'] | null = null;

  async start(name: string) {
    this.cleanup = await Promise.all([
      listen<string>('cloud:live', (e) => this.onMessage(e.payload)),
      listen('cloud:live-open', () => void this.onOpen()),
      listen('cloud:live-closed', () => this.onClosed()),
    ]);
    this.unsubscribeView = useUI.subscribe((s, prev) => {
      if (s.currentId !== prev.currentId) this.send({ t: 'view', pageId: s.currentId });
    });
    await invoke('cloud_live_open', { name });
  }

  async stop() {
    for (const off of this.cleanup) off();
    this.cleanup = [];
    this.unsubscribeView?.();
    for (const [pageId] of this.docs) this.detach(pageId);
    this.onClosed();
    await invoke('cloud_live_close').catch(() => undefined);
  }

  private send(message: ClientMessage) {
    if (!this.open) return;
    invoke('cloud_live_send', { text: JSON.stringify(message) }).catch(() => undefined);
  }

  private request<T>(req: Request): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.open) return reject(new Error('Keine Live-Verbindung'));
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('Keine Antwort'));
      }, 20_000);
      invoke('cloud_live_send', { text: JSON.stringify({ t: 'req', id, req } satisfies ClientMessage) }).catch((err) => {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private async onOpen() {
    this.open = true;
    try {
      const welcome = await this.request<Welcome>({ op: 'hello' });
      this.me = welcome.me;
      usePresence.setState({ me: `c${welcome.conn}` });
      this.send({ t: 'view', pageId: useUI.getState().currentId });
      for (const pageId of this.docs.keys()) void this.subscribe(pageId);
    } catch (err) {
      console.warn('Live-Verbindung', err);
    }
  }

  private onClosed() {
    this.open = false;
    this.subscribed.clear();
    for (const [, p] of this.pending) p.reject(new Error('Live-Verbindung unterbrochen'));
    this.pending.clear();
    usePresence.setState({ people: [], me: null });
  }

  private onMessage(text: string) {
    let message: ServerMessage;
    try {
      message = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    if (message.t === 'res') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(new Error(message.error));
    } else if (message.t === 'presence') {
      usePresence.setState({ people: message.people });
    } else if (message.t === 'doc.update') {
      const doc = this.docs.get(message.pageId)?.doc;
      if (doc) Y.applyUpdate(doc, decodeBinary(message.update), LIVE);
    } else if (message.t === 'doc.awareness') {
      const awareness = this.docs.get(message.pageId)?.awareness;
      if (awareness) applyAwarenessUpdate(awareness, decodeBinary(message.update), LIVE);
    }
  }

  /** Eine im Editor geöffnete Seite live mit den anderen verbinden. */
  attach(pageId: string, doc: Y.Doc, awareness: Awareness) {
    if (this.docs.has(pageId)) return;
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      // Was aus der Cloud kam (live oder über den Abgleich), hat der Server schon.
      if (origin === LIVE || origin === 'cloud') return;
      this.send({ t: 'doc.update', pageId, update: encodeBinary(update) });
    };
    const onAwareness = ({ added, updated, removed }: Record<'added' | 'updated' | 'removed', number[]>, origin: unknown) => {
      if (origin === LIVE || ![...added, ...updated, ...removed].includes(doc.clientID)) return;
      this.send({ t: 'doc.awareness', pageId, update: encodeBinary(encodeAwarenessUpdate(awareness, [doc.clientID])) });
    };
    doc.on('update', onUpdate);
    awareness.on('update', onAwareness);
    this.docs.set(pageId, {
      doc,
      awareness,
      off: () => {
        doc.off('update', onUpdate);
        awareness.off('update', onAwareness);
      },
    });
    if (this.open) void this.subscribe(pageId);
  }

  detach(pageId: string) {
    const entry = this.docs.get(pageId);
    if (!entry) return;
    entry.off();
    this.docs.delete(pageId);
    this.subscribed.delete(pageId);
    this.send({ t: 'leave', kind: 'doc', id: pageId });
  }

  /** Nach einem Abgleich: Seiten verbinden, die der Server vorher noch nicht kannte. */
  retry() {
    if (!this.open) return;
    for (const pageId of this.docs.keys()) if (!this.subscribed.has(pageId)) void this.subscribe(pageId);
  }

  private async subscribe(pageId: string) {
    const entry = this.docs.get(pageId);
    if (!entry) return;
    try {
      const snapshot = await this.request<DocSnapshot>({ op: 'doc.open', pageId, clientId: entry.doc.clientID });
      if (this.docs.get(pageId) !== entry) return;
      this.subscribed.add(pageId);
      Y.applyUpdate(entry.doc, decodeBinary(snapshot.update), LIVE);
      // Was hier schon mehr ist (offline geschrieben, noch nicht abgeglichen), gleich nachreichen.
      const missing = Y.encodeStateAsUpdate(entry.doc, decodeBinary(snapshot.sv));
      if (missing.length > 2) this.send({ t: 'doc.update', pageId, update: encodeBinary(missing) });
      if (snapshot.awareness) applyAwarenessUpdate(entry.awareness, decodeBinary(snapshot.awareness), LIVE);
      const local = entry.awareness.getLocalState();
      if (local) this.send({ t: 'doc.awareness', pageId, update: encodeBinary(encodeAwarenessUpdate(entry.awareness, [entry.doc.clientID])) });
    } catch (err) {
      // Seite (noch) nicht auf dem Server, z. B. gerade erst angelegt: der Abgleich holt sie nach.
      console.warn('Live-Seite', pageId, err);
    }
  }
}

export const live = new LiveBridge();
