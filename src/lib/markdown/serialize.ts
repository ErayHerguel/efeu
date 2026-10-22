import type { JSONContent } from '@tiptap/core';

export interface SerializeContext {
  /** Titel und relativer Link einer verlinkten Seite (href null = nicht Teil des Exports). */
  page(pageId: string): { title: string; href: string | null };
  /** Relativer Pfad eines Bildes aus dem Asset-Ordner. */
  asset(name: string): string;
}

type Mark = NonNullable<JSONContent['marks']>[number];

/** Reihenfolge von außen nach innen; Code muss innen liegen, Links außen. */
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'highlight', 'underline', 'code'];

const sortMarks = (marks: Mark[] = []) =>
  marks.filter((m) => MARK_ORDER.includes(m.type)).sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));

const sameMark = (a: Mark, b: Mark) => a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});

function openMark(mark: Mark): string {
  switch (mark.type) {
    case 'link':
      return '[';
    case 'bold':
      return '**';
    case 'italic':
      return '*';
    case 'strike':
      return '~~';
    case 'highlight':
      return '==';
    case 'underline':
      return '<u>';
    default:
      return '`';
  }
}

function closeMark(mark: Mark): string {
  if (mark.type === 'link') return `](${encodeHref(String(mark.attrs?.href ?? ''))})`;
  if (mark.type === 'underline') return '</u>';
  return openMark(mark);
}

const encodeHref = (href: string) => href.replace(/[ ()]/g, (c) => encodeURIComponent(c));

export function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]<>~=|])/g, '\\$1');
}

function inline(nodes: JSONContent[] = [], ctx: SerializeContext): string {
  let out = '';
  let pendingSpace = '';
  const open: Mark[] = [];
  const inCode = () => open.some((m) => m.type === 'code');

  for (const node of nodes) {
    const marks = node.type === 'text' ? sortMarks(node.marks) : [];
    let keep = 0;
    while (keep < open.length && keep < marks.length && sameMark(open[keep], marks[keep])) keep++;
    while (open.length > keep) out += closeMark(open.pop()!);

    if (node.type !== 'text') {
      out += pendingSpace;
      pendingSpace = '';
      if (node.type === 'hardBreak') out += '\\\n';
      else if (node.type === 'pageLink') {
        const target = ctx.page(String(node.attrs?.pageId));
        out += target.href ? `[${escapeText(target.title)}](${target.href})` : `[[${target.title}]]`;
      } else if (node.type === 'mention') out += escapeText(`@${String(node.attrs?.label ?? '')}`);
      continue;
    }

    let text = node.text ?? '';
    const lead = /^\s+/.exec(text)?.[0] ?? '';
    // Leerraum gehört vor öffnende Markierungen, sonst ist das Markdown ungültig (z. B. "** fett**").
    if (marks.length > keep) {
      out += pendingSpace + lead;
      text = text.slice(lead.length);
    } else {
      out += pendingSpace;
    }
    pendingSpace = '';
    for (const mark of marks.slice(keep)) {
      out += openMark(mark);
      open.push(mark);
    }
    const trail = /\s+$/.exec(text)?.[0] ?? '';
    if (trail && open.length) {
      text = text.slice(0, -trail.length);
      pendingSpace = trail;
    }
    out += inCode() ? text : escapeText(text);
  }
  while (open.length) out += closeMark(open.pop()!);
  return out + pendingSpace;
}

const indent = (text: string, prefix: string, first = prefix) =>
  text
    .split('\n')
    .map((line, i) => (i === 0 ? first : line ? prefix : '') + line)
    .join('\n');

function listItems(node: JSONContent, ctx: SerializeContext): string {
  const items = node.content ?? [];
  const start = Number(node.attrs?.start ?? 1);
  return items
    .map((item, i) => {
      const marker =
        node.type === 'orderedList' ? `${start + i}. ` : node.type === 'taskList' ? `- [${item.attrs?.checked ? 'x' : ' '}] ` : '- ';
      const body = blocks(item.content ?? [], ctx, '\n');
      return indent(body, ' '.repeat(node.type === 'orderedList' ? marker.length : 2), marker);
    })
    .join('\n');
}

function fence(code: string): string {
  let ticks = '```';
  while (code.includes(ticks)) ticks += '`';
  return ticks;
}

function block(node: JSONContent, ctx: SerializeContext): string {
  switch (node.type) {
    case 'paragraph':
      return inline(node.content, ctx);
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${inline(node.content, ctx)}`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listItems(node, ctx);
    case 'blockquote':
      return indent(blocks(node.content ?? [], ctx), '> ');
    case 'callout':
      return indent(`${node.attrs?.icon ?? '💡'} ${blocks(node.content ?? [], ctx)}`, '> ');
    case 'toggle': {
      const [summary, ...rest] = node.content ?? [];
      const body = blocks(rest, ctx);
      return `<details>\n<summary>${inline(summary?.content, ctx)}</summary>\n\n${body}${body ? '\n\n' : ''}</details>`;
    }
    case 'codeBlock': {
      const code = (node.content ?? []).map((t) => t.text ?? '').join('');
      const ticks = fence(code);
      return `${ticks}${node.attrs?.language ?? ''}\n${code}\n${ticks}`;
    }
    case 'horizontalRule':
      return '---';
    case 'image': {
      const caption = String(node.attrs?.caption ?? '');
      const title = caption ? ` "${caption.replace(/"/g, '\\"')}"` : '';
      return `![${escapeText(String(node.attrs?.alt ?? ''))}](${encodeHref(ctx.asset(String(node.attrs?.src)))}${title})`;
    }
    case 'file':
      return `[📎 ${escapeText(String(node.attrs?.name ?? 'Datei'))}](${encodeHref(ctx.asset(String(node.attrs?.src)))})`;
    case 'databaseBlock': {
      const target = ctx.page(String(node.attrs?.databaseId));
      return target.href ? `[${escapeText(target.title)}](${target.href})` : escapeText(target.title);
    }
    case 'table':
      return table(node, ctx);
    case 'boardEmbed':
    case 'pageRef': {
      const target = ctx.page(String(node.attrs?.pageId));
      return target.href ? `[${escapeText(target.title)}](${target.href})` : escapeText(target.title);
    }
    default:
      return blocks(node.content ?? [], ctx);
  }
}

/** GFM-Tabelle; die erste Zeile ist immer die Kopfzeile. Mehrere Absätze einer Zelle werden zu <br>. */
function table(node: JSONContent, ctx: SerializeContext): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((p) => inline(p.content, ctx))
        .join('<br>')
        .replace(/\n/g, ' '),
    ),
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

const DASH_LISTS = new Set(['bulletList', 'taskList']);

function blocks(nodes: JSONContent[], ctx: SerializeContext, separator = '\n\n'): string {
  let out = '';
  nodes.forEach((node, i) => {
    if (i > 0) {
      // Zwei "-"-Listen direkt hintereinander würden beim Einlesen zu einer verschmelzen.
      const merge = DASH_LISTS.has(nodes[i - 1].type ?? '') && DASH_LISTS.has(node.type ?? '');
      out += merge ? '\n\n<!-- -->\n\n' : separator;
    }
    out += block(node, ctx);
  });
  return out;
}

/** Wandelt ein Editor-Dokument in GitHub-flavoured Markdown. */
export function toMarkdown(doc: JSONContent, ctx: SerializeContext): string {
  return blocks(doc.content ?? [], ctx).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
