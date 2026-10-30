import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { fromMarkdown } from './parse';
import { toMarkdown, type SerializeContext } from './serialize';

const ctx: SerializeContext = {
  page: (id) => ({ title: id === 'p1' ? 'Projekt Plan' : 'Unbekannt', href: id === 'p1' ? 'Projekt%20Plan.md' : null }),
  asset: (name) => `assets/${name}`,
};

const parseCtx = {
  resolvePage: (target: string, kind: 'path' | 'title') =>
    (kind === 'path' && decodeURI(target) === 'Projekt Plan.md') || (kind === 'title' && target === 'Projekt Plan') ? 'p1' : null,
  image: (src: string) => (src.startsWith('assets/') ? src.slice('assets/'.length) : null),
};

const t = (text: string, marks?: string[]): JSONContent => ({
  type: 'text',
  text,
  ...(marks ? { marks: marks.map((type) => ({ type })) } : {}),
});
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });

describe('Markdown-Export', () => {
  it('setzt Leerraum außerhalb von Markierungen', () => {
    const doc = { type: 'doc', content: [p(t('Ein '), t('fettes ', ['bold']), t('Wort'))] };
    expect(toMarkdown(doc, ctx)).toBe('Ein **fettes** Wort\n');
  });

  it('verschachtelt Markierungen korrekt', () => {
    const doc = { type: 'doc', content: [p(t('fett ', ['bold']), t('beides', ['bold', 'italic']), t(' code', ['code']))] };
    expect(toMarkdown(doc, ctx)).toBe('**fett *beides*** `code`\n');
  });

  it('maskiert Sonderzeichen, aber nicht in Code', () => {
    const doc = { type: 'doc', content: [p(t('a*b_c [x]')), p(t('a*b', ['code']))] };
    expect(toMarkdown(doc, ctx)).toBe('a\\*b\\_c \\[x\\]\n\n`a*b`\n');
  });

  it('schreibt Hoch-/Tiefstellung als HTML und lässt Farben weg', () => {
    const colored: JSONContent = { type: 'text', text: 'rot', marks: [{ type: 'textColor', attrs: { color: 'red' } }] };
    const doc = { type: 'doc', content: [p(t('m'), t('2', ['superscript']), t(' H'), t('2', ['subscript']), t('O '), colored)] };
    const md = toMarkdown(doc, ctx);
    expect(md).toBe('m<sup>2</sup> H<sub>2</sub>O rot\n');
    expect(fromMarkdown(md, parseCtx).content).toEqual([p(t('m'), t('2', ['superscript']), t(' H'), t('2', ['subscript']), t('O rot'))]);
  });

  it('schreibt und liest Formeln, Dollarzeichen im Text bleiben Text', () => {
    const doc = {
      type: 'doc',
      content: [
        p(t('Satz '), { type: 'mathInline', attrs: { latex: 'a^2+b^2' } }, t(' kostet $5')),
        { type: 'mathBlock', attrs: { latex: '\\int_0^1 x\\,dx' } },
      ],
    };
    const md = toMarkdown(doc, ctx);
    expect(md).toBe('Satz $a^2+b^2$ kostet \\$5\n\n$$\n\\int_0^1 x\\,dx\n$$\n');
    expect(fromMarkdown(md, parseCtx).content).toEqual(doc.content);
    expect(fromMarkdown('Von $5 bis $10 und $$x$$\n\n$$E=mc^2$$', parseCtx).content).toEqual([
      p(t('Von $5 bis $10 und $$x$$')),
      { type: 'mathBlock', attrs: { latex: 'E=mc^2' } },
    ]);
  });

  it('wählt einen längeren Zaun, wenn der Code ``` enthält', () => {
    const doc = { type: 'doc', content: [{ type: 'codeBlock', attrs: { language: 'md' }, content: [t('```js\nx\n```')] }] };
    expect(toMarkdown(doc, ctx)).toBe('````md\n```js\nx\n```\n````\n');
  });
});

describe('Markdown-Import', () => {
  it('erkennt Listen, To-dos, Zitate und Code', () => {
    const doc = fromMarkdown('- eins\n  - zwei\n\n<!-- -->\n\n- [x] fertig\n- [ ] offen\n\n> Zitat\n\n```ts\nconst a = 1;\n```\n', parseCtx);
    expect(doc.content!.map((n) => n.type)).toEqual(['bulletList', 'taskList', 'blockquote', 'codeBlock']);
    expect(doc.content![1].content!.map((i) => i.attrs!.checked)).toEqual([true, false]);
    expect(doc.content![3].attrs!.language).toBe('ts');
  });

  it('behält [ ] als Text in gemischten Listen', () => {
    const doc = fromMarkdown('- [ ] Aufgabe\n- normaler Punkt\n', parseCtx);
    expect(doc.content![0].type).toBe('bulletList');
    expect(doc.content![0].content![0].content![0].content![0].text).toBe('[ ] Aufgabe');
  });

  it('löst Seitenlinks über Pfad und [[Titel]] auf und übernimmt nur lokale Bilder', () => {
    const doc = fromMarkdown(
      'Siehe [Plan](Projekt%20Plan.md) und [[Projekt Plan]] sowie [extern](https://example.com).\n\n![Bild](assets/a.png)\n\n![Web](https://example.com/x.png)\n',
      parseCtx,
    );
    const inline = doc.content![0].content!;
    expect(inline.filter((n) => n.type === 'pageLink')).toHaveLength(2);
    expect(inline.find((n) => n.marks?.some((m) => m.type === 'link'))?.text).toBe('extern');
    expect(doc.content![1]).toEqual({ type: 'image', attrs: { src: 'a.png', alt: 'Bild', caption: '' } });
    expect(doc.content![2].type).toBe('paragraph');
  });

  it('entfernt Front-Matter und liest Tabellen als Tabellenblock', () => {
    const doc = fromMarkdown('---\nStatus: Offen\n---\n| A | B |\n|---|---|\n| 1 | 2 |\n', parseCtx);
    const [table] = doc.content!;
    expect(table.type).toBe('table');
    expect(table.content!.map((row) => row.content!.map((cell) => `${cell.type}:${cell.content![0].content?.[0]?.text}`))).toEqual([
      ['tableHeader:A', 'tableHeader:B'],
      ['tableCell:1', 'tableCell:2'],
    ]);
  });
});

describe('Round-Trip', () => {
  it('erhält alle Blocktypen', () => {
    const original: JSONContent = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [t('Titel')] },
        { type: 'heading', attrs: { level: 3 }, content: [t('Klein')] },
        p(t('Text mit '), t('fett', ['bold']), t(', '), t('kursiv', ['italic']), t(', '), t('durch', ['strike']), t(', '), t('markiert', ['highlight']), t(' und '), t('code', ['code'])),
        p(t('Link: '), { type: 'text', text: 'Seite', marks: [{ type: 'link', attrs: { href: 'https://example.com/a b' } }] }, t(' und '), { type: 'pageLink', attrs: { pageId: 'p1' } }),
        { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('a')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('b'))] }] }] }] },
        { type: 'orderedList', content: [{ type: 'listItem', content: [p(t('erstens'))] }, { type: 'listItem', content: [p(t('zweitens'))] }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('erledigt'))] }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('direkt nach To-dos'))] }] },
        { type: 'blockquote', content: [p(t('Zitat'))] },
        { type: 'toggle', attrs: { open: false }, content: [p(t('Kopf')), p(t('Inhalt'))] },
        { type: 'codeBlock', attrs: { language: 'python' }, content: [t('print("hi")')] },
        { type: 'horizontalRule' },
        { type: 'image', attrs: { src: 'abc.png', alt: 'Diagramm', caption: 'Abb. 1' } },
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('Name'))] }, { type: 'tableHeader', content: [p(t('Wert'))] }] },
            { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('a'))] }, { type: 'tableCell', content: [p(t('1', ['bold']))] }] },
          ],
        },
      ],
    };
    const markdown = toMarkdown(original, ctx);
    const parsed = fromMarkdown(markdown, parseCtx);
    expect(parsed.content!.map((n) => n.type)).toEqual(original.content!.map((n) => n.type));
    expect(toMarkdown(parsed, ctx)).toBe(markdown);
  });
});
