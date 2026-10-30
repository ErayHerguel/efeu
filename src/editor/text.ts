import type { Node as PMNode } from '@tiptap/pm/model';

/** Klartext eines Dokuments für Suche und Export-Vorschau. */
export function docText(doc: PMNode, titleOf: (pageId: string) => string): string {
  return withInkTexts(doc, docTextOnly(doc, titleOf));
}

/** Texte schwebender Textfelder (Zeichnung) hinten anhängen, damit die Suche sie findet. */
function withInkTexts(doc: PMNode, text: string): string {
  const extra: string[] = [];
  doc.forEach((node) => {
    const ink: unknown = node.attrs.ink;
    if (!Array.isArray(ink)) return;
    for (const item of ink) if (item?.tool === 'text' && typeof item.text === 'string') extra.push(item.text);
  });
  return extra.length ? `${text}\n${extra.join('\n')}` : text;
}

function docTextOnly(doc: PMNode, titleOf: (pageId: string) => string): string {
  return doc.textBetween(0, doc.content.size, '\n', (leaf) => {
    if (leaf.type.name === 'pageLink' || leaf.type.name === 'pageRef') return titleOf(String(leaf.attrs.pageId));
    if (leaf.type.name === 'databaseBlock') return titleOf(String(leaf.attrs.databaseId));
    if (leaf.type.name === 'boardEmbed') return titleOf(String(leaf.attrs.pageId));
    if (leaf.type.name === 'file') return String(leaf.attrs.name);
    if (leaf.type.name === 'image') return String(leaf.attrs.caption ?? '');
    if (leaf.type.name === 'hardBreak') return '\n';
    if (leaf.type.name === 'mention') return `@${leaf.attrs.label}`;
    if (leaf.type.name === 'mathInline' || leaf.type.name === 'mathBlock') return String(leaf.attrs.latex ?? '');
    return '';
  });
}
