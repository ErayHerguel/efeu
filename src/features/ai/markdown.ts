import type { Editor, JSONContent } from '@tiptap/core';
import { fromMarkdown } from '../../lib/markdown/parse';
import { toMarkdown } from '../../lib/markdown/serialize';
import { usePages } from '../../store/pages';

/** Markdown für die KI: Seitenlinks als [[Titel]], Bilder nur mit Namen. */
export function toAiMarkdown(doc: JSONContent): string {
  return toMarkdown(doc, {
    page: (id) => ({ title: usePages.getState().pages[id]?.title || 'Ohne Titel', href: null }),
    asset: (name) => name,
  }).trim();
}

export function rangeMarkdown(editor: Editor, from: number, to: number): string {
  const slice = editor.state.doc.slice(from, to);
  const content = slice.content.toJSON() as JSONContent[] | null;
  if (!content) return '';
  // Teilauswahl innerhalb eines Absatzes: Inline-Inhalt in einen Absatz packen.
  const blocks = content.every((n) => editor.schema.nodes[n.type ?? '']?.isInline) ? [{ type: 'paragraph', content }] : content;
  return toAiMarkdown({ type: 'doc', content: blocks });
}

export function pageMarkdown(editor: Editor): string {
  return toAiMarkdown(editor.getJSON());
}

function resolveTitle(title: string): string | null {
  const wanted = title.trim().toLocaleLowerCase('de');
  const page = Object.values(usePages.getState().pages).find((p) => p.deletedAt === null && p.title.trim().toLocaleLowerCase('de') === wanted);
  return page?.id ?? null;
}

/** Markdown-Antwort → Editor-Inhalt; [[Titel]] wird zum Seitenlink, wenn es die Seite gibt. */
export function fromAiMarkdown(markdown: string): JSONContent[] {
  const doc = fromMarkdown(markdown.trim(), {
    resolvePage: (target, kind) => (kind === 'title' ? resolveTitle(target) : null),
    image: () => null,
  });
  return (doc.content ?? []).filter((n) => n.type !== 'image').map(toCallout);
}

const LEADING_EMOJI = /^(\p{Extended_Pictographic}\uFE0F?)\s+/u;

/** „> 💡 Text“ wird wieder zum Callout (so schreibt efeu Callouts auch als Markdown). */
function toCallout(node: JSONContent): JSONContent {
  if (node.type !== 'blockquote' || !node.content?.every((c) => c.type === 'paragraph')) return node;
  const [first, ...rest] = node.content;
  const lead = first.content?.[0];
  const match = lead?.type === 'text' ? LEADING_EMOJI.exec(lead.text ?? '') : null;
  if (!match || !lead) return node;
  const remaining = (lead.text ?? '').slice(match[0].length);
  const firstContent = remaining ? [{ ...lead, text: remaining }, ...(first.content ?? []).slice(1)] : (first.content ?? []).slice(1);
  return { type: 'callout', attrs: { icon: match[1] }, content: [{ type: 'paragraph', content: firstContent }, ...rest] };
}

/** Ein einzelner Absatz wird als Inline-Inhalt eingesetzt (passt in jede Teilauswahl). */
export function asInsertable(content: JSONContent[]): JSONContent[] {
  if (content.length === 1 && content[0].type === 'paragraph') return content[0].content ?? [];
  return content;
}

/** Entfernt eine versehentliche Einleitung oder einen Code-Zaun um die ganze Antwort. */
export function cleanAnswer(text: string): string {
  let out = text.trim();
  const fence = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(out);
  if (fence) out = fence[1].trim();
  return out;
}
