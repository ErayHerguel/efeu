/**
 * Alle Emojis mit deutschen Namen und Suchbegriffen (emojibase-data, MIT). Die Daten sind groß und
 * werden deshalb erst beim ersten Öffnen der Auswahl geladen.
 */

export interface Emoji {
  unicode: string;
  label: string;
  tags: string[];
  group: number;
  /** Varianten nach Hautfarbe (hell → dunkel), falls vorhanden */
  skins?: string[];
}

export interface EmojiGroup {
  id: number;
  name: string;
  emojis: Emoji[];
}

/** Emoji 16+: noch nicht auf allen Systemen darstellbar (würden als Kästchen erscheinen). */
const TOO_NEW = new Set(['1FAE9', '1FAEA', '1FAEF', '1FAC8', '1F9D1-200D-1FA70', '1FAC6', '1FACD', '1FABE', '1FADC', '1F6D8', '1FA8A', '1FA89', '1FA8E', '1FA8F', '1FADF', '1F1E8-1F1F6']);
/** Gruppe „Komponenten“ (Hautfarben-Bausteine, Haarteile) ergibt allein keinen Sinn. */
const COMPONENT_GROUP = 2;

interface Raw {
  hexcode: string;
  label: string;
  unicode: string;
  group?: number;
  order?: number;
  tags?: string[];
  skins?: { unicode: string }[];
}

let cache: Promise<EmojiGroup[]> | null = null;

export function loadEmojis(): Promise<EmojiGroup[]> {
  cache ??= Promise.all([import('emojibase-data/de/compact.json'), import('emojibase-data/de/messages.json')]).then(([data, messages]) => {
    const raw = (data.default ?? data) as unknown as Raw[];
    const names = new Map(((messages.default ?? messages) as { groups: { order: number; message: string }[] }).groups.map((g) => [g.order, g.message]));
    const groups = new Map<number, Emoji[]>();
    for (const e of [...raw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      if (e.group === undefined || e.group === COMPONENT_GROUP || TOO_NEW.has(e.hexcode)) continue;
      const list = groups.get(e.group) ?? [];
      list.push({ unicode: e.unicode, label: e.label, tags: e.tags ?? [], group: e.group, skins: e.skins?.slice(0, 5).map((s) => s.unicode) });
      groups.set(e.group, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a - b).map(([id, emojis]) => ({ id, name: names.get(id) ?? '', emojis }));
  });
  return cache;
}

/** Suche über Namen und Suchbegriffe; Treffer am Wortanfang zuerst. */
export function searchEmojis(groups: EmojiGroup[], query: string, limit = 120): Emoji[] {
  const q = query.trim().toLocaleLowerCase('de');
  if (!q) return [];
  const scored: { e: Emoji; score: number }[] = [];
  for (const g of groups) {
    for (const e of g.emojis) {
      const words = [e.label.toLocaleLowerCase('de'), ...e.tags];
      let score = 0;
      for (const w of words) {
        if (w === q) score = Math.max(score, 3);
        else if (w.startsWith(q) || w.includes(` ${q}`)) score = Math.max(score, 2);
        else if (w.includes(q)) score = Math.max(score, 1);
      }
      if (score) scored.push({ e, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.e);
}

/** Variante in der gewählten Hautfarbe (0 = gelb/neutral, 1–5 hell → dunkel) */
export function withSkin(e: Emoji, tone: number): string {
  return tone > 0 && e.skins?.[tone - 1] ? e.skins[tone - 1] : e.unicode;
}

const RECENT_KEY = 'flou.emoji.recent';
const TONE_KEY = 'flou.emoji.tone';

export function recentEmojis(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, 24) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...recentEmojis().filter((e) => e !== emoji)].slice(0, 24)));
  } catch {
    // Ohne Speicher gibt es eben keine Liste der zuletzt benutzten.
  }
}

export function skinTone(): number {
  try {
    const n = Number(localStorage.getItem(TONE_KEY));
    return n >= 0 && n <= 5 ? n : 0;
  } catch {
    return 0;
  }
}

export function setSkinTone(tone: number): void {
  try {
    localStorage.setItem(TONE_KEY, String(tone));
  } catch {
    // egal
  }
}
