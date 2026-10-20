import { newer, ordered } from '../features/board/elements';
import type { StoredScene } from '../db/boards';
import type { BoardElement } from './types';

/** Element-ID → Version, die die Cloud schon hat. */
export type Acked = Record<string, number>;

const asElement = (e: Record<string, unknown>) => e as unknown as BoardElement;

/**
 * Lokale Änderungen eines Boards gegenüber dem Stand der Cloud: neue und geänderte Elemente sowie
 * Grabsteine für Elemente, die lokal verschwunden sind (Excalidraw speichert gelöschte nicht).
 */
export function boardChanges(scene: StoredScene, acked: Acked): BoardElement[] {
  const elements = scene.elements.map(asElement);
  const present = new Set(elements.map((e) => e.id));
  const changed = elements.filter((e) => acked[e.id] !== e.version);
  const removed = Object.entries(acked)
    .filter(([id]) => !present.has(id))
    .map(([id, version]): BoardElement => ({ id, version: version + 1, versionNonce: 0, isDeleted: true }));
  return [...changed, ...removed];
}

/** Stand der Cloud nach erfolgreichem Hochladen. */
export function ackedOf(scene: StoredScene): Acked {
  return Object.fromEntries(scene.elements.map(asElement).map((e) => [e.id, e.version]));
}

/**
 * Übernimmt Elemente aus der Cloud (höhere Version gewinnt) und hält fest, was die Cloud nun hat.
 * Lokal neuere Elemente bleiben und werden beim nächsten Hochladen verschickt.
 */
export function mergeBoard(
  scene: StoredScene,
  incoming: BoardElement[],
  acked: Acked,
): { scene: StoredScene; acked: Acked; changed: boolean } {
  const elements = new Map(scene.elements.map(asElement).map((e) => [e.id, e]));
  const next: Acked = { ...acked };
  let changed = false;
  for (const element of incoming) {
    if (typeof element?.id !== 'string' || typeof element.version !== 'number') continue;
    const current = elements.get(element.id);
    if (element.isDeleted) delete next[element.id];
    else next[element.id] = element.version;
    if (current && !newer(element, current)) continue;
    if (element.isDeleted) {
      if (current) {
        elements.delete(element.id);
        changed = true;
      }
      continue;
    }
    elements.set(element.id, element);
    changed = true;
  }
  return {
    scene: { ...scene, elements: ordered(elements.values()) as unknown as Record<string, unknown>[] },
    acked: next,
    changed,
  };
}
