import type { JSONContent } from '@tiptap/core';
import { loadDoc } from '../../db/content';
import { getActiveEditor } from '../../editor/active';
import { usePages } from '../../store/pages';
import { reportError, toast } from '../../store/toast';
import { useUI } from '../../store/ui';
import { extractCards, SEPARATOR } from '../cards/extract';
import { appendBlocks } from '../lecture/pageWriter';
import { AiCancelled, askAi, costNote } from './client';
import { toAiMarkdown } from './markdown';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['front', 'back'],
        properties: { front: { type: 'string' }, back: { type: 'string' } },
      },
    },
  },
};

export const CARDS_HEADING = 'Karteikarten';

const oneLine = (text: string) => text.replace(/\s+/g, ' ').replace(/::/g, ':').trim();

/** Absätze „Frage :: Antwort“ für neue Karten, ohne solche, deren Frage es auf der Seite schon gibt. */
export function cardBlocks(doc: JSONContent, pageId: string, cards: { front: string; back: string }[]): JSONContent[] {
  const known = new Set(extractCards(pageId, doc).map((c) => c.front.toLowerCase()));
  const blocks: JSONContent[] = [];
  for (const card of cards) {
    const front = oneLine(card.front);
    const back = oneLine(card.back);
    if (!front || !back || known.has(front.toLowerCase())) continue;
    known.add(front.toLowerCase());
    blocks.push({ type: 'paragraph', content: [{ type: 'text', text: `${front}${SEPARATOR}${back}` }] });
  }
  const hasHeading = (doc.content ?? []).some(
    (n) => n.type === 'heading' && (n.content ?? []).map((t) => t.text ?? '').join('').trim() === CARDS_HEADING,
  );
  if (!blocks.length || hasHeading) return blocks;
  return [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: CARDS_HEADING }] }, ...blocks];
}

/** Lässt die KI aus einer Seite Karteikarten erstellen und hängt sie als „Frage :: Antwort“ unten an. */
export async function generateCards(pageId: string): Promise<void> {
  try {
    const editor = useUI.getState().currentId === pageId ? getActiveEditor() : null;
    const doc = (editor ? editor.getJSON() : await loadDoc(pageId)) ?? { type: 'doc', content: [] };
    const text = toAiMarkdown(doc).slice(0, 60_000);
    if (!text.trim()) return toast('Die Seite ist noch leer');
    const existing = extractCards(pageId, doc).map((c) => `- ${c.front}`);
    const result = await askAi({
      feature: 'cards',
      title: 'Karteikarten erstellen',
      system: [
        'Du erstellst aus Notizen Karteikarten zum Lernen. Jede Karte prüft genau eine Sache: einen Begriff, eine Definition, einen Zusammenhang, eine Zahl oder einen Ablauf.',
        'Vorderseite: eine klare, eigenständig verständliche Frage. Rückseite: kurze Antwort, höchstens zwei Sätze, ohne Zeilenumbrüche.',
        'Nur was wirklich in den Notizen steht, nichts erfinden. Wichtiges zuerst, keine Kleinigkeiten. Meist 5 bis 25 Karten, je nach Umfang.',
        'Sprache wie der Inhalt. Stelle keine Fragen, die es schon gibt.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: `<inhalt>\n${text}\n</inhalt>${existing.length ? `\n<vorhandene_karten>\n${existing.join('\n')}\n</vorhandene_karten>` : ''}`,
        },
      ],
      maxTokens: 8_000,
      effort: 'medium',
      output: [800, 4_000],
      schema: SCHEMA,
      mock: () =>
        JSON.stringify({
          cards: [
            { front: 'Was ist eine simulierte Karte?', back: 'Eine Karte, die ohne echte KI entsteht.' },
            { front: 'Wozu dient die Simulation?', back: 'Zum Ausprobieren ohne Kosten.' },
          ],
        }),
    });
    if (!result) return;
    const { cards } = JSON.parse(result.text) as { cards: { front: string; back: string }[] };
    // Seite kann sich während der Anfrage geändert haben: Doppelte gegen den aktuellen Stand prüfen.
    const nowEditor = useUI.getState().currentId === pageId ? getActiveEditor() : null;
    const current = (nowEditor ? nowEditor.getJSON() : await loadDoc(pageId)) ?? doc;
    const blocks = cardBlocks(current, pageId, cards);
    const count = blocks.filter((b) => b.type === 'paragraph').length;
    if (!count) return toast(`Keine neuen Karteikarten gefunden · ${costNote(result)}`);
    await appendBlocks(pageId, blocks);
    const title = usePages.getState().pages[pageId]?.title;
    toast(`${count} ${count === 1 ? 'Karteikarte' : 'Karteikarten'}${title ? ` in „${title}“` : ''} angelegt · ${costNote(result)}`);
  } catch (err) {
    if (!(err instanceof AiCancelled)) reportError('Karteikarten erstellen', err);
  }
}
