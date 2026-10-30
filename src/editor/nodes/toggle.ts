import { mergeAttributes, Node } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { showBlockColor } from '../format/blockAttrs';
import { el, icon } from '../dom';
import { unwrapAtStart } from './unwrap';

/** Aufklappbarer Block: der erste Absatz ist die Überschrift, alles danach der Inhalt. */
export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'paragraph block*',
  defining: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (element) => element.getAttribute('data-open') !== 'false',
        renderHTML: (attrs) => ({ 'data-open': String(attrs.open) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-toggle]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-toggle': '' }), 0];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = el('div', 'toggle');
      showBlockColor(dom, node.attrs.blockColor);
      dom.dataset.open = String(node.attrs.open);
      const button = el('button', 'toggle-button');
      button.type = 'button';
      button.contentEditable = 'false';
      button.setAttribute('aria-label', 'Auf-/Zuklappen');
      button.append(icon('chevron', 16));
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => {
        const pos = getPos();
        const current = typeof pos === 'number' ? editor.state.doc.nodeAt(pos) : null;
        if (!current) return;
        editor.view.dispatch(editor.state.tr.setNodeAttribute(pos as number, 'open', !current.attrs.open));
      });
      const content = el('div', 'toggle-content');
      dom.append(button, content);
      return {
        dom,
        contentDOM: content,
        update: (updated) => {
          if (updated.type.name !== 'toggle') return false;
          showBlockColor(dom, updated.attrs.blockColor);
          dom.dataset.open = String(updated.attrs.open);
          return true;
        },
        ignoreMutation: (mutation) => button.contains(mutation.target) || (mutation.type === 'attributes' && mutation.target === dom),
      };
    };
  },

  addKeyboardShortcuts() {
    return {
      // Enter in der Überschrift eines zugeklappten Toggles: neuer Block unterhalb statt versteckt im Inhalt.
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.depth < 2) return false;
        const toggle = $from.node(-1);
        if (toggle.type.name !== this.name || toggle.attrs.open || $from.index(-1) !== 0) return false;
        const after = $from.after(-1);
        const tr = editor.state.tr.insert(after, editor.schema.nodes.paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, after + 1));
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },
      Backspace: () => unwrapAtStart(this.editor, this.name),
    };
  },
});
