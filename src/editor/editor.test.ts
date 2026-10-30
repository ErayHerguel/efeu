// @vitest-environment jsdom
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import { collectLinkTargets } from '../lib/doc';
import { createTestEditor, p, pressKey, textOf, topLevelTypes, typeText } from '../test/editor';
import { dissolveEmptiedColumns, movableBlock, moveBlock } from './dragHandle';
import { SLASH_ITEMS } from './suggest/slashItems';
import { docText } from './text';

let editor: Editor;
afterEach(() => editor?.destroy());

/** Setzt den Cursor an das Ende des n-ten Textblocks (0-basiert). */
function cursorInBlock(index: number, atStart = false) {
  let count = -1;
  let target = 0;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    count += 1;
    if (count === index) target = atStart ? pos + 1 : pos + 1 + node.content.size;
    return false;
  });
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target)));
}

describe('Markdown-Shortcuts', () => {
  const cases: [string, string][] = [
    ['# ', 'heading'],
    ['- ', 'bulletList'],
    ['1. ', 'orderedList'],
    ['[] ', 'taskList'],
    ['> ', 'blockquote'],
    ['``` ', 'codeBlock'],
  ];
  for (const [input, type] of cases) {
    it(`„${input.trim()}“ wird zu ${type}`, () => {
      editor = createTestEditor({ type: 'doc', content: [p()] });
      cursorInBlock(0);
      typeText(editor, input);
      expect(topLevelTypes(editor)[0]).toBe(type);
    });
  }

  it('erkennt ## als Überschrift 2', () => {
    editor = createTestEditor({ type: 'doc', content: [p()] });
    cursorInBlock(0);
    typeText(editor, '## Titel');
    expect(editor.state.doc.firstChild?.attrs.level).toBe(2);
    expect(editor.state.doc.firstChild?.textContent).toBe('Titel');
  });
});

describe('Blöcke verschieben', () => {
  it('verschiebt Absätze nach oben und unten und behält den Cursor', () => {
    editor = createTestEditor({ type: 'doc', content: [p('A'), p('B'), p('C')] });
    cursorInBlock(1);
    expect(moveBlock(editor, -1)).toBe(true);
    expect(textOf(editor)).toEqual(['B', 'A', 'C']);
    expect(editor.state.selection.$from.parent.textContent).toBe('B');
    expect(moveBlock(editor, -1)).toBe(false);
    moveBlock(editor, 1);
    moveBlock(editor, 1);
    expect(textOf(editor)).toEqual(['A', 'C', 'B']);
  });

  it('verschiebt Listeneinträge innerhalb der Liste', () => {
    editor = createTestEditor('<ul><li><p>eins</p></li><li><p>zwei</p></li></ul>');
    cursorInBlock(1);
    moveBlock(editor, -1);
    const items: string[] = [];
    editor.state.doc.firstChild?.forEach((li) => items.push(li.textContent));
    expect(items).toEqual(['zwei', 'eins']);
  });

  it('macht das Verschieben mit einem Undo rückgängig', () => {
    editor = createTestEditor({ type: 'doc', content: [p('A'), p('B')] });
    cursorInBlock(1);
    moveBlock(editor, -1);
    editor.commands.undo();
    expect(textOf(editor)).toEqual(['A', 'B']);
  });
});

describe('Verschiebbare Blöcke', () => {
  /** Startposition des Textblocks mit genau diesem Text. */
  function textblock(text: string): number {
    let found = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === text) found = pos;
      return found < 0;
    });
    return found;
  }
  const typeAt = (pos: number | null) => (pos === null ? null : editor.state.doc.nodeAt(pos)?.type.name);
  const columns = (...cols: string[][]) => ({
    type: 'columns',
    content: cols.map((texts) => ({ type: 'column', content: texts.map((t) => p(t)) })),
  });

  it('greift jeden Block in Spalten einzeln', () => {
    editor = createTestEditor({ type: 'doc', content: [columns(['A', 'B'], ['C']), p('D')] });
    expect(typeAt(movableBlock(editor.state.doc, textblock('B')))).toBe('paragraph');
    expect(movableBlock(editor.state.doc, textblock('C'))).toBe(textblock('C'));
  });

  it('steht mit der ersten Zeile für Toggle, Callout und Listeneintrag, sonst für den Block selbst', () => {
    editor = createTestEditor({
      type: 'doc',
      content: [
        { type: 'toggle', attrs: { open: true }, content: [p('Kopf'), p('Inhalt')] },
        { type: 'callout', content: [p('Hinweis'), p('Zweiter')] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [p('Punkt'), p('Weiter')] }] },
        p('Ende'),
      ],
    });
    const doc = editor.state.doc;
    expect(typeAt(movableBlock(doc, textblock('Kopf')))).toBe('toggle');
    expect(movableBlock(doc, textblock('Inhalt'))).toBe(textblock('Inhalt'));
    expect(typeAt(movableBlock(doc, textblock('Hinweis')))).toBe('callout');
    expect(movableBlock(doc, textblock('Zweiter'))).toBe(textblock('Zweiter'));
    expect(typeAt(movableBlock(doc, textblock('Punkt')))).toBe('listItem');
    expect(movableBlock(doc, textblock('Weiter'))).toBe(textblock('Weiter'));
  });

  it('verschiebt Tabellen als Ganzes', () => {
    editor = createTestEditor('<table><tr><td><p>Zelle</p></td></tr></table><p>Ende</p>');
    expect(typeAt(movableBlock(editor.state.doc, textblock('Zelle')))).toBe('table');
  });

  it('verschiebt Blöcke innerhalb einer Spalte per Tastatur', () => {
    editor = createTestEditor({ type: 'doc', content: [columns(['A', 'B'], ['C']), p('D')] });
    cursorInBlock(1);
    expect(moveBlock(editor, -1)).toBe(true);
    const first: string[] = [];
    editor.state.doc.firstChild!.firstChild!.forEach((n) => first.push(n.textContent));
    expect(first).toEqual(['B', 'A']);
  });

  it('verlässt den Zieh-Zustand, wenn das Ziehen außerhalb des Editors endet', () => {
    vi.useFakeTimers();
    try {
      editor = createTestEditor({ type: 'doc', content: [p('A'), p('B')] });
      const grip = editor.view.dom.parentElement!.querySelector('.block-handle div.block-handle-button')!;
      editor.view.dragging = { slice: editor.state.doc.slice(0, 3), move: true };
      grip.dispatchEvent(new Event('dragend'));
      vi.advanceTimersByTime(100);
      expect(editor.view.dragging).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('löst eine Spalte auf, die durch Verschieben leer wurde', () => {
    editor = createTestEditor({ type: 'doc', content: [columns(['A'], ['B']), p('D')] });
    const before = editor.state.doc;
    const tr = editor.state.tr;
    const a = textblock('A');
    tr.delete(a, a + before.nodeAt(a)!.nodeSize);
    dissolveEmptiedColumns(before, tr.mapping, tr);
    editor.view.dispatch(tr);
    expect(topLevelTypes(editor)).toEqual(['paragraph', 'paragraph']);
    expect(textOf(editor)).toEqual(['B', 'D']);
  });

  it('lässt absichtlich leere Spalten stehen', () => {
    editor = createTestEditor({ type: 'doc', content: [columns([''], ['B'], ['C']), p('D')] });
    const before = editor.state.doc;
    const tr = editor.state.tr;
    const c = textblock('C');
    tr.insertText('!', c + 1);
    dissolveEmptiedColumns(before, tr.mapping, tr);
    expect(tr.doc.firstChild!.childCount).toBe(3);
  });
});

describe('Toggle und Callout', () => {
  const toggleDoc = (open: boolean) => ({
    type: 'doc',
    // Absatz am Ende, damit TrailingNode keinen zusätzlichen Absatz anhängt.
    content: [{ type: 'toggle', attrs: { open }, content: [p('Kopf'), p('Inhalt')] }, p('Danach')],
  });

  it('Enter im Kopf eines zugeklappten Toggles legt einen Block darunter an', () => {
    editor = createTestEditor(toggleDoc(false));
    cursorInBlock(0);
    pressKey(editor, 'Enter');
    expect(textOf(editor)).toEqual(['KopfInhalt', '', 'Danach']);
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.state.selection.$from.parent.textContent).toBe('');
    expect(editor.state.selection.$from.depth).toBe(1);
  });

  it('Enter im Kopf eines offenen Toggles bleibt im Toggle', () => {
    editor = createTestEditor(toggleDoc(true));
    cursorInBlock(0);
    pressKey(editor, 'Enter');
    expect(topLevelTypes(editor)).toEqual(['toggle', 'paragraph']);
    expect(editor.state.doc.firstChild?.childCount).toBe(3);
  });

  it('Backspace am Anfang löst Toggle und Callout auf, ohne Inhalt zu verlieren', () => {
    editor = createTestEditor(toggleDoc(true));
    cursorInBlock(0, true);
    pressKey(editor, 'Backspace');
    expect(textOf(editor)).toEqual(['Kopf', 'Inhalt', 'Danach']);
    editor.destroy();

    editor = createTestEditor({ type: 'doc', content: [{ type: 'callout', content: [p('Hinweis')] }, p('Danach')] });
    cursorInBlock(0, true);
    pressKey(editor, 'Backspace');
    expect(topLevelTypes(editor)).toEqual(['paragraph', 'paragraph']);
    expect(textOf(editor)).toEqual(['Hinweis', 'Danach']);
  });
});

describe('Slash-Befehle', () => {
  const run = (id: string) => {
    const item = SLASH_ITEMS.find((i) => i.id === id)!;
    const { from } = editor.state.selection;
    item.run(editor, { from: from - 1, to: from }, { pageId: 'x' });
  };

  for (const [id, type] of [
    ['h2', 'heading'],
    ['todo', 'taskList'],
    ['toggle', 'toggle'],
    ['callout', 'callout'],
    ['quote', 'blockquote'],
    ['code', 'codeBlock'],
    ['bullet', 'bulletList'],
    ['table', 'table'],
    ['columns2', 'columns'],
  ] as const) {
    it(`/${id} erzeugt ${type} und entfernt das Slash-Zeichen`, () => {
      editor = createTestEditor({ type: 'doc', content: [p('Text/')] });
      cursorInBlock(0);
      run(id);
      // Blöcke wie Tabelle/Spalten werden nach dem nicht-leeren Absatz eingefügt.
      expect(topLevelTypes(editor)).toContain(type);
      expect(editor.state.doc.textContent).toBe('Text');
    });
  }

  it('wandelt eine Zeile mit Text nachträglich um (Leerzeichen vor dem Slash verschwindet)', () => {
    editor = createTestEditor({ type: 'doc', content: [p('Hallo Welt /')] });
    cursorInBlock(0);
    run('h1');
    expect(editor.state.doc.child(0).type.name).toBe('heading');
    expect(editor.state.doc.child(0).textContent).toBe('Hallo Welt');
    typeText(editor, ' /');
    run('paragraph');
    expect(editor.state.doc.child(0).type.name).toBe('paragraph');
    expect(editor.state.doc.child(0).textContent).toBe('Hallo Welt');
  });

  it('/divider fügt einen Trenner ein', () => {
    editor = createTestEditor({ type: 'doc', content: [p('/')] });
    cursorInBlock(0);
    run('divider');
    expect(topLevelTypes(editor)).toContain('horizontalRule');
  });
});

describe('Seitenlinks', () => {
  it('extrahiert Linkziele und Suchtext', () => {
    editor = createTestEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Siehe ' },
            { type: 'pageLink', attrs: { pageId: 'ziel' } },
            { type: 'pageLink', attrs: { pageId: 'page-under-test' } },
          ],
        },
        { type: 'pageRef', attrs: { pageId: 'kind' } },
      ],
    });
    const json = editor.getJSON();
    expect(collectLinkTargets(json, 'page-under-test')).toEqual(['ziel']);
    expect(docText(editor.state.doc, (id) => (id === 'ziel' ? 'Zielseite' : 'Kindseite'))).toBe('Siehe ZielseiteKindseite\nKindseite');
  });

  it('übernimmt beim Einfügen keine externen Bilder', () => {
    editor = createTestEditor('<p>a</p><img src="https://example.com/x.png"><p>b</p>');
    expect(topLevelTypes(editor)).not.toContain('image');
  });
});

describe('Kommentare', () => {
  it('speichert Kommentare als Markierung im Dokument', () => {
    editor = createTestEditor({ type: 'doc', content: [p('Wichtiger Satz')] });
    editor.chain().setTextSelection({ from: 1, to: 10 }).setMark('comment', { id: 'c1', text: 'Prüfen', createdAt: 1 }).run();
    const marks = editor.getJSON().content![0].content![0].marks!;
    expect(marks[0]).toEqual({ type: 'comment', attrs: { id: 'c1', text: 'Prüfen', createdAt: 1 } });
  });
});
