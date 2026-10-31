import { loadDoc } from '../../db/content';
import { descendantIds } from '../../lib/tree';
import { usePages } from '../../store/pages';
import { askAi, type AiResult } from '../ai/client';
import { cardBlocks } from '../ai/cards';
import { toAiMarkdown } from '../ai/markdown';
import { appendBlocks } from '../lecture/pageWriter';

/**
 * Klausurmodus: Claude stellt aus einer Seite samt Unterseiten eine Probeklausur zusammen
 * (Auswahl- und Freitextfragen), bewertet die Antworten und erklärt Fehler.
 */

export type QuestionKind = 'choice' | 'open';
export type ExamMix = 'mixed' | 'choice' | 'open';
export type ExamLevel = 'normal' | 'hard';

export interface Question {
  kind: QuestionKind;
  question: string;
  /** Auswahlfragen: genau vier Möglichkeiten */
  options: string[];
  /** Index der richtigen Möglichkeit (Freitext: -1) */
  answer: number;
  /** Musterlösung bzw. Erklärung, warum die Antwort stimmt */
  solution: string;
  /** Seite, aus der die Frage stammt */
  pageId: string;
}

export interface Graded {
  /** 0 = falsch, 1 = teilweise, 2 = richtig */
  points: 0 | 1 | 2;
  feedback: string;
}

const MAX_CHARS = 120_000;

/** Inhalt der Seite und ihrer Unterseiten, mit Seitenkennung, damit Fragen auf ihre Quelle zeigen. */
export async function examSource(rootId: string): Promise<{ text: string; pages: number }> {
  const { pages } = usePages.getState();
  const ids = [rootId, ...descendantIds(pages, rootId)].filter((id) => pages[id] && pages[id].deletedAt === null && pages[id].type === 'page');
  const parts: string[] = [];
  let length = 0;
  for (const id of ids) {
    const doc = await loadDoc(id);
    const text = doc ? toAiMarkdown(doc).trim() : '';
    if (!text) continue;
    const part = `<seite id="${id}" titel="${(pages[id].title || 'Ohne Titel').replace(/"/g, "'")}">\n${text}\n</seite>`;
    if (length + part.length > MAX_CHARS) break;
    parts.push(part);
    length += part.length;
  }
  return { text: parts.join('\n\n'), pages: parts.length };
}

const QUESTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'question', 'options', 'answer', 'solution', 'pageId'],
        properties: {
          kind: { type: 'string', enum: ['choice', 'open'] },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answer: { type: 'integer' },
          solution: { type: 'string' },
          pageId: { type: 'string' },
        },
      },
    },
  },
};

/** Nur brauchbare Fragen übernehmen (Auswahl: vier Möglichkeiten, gültige Lösung). */
export function cleanQuestions(raw: Question[], validPages: Set<string>, fallbackPage: string): Question[] {
  return raw
    .filter((q) => q.question?.trim() && q.solution?.trim())
    .map((q): Question | null => {
      const pageId = validPages.has(q.pageId) ? q.pageId : fallbackPage;
      if (q.kind === 'choice') {
        const options = (q.options ?? []).map((o) => o.trim()).filter(Boolean);
        if (options.length < 2 || q.answer < 0 || q.answer >= options.length) return null;
        return { ...q, options, pageId };
      }
      return { ...q, kind: 'open', options: [], answer: -1, pageId };
    })
    .filter((q): q is Question => q !== null);
}

export async function generateExam(rootId: string, count: number, mix: ExamMix, level: ExamLevel): Promise<{ questions: Question[]; result: AiResult } | null> {
  const source = await examSource(rootId);
  if (!source.text) throw new Error('Auf dieser Seite und ihren Unterseiten steht noch nichts, woraus sich Fragen machen ließen.');
  const mixText = {
    mixed: 'Etwa zwei Drittel Auswahlfragen mit genau vier Möglichkeiten, ein Drittel Freitextfragen.',
    choice: 'Nur Auswahlfragen mit genau vier Möglichkeiten.',
    open: 'Nur Freitextfragen.',
  }[mix];
  const result = await askAi({
    feature: 'exam',
    title: `Probeklausur mit ${count} Fragen`,
    system: [
      'Du bist Prüfer an einer Hochschule und stellst aus Lernnotizen eine Probeklausur zusammen.',
      `Erstelle genau ${count} Fragen. ${mixText}`,
      level === 'hard'
        ? 'Schwierigkeit: anspruchsvoll. Prüfe Verständnis, Zusammenhänge, Anwendung und Transfer, nicht nur Begriffe.'
        : 'Schwierigkeit: wie in einer normalen Klausur. Mische Wissen, Verständnis und Anwendung.',
      'Decke die wichtigsten Themen breit ab, keine zwei Fragen zum selben Detail. Nur was in den Notizen steht oder direkt daraus folgt.',
      'Auswahlfragen: Falsche Möglichkeiten müssen plausibel klingen (typische Denkfehler), gleich lang und ohne Hinweise. Die richtige Möglichkeit an zufälliger Stelle. answer ist ihr Index (0–3).',
      'Freitextfragen: options ist leer, answer ist -1. solution enthält eine knappe Musterlösung mit den Punkten, die eine volle Antwort braucht.',
      'Bei Auswahlfragen erklärt solution in ein bis zwei Sätzen, warum die richtige Antwort stimmt.',
      'pageId ist die id der Seite, aus der die Frage stammt. Sprache wie die Notizen. Formeln in LaTeX zwischen $…$.',
    ].join('\n'),
    messages: [{ role: 'user', content: `<notizen>\n${source.text}\n</notizen>` }],
    maxTokens: 16_000,
    effort: 'medium',
    output: [count * 150, count * 400],
    schema: QUESTIONS_SCHEMA,
    mock: () =>
      JSON.stringify({
        questions: [
          { kind: 'choice', question: 'Was erzeugen Mitochondrien?', options: ['ATP', 'DNA', 'Glukose', 'Proteine'], answer: 0, solution: 'Mitochondrien erzeugen ATP durch Zellatmung.', pageId: rootId },
          { kind: 'open', question: 'Erkläre kurz, wozu Ribosomen da sind.', options: [], answer: -1, solution: 'Ribosomen bauen Proteine aus Aminosäuren (Translation).', pageId: rootId },
        ],
      }),
  });
  if (!result) return null;
  const { pages } = usePages.getState();
  const valid = new Set([rootId, ...descendantIds(pages, rootId)]);
  const questions = cleanQuestions((JSON.parse(result.text) as { questions: Question[] }).questions, valid, rootId);
  if (!questions.length) throw new Error('Claude hat keine brauchbaren Fragen geliefert. Versuch es noch einmal.');
  return { questions, result };
}

const GRADE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'points', 'feedback'],
        properties: { index: { type: 'integer' }, points: { type: 'integer', enum: [0, 1, 2] }, feedback: { type: 'string' } },
      },
    },
  },
};

/** Bewertet Freitextantworten gegen die Musterlösung (Auswahlfragen bewertet efeu selbst). */
export async function gradeOpen(questions: Question[], answers: string[]): Promise<{ graded: Map<number, Graded>; result: AiResult | null }> {
  const graded = new Map<number, Graded>();
  const open = questions.map((q, index) => ({ q, index })).filter(({ q }) => q.kind === 'open');
  const todo = open.filter(({ index }) => answers[index]?.trim());
  for (const { index } of open) if (!answers[index]?.trim()) graded.set(index, { points: 0, feedback: 'Keine Antwort.' });
  if (!todo.length) return { graded, result: null };
  const result = await askAi({
    feature: 'exam',
    title: `${todo.length} Freitextantworten bewerten`,
    system: [
      'Du korrigierst Klausurantworten fair wie ein Prüfer. Vergleiche jede Antwort mit der Musterlösung.',
      'points: 2 = inhaltlich richtig und vollständig (andere Worte sind in Ordnung), 1 = teilweise richtig oder wichtige Punkte fehlen, 0 = falsch oder am Thema vorbei.',
      'feedback: ein bis zwei Sätze direkt an die Person (du): was gut war und was fehlte oder falsch war. Sprache wie die Frage.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: todo
          .map(({ q, index }) => `<aufgabe index="${index}">\n<frage>${q.question}</frage>\n<musterloesung>${q.solution}</musterloesung>\n<antwort>${answers[index]}</antwort>\n</aufgabe>`)
          .join('\n'),
      },
    ],
    maxTokens: 6_000,
    effort: 'low',
    output: [todo.length * 60, todo.length * 200],
    schema: GRADE_SCHEMA,
    mock: () => JSON.stringify({ results: todo.map(({ index }) => ({ index, points: 1, feedback: 'Teilweise richtig (simuliert).' })) }),
  });
  if (!result) return { graded, result: null };
  for (const r of (JSON.parse(result.text) as { results: { index: number; points: number; feedback: string }[] }).results) {
    if (todo.some((t) => t.index === r.index)) graded.set(r.index, { points: Math.max(0, Math.min(2, r.points)) as 0 | 1 | 2, feedback: r.feedback });
  }
  return { graded, result };
}

/** Auswahlfrage: richtig = 2 Punkte, sonst 0. */
export function gradeChoice(q: Question, picked: number | null): Graded {
  const right = picked === q.answer;
  return { points: right ? 2 : 0, feedback: right ? 'Richtig.' : `Richtig wäre: ${q.options[q.answer]}` };
}

/** Note nach üblichem Hochschulschlüssel (ab 50 % bestanden). */
export function examGrade(percent: number): string {
  const steps: [number, string][] = [
    [95, '1,0'],
    [90, '1,3'],
    [85, '1,7'],
    [80, '2,0'],
    [75, '2,3'],
    [70, '2,7'],
    [65, '3,0'],
    [60, '3,3'],
    [55, '3,7'],
    [50, '4,0'],
  ];
  return steps.find(([min]) => percent >= min)?.[1] ?? '5,0';
}

/** Falsch beantwortete Fragen als Karteikarten an ihre Seite hängen (ohne Doppelte). */
export async function saveAsCards(items: { question: Question }[]): Promise<number> {
  const byPage = new Map<string, { front: string; back: string }[]>();
  for (const { question } of items) {
    const back = question.kind === 'choice' ? question.options[question.answer] : question.solution;
    byPage.set(question.pageId, [...(byPage.get(question.pageId) ?? []), { front: question.question, back }]);
  }
  let count = 0;
  for (const [pageId, cards] of byPage) {
    const doc = (await loadDoc(pageId)) ?? { type: 'doc', content: [] };
    const blocks = cardBlocks(doc, pageId, cards);
    count += blocks.filter((b) => b.type === 'paragraph').length;
    await appendBlocks(pageId, blocks);
  }
  return count;
}

const HISTORY_KEY = 'efeu.exam.history';

export interface ExamRun {
  at: number;
  percent: number;
  questions: number;
}

/** Bisherige Ergebnisse je Seite (nur auf diesem Gerät). */
export function examHistory(rootId: string): ExamRun[] {
  try {
    const all = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}') as Record<string, ExamRun[]>;
    return all[rootId] ?? [];
  } catch {
    return [];
  }
}

export function rememberExam(rootId: string, run: ExamRun): void {
  try {
    const all = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}') as Record<string, ExamRun[]>;
    all[rootId] = [...(all[rootId] ?? []), run].slice(-20);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch {
    // Ohne Speicher gibt es eben keinen Verlauf.
  }
}
