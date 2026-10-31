import type { JSONContent } from '@tiptap/core';
import { loadDoc, saveContent } from '../../db/content';
import { commit } from '../../db/saveQueue';
import { getActiveEditor } from '../../editor/active';
import { collectLinkTargets, jsonText } from '../../lib/doc';
import { useUI } from '../../store/ui';

/**
 * Schreibt in eine Seite, egal ob sie gerade offen ist: im offenen Editor per Transaktion (ohne Cursor,
 * Fokus oder Scrollposition zu verändern, nicht im Rückgängig-Verlauf), sonst direkt in die Datenbank.
 */

export function openEditor(pageId: string) {
  const editor = getActiveEditor();
  return editor && useUI.getState().currentId === pageId && editor.isEditable ? editor : null;
}

export async function writeDoc(pageId: string, change: (content: JSONContent[]) => JSONContent[]): Promise<void> {
  const doc = (await loadDoc(pageId)) ?? { type: 'doc', content: [] };
  const content = change([...(doc.content ?? [])]);
  const next: JSONContent = { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
  await commit(saveContent(pageId, next, jsonText(next), collectLinkTargets(next, pageId), Date.now()));
}

const isEmptyParagraph = (n: JSONContent | undefined) => n?.type === 'paragraph' && !(n.content ?? []).length;

/** Hängt Blöcke ans Ende der Seite (vor einen leeren Schlussabsatz). */
export async function appendBlocks(pageId: string, blocks: JSONContent[]): Promise<void> {
  if (!blocks.length) return;
  const editor = openEditor(pageId);
  if (editor) {
    const { doc, schema, tr } = editor.state;
    const last = doc.lastChild;
    const pos = last && last.type.name === 'paragraph' && last.content.size === 0 ? doc.content.size - last.nodeSize : doc.content.size;
    tr.insert(pos, blocks.map((b) => schema.nodeFromJSON(b)));
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
    return;
  }
  await writeDoc(pageId, (content) => {
    const trailing = isEmptyParagraph(content.at(-1)) ? content.pop() : undefined;
    return [...content, ...blocks, ...(trailing ? [trailing] : [])];
  });
}

const textOf = (n: JSONContent): string => (n.text ?? '') + (n.content ?? []).map(textOf).join('');

/** Ersetzt den ersten obersten Block, dessen Text `marker` enthält (z. B. den Platzhalter der Zusammenfassung). */
export async function replaceMarker(pageId: string, marker: string, blocks: JSONContent[]): Promise<boolean> {
  const editor = openEditor(pageId);
  if (editor) {
    const { doc, schema, tr } = editor.state;
    let found: { from: number; to: number } | null = null;
    doc.forEach((node, offset) => {
      if (!found && node.textContent.includes(marker)) found = { from: offset, to: offset + node.nodeSize };
    });
    if (!found) return false;
    const { from, to } = found;
    tr.replaceWith(from, to, blocks.map((b) => schema.nodeFromJSON(b)));
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
    return true;
  }
  let replaced = false;
  await writeDoc(pageId, (content) => {
    const index = content.findIndex((n) => textOf(n).includes(marker));
    if (index < 0) return content;
    replaced = true;
    return [...content.slice(0, index), ...blocks, ...content.slice(index + 1)];
  });
  return replaced;
}
