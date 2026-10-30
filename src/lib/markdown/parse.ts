import type { JSONContent } from '@tiptap/core';
import MarkdownIt, { type Token } from 'markdown-it';
import markPlugin from 'markdown-it-mark';

export interface ParseContext {
  /** Liefert die Seiten-ID für einen relativen Link oder [[Titel]], sonst null. */
  resolvePage(target: string, kind: 'path' | 'title'): string | null;
  /** Ersetzt einen relativen Bildpfad durch einen Platzhalter, der später importiert wird. */
  image(src: string): string | null;
}

const md = new MarkdownIt({ html: true, linkify: false }).use(markPlugin);

type MarkSpec = NonNullable<JSONContent['marks']>[number];

const WIKI_LINK = /\[\[([^[\]]+)\]\]/g;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

function inline(tokens: Token[], ctx: ParseContext): JSONContent[] {
  const out: JSONContent[] = [];
  const marks: MarkSpec[] = [];
  let pageLinkOpen: string | null = null;

  const pushText = (text: string) => {
    if (!text) return;
    if (pageLinkOpen) return; // Linktext eines Seitenlinks wird durch den Seitentitel ersetzt
    // [[Titel]] innerhalb von Text
    let last = 0;
    for (const match of text.matchAll(WIKI_LINK)) {
      const id = ctx.resolvePage(match[1].trim(), 'title');
      if (!id) continue;
      if (match.index! > last) out.push({ type: 'text', text: text.slice(last, match.index), ...(marks.length ? { marks: [...marks] } : {}) });
      out.push({ type: 'pageLink', attrs: { pageId: id } });
      last = match.index! + match[0].length;
    }
    const rest = text.slice(last);
    if (rest) out.push({ type: 'text', text: rest, ...(marks.length ? { marks: [...marks] } : {}) });
  };

  const toggle = (type: string, open: boolean, attrs?: Record<string, unknown>) => {
    if (open) marks.push(attrs ? { type, attrs } : { type });
    else {
      const index = marks.map((m) => m.type).lastIndexOf(type);
      if (index !== -1) marks.splice(index, 1);
    }
  };

  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        pushText(t.content);
        break;
      case 'softbreak':
        pushText(' ');
        break;
      case 'hardbreak':
        out.push({ type: 'hardBreak' });
        break;
      case 'code_inline':
        if (!pageLinkOpen) out.push({ type: 'text', text: t.content, marks: [...marks, { type: 'code' }] });
        break;
      case 'strong_open':
      case 'strong_close':
        toggle('bold', t.type.endsWith('open'));
        break;
      case 'em_open':
      case 'em_close':
        toggle('italic', t.type.endsWith('open'));
        break;
      case 's_open':
      case 's_close':
        toggle('strike', t.type.endsWith('open'));
        break;
      case 'mark_open':
      case 'mark_close':
        toggle('highlight', t.type.endsWith('open'));
        break;
      case 'html_inline':
        if (/^<u>$/i.test(t.content)) toggle('underline', true);
        else if (/^<\/u>$/i.test(t.content)) toggle('underline', false);
        else if (/^<br\s*\/?>$/i.test(t.content)) out.push({ type: 'hardBreak' });
        else if (/^<(\/?)(sup|sub)>$/i.test(t.content)) {
          const [, close, tag] = /^<(\/?)(sup|sub)>$/i.exec(t.content)!;
          toggle(tag.toLowerCase() === 'sup' ? 'superscript' : 'subscript', !close);
        }
        break;
      case 'link_open': {
        const href = String(t.attrGet('href') ?? '');
        const pageId = EXTERNAL.test(href) || href.startsWith('#') ? null : ctx.resolvePage(href, 'path');
        if (pageId) {
          out.push({ type: 'pageLink', attrs: { pageId } });
          pageLinkOpen = pageId;
        } else toggle('link', true, { href });
        break;
      }
      case 'link_close':
        if (pageLinkOpen) pageLinkOpen = null;
        else toggle('link', false);
        break;
      case 'image': {
        // Bilder innerhalb von Text werden als Alternativtext übernommen; Blockbilder behandelt `blocks`.
        pushText(t.content);
        break;
      }
    }
  }
  return out;
}

const paragraph = (content: JSONContent[]): JSONContent => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });

/** Absatz, der nur aus einem Bild besteht → eigener Bildblock. */
function imageBlock(children: Token[], ctx: ParseContext): JSONContent | null {
  const meaningful = children.filter((c) => !(c.type === 'text' && !c.content.trim()) && c.type !== 'softbreak');
  if (meaningful.length !== 1 || meaningful[0].type !== 'image') return null;
  const image = meaningful[0];
  const src = String(image.attrGet('src') ?? '');
  const placeholder = EXTERNAL.test(src) ? null : ctx.image(src);
  if (!placeholder) return null;
  return { type: 'image', attrs: { src: placeholder, alt: image.content, caption: String(image.attrGet('title') ?? '') } };
}

/** Wandelt eine Token-Folge zwischen open/close in Blöcke. */
function blocks(tokens: Token[], ctx: ParseContext): JSONContent[] {
  const out: JSONContent[] = [];
  let i = 0;

  const until = (start: number): number => {
    // Index des passenden close-Tokens (gleiche Ebene)
    let depth = 0;
    for (let j = start; j < tokens.length; j++) {
      depth += tokens[j].nesting;
      if (depth === 0) return j;
    }
    return tokens.length - 1;
  };

  while (i < tokens.length) {
    const t = tokens[i];
    switch (t.type) {
      case 'heading_open': {
        const level = Math.min(3, Number(t.tag.slice(1)));
        const content = inline(tokens[i + 1].children ?? [], ctx);
        out.push({ type: 'heading', attrs: { level }, ...(content.length ? { content } : {}) });
        i += 3;
        break;
      }
      case 'paragraph_open': {
        const children = tokens[i + 1].children ?? [];
        out.push(imageBlock(children, ctx) ?? paragraph(inline(children, ctx)));
        i += 3;
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const end = until(i);
        out.push(list(tokens.slice(i, end + 1), ctx));
        i = end + 1;
        break;
      }
      case 'blockquote_open': {
        const end = until(i);
        const content = blocks(tokens.slice(i + 1, end), ctx);
        out.push({ type: 'blockquote', content: content.length ? content : [paragraph([])] });
        i = end + 1;
        break;
      }
      case 'fence':
      case 'code_block': {
        const code = t.content.replace(/\n$/, '');
        const language = t.info.trim().split(/\s+/)[0] || null;
        out.push({ type: 'codeBlock', attrs: { language }, ...(code ? { content: [{ type: 'text', text: code }] } : {}) });
        i += 1;
        break;
      }
      case 'hr':
        out.push({ type: 'horizontalRule' });
        i += 1;
        break;
      case 'html_block': {
        const consumed = details(tokens, i, ctx, out);
        i = consumed;
        break;
      }
      case 'table_open': {
        const end = until(i);
        out.push(...table(tokens.slice(i, end + 1), ctx));
        i = end + 1;
        break;
      }
      default:
        i += 1;
    }
  }
  return out;
}

/** <details><summary>…</summary> … </details> wird zum Toggle. */
function details(tokens: Token[], start: number, ctx: ParseContext, out: JSONContent[]): number {
  const html = tokens[start].content;
  const open = /^<details[^>]*>\s*(?:<summary>([\s\S]*?)<\/summary>)?/i.exec(html.trim());
  if (!open) return start + 1;
  // Ende suchen: html_block mit </details>
  let end = start + 1;
  let depth = 1;
  if (/<\/details>\s*$/i.test(html.trim())) depth = 0;
  while (depth > 0 && end < tokens.length) {
    const t = tokens[end];
    if (t.type === 'html_block') {
      if (/<details/i.test(t.content)) depth++;
      if (/<\/details>/i.test(t.content)) depth--;
    }
    end++;
  }
  const summary = md.parseInline(open[1] ?? '', {})[0]?.children ?? [];
  const inner = blocks(tokens.slice(start + 1, depth === 0 && end > start + 1 ? end - 1 : end), ctx);
  out.push({ type: 'toggle', attrs: { open: false }, content: [paragraph(inline(summary, ctx)), ...inner] });
  return end;
}

const TASK = /^\[([ xX])\]\s+/;

function list(tokens: Token[], ctx: ParseContext): JSONContent {
  const ordered = tokens[0].type === 'ordered_list_open';
  // Erst alle Einträge erfassen: Eine To-do-Liste liegt nur vor, wenn jeder Eintrag mit [ ] / [x] beginnt.
  const slices: { inner: Token[]; checked: boolean | null }[] = [];
  let i = 1;
  while (i < tokens.length - 1) {
    if (tokens[i].type !== 'list_item_open') {
      i++;
      continue;
    }
    let depth = 0;
    let end = i;
    for (; end < tokens.length; end++) {
      depth += tokens[end].nesting;
      if (depth === 0) break;
    }
    const inner = tokens.slice(i + 1, end);
    const firstInline = inner.find((t) => t.type === 'inline');
    const match = firstInline ? TASK.exec(firstInline.content) : null;
    slices.push({ inner, checked: match ? match[1].toLowerCase() === 'x' : null });
    i = end + 1;
  }

  const isTask = !ordered && slices.length > 0 && slices.every((s) => s.checked !== null);
  const items = slices.map(({ inner, checked }) => {
    if (isTask) {
      const first = inner.find((t) => t.type === 'inline')?.children?.[0];
      if (first?.type === 'text') first.content = first.content.replace(TASK, '');
    }
    const content = blocks(inner, ctx);
    return { content: content.length ? content : [paragraph([])], checked };
  });

  if (isTask) {
    return { type: 'taskList', content: items.map((item) => ({ type: 'taskItem', attrs: { checked: item.checked }, content: item.content })) };
  }
  const start = Number(tokens[0].attrGet('start') ?? 1);
  return {
    type: ordered ? 'orderedList' : 'bulletList',
    ...(ordered && start !== 1 ? { attrs: { start } } : {}),
    content: items.map((item) => ({ type: 'listItem', content: item.content })),
  };
}

/** GFM-Tabelle → Tabellenblock (Kopfzeile aus thead). */
function table(tokens: Token[], ctx: ParseContext): JSONContent[] {
  const rows: JSONContent[] = [];
  let cells: JSONContent[] = [];
  let header = false;
  for (const t of tokens) {
    if (t.type === 'thead_open') header = true;
    if (t.type === 'tbody_open') header = false;
    if (t.type === 'tr_open') cells = [];
    if (t.type === 'inline') {
      const content = inline(t.children ?? [], ctx);
      cells.push({ type: header ? 'tableHeader' : 'tableCell', content: [paragraph(content)] });
    }
    if (t.type === 'tr_close') rows.push({ type: 'tableRow', content: cells });
  }
  return rows.length ? [{ type: 'table', content: rows }] : [];
}

/** Entfernt YAML-Front-Matter am Anfang. */
export function stripFrontMatter(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** Wandelt Markdown in ein Editor-Dokument. */
export function fromMarkdown(source: string, ctx: ParseContext): JSONContent {
  const content = blocks(md.parse(stripFrontMatter(source), {}), ctx);
  return { type: 'doc', content: content.length ? content : [paragraph([])] };
}
