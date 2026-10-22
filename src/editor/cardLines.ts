import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

/** Markiert Karteikarten im Text: Zeilen „Frage :: Antwort“ bekommen einen dezenten Rand. */
export const CardLines = Extension.create({
  name: 'cardLines',
  addProseMirrorPlugins() {
    const build = (doc: PMNode) => {
      const decorations: Decoration[] = [];
      doc.descendants((node, pos) => {
        if (node.type.name === 'codeBlock') return false;
        if (node.type.name !== 'paragraph') return true;
        const text = node.textContent;
        const at = text.indexOf('::');
        if (at > 0 && text.slice(at + 2).trim()) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'card-line' }));
        return false;
      });
      return DecorationSet.create(doc, decorations);
    };
    const key = new PluginKey<DecorationSet>('cardLines');
    return [
      new Plugin({
        key,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});
