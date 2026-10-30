// @vitest-environment jsdom
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEditor, p } from '../../test/editor';
import { hitsStroke, simplify, strokesOf, validStrokes, type Stroke } from './ink';

let editor: Editor;
afterEach(() => editor?.destroy());

const stroke = (id: string, points = [0, 0, 0.5, 100, 0, 0.5]): Stroke => ({ id, tool: 'pen', color: 'red', points });

describe('Zeichnen', () => {
  it('hängt Striche an Blöcke, sie wandern mit und lassen sich rückgängig machen', () => {
    editor = createTestEditor({ type: 'doc', content: [p('Eins'), p('Zwei')] });
    const second = editor.state.doc.child(0).nodeSize;
    editor.commands.setInk(second, [stroke('a')]);
    expect(strokesOf(editor.state.doc.child(1))).toHaveLength(1);
    // Absatz davor einfügen: Strich bleibt an „Zwei“.
    editor.chain().insertContentAt(0, p('Neu')).run();
    expect(editor.state.doc.child(2).textContent).toBe('Zwei');
    expect(strokesOf(editor.state.doc.child(2))[0].id).toBe('a');
    // Enter in der Mitte: der neue Teil bekommt keine Kopie.
    const pos = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize + 3;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
    editor.commands.splitBlock();
    expect(editor.state.doc.childCount).toBe(4);
    expect(strokesOf(editor.state.doc.child(3))).toHaveLength(0);
    editor.commands.setInk(editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize, []);
    expect(editor.getJSON().content?.some((n) => n.attrs?.ink)).toBe(false);
    // Zeichnungen erscheinen nicht im HTML (Kopieren, Export).
    editor.commands.setInk(0, [stroke('b')]);
    expect(editor.getHTML()).not.toContain('ink');
  });

  it('übernimmt nur gültige Striche', () => {
    expect(validStrokes([stroke('ok'), { id: 'x', tool: 'laser', color: 'red', points: [0, 0, 0, 1, 1, 1] }, { ...stroke('kurz'), points: [1, 2, 3] }, null, 'x'])).toEqual([
      stroke('ok'),
    ]);
    expect(validStrokes({ id: 'nope' })).toEqual([]);
  });

  it('fasst Punkte zusammen und erkennt Treffer für den Radierer', () => {
    const points = [0, 0, 0.5, 0.4, 0.4, 0.5, 10, 0, 0.5, 10.3, 0.2, 0.5, 20, 0, 0.5];
    expect(simplify(points)).toEqual([0, 0, 0.5, 10, 0, 0.5, 20, 0, 0.5]);
    const s = stroke('s', [0, 0, 0.5, 100, 0, 0.5]);
    expect(hitsStroke(s, 50, 5)).toBe(true);
    expect(hitsStroke(s, 50, 30)).toBe(false);
  });
});
