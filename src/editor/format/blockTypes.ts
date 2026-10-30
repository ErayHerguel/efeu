import type { ChainedCommands, Editor } from '@tiptap/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import { AlertCircle, ChevronRight, Code2, Heading1, Heading2, Heading3, List, ListChecks, ListOrdered, Quote, Type, type LucideIcon } from 'lucide-react';

export type BlockTypeId = 'paragraph' | 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'todo' | 'toggle' | 'quote' | 'callout' | 'code';

export interface BlockType {
  id: BlockTypeId;
  label: string;
  icon: LucideIcon;
  /** Wandelt die Blöcke der Auswahl um (vorher alles auf Absätze zurücksetzen, dann neu einpacken). */
  apply: (chain: ChainedCommands) => ChainedCommands;
}

export const BLOCK_TYPES: BlockType[] = [
  { id: 'paragraph', label: 'Text', icon: Type, apply: (c) => c.clearNodes() },
  { id: 'h1', label: 'Überschrift 1', icon: Heading1, apply: (c) => c.clearNodes().setNode('heading', { level: 1 }) },
  { id: 'h2', label: 'Überschrift 2', icon: Heading2, apply: (c) => c.clearNodes().setNode('heading', { level: 2 }) },
  { id: 'h3', label: 'Überschrift 3', icon: Heading3, apply: (c) => c.clearNodes().setNode('heading', { level: 3 }) },
  { id: 'bullet', label: 'Aufzählung', icon: List, apply: (c) => c.clearNodes().toggleBulletList() },
  { id: 'ordered', label: 'Nummerierte Liste', icon: ListOrdered, apply: (c) => c.clearNodes().toggleOrderedList() },
  { id: 'todo', label: 'To-do-Liste', icon: ListChecks, apply: (c) => c.clearNodes().toggleTaskList() },
  { id: 'toggle', label: 'Toggle', icon: ChevronRight, apply: (c) => c.clearNodes().wrapIn('toggle') },
  { id: 'quote', label: 'Zitat', icon: Quote, apply: (c) => c.clearNodes().setBlockquote() },
  { id: 'callout', label: 'Callout', icon: AlertCircle, apply: (c) => c.clearNodes().wrapIn('callout') },
  { id: 'code', label: 'Code', icon: Code2, apply: (c) => c.clearNodes().setCodeBlock() },
];

/** Art des Blocks an einer Position: der nächste umgebende Container zählt (Liste, Zitat, Toggle …). */
export function blockTypeAt($pos: ResolvedPos): BlockTypeId {
  const block = $pos.parent;
  if (block.type.name === 'codeBlock') return 'code';
  for (let d = $pos.depth - 1; d > 0; d--) {
    const node = $pos.node(d);
    switch (node.type.name) {
      case 'taskItem':
        return 'todo';
      case 'listItem':
        return $pos.node(d - 1).type.name === 'orderedList' ? 'ordered' : 'bullet';
      case 'blockquote':
        return 'quote';
      case 'callout':
        return 'callout';
      case 'toggle':
        return 'toggle';
      case 'tableCell':
      case 'tableHeader':
      case 'column':
        d = 0;
        break;
    }
  }
  if (block.type.name === 'heading') return (['h1', 'h2', 'h3'] as const)[Math.min(3, Math.max(1, block.attrs.level as number)) - 1];
  return 'paragraph';
}

/** Wandelt die Auswahl in einen anderen Blocktyp um. */
export function turnInto(editor: Editor, id: BlockTypeId): boolean {
  const type = BLOCK_TYPES.find((t) => t.id === id);
  if (!type || blockTypeAt(editor.state.selection.$from) === id) return false;
  return type.apply(editor.chain().focus()).run();
}
