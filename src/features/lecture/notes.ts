import type { JSONContent } from '@tiptap/core';
import type { AiRequest, Content } from '../ai/client';

/** Ein erkannter Satz mit Zeit seit Beginn der Mitschrift (ohne Pausen) */
export interface Segment {
  text: string;
  startMs: number;
  endMs: number;
}

/** Live-Notizen alle ~3 Minuten; kürzer nur, wenn sehr viel gesagt wurde. */
export const LIVE_INTERVAL_MS = 3 * 60_000;
export const LIVE_MIN_CHARS = 400;
export const LIVE_MAX_CHARS = 6_000;

export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** Text der Segmente als Fließtext mit gelegentlichen Zeitmarken (für Claude und die Mitschrift). */
export function transcriptText(segments: Segment[], markEveryMs = 60_000): string {
  let out = '';
  let nextMark = -1;
  for (const s of segments) {
    if (s.startMs >= nextMark) {
      out += `${out ? '\n\n' : ''}[${clock(s.startMs)}] `;
      nextMark = s.startMs + markEveryMs;
    } else out += ' ';
    out += s.text;
  }
  return out;
}

/** Soll jetzt ein Live-Abschnitt notiert werden? */
export function dueForNotes(pending: Segment[], force = false): boolean {
  if (!pending.length) return false;
  const chars = pending.reduce((n, s) => n + s.text.length, 0);
  const span = pending[pending.length - 1].endMs - pending[0].startMs;
  if (force) return chars > 40;
  return (span >= LIVE_INTERVAL_MS && chars >= LIVE_MIN_CHARS) || chars >= LIVE_MAX_CHARS;
}

const LIVE_SYSTEM = `Du schreibst live Notizen zu einer Vorlesung, Abschnitt für Abschnitt, für eine Notiz-App.
Du bekommst den neuen Abschnitt der automatischen Mitschrift (Spracherkennung, kann Fehler enthalten) und die bisherigen Notizen.
Schreibe nur die Notizen für den neuen Abschnitt, in Markdown:
- Beginnt ein neues Thema, starte mit einer kurzen Zwischenüberschrift "### …". Sonst keine Überschrift.
- Dann 2 bis 6 knappe Stichpunkte: Kernaussagen, Definitionen, Formeln, Beispiele. Wichtige Begriffe **fett**.
- Sagt der Dozent, etwas sei prüfungs-/klausurrelevant oder wichtig: Stichpunkt mit "⚠️ " beginnen. Termine, Abgaben, Aufgaben: als "- [ ] …".
- Korrigiere offensichtliche Erkennungsfehler bei Fachbegriffen. Wiederhole nichts, was schon in den bisherigen Notizen steht.
- Ist der Abschnitt inhaltsleer (Smalltalk, Technikprobleme, Pause), antworte genau: LEER
- Sprache: wie die Vorlesung.`;

export function liveNotesRequest(chunk: Segment[], previousNotes: string): AiRequest {
  const text = transcriptText(chunk);
  return {
    feature: 'lecture',
    title: 'Live-Notizen',
    system: LIVE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `<bisherige_notizen>\n${previousNotes.slice(-2_500) || '(noch keine)'}\n</bisherige_notizen>\n\n<neuer_abschnitt>\n${text}\n</neuer_abschnitt>`,
      },
    ],
    maxTokens: 2_000,
    effort: 'low',
    output: [150, 600],
    mock: () => `### Simulierter Abschnitt\n- **Kernaussage** aus der Mitschrift\n- ${chunk[0]?.text.slice(0, 60) ?? ''}`,
  };
}

const SUMMARY_SYSTEM = `Du fasst eine Vorlesung für Studierende zusammen, für eine Notiz-App.
Du bekommst die Live-Notizen, die vollständige automatische Mitschrift (Spracherkennung, kann Fehler enthalten) und eventuell die Folien als PDF.
Schreibe in Markdown genau diese Abschnitte (leere weglassen):
## Zusammenfassung
5 bis 10 Stichpunkte: worum ging es, was sind die Kernaussagen.
## Wichtige Begriffe
"- **Begriff**: kurze Erklärung"
## Klausurrelevant
Alles, was der Dozent als prüfungsrelevant oder besonders wichtig betont hat.
## Aufgaben und Termine
Als "- [ ] …" mit Datum, falls genannt.
## Offene Fragen
Was unklar blieb oder nachgearbeitet werden sollte.
Mit Folien: ordne Inhalte den Folien zu ("Folie 12: …") und ergänze, was nur mündlich gesagt wurde. Nimm Fakten nur aus Mitschrift, Notizen und Folien. Sprache: wie die Vorlesung.`;

export function summaryRequest(notes: string, segments: Segment[], slides: { name: string; data: string } | null): AiRequest {
  const text = transcriptText(segments, 120_000);
  const body = `<live_notizen>\n${notes || '(keine)'}\n</live_notizen>\n\n<mitschrift>\n${text}\n</mitschrift>`;
  const content: Content = slides
    ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: slides.data }, title: slides.name }, { type: 'text', text: body }]
    : body;
  const t = Math.ceil(text.length / 3.5);
  return {
    feature: 'lecture',
    title: 'Vorlesung zusammenfassen',
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content }],
    maxTokens: 16_000,
    effort: 'medium',
    output: [800 + Math.round(t * 0.03), 2_500 + Math.round(t * 0.12)],
    mock: () => '## Zusammenfassung\n- Simulierte Zusammenfassung der Vorlesung\n## Wichtige Begriffe\n- **Begriff**: Erklärung\n## Aufgaben und Termine\n- [ ] Übungsblatt bearbeiten',
  };
}

/** Rohe Mitschrift zum Aufklappen: Absätze mit Zeitmarken */
export function transcriptToggle(segments: Segment[]): JSONContent {
  const paragraphs = transcriptText(segments)
    .split('\n\n')
    .map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] }));
  return {
    type: 'toggle',
    attrs: { open: false },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mitschrift (automatisch erkannt)' }] }, ...paragraphs],
  };
}
