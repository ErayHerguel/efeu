import { describe, expect, it } from 'vitest';
import { clock, dueForNotes, liveNotesRequest, summaryRequest, transcriptText, transcriptToggle, type Segment } from './notes';

const seg = (text: string, startS: number, endS = startS + 5): Segment => ({ text, startMs: startS * 1000, endMs: endS * 1000 });

describe('Mitschrift', () => {
  it('formatiert Zeiten', () => {
    expect(clock(65_000)).toBe('1:05');
    expect(clock(3_725_000)).toBe('1:02:05');
  });

  it('setzt Zeitmarken etwa jede Minute', () => {
    const text = transcriptText([seg('Hallo.', 0), seg('Heute Entropie.', 10), seg('Neuer Punkt.', 70)]);
    expect(text).toBe('[0:00] Hallo. Heute Entropie.\n\n[1:10] Neuer Punkt.');
  });

  it('notiert nach etwa drei Minuten oder bei sehr viel Text', () => {
    const long = 'x'.repeat(120);
    const threeMin = [seg(long, 0), seg(long, 60), seg(long, 120), seg(long, 175, 181)];
    expect(dueForNotes(threeMin.slice(0, 2))).toBe(false);
    expect(dueForNotes(threeMin)).toBe(true);
    expect(dueForNotes([seg('y'.repeat(7_000), 0, 30)])).toBe(true);
    expect(dueForNotes([seg('kurz, aber genug für den Schluss', 0)], true)).toBe(false);
    expect(dueForNotes([seg('ein letzter Satz, der lang genug ist, um notiert zu werden', 0)], true)).toBe(true);
  });

  it('Live-Notizen sind günstig und kennen die bisherigen Notizen', () => {
    const req = liveNotesRequest([seg('Die Entropie misst Unordnung.', 0)], '### Einführung\n- Thermodynamik');
    expect(req.effort).toBe('low');
    expect(String(req.messages[0].content)).toContain('Thermodynamik');
    expect(String(req.messages[0].content)).toContain('Entropie misst');
  });

  it('Zusammenfassung mit Folien hängt das PDF an', () => {
    const req = summaryRequest('- Punkt', [seg('Text', 0)], { name: 'Folien', data: 'AAAA' });
    const content = req.messages[0].content as { type: string }[];
    expect(content[0].type).toBe('document');
  });

  it('Mitschrift als eingeklappter Toggle', () => {
    const toggle = transcriptToggle([seg('Eins.', 0), seg('Zwei.', 90)]);
    expect(toggle).toMatchObject({ type: 'toggle', attrs: { open: false } });
    expect(toggle.content).toHaveLength(3);
  });
});
