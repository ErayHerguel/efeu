import type { JSONContent } from '@tiptap/core';
import { db, type Statement } from '../../db/driver';
import { descendantIds } from '../../lib/tree';
import { usePages } from '../../store/pages';
import { extractCards, type Card } from './extract';
import { newReview, type Review } from './schedule';

export interface StudyCard extends Card {
  review: Review;
  isNew: boolean;
}

/** Neue Karten pro Lerneinheit (wie bei Anki), damit es nicht zu viel auf einmal wird. */
export const NEW_PER_SESSION = 20;

const titleOf = (id: string) => usePages.getState().pages[id]?.title ?? '';

/** Seiten eines Stapels: eine Seite samt Unterseiten oder (null) alle Seiten außerhalb des Papierkorbs. */
function deckPages(rootId: string | null): string[] {
  const { pages } = usePages.getState();
  const ids = rootId ? [rootId, ...descendantIds(pages, rootId)] : Object.keys(pages);
  return ids.filter((id) => pages[id] && pages[id].deletedAt === null && pages[id].type === 'page');
}

/** Alle Karten eines Stapels mit Lernstand. */
export async function loadCards(rootId: string | null): Promise<StudyCard[]> {
  const ids = deckPages(rootId);
  if (!ids.length) return [];
  const docs = await db().select<{ page_id: string; doc: string }>(
    'SELECT page_id, doc FROM page_content WHERE page_id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(ids)],
  );
  const reviews = new Map(
    (
      await db().select<{ card_id: string; due: number; interval: number; ease: number; reps: number; lapses: number }>(
        'SELECT card_id, due, interval, ease, reps, lapses FROM card_reviews WHERE page_id IN (SELECT value FROM json_each(?))',
        [JSON.stringify(ids)],
      )
    ).map((r) => [r.card_id, { due: Number(r.due), interval: Number(r.interval), ease: Number(r.ease), reps: Number(r.reps), lapses: Number(r.lapses) }]),
  );
  const now = Date.now();
  const cards: StudyCard[] = [];
  for (const row of docs) {
    let doc: JSONContent;
    try {
      doc = JSON.parse(row.doc) as JSONContent;
    } catch {
      continue;
    }
    for (const card of extractCards(row.page_id, doc, titleOf)) {
      const review = reviews.get(card.id);
      cards.push({ ...card, review: review ?? newReview(now), isNew: !review });
    }
  }
  return cards;
}

/** Was heute dran ist: fällige Karten (älteste zuerst), dann neue bis zur Tagesgrenze. */
export function dueQueue(cards: StudyCard[], now = Date.now()): StudyCard[] {
  const due = cards.filter((c) => !c.isNew && c.review.due <= now).sort((a, b) => a.review.due - b.review.due);
  const fresh = cards.filter((c) => c.isNew).slice(0, NEW_PER_SESSION);
  return [...due, ...fresh];
}

export function saveReview(card: Card, review: Review): Statement {
  return {
    sql: `INSERT INTO card_reviews (card_id, page_id, due, interval, ease, reps, lapses, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(card_id) DO UPDATE SET page_id = excluded.page_id, due = excluded.due, interval = excluded.interval,
          ease = excluded.ease, reps = excluded.reps, lapses = excluded.lapses, updated_at = excluded.updated_at`,
    params: [card.id, card.pageId, review.due, review.interval, review.ease, review.reps, review.lapses, Date.now()],
  };
}
