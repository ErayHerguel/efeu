import { create } from 'zustand';
import type { Anchor } from '../components/Popover';

/** Offenes Blockmenü (Klick auf den Greifer): Startposition des Blocks und Anker für das Menü. */
export const useBlockMenu = create<{ pos: number | null; anchor: Anchor | null }>(() => ({ pos: null, anchor: null }));

export function openBlockMenu(pos: number, rect: DOMRect): void {
  useBlockMenu.setState({ pos, anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } });
}

export function closeBlockMenu(): void {
  useBlockMenu.setState({ pos: null, anchor: null });
}
