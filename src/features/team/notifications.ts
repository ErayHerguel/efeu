import { create } from 'zustand';

/** Mitteilung über eine Erwähnung. */
export interface MentionNotice {
  id: number;
  pageId: string;
  title: string;
  byName: string;
  createdAt: number;
  read: boolean;
}

interface Source {
  list(): Promise<MentionNotice[]>;
  read(ids: number[] | 'all'): Promise<unknown>;
}

interface NoticeState {
  items: MentionNotice[];
  source: Source | null;
}

export const useNotices = create<NoticeState>(() => ({ items: [], source: null }));

export const unreadCount = (items: MentionNotice[]) => items.filter((n) => !n.read).length;

/** Woher die Erwähnungen kommen: in der App über die Cloud, im Browser über die Live-Verbindung. */
export function setNoticeSource(source: Source | null) {
  useNotices.setState({ source, items: source ? useNotices.getState().items : [] });
}

/** Neu laden; liefert die neu hinzugekommenen, ungelesenen Mitteilungen (z. B. für eine Systemmitteilung). */
export async function refreshNotices(): Promise<MentionNotice[]> {
  const { source, items } = useNotices.getState();
  if (!source) return [];
  const next = await source.list();
  const known = new Set(items.map((n) => n.id));
  useNotices.setState({ items: next });
  return next.filter((n) => !n.read && !known.has(n.id));
}

export async function markNoticesRead(ids: number[] | 'all') {
  const { source, items } = useNotices.getState();
  if (!source) return;
  useNotices.setState({ items: items.map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read: true } : n)) });
  await source.read(ids).catch(() => undefined);
}
