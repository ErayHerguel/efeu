// @vitest-environment jsdom
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEditor, p } from '../../test/editor';
import { blockTypeAt, turnInto } from './blockTypes';

let editor: Editor;
afterEach(() => editor?.destroy());

const cursorAt = (pos: number) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));

describe('Formatierung', () => {
  it('wandelt Blöcke um und erkennt den aktuellen Typ', () => {
    editor = createTestEditor({ type: 'doc', content: [p('Eins')] });
    cursorAt(2);
    expect(blockTypeAt(editor.state.selection.$from)).toBe('paragraph');
    for (const id of ['h2', 'bullet', 'ordered', 'todo', 'quote', 'callout', 'toggle', 'code', 'paragraph'] as const) {
      expect(turnInto(editor, id)).toBe(true);
      expect(blockTypeAt(editor.state.selection.$from)).toBe(id);
      expect(editor.state.doc.textContent).toBe('Eins');
    }
  });

  it('setzt Ausrichtung, Blockfarbe, Textfarbe und Hochstellung', () => {
    editor = createTestEditor({ type: 'doc', content: [p('Hallo Welt')] });
    editor.chain().selectAll().setTextAlign('center').setTextColor('red').setHighlight({ color: 'blue' }).run();
    editor.commands.setBlockColor(0, 'green-bg');
    editor.chain().setTextSelection({ from: 7, to: 11 }).toggleSuperscript().run();
    const html = editor.getHTML();
    expect(html).toContain('text-align: center');
    expect(html).toContain('data-block-color="green-bg"');
    expect(html).toContain('data-text-color="" data-color="red"');
    expect(html).toContain('<mark data-color="blue">');
    expect(html).toContain('<sup>');
    // Unbekannte Farben werden nicht übernommen.
    expect(editor.commands.setTextColor('lila; background: url(x)')).toBe(false);
    editor.commands.setBlockColor(0, 'nope');
    expect(editor.state.doc.child(0).attrs.blockColor).toBeNull();
  });
});
