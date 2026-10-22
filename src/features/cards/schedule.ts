/** Lernstand einer Karte (wie bei Anki: Abstand in Tagen, Leichtigkeit, Wiederholungen). */
export interface Review {
  due: number;
  interval: number;
  ease: number;
  reps: number;
  lapses: number;
}

/** 1 Nochmal · 2 Schwer · 3 Gut · 4 Einfach */
export type Grade = 1 | 2 | 3 | 4;

const DAY = 24 * 60 * 60 * 1000;
const MIN_EASE = 1.3;

export const newReview = (now: number): Review => ({ due: now, interval: 0, ease: 2.5, reps: 0, lapses: 0 });

/**
 * Nächster Termin nach dem SM-2-Verfahren (vereinfacht): Wer sich erinnert, sieht die Karte in immer
 * größeren Abständen wieder; „Nochmal“ holt sie in zehn Minuten zurück und senkt die Leichtigkeit.
 */
export function schedule(review: Review, grade: Grade, now: number): Review {
  if (grade === 1) {
    return { due: now + 10 * 60 * 1000, interval: 0, ease: Math.max(MIN_EASE, review.ease - 0.2), reps: 0, lapses: review.lapses + (review.reps > 0 ? 1 : 0) };
  }
  let interval: number;
  let ease = review.ease;
  if (review.reps === 0) interval = grade === 2 ? 1 : grade === 3 ? 1 : 4;
  else if (review.reps === 1) interval = grade === 2 ? 2 : grade === 3 ? 4 : 7;
  else interval = review.interval * (grade === 2 ? 1.2 : grade === 3 ? ease : ease * 1.3);
  if (grade === 2) ease = Math.max(MIN_EASE, ease - 0.15);
  if (grade === 4) ease += 0.15;
  interval = Math.min(Math.max(interval, review.interval + (grade === 2 ? 0 : 1), 1), 3650);
  return { due: now + Math.round(interval * DAY), interval, ease, reps: review.reps + 1, lapses: review.lapses };
}

/** Wann die Karte bei dieser Bewertung wiederkommt, kurz für die Knöpfe: „10 Min.“, „4 T.“, „2 Mon.“ */
export function nextLabel(review: Review, grade: Grade, now: number): string {
  const ms = schedule(review, grade, now).due - now;
  const days = ms / DAY;
  if (days < 1) return `${Math.max(1, Math.round(ms / 60_000))} Min.`;
  if (days < 30) return `${Math.round(days)} T.`;
  if (days < 365) return `${Math.round(days / 30)} Mon.`;
  return `${(days / 365).toFixed(1).replace('.', ',')} J.`;
}
