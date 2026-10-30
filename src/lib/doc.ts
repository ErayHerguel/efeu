import type { JSONContent } from '@tiptap/core';

/** Ziel-IDs aller [[Seitenlinks]] im Dokument, ohne Duplikate und ohne Selbstverweis. */
export function collectLinkTargets(doc: JSONContent, selfId: string): string[] {
  const targets = new Set<string>();
  const walk = (node: JSONContent) => {
    if (node.type === 'pageLink' && typeof node.attrs?.pageId === 'string') targets.add(node.attrs.pageId);
    node.content?.forEach(walk);
  };
  walk(doc);
  targets.delete(selfId);
  return [...targets];
}

/** Klartext eines JSON-Dokuments (für Suchindex bei Seiten, die nicht im Editor entstanden sind). */
const INLINE = new Set(['text', 'hardBreak', 'pageLink', 'mention', 'mathInline']);

export function jsonText(doc: JSONContent): string {
  const blocks: string[] = [];
  const inline = (node: JSONContent): string =>
    node.type === 'text'
      ? (node.text ?? '')
      : node.type === 'hardBreak'
        ? '\n'
        : node.type === 'mathInline'
          ? String(node.attrs?.latex ?? '')
          : node.type === 'mention'
            ? `@${String(node.attrs?.label ?? '')}`
            : (node.content ?? []).map(inline).join('');
  const walk = (node: JSONContent) => {
    const children = node.content ?? [];
    if (children.length > 0 && children.every((c) => INLINE.has(c.type ?? ''))) {
      blocks.push(children.map(inline).join(''));
      return;
    }
    if (node.type === 'mathBlock') {
      blocks.push(String(node.attrs?.latex ?? ''));
      return;
    }
    if (node.type === 'codeBlock') {
      blocks.push(children.map(inline).join(''));
      return;
    }
    children.forEach(walk);
  };
  walk(doc);
  // Schwebende Textfelder der Zeichnung (Attribut „ink“ der obersten Blöcke) sind auch durchsuchbar.
  for (const node of doc.content ?? []) {
    const ink: unknown = node.attrs?.ink;
    if (Array.isArray(ink)) for (const item of ink) if (item?.tool === 'text' && typeof item.text === 'string') blocks.push(item.text);
  }
  return blocks.join('\n');
}
