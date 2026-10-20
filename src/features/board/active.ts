import { create } from 'zustand';
import type { BoardEdits, BoardEl } from '../ai/edit/boardModel';

/** Ein Post-it (Form mit Text) auf dem Board */
export interface BoardNote {
  id: string;
  text: string;
  width: number;
  height: number;
}

/**
 * Schnittstelle des gerade geöffneten Boards für die KI. Excalidraw selbst wird nur mit dem Board
 * geladen; die KI spricht ausschließlich über diese Brücke mit der Zeichenfläche.
 */
export interface BoardBridge {
  pageId: string;
  /** Umriss des vorhandenen Inhalts, null bei leerem Board */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** Fügt Elemente (Excalidraw-Skelette) hinzu, rückgängig machbar, und zeigt sie an. */
  insert(skeletons: unknown[]): Promise<void>;
  /** Ausgewählte Post-its */
  selectedNotes(): BoardNote[];
  /** Verschiebt Post-its (samt Text) und färbt sie um, fügt Rahmen/Überschriften hinzu. */
  arrange(moves: { id: string; x: number; y: number; color: string }[], skeletons: unknown[]): Promise<void>;
  /** Alle sichtbaren Elemente (vereinfacht) und die IDs der Auswahl */
  snapshot(): { elements: BoardEl[]; selected: string[] };
  /** Wendet KI-Änderungen in einem Schritt an (mit ⌘Z rückgängig) */
  applyEdits(edits: BoardEdits, created: unknown[]): Promise<void>;
}

export const useActiveBoard = create<{ bridge: BoardBridge | null }>(() => ({ bridge: null }));

/** Stand je Board: steigt, wenn ein Board im Hintergrund geändert wurde (Vorschauen laden neu). */
export const useBoardRevision = create<Record<string, number>>(() => ({}));

export function bumpBoard(pageId: string): void {
  useBoardRevision.setState((s) => ({ [pageId]: (s[pageId] ?? 0) + 1 }));
}

/** Board, das unsichtbar geöffnet ist, damit die KI darauf zeichnen kann (ohne die Seite zu verlassen). */
export const useHiddenBoard = create<{ pageId: string | null }>(() => ({ pageId: null }));

/** Wartet, bis das Board mit dieser ID bereit ist (z. B. direkt nach dem Anlegen). */
export function waitForBoard(pageId: string, timeoutMs = 15_000): Promise<BoardBridge> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const bridge = useActiveBoard.getState().bridge;
      if (bridge?.pageId === pageId) {
        off();
        clearTimeout(timer);
        resolve(bridge);
        return true;
      }
      return false;
    };
    const off = useActiveBoard.subscribe(check);
    const timer = setTimeout(() => {
      off();
      reject(new Error('Das Board ist nicht geöffnet.'));
    }, timeoutMs);
    check();
  });
}
