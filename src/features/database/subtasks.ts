import type { JSONContent } from '@tiptap/core';
import { create } from 'zustand';
import { db } from '../../db/driver';
import { openEditor, writeDoc } from '../lecture/pageWriter';

/**
 * Unteraufgaben eines Datenbank-Eintrags: die To-dos in seiner Seite. Board-Karten zeigen den
 * Fortschritt und lassen sich direkt abhaken oder ergänzen, ohne die Seite zu öffnen.
 */

export interface Subtask {
  text: string;
  checked: boolean;
}

const plain = (node: JSONContent): string => (node.text ?? '') + (node.content ?? []).map(plain).join('');

/** Alle To-dos eines Dokuments in Lesereihenfolge (auch verschachtelte). */
export function extractSubtasks(doc: JSONContent): Subtask[] {
  const out: Subtask[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === 'taskItem') {
      const first = node.content?.[0];
      out.push({ text: first ? plain(first).trim() : '', checked: !!node.attrs?.checked });
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return out;
}

/** Setzt beim n-ten To-do (Lesereihenfolge) das Häkchen. */
export function toggleInDoc(content: JSONContent[], index: number, checked: boolean): JSONContent[] {
  let seen = -1;
  const visit = (node: JSONContent): JSONContent => {
    if (node.type === 'taskItem') {
      seen += 1;
      const self = seen === index ? { ...node, attrs: { ...node.attrs, checked } } : node;
      return self.content ? { ...self, content: self.content.map(visit) } : self;
    }
    return node.content ? { ...node, content: node.content.map(visit) } : node;
  };
  return content.map(visit);
}

const taskItem = (text: string): JSONContent => ({
  type: 'taskItem',
  attrs: { checked: false },
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Hängt ein To-do an die letzte To-do-Liste der Seite an (oder legt eine an). */
export function appendInDoc(content: JSONContent[], text: string): JSONContent[] {
  const lastList = content.map((n) => n.type).lastIndexOf('taskList');
  const trailingEmpty = content.length > 0 && content[content.length - 1].type === 'paragraph' && !content[content.length - 1].content?.length;
  // Nur an eine Liste am Ende anhängen; sonst eine neue Liste unten anlegen.
  if (lastList >= 0 && lastList >= content.length - (trailingEmpty ? 2 : 1)) {
    const list = content[lastList];
    return content.map((n, i) => (i === lastList ? { ...list, content: [...(list.content ?? []), taskItem(text)] } : n));
  }
  const list: JSONContent = { type: 'taskList', content: [taskItem(text)] };
  return trailingEmpty ? [...content.slice(0, -1), list, content[content.length - 1]] : [...content, list];
}

/** Zwischenspeicher je Eintrag, damit Karten nicht bei jedem Zeichnen die Datenbank fragen. */
export const useSubtasks = create<{ byRow: Record<string, Subtask[]> }>(() => ({ byRow: {} }));

export async function loadSubtasks(rowIds: string[]): Promise<void> {
  if (!rowIds.length) return;
  const rows = await db().select<{ page_id: string; doc: string }>(
    'SELECT page_id, doc FROM page_content WHERE page_id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(rowIds)],
  );
  const next: Record<string, Subtask[]> = {};
  for (const id of rowIds) next[id] = [];
  for (const row of rows) {
    try {
      next[row.page_id] = extractSubtasks(JSON.parse(row.doc) as JSONContent);
    } catch {
      // Unlesbarer Inhalt: keine Unteraufgaben
    }
  }
  useSubtasks.setState((s) => ({ byRow: { ...s.byRow, ...next } }));
}

/** Häkchen setzen; in einer offenen Seite über den Editor, sonst direkt im gespeicherten Inhalt. */
export async function toggleSubtask(rowId: string, index: number, checked: boolean): Promise<void> {
  const editor = openEditor(rowId);
  if (editor) {
    let seen = -1;
    const { tr } = editor.state;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'taskItem') return true;
      seen += 1;
      if (seen === index) tr.setNodeAttribute(pos, 'checked', checked);
      return true;
    });
    editor.view.dispatch(tr);
  } else {
    await writeDoc(rowId, (content) => toggleInDoc(content, index, checked));
  }
  await loadSubtasks([rowId]);
}

export async function addSubtask(rowId: string, text: string): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  const editor = openEditor(rowId);
  if (editor) editor.chain().insertContentAt(editor.state.doc.content.size, { type: 'taskList', content: [taskItem(clean)] }).run();
  else await writeDoc(rowId, (content) => appendInDoc(content, clean));
  await loadSubtasks([rowId]);
}
