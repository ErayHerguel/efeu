import { describe, expect, it } from 'vitest';
import { extractCards } from './extract';

const p = (text: string) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });

describe('Karteikarten aus Notizen', () => {
  it('erkennt „Frage :: Antwort“ und Toggles, ignoriert Code', () => {
    const doc = {
      type: 'doc',
      content: [
        p('Hauptstadt von Frankreich :: Paris'),
        p('Kein Trenner hier'),
        p(':: ohne Frage'),
        { type: 'toggle', content: [p('Was ist Photosynthese?'), p('Licht → Zucker'), p('in Chloroplasten')] },
        { type: 'toggle', content: [p('Details zum Projekt'), p('nur eingeklappt, keine Karte')] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'a :: b' }] },
        p('hauptstadt von frankreich :: doppelt'),
      ],
    };
    const cards = extractCards('seite', doc);
    expect(cards.map((c) => [c.front, c.back])).toEqual([
      ['Hauptstadt von Frankreich', 'Paris'],
      ['Was ist Photosynthese?', 'Licht → Zucker\nin Chloroplasten'],
    ]);
  });

  it('vergibt stabile Kennungen je Seite und Frage', () => {
    const a = extractCards('x', { type: 'doc', content: [p('Frage :: Antwort')] })[0];
    const b = extractCards('x', { type: 'doc', content: [p('Frage :: andere Antwort')] })[0];
    const c = extractCards('y', { type: 'doc', content: [p('Frage :: Antwort')] })[0];
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });
});
