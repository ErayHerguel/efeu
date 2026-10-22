import { create } from 'zustand';

/** Jemand, den man mit @ erwähnen kann: der Inhaber der Cloud ('owner') oder ein Team-Mitglied. */
export interface TeamPerson {
  id: string;
  name: string;
  color: string;
}

/** Die Leute im Team (aus der Cloud bzw. im Browser vom Hub), für @-Erwähnungen. */
export const usePeople = create<{ people: TeamPerson[]; me: string | null }>(() => ({ people: [], me: null }));

export const personName = (id: string): string | undefined => usePeople.getState().people.find((p) => p.id === id)?.name;
