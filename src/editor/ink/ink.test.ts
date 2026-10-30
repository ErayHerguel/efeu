// @vitest-environment jsdom
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEditor, p } from '../../test/editor';
import { docText } from '../text';
import { jsonText } from '../../lib/doc';
import { arrowMid, controlPoint, hitsStroke, moveStroke, simplify, strokeBox, strokesOf, validStrokes, type Stroke } from './ink';

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

  it('biegt Pfeile, verschiebt Elemente und prüft Textfelder', () => {
    const arrow: Stroke = { id: 'a', tool: 'arrow', color: 'red', points: [0, 0, 0.5, 100, 0, 0.5], bend: [50, 40], heads: 'both', dash: true };
    expect(validStrokes([arrow])).toHaveLength(1);
    // Die Kurve läuft durch den Biegepunkt: Treffer dort, nicht auf der Geraden.
    expect(hitsStroke(arrow, 50, 40)).toBe(true);
    expect(hitsStroke(arrow, 50, 0, 4)).toBe(false);
    expect(controlPoint(arrow)).toEqual([50, 80]);
    expect(strokeBox(arrow).bottom).toBeGreaterThan(40);
    const moved = moveStroke(arrow, 10, 5);
    expect(moved.points).toEqual([10, 5, 0.5, 110, 5, 0.5]);
    expect(arrowMid(moved)).toEqual([60, 45]);
    const text: Stroke = { id: 't', tool: 'text', color: 'blue', points: [20, -10, 0.5], text: 'Wichtig!', size: 'l', hand: true };
    expect(validStrokes([text, { ...text, size: 'xl' }, { ...text, text: 5 }])).toEqual([text]);
  });

  it('macht Textfelder durchsuchbar', () => {
    editor = createTestEditor({ type: 'doc', content: [p('Absatz')] });
    editor.commands.setInk(0, [{ id: 't', tool: 'text', color: 'text', points: [0, 0, 0.5], text: 'Randnotiz' }]);
    expect(docText(editor.state.doc, () => '')).toContain('Randnotiz');
    expect(jsonText(editor.getJSON())).toContain('Randnotiz');
  });
});
