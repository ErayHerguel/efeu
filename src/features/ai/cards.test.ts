import { describe, expect, it } from 'vitest';
import { cardBlocks, CARDS_HEADING } from './cards';

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('cardBlocks', () => {
  it('hängt Karten unter einer Überschrift an und lässt vorhandene Fragen weg', () => {
    const doc = { type: 'doc', content: [para('Was ist ATP? :: Energieträger der Zelle')] };
    const blocks = cardBlocks(doc, 'p1', [
      { front: 'was ist ATP?', back: 'doppelt' },
      { front: 'Wo entsteht ATP?', back: 'In den\nMitochondrien :: vor allem' },
      { front: 'Wo entsteht ATP?', back: 'doppelt in der Antwort' },
      { front: '  ', back: 'leer' },
    ]);
    expect(blocks).toEqual([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: CARDS_HEADING }] },
      para('Wo entsteht ATP? :: In den Mitochondrien : vor allem'),
    ]);
  });

  it('setzt keine zweite Überschrift und gibt nichts zurück, wenn nichts neu ist', () => {
    const doc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: CARDS_HEADING }] }] };
    expect(cardBlocks(doc, 'p1', [{ front: 'A?', back: 'B' }])).toEqual([para('A? :: B')]);
    expect(cardBlocks({ type: 'doc', content: [] }, 'p1', [])).toEqual([]);
  });
});
