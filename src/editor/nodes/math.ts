import { InputRule, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { create } from 'zustand';
import type { Anchor } from '../../components/Popover';
import { el } from '../dom';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    math: {
      /** Fügt eine Formel ein (im Text oder als eigenen Block) und öffnet die Eingabe. */
      insertMath: (display: boolean, latex?: string) => ReturnType;
    };
  }
}

/** Offene Formeleingabe: Position des Formelknotens und Anker für das Eingabefeld. */
export const useMathEditor = create<{ pos: number | null; anchor: Anchor | null; editor: Editor | null }>(() => ({
  pos: null,
  anchor: null,
  editor: null,
}));

export function openMathEditor(editor: Editor, pos: number): void {
  const dom = editor.view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return;
  const r = dom.getBoundingClientRect();
  useMathEditor.setState({ editor, pos, anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
}

/** Setzt LaTeX als Formel; Fehler im Ausdruck werden rot im Text gezeigt statt eine Ausnahme zu werfen. */
export function renderMath(target: HTMLElement, latex: string, display: boolean): void {
  if (!latex.trim()) {
    target.textContent = display ? 'Formel eingeben (LaTeX)' : 'Formel';
    target.classList.add('is-empty');
    return;
  }
  target.classList.remove('is-empty');
  katex.render(latex, target, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000 });
}

function mathNodeView(display: boolean) {
  return ({ node, getPos, editor }: { node: { attrs: Record<string, unknown> }; getPos: () => number | undefined; editor: Editor }) => {
    const dom = el(display ? 'div' : 'span', display ? 'math-block' : 'math-inline');
    dom.contentEditable = 'false';
    let latex = String(node.attrs.latex ?? '');
    renderMath(dom, latex, display);
    dom.addEventListener('click', (event) => {
      const pos = getPos();
      if (!editor.isEditable || typeof pos !== 'number') return;
      event.preventDefault();
      openMathEditor(editor, pos);
    });
    return {
      dom,
      update: (updated: { type: { name: string }; attrs: Record<string, unknown> }) => {
        if (updated.type.name !== (display ? 'mathBlock' : 'mathInline')) return false;
        const next = String(updated.attrs.latex ?? '');
        if (next !== latex) {
          latex = next;
          renderMath(dom, latex, display);
        }
        return true;
      },
      ignoreMutation: () => true,
      stopEvent: (event: Event) => event.type === 'click' || event.type === 'mousedown',
    };
  };
}

const latexAttr = {
  latex: {
    default: '',
    parseHTML: (el: HTMLElement) => el.getAttribute('data-latex') ?? '',
    renderHTML: (attrs: Record<string, unknown>) => ({ 'data-latex': attrs.latex }),
  },
};

/** Formel im Fließtext: `$a^2$` tippen oder über „/formel“. */
export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => latexAttr,
  parseHTML: () => [{ tag: 'span[data-math-inline]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { 'data-math-inline': '' })],
  renderText: ({ node }) => `$${node.attrs.latex}$`,
  addNodeView() {
    return mathNodeView(false) as never;
  },
  addCommands() {
    return {
      insertMath:
        (display, latex = '') =>
        ({ editor, chain }) => {
          const type = display ? 'mathBlock' : 'mathInline';
          const ok = chain().insertContent({ type, attrs: { latex } }).run();
          if (!ok) return false;
          // Neue Formel finden (leerer Ausdruck, nächste zum Cursor) und die Eingabe öffnen.
          if (!latex)
            requestAnimationFrame(() => {
              const { doc, selection } = editor.state;
              let best: number | null = null;
              doc.descendants((node, pos) => {
                if (node.type.name === type && !node.attrs.latex && (best === null || Math.abs(pos - selection.from) < Math.abs(best - selection.from))) best = pos;
              });
              if (best !== null) openMathEditor(editor, best);
            });
          return true;
        },
    };
  },
  addInputRules() {
    return [
      // $…$ ohne Leerraum direkt innen; nicht bei Beträgen wie „$5 und $10“
      new InputRule({
        find: /(?:^|[^$\\\w])(\$([^$\s](?:[^$]*[^$\s])?)\$)$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.to - match[1].length, range.to, this.type.create({ latex: match[2] }));
        },
      }),
    ];
  },
});

/** Formel als eigener, zentrierter Block: `$$` und Leertaste am Zeilenanfang oder über „/formel“. */
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => latexAttr,
  parseHTML: () => [{ tag: 'div[data-math-block]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-math-block': '' })],
  renderText: ({ node }) => `$$${node.attrs.latex}$$`,
  addNodeView() {
    return mathNodeView(true) as never;
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== 'paragraph' || $from.depth === 0 || $from.parent.textContent.trim() !== '$$') return null;
          const start = $from.before();
          const tr = state.tr;
          tr.replaceWith(start, $from.after(), [this.type.create(), state.schema.nodes.paragraph.create()]);
          tr.setSelection(TextSelection.near(tr.doc.resolve(start + 2)));
          const editor = this.editor;
          requestAnimationFrame(() => openMathEditor(editor, start));
        },
      }),
    ];
  },
});
