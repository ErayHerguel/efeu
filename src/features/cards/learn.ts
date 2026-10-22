import { create } from 'zustand';
import { useUI } from '../../store/ui';
import { dueQueue, loadCards } from './cards';

interface LearnState {
  /** Stapel: Seite samt Unterseiten oder null für alle */
  rootId: string | null;
  /** Fällige Karten insgesamt (für die Seitenleiste), null = noch nicht gezählt */
  due: number | null;
  /** Gibt es überhaupt Karten? */
  any: boolean;
}

export const useLearn = create<LearnState>(() => ({ rootId: null, due: null, any: false }));

export function startLearning(rootId: string | null) {
  useLearn.setState({ rootId });
  useUI.getState().setOverlay('learn');
}

/** Fällige Karten neu zählen (nach dem Lernen, beim Start und ab und zu). */
export async function countDue(): Promise<void> {
  const cards = await loadCards(null).catch(() => []);
  useLearn.setState({ due: dueQueue(cards).length, any: cards.length > 0 });
}
