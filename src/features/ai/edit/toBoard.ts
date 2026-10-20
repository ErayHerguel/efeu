import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { flush } from '../../../db/saveQueue';
import { usePages } from '../../../store/pages';
import { reportError, toast } from '../../../store/toast';
import { useUI } from '../../../store/ui';
import { bumpBoard, useHiddenBoard, waitForBoard } from '../../board/active';
import { createBoard } from '../../board/create';
import { layoutBoard } from '../board/layout';
import { normalizePlan } from '../board/plan';
import { AiCancelled, askAi, costNote } from '../client';
import { pageMarkdown, rangeMarkdown } from '../markdown';
import type { BoardEditPlan } from './boardModel';
import { boardEditRequest } from './requests';

/**
 * Text → Board: Claude macht aus der Auswahl (oder der ganzen Seite) ein Board im Miro-Stil. flou legt
 * es als Unterseite an und bettet es direkt darunter bzw. am Seitenende ein; man bleibt auf der Seite.
 */

let busy = false;

/** Position hinter dem obersten Block, in dem `pos` liegt (bzw. Seitenende vor leerem Schlussabsatz) */
function insertPosition(editor: Editor, scope: 'selection' | 'page'): number {
  const { doc, selection } = editor.state;
  if (scope === 'selection') {
    const $to = doc.resolve(selection.to);
    return $to.depth >= 1 ? $to.after(1) : $to.pos;
  }
  const last = doc.lastChild;
  return last && last.type.name === 'paragraph' && last.content.size === 0 ? doc.content.size - last.nodeSize : doc.content.size;
}

function titleFrom(markdown: string, fallback: string): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(markdown)?.[1];
  const words = (heading ?? markdown.replace(/[#>*_`[\]-]/g, ' ')).trim().split(/\s+/).slice(0, 6).join(' ');
  return words ? `Board: ${words}` : `Board: ${fallback}`;
}

export async function convertToBoard(editor: Editor, scope: 'selection' | 'page'): Promise<void> {
  if (busy) return toast('Es wird bereits ein Board erstellt …');
  const pageId = useUI.getState().currentId;
  const page = pageId ? usePages.getState().pages[pageId] : undefined;
  if (!pageId || !page || page.type !== 'page') return;
  const { from, to, empty } = editor.state.selection;
  if (scope === 'selection' && empty) return toast('Markiere zuerst den Text, aus dem ein Board werden soll');
  const markdown = scope === 'selection' ? rangeMarkdown(editor, from, to) : pageMarkdown(editor);
  if (!markdown.trim()) return toast('Hier steht noch nichts, woraus ein Board werden könnte');

  busy = true;
  // Einfügestelle mitführen, falls während der Anfrage weitergeschrieben wird.
  let at = insertPosition(editor, scope);
  const track = ({ transaction }: { transaction: Transaction }) => {
    if (transaction.docChanged) at = transaction.mapping.map(at);
  };
  editor.on('transaction', track);
  try {
    const request = boardEditRequest({
      boardText: '',
      selectionOnly: false,
      instruction:
        scope === 'selection'
          ? 'Mach aus diesem Ausschnitt ein übersichtliches Board. (Das Board ist leer: erstelle den Inhalt über create.)'
          : 'Mach aus der Seite ein übersichtliches Board. (Das Board ist leer: erstelle den Inhalt über create.)',
      attachments: [{ kind: 'page', id: pageId, title: page.title || 'Ohne Titel', markdown }],
    });
    request.title = scope === 'selection' ? 'Auswahl als Board' : 'Seite als Board';
    toast('Claude baut das Board …');
    const result = await askAi(request);
    if (!result) return;
    const plan = JSON.parse(result.text) as BoardEditPlan;
    const { elements } = layoutBoard(normalizePlan(plan.create), { x: 0, y: 0 });
    if (!elements.length) throw new Error('Claude hat daraus kein Board gemacht. Versuch es mit mehr Text.');

    const boardId = await createBoard(pageId);
    usePages.getState().update(boardId, { title: titleFrom(markdown, page.title || 'Seite'), icon: '🧩' });
    useUI.getState().setExpanded(pageId, true);
    if (!editor.isDestroyed) {
      const node = editor.state.schema.nodes.boardEmbed.create({ pageId: boardId });
      editor.view.dispatch(editor.state.tr.insert(Math.min(at, editor.state.doc.content.size), node));
    }

    // Unsichtbar öffnen, zeichnen, speichern, schließen.
    useHiddenBoard.setState({ pageId: boardId });
    const bridge = await waitForBoard(boardId);
    await bridge.insert(elements);
    await new Promise((r) => setTimeout(r, 400));
    await flush();
    bumpBoard(boardId);
    toast(`Board erstellt · ${costNote(result)}`);
  } catch (err) {
    if (!(err instanceof AiCancelled)) reportError('Board erstellen', err);
  } finally {
    editor.off('transaction', track);
    if (useHiddenBoard.getState().pageId) useHiddenBoard.setState({ pageId: null });
    busy = false;
  }
}
