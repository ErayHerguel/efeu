import type { JSONContent } from '@tiptap/core';

/** Eine Karteikarte aus einer Seite: Vorderseite (Frage) und Rückseite (Antwort). */
export interface Card {
  id: string;
  pageId: string;
  front: string;
  back: string;
}

/** Trennzeichen in einer Zeile: „Frage :: Antwort“. */
export const SEPARATOR = ' :: ';

/** Kurzer, stabiler Hash (53 Bit) als Hex – Karten behalten so ihren Lernstand, solange die Frage gleich bleibt. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Sichtbarer Text eines Knotens (Erwähnungen und Seitenlinks als Name). */
function textOf(node: JSONContent, titleOf: (pageId: string) => string): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return `@${String(node.attrs?.label ?? '')}`;
  if (node.type === 'pageLink') return titleOf(String(node.attrs?.pageId ?? ''));
  const inner = (node.content ?? []).map((c) => textOf(c, titleOf));
  // Blöcke untereinander, Inline-Inhalt hintereinander
  const block = node.content?.some((c) => c.type !== 'text' && c.type !== 'hardBreak' && c.type !== 'mention' && c.type !== 'pageLink');
  return inner.join(block ? '\n' : '').trim();
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Karten einer Seite: Zeilen „Frage :: Antwort“ und Toggle-Blöcke (Überschrift = Frage, Inhalt = Antwort).
 * Gleiche Fragen in derselben Seite zählen als eine Karte.
 */
export function extractCards(pageId: string, doc: JSONContent, titleOf: (pageId: string) => string = () => ''): Card[] {
  const cards = new Map<string, Card>();
  const add = (front: string, back: string) => {
    front = front.trim();
    back = back.trim();
    if (!front || !back) return;
    const id = hash(`${pageId}\u0000${normalize(front)}`);
    if (!cards.has(id)) cards.set(id, { id, pageId, front, back });
  };
  const walk = (node: JSONContent) => {
    if (node.type === 'paragraph') {
      const text = textOf(node, titleOf);
      const at = text.indexOf(SEPARATOR.trim());
      if (at > 0) add(text.slice(0, at), text.slice(at + 2));
      return;
    }
    if (node.type === 'toggle') {
      const [summary, ...body] = node.content ?? [];
      if (summary) add(textOf(summary, titleOf), body.map((b) => textOf(b, titleOf)).join('\n'));
      for (const b of body) walk(b);
      return;
    }
    if (node.type === 'codeBlock') return;
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return [...cards.values()];
}
