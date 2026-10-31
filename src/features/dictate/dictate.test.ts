// @vitest-environment jsdom
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEditor, p } from '../../test/editor';
import { insertDictation } from './dictate';

let editor: Editor;
afterEach(() => editor?.destroy());

describe('Diktat', () => {
  it('fügt den Text am Cursor ein, mit Leerzeichen zum Text davor', () => {
    editor = createTestEditor({ type: 'doc', content: [p('Hallo')] });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    insertDictation(editor, '  das ist   ein Test. ');
    expect(editor.state.doc.textContent).toBe('Hallo das ist ein Test.');
    insertDictation(editor, '');
    expect(editor.state.doc.textContent).toBe('Hallo das ist ein Test.');
  });

  it('ersetzt eine Auswahl und setzt am Zeilenanfang kein Leerzeichen', () => {
    editor = createTestEditor({ type: 'doc', content: [p('alt')] });
    editor.commands.setTextSelection({ from: 1, to: 4 });
    insertDictation(editor, 'neu');
    expect(editor.state.doc.textContent).toBe('neu');
  });
});
