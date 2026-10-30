import { Extension } from '@tiptap/core';
import { colorName } from '../colors';

export type TextAlign = 'left' | 'center' | 'right';
const ALIGNS = new Set<string>(['center', 'right']);

/** Blöcke, die eine Ausrichtung haben können. */
const ALIGNABLE = ['paragraph', 'heading'];
/** Blöcke, die eine Farbe haben können (Text- oder Hintergrundfarbe für den ganzen Block). */
export const COLORABLE = ['paragraph', 'heading', 'blockquote', 'listItem', 'taskItem', 'toggle', 'callout'];

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockAttrs: {
      /** Ausrichtung der Absätze/Überschriften in der Auswahl; null = links */
      setTextAlign: (align: TextAlign | null) => ReturnType;
      /** Farbe eines Blocks an `pos`: z. B. 'red' (Text) oder 'red-bg' (Hintergrund), null entfernt sie */
      setBlockColor: (pos: number, color: string | null) => ReturnType;
    };
  }
}

/** Gültiger Blockfarbwert: Farbname, optional mit „-bg“ für Hintergrund. */
export function blockColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const [name, bg] = value.split('-');
  return colorName(name) && (bg === undefined || bg === 'bg') ? value : null;
}

/** Für Node-Views, die ihr DOM selbst bauen (Callout, Toggle): Blockfarbe am Element setzen. */
export function showBlockColor(dom: HTMLElement, value: unknown): void {
  const color = blockColor(value);
  if (color) dom.dataset.blockColor = color;
  else delete dom.dataset.blockColor;
}

/** Ausrichtung (Absätze, Überschriften) und Blockfarben als zusätzliche Attribute vorhandener Blöcke. */
export const BlockAttrs = Extension.create({
  name: 'blockAttrs',
  addGlobalAttributes() {
    return [
      {
        types: ALIGNABLE,
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (el) => (ALIGNS.has(el.style.textAlign) ? el.style.textAlign : null),
            renderHTML: (attrs) => (typeof attrs.textAlign === 'string' && ALIGNS.has(attrs.textAlign) ? { style: `text-align: ${attrs.textAlign}` } : {}),
          },
        },
      },
      {
        types: COLORABLE,
        attributes: {
          blockColor: {
            default: null,
            parseHTML: (el) => blockColor(el.getAttribute('data-block-color')),
            renderHTML: (attrs) => (blockColor(attrs.blockColor) ? { 'data-block-color': attrs.blockColor } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setTextAlign:
        (align) =>
        ({ tr, state, dispatch }) => {
          const value = align && ALIGNS.has(align) ? align : null;
          const { from, to } = state.selection;
          let changed = false;
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (!ALIGNABLE.includes(node.type.name)) return true;
            if (node.attrs.textAlign !== value) {
              if (dispatch) tr.setNodeAttribute(pos, 'textAlign', value);
              changed = true;
            }
            return false;
          });
          return changed;
        },
      setBlockColor:
        (pos, color) =>
        ({ tr, state, dispatch }) => {
          const node = state.doc.nodeAt(pos);
          if (!node || !COLORABLE.includes(node.type.name)) return false;
          if (dispatch) tr.setNodeAttribute(pos, 'blockColor', blockColor(color));
          return true;
        },
    };
  },
});
