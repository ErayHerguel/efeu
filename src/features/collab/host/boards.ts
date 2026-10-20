import { loadBoard, saveBoard, sceneText, type StoredScene } from '../../../db/boards';
import { flush, schedule } from '../../../db/saveQueue';
import type { BoardFile, BoardSnapshot, ServerMessage } from '../protocol';
import { newer, ordered } from '../../board/elements';
import type { Access } from '../access';
import type { BoardElement as Element, BoardEvents, RemotePointer } from '../sources';

type BoardListener = BoardEvents;

interface Entry {
  pageId: string;
  elements: Map<string, Element>;
  files: Record<string, BoardFile>;
  background: string;
  guests: Set<number>;
  listeners: Set<BoardListener>;
}

/**
 * Gemeinsame Boards beim Gastgeber: hält die Elemente jedes geöffneten Boards, übernimmt Änderungen
 * (Gäste und Gastgeber), verteilt sie weiter und speichert die Szene gebündelt.
 */
export class BoardHub {
  private entries = new Map<string, Promise<Entry>>();

  constructor(private send: (targets: number[], message: ServerMessage) => void) {}

  private open(pageId: string): Promise<Entry> {
    let entry = this.entries.get(pageId);
    if (!entry) {
      entry = (async () => {
        await flush();
        const scene = await loadBoard(pageId);
        return {
          pageId,
          elements: new Map(scene.elements.map((e) => [String(e.id), e as Element])),
          files: { ...scene.files },
          background: scene.appState?.viewBackgroundColor ?? '#ffffff',
          guests: new Set<number>(),
          listeners: new Set<BoardListener>(),
        };
      })();
      this.entries.set(pageId, entry);
      entry.catch(() => this.entries.delete(pageId));
    }
    return entry;
  }

  private release(entry: Entry) {
    if (entry.guests.size === 0 && entry.listeners.size === 0) this.entries.delete(entry.pageId);
  }

  private persist(entry: Entry) {
    const { pageId } = entry;
    schedule(`board:${pageId}`, () => {
      const elements = ordered(entry.elements.values()).filter((e) => !e.isDeleted);
      const scene: StoredScene = { elements, files: entry.files, appState: { viewBackgroundColor: entry.background } };
      return saveBoard(pageId, scene, sceneText(elements), Date.now());
    });
  }

  /** Übernimmt neuere Elemente und liefert die tatsächlich übernommenen. */
  private merge(entry: Entry, incoming: Element[]): Element[] {
    const accepted: Element[] = [];
    for (const element of incoming) {
      if (!newer(element, entry.elements.get(element.id))) continue;
      entry.elements.set(element.id, element);
      accepted.push(element);
    }
    if (accepted.length) this.persist(entry);
    return accepted;
  }

  async snapshot(pageId: string, access: Access): Promise<BoardSnapshot> {
    const entry = await this.open(pageId);
    const snapshot: BoardSnapshot = {
      elements: ordered(entry.elements.values()),
      files: entry.files,
      background: entry.background,
      access,
    };
    this.release(entry);
    return snapshot;
  }

  async subscribe(pageId: string, conn: number, access: Access): Promise<BoardSnapshot> {
    const entry = await this.open(pageId);
    entry.guests.add(conn);
    return { elements: ordered(entry.elements.values()), files: entry.files, background: entry.background, access };
  }

  async unsubscribe(pageId: string, conn: number, person: string) {
    const entry = await this.entries.get(pageId)?.catch(() => null);
    if (!entry || !entry.guests.delete(conn)) return;
    this.send([...entry.guests], { t: 'board.leave', pageId, person });
    for (const l of entry.listeners) l.leave(person);
    this.release(entry);
  }

  dropConnection(conn: number) {
    for (const pageId of this.entries.keys()) void this.unsubscribe(pageId, conn, `c${conn}`);
  }

  async subscriptions(conn: number): Promise<string[]> {
    const entries = await Promise.all([...this.entries.values()].map((e) => e.catch(() => null)));
    return entries.filter((e): e is Entry => e !== null && e.guests.has(conn)).map((e) => e.pageId);
  }

  /** Änderungen eines Gastes. */
  async remote(pageId: string, conn: number, elements: Element[]) {
    const entry = await this.entries.get(pageId)?.catch(() => null);
    if (!entry || !entry.guests.has(conn)) return;
    const accepted = this.merge(entry, elements);
    if (!accepted.length) return;
    this.send([...entry.guests].filter((c) => c !== conn), { t: 'board.update', pageId, elements: accepted });
    for (const l of entry.listeners) l.elements(accepted);
  }

  /** Neue Bilder (bereits als Asset gespeichert). */
  async addFiles(pageId: string, origin: number | 'host', files: Record<string, BoardFile>) {
    const entry = await this.entries.get(pageId)?.catch(() => null);
    if (!entry) return;
    const fresh = Object.fromEntries(Object.entries(files).filter(([id]) => !entry.files[id]));
    if (!Object.keys(fresh).length) return;
    entry.files = { ...entry.files, ...fresh };
    this.persist(entry);
    this.send([...entry.guests].filter((c) => c !== origin), { t: 'board.files', pageId, files: fresh });
    if (origin !== 'host') for (const l of entry.listeners) l.files(fresh);
  }

  /** Elemente, die der Cloud-Abgleich schon gespeichert hat: in eine offene Ansicht übernehmen. */
  external(pageId: string, elements: Element[], files: Record<string, BoardFile>) {
    void this.entries.get(pageId)?.then((entry) => {
      const accepted: Element[] = [];
      for (const element of elements) {
        if (!newer(element, entry.elements.get(element.id))) continue;
        entry.elements.set(element.id, element);
        accepted.push(element);
      }
      const fresh = Object.fromEntries(Object.entries(files).filter(([id]) => !entry.files[id]));
      if (Object.keys(fresh).length) {
        entry.files = { ...entry.files, ...fresh };
        for (const l of entry.listeners) l.files(fresh);
        this.send([...entry.guests], { t: 'board.files', pageId, files: fresh });
      }
      if (!accepted.length) return;
      this.send([...entry.guests], { t: 'board.update', pageId, elements: accepted });
      for (const l of entry.listeners) l.elements(accepted);
    }, () => undefined);
  }

  async pointer(pageId: string, origin: number | 'host', p: RemotePointer) {
    const entry = await this.entries.get(pageId)?.catch(() => null);
    if (!entry || (origin !== 'host' && !entry.guests.has(origin))) return;
    this.send([...entry.guests].filter((c) => c !== origin), { t: 'board.pointer', pageId, ...p });
    if (origin !== 'host') for (const l of entry.listeners) l.pointer(p);
  }

  /** Board-Ansicht des Gastgebers anbinden. */
  async attach(pageId: string, listener: BoardListener) {
    const entry = await this.open(pageId);
    entry.listeners.add(listener);
    return {
      snapshot: { elements: ordered(entry.elements.values()), files: entry.files, background: entry.background },
      /** Änderungen aus der Ansicht des Gastgebers */
      change: (elements: Element[], background: string) => {
        const accepted = this.merge(entry, elements);
        if (background !== entry.background) {
          entry.background = background;
          this.persist(entry);
        }
        if (accepted.length) this.send([...entry.guests], { t: 'board.update', pageId, elements: accepted });
      },
      detach: () => {
        entry.listeners.delete(listener);
        // Mauszeiger des Gastgebers bei den Gästen ausblenden.
        this.send([...entry.guests], { t: 'board.leave', pageId, person: 'host' });
        this.release(entry);
      },
    };
  }

  destroy() {
    this.entries.clear();
  }
}
