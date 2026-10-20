import type { JSONContent } from '@tiptap/core';
import { loadDocs, saveContent } from '../../db/content';
import { searchRelevant } from '../../db/search';
import { collectLinkTargets, jsonText } from '../../lib/doc';
import { usePages } from '../../store/pages';
import type { AiRequest } from './client';
import { fromAiMarkdown, toAiMarkdown } from './markdown';
import type { Citation } from './stream';

export interface ContextPage {
  id: string;
  title: string;
  markdown: string;
}

/** Pro Seite höchstens so viele Zeichen: genug für Antworten, ohne die Kosten explodieren zu lassen. */
const PAGE_CHARS = 8_000;

/** Sucht die passendsten Seiten zur Frage (plus die geöffnete Seite) und lädt ihren Inhalt. */
export async function gatherContext(question: string, currentId: string | null): Promise<ContextPage[]> {
  const pages = usePages.getState().pages;
  const found = await searchRelevant(question, 8);
  const ids = [...new Set([...(currentId ? [currentId] : []), ...found])].filter((id) => pages[id]?.type === 'page' && pages[id]?.deletedAt === null);
  const docs = await loadDocs(ids);
  const out: ContextPage[] = [];
  for (const id of ids) {
    const doc = docs[id];
    const markdown = doc ? toAiMarkdown(doc) : '';
    if (!markdown.trim()) continue;
    out.push({
      id,
      title: pages[id].title || 'Ohne Titel',
      markdown: markdown.length > PAGE_CHARS ? `${markdown.slice(0, PAGE_CHARS)}\n…(gekürzt)` : markdown,
    });
  }
  return out;
}

export function askRequest(question: string, context: ContextPage[]): AiRequest {
  const pages = context.map((p) => `<seite titel="${p.title.replace(/"/g, "'")}">\n${p.markdown}\n</seite>`).join('\n\n');
  return {
    feature: 'ask',
    title: 'Frag efeu',
    system: `Du beantwortest Fragen zum persönlichen Notiz-Workspace in der App efeu. Grundlage sind ausschließlich die mitgeschickten Seiten.
- Antworte knapp und konkret in Markdown, in der Sprache der Frage.
- Nenne die Seiten, auf die du dich stützt, als [[Seitentitel]] (genau der Titel aus dem Attribut), direkt im Text oder am Ende.
- Steht die Antwort nicht in den Seiten, sag das ehrlich und rate nicht.`,
    messages: [{ role: 'user', content: `${pages || '(Keine passenden Seiten gefunden.)'}\n\n<frage>${question}</frage>` }],
    maxTokens: 8_000,
    effort: 'low',
    output: [300, 2_000],
    mock: () =>
      context.length
        ? `Simulierte Antwort: Laut [[${context[0].title}]] steht dazu Folgendes …`
        : 'Dazu habe ich in deinen Seiten nichts gefunden.',
  };
}

export function researchRequest(question: string): AiRequest {
  const today = new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  return {
    feature: 'research',
    title: 'Recherche mit Websuche',
    system: `Du recherchierst für die Notiz-App efeu im Web und schreibst einen übersichtlichen Bericht für eine Notizseite.
Heute ist der ${today}. Deine Trainingsdaten enden lange vor diesem Datum. Zahlen, Preise, Versionen, Regeln und alles „Aktuelle“ können sich geändert haben: suche danach, bevor du antwortest, auch wenn du dir sicher bist. Dinge, die sich nicht ändern können, brauchen keine Suche.
- Schreib in der Sprache der Frage, gegliedert mit Überschriften (##) und Stichpunkten, knapp und konkret.
- Belege Aussagen mit den Suchergebnissen. Füge am Ende keine eigene Quellenliste an, die Quellen ergänzt efeu automatisch.
- Wenn sich Quellen widersprechen oder etwas unklar bleibt, sag das.`,
    messages: [{ role: 'user', content: question }],
    maxTokens: 16_000,
    effort: 'medium',
    output: [2_000, 8_000],
    webSearch: 5,
    extraInput: [8_000, 40_000],
    mock: () => `## Überblick\n\nSimulierter Bericht zu „${question}“.\n\n- Erster Punkt\n- Zweiter Punkt`,
  };
}

/** Antwort (und bei Recherche die Quellen) als neue Seite speichern. */
export async function saveAnswerAsPage(question: string, answer: string, citations: Citation[]): Promise<string> {
  const content: JSONContent[] = [...fromAiMarkdown(answer)];
  if (citations.length) {
    content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Quellen' }] });
    content.push({
      type: 'bulletList',
      content: citations.map((c) => ({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: c.title || c.url || 'Quelle', marks: c.url ? [{ type: 'link', attrs: { href: c.url } }] : [] }],
          },
        ],
      })),
    });
  }
  const doc: JSONContent = { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
  const title = question.length > 80 ? `${question.slice(0, 79)}…` : question;
  return usePages.getState().create({
    title,
    icon: '✨',
    extra: (page) => saveContent(page.id, doc, jsonText(doc), collectLinkTargets(doc, page.id), Date.now()),
  });
}
