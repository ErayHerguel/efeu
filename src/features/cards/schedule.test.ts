import { describe, expect, it } from 'vitest';
import { newReview, nextLabel, schedule } from './schedule';

const DAY = 24 * 60 * 60 * 1000;

describe('Wiederholungsplan', () => {
  it('vergrößert die Abstände bei „Gut“ und holt „Nochmal“ bald zurück', () => {
    let r = newReview(0);
    r = schedule(r, 3, 0);
    expect(r.due).toBe(1 * DAY);
    r = schedule(r, 3, r.due);
    expect(r.interval).toBe(4);
    r = schedule(r, 3, r.due);
    expect(r.interval).toBe(10);
    const again = schedule(r, 1, r.due);
    expect(again.due - r.due).toBe(10 * 60 * 1000);
    expect(again.reps).toBe(0);
    expect(again.lapses).toBe(1);
    expect(again.ease).toBeCloseTo(2.3);
  });

  it('„Einfach“ springt weiter als „Gut“, „Schwer“ weniger weit', () => {
    const r = schedule(schedule(newReview(0), 3, 0), 3, DAY);
    const hard = schedule(r, 2, 0).interval;
    const good = schedule(r, 3, 0).interval;
    const easy = schedule(r, 4, 0).interval;
    expect(hard).toBeLessThan(good);
    expect(good).toBeLessThan(easy);
    expect(nextLabel(newReview(0), 1, 0)).toBe('10 Min.');
    expect(nextLabel(newReview(0), 4, 0)).toBe('4 T.');
  });
});
