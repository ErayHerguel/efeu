// @vitest-environment jsdom
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEditor, p, typeText } from '../../test/editor';

let editor: Editor;
afterEach(() => editor?.destroy());

const atEnd = () => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));

describe('Formeln', () => {
  it('wandelt $…$ beim Tippen in eine Formel um, Beträge bleiben Text', () => {
    editor = createTestEditor({ type: 'doc', content: [p('Satz')] });
    atEnd();
    typeText(editor, ' $a^2+b^2$ und $5 bis $10');
    const para = editor.state.doc.child(0);
    const types: string[] = [];
    para.forEach((n) => types.push(n.type.name));
    expect(types).toEqual(['text', 'mathInline', 'text']);
    expect(para.child(1).attrs.latex).toBe('a^2+b^2');
    expect(para.child(2).text).toBe(' und $5 bis $10');
  });
});
