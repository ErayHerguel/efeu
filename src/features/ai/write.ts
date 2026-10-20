import type { AiRequest } from './client';
import type { Feature } from './usage';

/** Was die Schreibhilfe mit einem Text tun kann */
export type WriteAction =
  | 'improve'
  | 'shorten'
  | 'expand'
  | 'simplify'
  | 'casual'
  | 'formal'
  | 'english'
  | 'german'
  | 'custom'
  | 'explain'
  | 'summarize'
  | 'tasks'
  | 'continue';

export const REWRITE_ACTIONS: { id: WriteAction; label: string }[] = [
  { id: 'improve', label: 'Verbessern' },
  { id: 'shorten', label: 'Kürzen' },
  { id: 'expand', label: 'Ausführlicher' },
  { id: 'simplify', label: 'Einfacher' },
  { id: 'casual', label: 'Lockerer' },
  { id: 'formal', label: 'Förmlicher' },
  { id: 'english', label: 'Ins Englische' },
  { id: 'german', label: 'Ins Deutsche' },
];

const LABELS: Record<WriteAction, string> = {
  ...Object.fromEntries(REWRITE_ACTIONS.map((a) => [a.id, a.label])),
  custom: 'Eigene Anweisung',
  explain: 'Erklären',
  summarize: 'Seite zusammenfassen',
  tasks: 'Aufgaben herausziehen',
  continue: 'Weiterschreiben',
} as Record<WriteAction, string>;

export const actionLabel = (action: WriteAction) => LABELS[action];

const INSTRUCTIONS: Partial<Record<WriteAction, string>> = {
  improve: 'Verbessere Rechtschreibung, Grammatik und Lesefluss. Inhalt, Länge und Ton bleiben gleich.',
  shorten: 'Kürze den Text deutlich, etwa auf die Hälfte, ohne wichtige Informationen zu verlieren.',
  expand: 'Formuliere den Text ausführlicher und konkreter. Erfinde keine Fakten, Zahlen oder Namen.',
  simplify: 'Formuliere den Text einfacher und klarer: kurze Sätze, gängige Wörter, gleicher Inhalt.',
  casual: 'Formuliere den Text lockerer und persönlicher, gleicher Inhalt.',
  formal: 'Formuliere den Text förmlicher und professioneller, gleicher Inhalt.',
  english: 'Übersetze den Text ins Englische. Natürlich klingend, nicht wörtlich.',
  german: 'Übersetze den Text ins Deutsche. Natürlich klingend, nicht wörtlich.',
};

const SYSTEM_REWRITE = `Du bist die Schreibhilfe in der Notiz-App efeu.
Du bekommst einen Text aus einer Notiz und eine Anweisung. Antworte ausschließlich mit dem überarbeiteten Text in Markdown: keine Einleitung, keine Erklärung, keine Anführungszeichen um das Ergebnis.
Behalte die Sprache des Textes bei, außer die Anweisung verlangt eine Übersetzung.
Behalte die Struktur bei (Überschriften, Listen, Aufgaben "- [ ]", Fett, Links). Seitenlinks in der Form [[Titel]] bleiben unverändert erhalten.`;

const SYSTEM_PAGE = `Du bist die Schreibhilfe in der Notiz-App efeu. Du arbeitest mit dem Inhalt einer Notizseite (Markdown, Seitenlinks als [[Titel]]).
Antworte ausschließlich mit dem gewünschten Ergebnis in Markdown, ohne Einleitung oder Schlusssatz. Schreib in der Sprache der Seite.`;

/** Grobe Token-Schätzung für die Ausgabe-Spanne (die Eingabe wird exakt gezählt). */
const approxTokens = (text: string) => Math.ceil(text.length / 3.5);

const FEATURE: Record<WriteAction, Feature> = {
  improve: 'rewrite',
  shorten: 'rewrite',
  expand: 'rewrite',
  simplify: 'rewrite',
  casual: 'rewrite',
  formal: 'rewrite',
  english: 'rewrite',
  german: 'rewrite',
  custom: 'rewrite',
  explain: 'explain',
  summarize: 'summarize',
  tasks: 'tasks',
  continue: 'continue',
};

/** Erklärt markierten Text, ohne ihn zu ersetzen (Fachbegriffe, Zusammenhänge, Beispiele). */
export function explainRequest(text: string): AiRequest {
  const t = approxTokens(text);
  return {
    feature: 'explain',
    title: 'Erklären',
    system:
      'Du erklärst Textstellen aus Notizen verständlich: Was bedeutet das, welche Begriffe sind wichtig, ein kurzes Beispiel. Knapp, in Markdown, ohne Einleitung, in der Sprache des Textes.',
    messages: [{ role: 'user', content: `<text>\n${text}\n</text>` }],
    maxTokens: 4_000,
    effort: 'low',
    output: [200, 900 + t],
    mock: () => '**Kurz erklärt:** Simulierte Erklärung der markierten Stelle.',
  };
}

export function rewriteRequest(action: WriteAction, text: string, instruction = ''): AiRequest {
  const task = action === 'custom' ? instruction.trim() : INSTRUCTIONS[action];
  const t = approxTokens(text);
  const factor: [number, number] = action === 'shorten' ? [0.3, 0.7] : action === 'expand' ? [1.3, 2.5] : [0.8, 1.4];
  return {
    feature: FEATURE[action],
    title: action === 'custom' ? `Anweisung: ${truncate(instruction, 40)}` : `Text: ${actionLabel(action)}`,
    system: SYSTEM_REWRITE,
    messages: [{ role: 'user', content: `<anweisung>${task}</anweisung>\n\n<text>\n${text}\n</text>` }],
    maxTokens: Math.min(32_000, Math.max(2_000, t * 4 + 2_000)),
    effort: 'low',
    output: [Math.round(t * factor[0]) + 100, Math.round(t * factor[1]) + 800],
    mock: () => mockRewrite(action, text),
  };
}

export function pageRequest(action: 'summarize' | 'tasks' | 'continue', markdown: string, title: string): AiRequest {
  const page = `<seite titel="${title.replace(/"/g, "'")}">\n${markdown}\n</seite>`;
  const t = approxTokens(markdown);
  if (action === 'summarize') {
    return {
      feature: 'summarize',
      title: 'Seite zusammenfassen',
      system: SYSTEM_PAGE,
      messages: [
        {
          role: 'user',
          content: `${page}\n\nFasse die Seite in 3 bis 6 knappen Stichpunkten zusammen (Markdown-Liste). Nur das Wichtigste, nichts erfinden.`,
        },
      ],
      maxTokens: 4_000,
      effort: 'low',
      output: [200, Math.min(1_500, 300 + t / 4)],
      mock: () => '- Erster wichtiger Punkt der Seite\n- Zweiter Punkt mit **Hervorhebung**\n- Dritter Punkt',
    };
  }
  if (action === 'tasks') {
    return {
      feature: 'tasks',
      title: 'Aufgaben herausziehen',
      system: SYSTEM_PAGE,
      messages: [
        {
          role: 'user',
          content: `${page}\n\nZiehe alle konkreten Aufgaben und nächsten Schritte aus der Seite heraus, als Markdown-Aufgabenliste ("- [ ] …"), kurz und mit Verb formuliert. Bereits erledigte Aufgaben weglassen. Gibt es keine, antworte genau mit: KEINE`,
        },
      ],
      maxTokens: 4_000,
      effort: 'low',
      output: [150, Math.min(1_500, 300 + t / 5)],
      mock: () => '- [ ] Ersten Entwurf fertigstellen\n- [ ] Termin mit dem Team abstimmen\n- [ ] Feedback einarbeiten',
    };
  }
  return {
    feature: 'continue',
    title: 'Weiterschreiben',
    system: SYSTEM_PAGE,
    messages: [
      {
        role: 'user',
        content: `${page}\n\nDie Stelle <weiter/> markiert den Cursor. Schreib dort sinnvoll weiter: 1 bis 3 Absätze im Stil und in der Sprache der Seite. Gib nur den neuen Text aus.`,
      },
    ],
    maxTokens: 4_000,
    effort: 'low',
    output: [200, 900],
    mock: () => 'Hier geht der Text simuliert weiter, im gleichen Stil wie die Seite davor.',
  };
}

function truncate(text: string, n: number): string {
  const t = text.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function mockRewrite(action: WriteAction, text: string): string {
  if (action === 'shorten') return text.split(/\s+/).slice(0, Math.max(3, Math.ceil(text.split(/\s+/).length / 2))).join(' ');
  if (action === 'english') return `(EN) ${text}`;
  return `${text} (überarbeitet: ${actionLabel(action)})`;
}
