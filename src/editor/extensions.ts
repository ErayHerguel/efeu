import { Extension, type Extensions } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Highlight from '@tiptap/extension-highlight';
import { Table, TableRow } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import StarterKit from '@tiptap/starter-kit';
import { DragHandle } from './dragHandle';
import { ImageInput } from './imageInput';
import { LinkClick } from './linkClick';
import { Callout } from './nodes/callout';
import { CodeBlock } from './nodes/codeBlock';
import { Column, Columns } from './nodes/columns';
import { Comment } from './nodes/comment';
import { BoardEmbed } from './nodes/boardEmbed';
import { DatabaseBlock } from './nodes/databaseBlock';
import { FileBlock } from './nodes/file';
import { Image } from './nodes/image';
import { PageLink } from './nodes/pageLink';
import { PageRef } from './nodes/pageRef';
import { TableCell, TableHeader } from './nodes/table';
import { Toggle } from './nodes/toggle';
import { MentionSuggestion, PageLinkSuggestion, SlashCommand } from './suggest/extensions';
import { Mention } from './nodes/mention';
import { CardLines } from './cardLines';
import type { DocBinding } from '../features/collab/sources';

interface ToolbarStorage {
  openLink: (() => void) | null;
  openComment: (() => void) | null;
}

declare module '@tiptap/core' {
  interface Storage {
    toolbar: ToolbarStorage;
  }
}

/** Verbindet Mod+Shift+K (Link) und Mod+Shift+M (Kommentar) mit der schwebenden Leiste. */
const ToolbarShortcuts = Extension.create<object, ToolbarStorage>({
  name: 'toolbar',
  addStorage: () => ({ openLink: null, openComment: null }),
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-m': () => {
        if (this.editor.state.selection.empty || !this.storage.openComment) return false;
        this.storage.openComment();
        return true;
      },
      'Mod-Shift-k': () => {
        if (this.editor.state.selection.empty || !this.storage.openLink) return false;
        this.storage.openLink();
        return true;
      },
    };
  },
});

/** collab: gemeinsames Dokument (Yjs) statt lokalem Inhalt; der Verlauf läuft dann über Yjs. */
export function createExtensions(pageId: string, collab?: Pick<DocBinding, 'doc' | 'awareness' | 'user'>): Extensions {
  return [
    StarterKit.configure({
      codeBlock: false,
      undoRedo: collab ? false : { depth: 500, newGroupDelay: 400 },
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
      heading: { levels: [1, 2, 3] },
      dropcursor: { color: 'var(--c-accent)', width: 2 },
    }),
    CodeBlock,
    TaskList,
    TaskItem.configure({ nested: true }),
    Highlight,
    Callout,
    Toggle,
    Image,
    FileBlock,
    Table.configure({ resizable: true, lastColumnResizable: false, cellMinWidth: 80 }),
    TableRow,
    TableHeader,
    TableCell,
    Columns,
    Column,
    Comment,
    DatabaseBlock,
    BoardEmbed,
    PageRef,
    PageLink,
    Mention,
    Placeholder.configure({
      placeholder: ({ node }) =>
        node.type.name === 'heading' ? `Überschrift ${node.attrs.level}` : 'Tippe „/“ für Befehle oder „[[“ für Seitenlinks …',
    }),
    SlashCommand.configure({ pageId }),
    PageLinkSuggestion.configure({ pageId }),
    MentionSuggestion,
    CardLines,
    DragHandle,
    ImageInput,
    LinkClick,
    ToolbarShortcuts,
    ...(collab
      ? [
          Collaboration.configure({ document: collab.doc }),
          CollaborationCaret.configure({ provider: { awareness: collab.awareness }, user: collab.user }),
        ]
      : []),
  ];
}
