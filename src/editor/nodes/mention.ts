import { Node } from '@tiptap/core';
import { usePeople } from '../../features/team/people';
import { el } from '../dom';

/**
 * Erwähnung „@Lena“. Gespeichert werden Kennung und Name zum Zeitpunkt der Erwähnung; angezeigt wird der
 * aktuelle Name, solange die Person im Team ist. Der Server schickt der erwähnten Person eine Mitteilung.
 */
export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { id: { default: null }, label: { default: '' } };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-mention]',
        getAttrs: (element) => ({ id: element.getAttribute('data-mention'), label: element.getAttribute('data-label') ?? element.textContent?.replace(/^@/, '') }),
      },
    ];
  },

  renderHTML({ node }) {
    return ['span', { 'data-mention': node.attrs.id, 'data-label': node.attrs.label }, `@${node.attrs.label}`];
  },

  renderText({ node }) {
    return `@${node.attrs.label}`;
  },

  addNodeView() {
    return ({ node }) => {
      const dom = el('span', 'mention');
      dom.contentEditable = 'false';
      const paint = () => {
        const person = usePeople.getState().people.find((p) => p.id === node.attrs.id);
        dom.textContent = `@${person?.name ?? node.attrs.label}`;
        dom.style.setProperty('--mention', person?.color ?? 'var(--c-accent)');
        dom.classList.toggle('is-me', usePeople.getState().me === node.attrs.id);
      };
      paint();
      const unsubscribe = usePeople.subscribe(paint);
      return {
        dom,
        update: (updated) => updated.type.name === 'mention' && updated.attrs.id === node.attrs.id,
        selectNode: () => dom.classList.add('is-selected'),
        deselectNode: () => dom.classList.remove('is-selected'),
        ignoreMutation: () => true,
        destroy: unsubscribe,
      };
    };
  },
});
