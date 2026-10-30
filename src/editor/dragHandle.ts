import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';
import { Mapping, type Mappable } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { openBlockMenu } from './blockMenuStore';
import { el, icon } from './dom';

const LIST_ITEMS = new Set(['listItem', 'taskItem']);
/** Container, deren erste Zeile für den ganzen Container steht (Greifer an der ersten Zeile verschiebt alles). */
const FIRST_LINE_CONTAINERS = new Set(['listItem', 'taskItem', 'toggle', 'callout', 'blockquote']);
const HANDLE_SIZE = 24;
/** Wie weit links vom Text der Mauszeiger noch als "über dem Block" gilt. */
const GUTTER = 64;

/**
 * Startposition des verschiebbaren Blocks, zu dem der Block an `pos` gehört: jeder Block auf jeder Ebene
 * (auch in Spalten, Toggles und Callouts). Die erste Zeile eines Listeneintrags, Toggles, Callouts oder Zitats
 * steht für den ganzen Container, Tabellen werden als Ganzes verschoben.
 */
export function movableBlock(doc: PMNode, pos: number): number | null {
  let $b = doc.resolve(pos);
  if (!$b.nodeAfter?.isBlock) return null;
  for (let d = $b.depth; d > 0; d--) if ($b.node(d).type.name === 'table') return $b.before(d);
  while ($b.depth > 0 && $b.index() === 0 && FIRST_LINE_CONTAINERS.has($b.parent.type.name)) $b = doc.resolve($b.before());
  return $b.pos;
}

/** Oberster Block (Ebene 1), in dem `pos` liegt. */
function topLevelBlock(doc: PMNode, pos: number): number {
  const $pos = doc.resolve(pos);
  return $pos.depth === 0 ? pos : $pos.before(1);
}

/** Startposition des Blocks unter dem Mauszeiger. */
function blockAt(view: EditorView, x: number, y: number): number | null {
  const rect = view.dom.getBoundingClientRect();
  const hit = view.posAtCoords({ left: Math.min(Math.max(x, rect.left + 4), rect.right - 4), top: y });
  if (!hit) return null;
  const { doc } = view.state;
  const inside = hit.inside >= 0 ? doc.nodeAt(hit.inside) : null;
  if (inside?.isBlock && (inside.isTextblock || inside.isAtom)) return movableBlock(doc, hit.inside);
  const $pos = doc.resolve(hit.pos);
  if ($pos.parent.isTextblock) return $pos.depth === 0 ? null : movableBlock(doc, $pos.before());
  if ($pos.nodeAfter) return movableBlock(doc, hit.pos);
  if ($pos.nodeBefore) return movableBlock(doc, hit.pos - $pos.nodeBefore.nodeSize);
  return null;
}

/** Liegt die Höhe y innerhalb des Blocks an pos? */
function coversY(view: EditorView, pos: number, y: number): boolean {
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return false;
  const rect = dom.getBoundingClientRect();
  return y >= rect.top && y <= rect.bottom;
}

/** Spalten, die durch ein Verschieben leer geworden sind, entfernen; bleibt nur eine Spalte, wird sie aufgelöst. */
export function dissolveEmptiedColumns(before: PMNode, mapping: Mappable, tr: Transaction): void {
  const wasEmpty = new Set<number>();
  before.descendants((node, pos) => {
    if (node.type.name === 'column' && isEmptyColumn(node)) wasEmpty.add(mapping.map(pos));
    return node.type.name !== 'paragraph';
  });
  const emptied: number[] = [];
  tr.doc.descendants((node, pos) => {
    if (node.type.name === 'column' && isEmptyColumn(node) && !wasEmpty.has(pos)) emptied.push(pos);
    return node.type.name !== 'paragraph';
  });
  // Von hinten nach vorn, damit frühere Positionen gültig bleiben.
  for (const pos of emptied.reverse()) {
    const $col = tr.doc.resolve(pos);
    const columns = $col.parent;
    const columnsPos = $col.before();
    if (columns.childCount > 2) {
      tr.delete(pos, pos + columns.child($col.index()).nodeSize);
    } else {
      const rest = columns.child($col.index() === 0 ? 1 : 0);
      tr.replaceWith(columnsPos, columnsPos + columns.nodeSize, rest.content);
    }
  }
}

const isEmptyColumn = (column: PMNode) => column.childCount === 1 && column.firstChild!.type.name === 'paragraph' && column.firstChild!.content.size === 0;

function placeHandle(view: EditorView, handle: HTMLElement, pos: number) {
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return false;
  const wrapper = handle.parentElement!.getBoundingClientRect();
  const isListItem = LIST_ITEMS.has(view.state.doc.nodeAt(pos)?.type.name ?? '');
  const firstLine = (dom.querySelector(':scope > p, :scope > div > p') as HTMLElement | null) ?? dom;
  const style = getComputedStyle(firstLine);
  const lineHeight = parseFloat(style.lineHeight) || HANDLE_SIZE;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const lineTop = firstLine.getBoundingClientRect().top;
  const top = lineTop - wrapper.top + paddingTop + (Math.min(lineHeight, 40) - HANDLE_SIZE) / 2;
  const left = dom.getBoundingClientRect().left - wrapper.left - handle.offsetWidth - (isListItem ? 22 : 4);
  handle.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  return true;
}

/** Verschiebt den Block mit dem Cursor um eine Position nach oben (-1) oder unten (+1). */
export function moveBlock(editor: Editor, dir: -1 | 1): boolean {
  const { state } = editor;
  const { selection, doc } = state;
  const start =
    selection instanceof NodeSelection && selection.node.isBlock
      ? selection.from
      : selection.$from.depth > 0
        ? movableBlock(doc, selection.$from.before())
        : null;
  if (start === null) return false;
  const $start = doc.resolve(start);
  const parent = $start.parent;
  const index = $start.index();
  const target = index + dir;
  if (target < 0 || target >= parent.childCount) return false;
  const node = $start.nodeAfter!;
  const end = start + node.nodeSize;
  const sibling: PMNode = parent.child(target);
  const tr = state.tr;
  let newStart: number;
  if (dir < 0) {
    newStart = start - sibling.nodeSize;
    tr.delete(start, end).insert(newStart, node);
  } else {
    tr.insert(end + sibling.nodeSize, node).delete(start, end);
    newStart = start + sibling.nodeSize;
  }
  const shift = newStart - start;
  tr.setSelection(
    selection instanceof NodeSelection
      ? NodeSelection.create(tr.doc, selection.from + shift)
      : TextSelection.create(tr.doc, selection.anchor + shift, selection.head + shift),
  );
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

const targetKey = new PluginKey<number | null>('dragHandle');

/** Greifer und Plus-Knopf links neben jedem Block. */
export const DragHandle = Extension.create({
  name: 'dragHandle',

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-ArrowUp': ({ editor }) => moveBlock(editor, -1),
      'Mod-Shift-ArrowDown': ({ editor }) => moveBlock(editor, 1),
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    let current: number | null = null;

    const handle = el('div', 'block-handle');
    const plus = el('button', 'block-handle-button');
    plus.type = 'button';
    plus.title = 'Klicken: Block darunter einfügen';
    plus.append(icon('plus', 16));
    const grip = el('div', 'block-handle-button');
    grip.draggable = true;
    grip.title = 'Ziehen: verschieben\nKlicken: Menü';
    grip.append(icon('grip', 16));
    handle.append(plus, grip);

    /** Zeigt beim Zeigen auf den Greifer, welcher Block verschoben wird (als Dekoration, nicht per DOM-Klasse). */
    let marked: number | null = null;
    const markTarget = (on: boolean) => {
      const next = on ? current : null;
      if (next === marked || editor.isDestroyed) return;
      marked = next;
      editor.view.dispatch(editor.state.tr.setMeta(targetKey, next));
    };

    /** silent: ohne Transaktion, z. B. während der Editor sich aktualisiert oder abgebaut wird. */
    const hide = (silent = false) => {
      handle.classList.remove('is-visible');
      if (silent) marked = null;
      else markTarget(false);
      current = null;
    };

    let frame = 0;
    const onMouseMove = (event: MouseEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const view = editor.view;
        if (view.dragging || !editor.isEditable) return;
        if (handle.contains(event.target as Node)) return;
        const rect = view.dom.getBoundingClientRect();
        const { clientX: x, clientY: y } = event;
        const inside = y >= rect.top && y <= rect.bottom && x >= rect.left - GUTTER && x <= rect.right;
        if (!inside) return hide();
        let pos: number | null;
        if (x < rect.left && current !== null && coversY(view, current, y)) {
          // Auf dem Weg vom Text zum Greifer bleibt der Block gewählt.
          pos = current;
        } else {
          pos = blockAt(view, x, y);
          // Links neben Spalten greift man den ganzen Spaltenblock.
          if (pos !== null && x < rect.left) {
            const top = topLevelBlock(view.state.doc, pos);
            if (view.state.doc.nodeAt(top)?.type.name === 'columns') pos = top;
          }
        }
        if (pos === null) return hide();
        handle.classList.toggle('is-compact', view.state.doc.resolve(pos).parent.type.name === 'column');
        if (!placeHandle(view, handle, pos)) return hide();
        if (pos !== current) markTarget(false);
        current = pos;
        handle.classList.add('is-visible');
      });
    };

    plus.addEventListener('mousedown', (e) => e.preventDefault());
    plus.addEventListener('click', () => {
      if (current === null) return;
      const $pos = editor.state.doc.resolve(current);
      const node = editor.state.doc.nodeAt(current);
      if (!node) return;
      const end = current + node.nodeSize;
      const inList = $pos.depth > 0 && LIST_ITEMS.has(node.type.name);
      const content = inList
        ? { type: node.type.name, content: [{ type: 'paragraph', content: [{ type: 'text', text: '/' }] }] }
        : { type: 'paragraph', content: [{ type: 'text', text: '/' }] };
      editor
        .chain()
        .insertContentAt(end, content)
        .setTextSelection(end + (inList ? 3 : 2))
        .focus()
        .run();
      hide();
    });

    grip.addEventListener('mouseenter', () => markTarget(true));
    grip.addEventListener('mouseleave', () => markTarget(false));
    grip.addEventListener('mousedown', (e) => e.stopPropagation());
    grip.addEventListener('click', () => {
      if (current === null) return;
      const view = editor.view;
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, current)));
      view.focus();
      openBlockMenu(current, grip.getBoundingClientRect());
    });
    grip.addEventListener('dragstart', (event) => {
      if (current === null || !event.dataTransfer) return;
      const view = editor.view;
      const selection = NodeSelection.create(view.state.doc, current);
      view.dispatch(view.state.tr.setSelection(selection));
      const slice = selection.content();
      const { dom, text } = view.serializeForClipboard(slice);
      event.dataTransfer.clearData();
      event.dataTransfer.setData('text/html', dom.innerHTML);
      event.dataTransfer.setData('text/plain', text);
      event.dataTransfer.effectAllowed = 'copyMove';
      const blockDom = view.nodeDOM(current);
      if (blockDom instanceof HTMLElement) event.dataTransfer.setDragImage(blockDom, 0, 0);
      // node: ProseMirror löscht beim Ablegen genau diesen Block (auch wenn sich die Auswahl inzwischen geändert hat).
      view.dragging = { slice, move: true, node: selection } as EditorView['dragging'];
    });
    // Der Greifer liegt außerhalb des Editors, daher erreicht dessen dragend den Editor nicht.
    // Ohne Aufräumen bliebe der Editor nach einem abgebrochenen Ziehen (Esc, Ablegen außerhalb)
    // im Zieh-Zustand: kein Greifer mehr, und ein späteres Ablegen würde die alte Auswahl löschen.
    grip.addEventListener('dragend', () => {
      const view = editor.view;
      const dragging = view.dragging;
      window.setTimeout(() => {
        if (view.dragging === dragging) view.dragging = null;
      }, 50);
      hide();
    });

    return [
      new Plugin<number | null>({
        key: targetKey,
        state: {
          init: () => null,
          apply: (tr, value) => {
            const meta = tr.getMeta(targetKey) as number | null | undefined;
            if (meta !== undefined) return meta;
            return value === null || !tr.docChanged ? value : null;
          },
        },
        appendTransaction(transactions, _, newState) {
          const drop = transactions.find((t) => t.getMeta('uiEvent') === 'drop' && t.docChanged);
          if (!drop) return null;
          const mapping = new Mapping();
          for (const t of transactions.slice(transactions.indexOf(drop))) mapping.appendMapping(t.mapping);
          const tr = newState.tr;
          dissolveEmptiedColumns(drop.before, mapping, tr);
          return tr.docChanged ? tr : null;
        },
        view(view) {
          view.dom.parentElement?.append(handle);
          document.addEventListener('mousemove', onMouseMove);
          return {
            update(_, prev) {
              // Der Plugin-Zustand verwirft die Markierung bei Dokumentänderungen selbst.
              if (prev.doc !== view.state.doc) hide(true);
            },
            destroy() {
              cancelAnimationFrame(frame);
              document.removeEventListener('mousemove', onMouseMove);
              hide(true);
              handle.remove();
            },
          };
        },
        props: {
          decorations(state) {
            const pos = targetKey.getState(state);
            const node = pos === null || pos === undefined ? null : state.doc.nodeAt(pos);
            if (!node || pos === null || pos === undefined) return null;
            return DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, { class: 'is-drag-target' })]);
          },
          handleDOMEvents: {
            keydown: () => {
              hide();
              return false;
            },
            drop: () => {
              hide();
              return false;
            },
          },
        },
      }),
    ];
  },
});
