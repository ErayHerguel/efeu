import type { Editor, Range } from '@tiptap/core';
import {
  AlertCircle,
  ChevronRight,
  Code2,
  Columns2,
  Columns3,
  Database,
  Paperclip,
  Shapes,
  Sheet,
  Table as TableIcon,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Type,
  type LucideIcon,
  LayoutTemplate,
  Sparkles,
  ListTodo,
  PenLine,
  Mic,
} from 'lucide-react';
import { startWrite } from '../../features/ai/writeSession';
import { openAiBar } from '../../features/ai/edit/session';
import { convertToBoard } from '../../features/ai/edit/toBoard';
import { openLectureStart } from '../../features/lecture/LectureUI';
import { pickAndStoreFile, pickImage } from '../../lib/assets';
import { columnsContent } from '../nodes/columns';
import { createBoard } from '../../features/board/create';
import { useDatabases } from '../../store/databases';
import { usePages } from '../../store/pages';
import { reportError } from '../../store/toast';
import { createSubpageBlock } from './subpage';
import { openTemplatePicker } from '../../features/templates/TemplatePicker';
import { useUI } from '../../store/ui';

export interface SlashContext {
  pageId: string;
}

export interface SlashItem {
  id: string;
  title: string;
  description: string;
  group: 'Grundblöcke' | 'Layout' | 'Medien' | 'Seiten' | 'KI';
  keywords: string[];
  icon: LucideIcon;
  /** Nur im eigenen Workspace (nicht als Gast) */
  hostOnly?: boolean;
  /** Nur mit eingerichteter KI */
  ai?: boolean;
  run(editor: Editor, range: Range, ctx: SlashContext): void;
}

const block = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'paragraph',
    title: 'Text',
    description: 'Normaler Absatz',
    group: 'Grundblöcke',
    keywords: ['absatz', 'paragraph', 'text', 'plain'],
    icon: Type,
    run: (editor, range) => block(editor, range).setParagraph().run(),
  },
  ...([1, 2, 3] as const).map<SlashItem>((level) => ({
    id: `h${level}`,
    title: `Überschrift ${level}`,
    description: ['Große', 'Mittlere', 'Kleine'][level - 1] + ' Abschnittsüberschrift',
    group: 'Grundblöcke',
    keywords: [`h${level}`, 'heading', 'titel', '#'.repeat(level)],
    icon: [Heading1, Heading2, Heading3][level - 1],
    run: (editor, range) => block(editor, range).setNode('heading', { level }).run(),
  })),
  {
    id: 'bullet',
    title: 'Aufzählung',
    description: 'Einfache Liste mit Punkten',
    group: 'Grundblöcke',
    keywords: ['liste', 'bullet', 'ul', 'punkte'],
    icon: List,
    run: (editor, range) => block(editor, range).toggleBulletList().run(),
  },
  {
    id: 'ordered',
    title: 'Nummerierte Liste',
    description: 'Liste mit Zahlen',
    group: 'Grundblöcke',
    keywords: ['nummer', 'ordered', 'ol', 'zahlen'],
    icon: ListOrdered,
    run: (editor, range) => block(editor, range).toggleOrderedList().run(),
  },
  {
    id: 'todo',
    title: 'To-do-Liste',
    description: 'Aufgaben zum Abhaken',
    group: 'Grundblöcke',
    keywords: ['todo', 'aufgabe', 'checkbox', 'task', 'check'],
    icon: ListChecks,
    run: (editor, range) => block(editor, range).toggleTaskList().run(),
  },
  {
    id: 'toggle',
    title: 'Toggle',
    description: 'Aufklappbarer Inhalt',
    group: 'Grundblöcke',
    keywords: ['aufklappen', 'details', 'collapse', 'toggle'],
    icon: ChevronRight,
    run: (editor, range) => block(editor, range).setParagraph().wrapIn('toggle').run(),
  },
  {
    id: 'quote',
    title: 'Zitat',
    description: 'Hervorgehobenes Zitat',
    group: 'Grundblöcke',
    keywords: ['quote', 'blockquote', 'zitat', '>'],
    icon: Quote,
    run: (editor, range) => block(editor, range).setParagraph().setBlockquote().run(),
  },
  {
    id: 'callout',
    title: 'Callout',
    description: 'Hinweis mit Icon',
    group: 'Grundblöcke',
    keywords: ['hinweis', 'callout', 'info', 'box', 'warnung'],
    icon: AlertCircle,
    run: (editor, range) => block(editor, range).setParagraph().wrapIn('callout').run(),
  },
  {
    id: 'code',
    title: 'Code',
    description: 'Codeblock mit Syntax-Highlighting',
    group: 'Grundblöcke',
    keywords: ['code', 'snippet', 'programm', '```'],
    icon: Code2,
    run: (editor, range) => block(editor, range).setCodeBlock().run(),
  },
  {
    id: 'divider',
    title: 'Trenner',
    description: 'Horizontale Linie',
    group: 'Grundblöcke',
    keywords: ['linie', 'divider', 'hr', 'trennlinie', '---'],
    icon: Minus,
    run: (editor, range) => block(editor, range).setHorizontalRule().run(),
  },
  {
    id: 'table',
    title: 'Tabelle',
    description: 'Einfache Tabelle mit Kopfzeile',
    group: 'Layout',
    keywords: ['tabelle', 'table', 'grid', 'raster'],
    icon: TableIcon,
    run: (editor, range) => block(editor, range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'columns2',
    title: '2 Spalten',
    description: 'Inhalt nebeneinander',
    group: 'Layout',
    keywords: ['spalten', 'columns', 'nebeneinander', 'layout'],
    icon: Columns2,
    run: (editor, range) => block(editor, range).insertContent(columnsContent(2)).run(),
  },
  {
    id: 'columns3',
    title: '3 Spalten',
    description: 'Inhalt in drei Spalten',
    group: 'Layout',
    keywords: ['spalten', 'columns', 'drei', 'layout'],
    icon: Columns3,
    run: (editor, range) => block(editor, range).insertContent(columnsContent(3)).run(),
  },
  {
    id: 'image',
    title: 'Bild',
    description: 'Bild von deinem Mac einfügen',
    group: 'Medien',
    keywords: ['bild', 'image', 'foto', 'picture', 'png', 'jpg'],
    icon: ImageIcon,
    run: (editor, range) => {
      block(editor, range).run();
      pickImage()
        .then((src) => {
          if (src) editor.chain().focus().insertContent({ type: 'image', attrs: { src } }).run();
        })
        .catch((err) => reportError('Bild konnte nicht eingefügt werden', err));
    },
  },
  {
    id: 'file',
    title: 'Datei',
    description: 'Anhang; Audio und Video spielen direkt',
    group: 'Medien',
    keywords: ['datei', 'file', 'anhang', 'pdf', 'video', 'audio'],
    icon: Paperclip,
    run: (editor, range) => {
      block(editor, range).run();
      pickAndStoreFile()
        .then((stored) => {
          if (!stored) return;
          editor.chain().focus().insertContent({ type: 'file', attrs: { src: stored.src, name: stored.name, size: stored.size } }).run();
        })
        .catch((err) => reportError('Datei konnte nicht eingefügt werden', err));
    },
  },
  {
    id: 'subpage',
    title: 'Unterseite',
    description: 'Neue Seite innerhalb dieser Seite',
    group: 'Seiten',
    keywords: ['seite', 'page', 'unterseite', 'subpage'],
    icon: FileText,
    run: (editor, range, ctx) =>
      void createSubpageBlock(editor, range, ctx.pageId, (parentId) => usePages.getState().create({ parentId })),
  },
  {
    id: 'template',
    title: 'Aus Vorlage',
    description: 'Unterseite aus einer Vorlage',
    group: 'Seiten',
    keywords: ['vorlage', 'template', 'meeting', 'projekt', 'wochenplan'],
    icon: LayoutTemplate,
    hostOnly: true,
    run: (editor, range, ctx) => {
      editor.chain().focus().deleteRange(range).run();
      openTemplatePicker({
        parentId: ctx.pageId,
        onCreated: (id) => {
          if (!editor.isDestroyed) editor.chain().focus().insertContent({ type: 'pageRef', attrs: { pageId: id } }).run();
          useUI.getState().setExpanded(ctx.pageId, true);
        },
      });
    },
  },
  {
    id: 'database',
    title: 'Datenbank',
    description: 'Tabelle und Board als Unterseite',
    group: 'Seiten',
    keywords: ['datenbank', 'database', 'tabelle', 'table', 'board', 'kanban'],
    icon: Database,
    run: (editor, range, ctx) =>
      void createSubpageBlock(editor, range, ctx.pageId, (parentId) => useDatabases.getState().createDatabase(parentId)),
  },
  {
    id: 'board',
    title: 'Board',
    description: 'Whiteboard mit Sticky Notes, Formen und Pfeilen',
    group: 'Seiten',
    keywords: ['board', 'whiteboard', 'figjam', 'canvas', 'zeichnen', 'sticky', 'mindmap', 'diagramm'],
    icon: Shapes,
    run: (editor, range, ctx) => {
      block(editor, range).run();
      createBoard(ctx.pageId)
        .then((pageId) => {
          if (!editor.isDestroyed) editor.chain().focus().insertContent({ type: 'boardEmbed', attrs: { pageId } }).run();
        })
        .catch((err) => reportError('Board konnte nicht angelegt werden', err));
    },
  },
  {
    id: 'inlineDatabase',
    title: 'Datenbank im Text',
    description: 'Tabelle, Board oder Kalender direkt hier',
    group: 'Seiten',
    keywords: ['datenbank', 'inline', 'eingebettet', 'tabelle', 'board', 'kalender'],
    icon: Sheet,
    run: (editor, range, ctx) => {
      block(editor, range).run();
      useDatabases
        .getState()
        .createDatabase(ctx.pageId)
        .then((databaseId) => {
          if (!editor.isDestroyed) editor.chain().focus().insertContent({ type: 'databaseBlock', attrs: { databaseId } }).run();
        })
        .catch((err) => reportError('Datenbank konnte nicht angelegt werden', err));
    },
  },
  {
    id: 'pageLink',
    title: 'Seitenlink',
    description: 'Auf eine andere Seite verweisen',
    group: 'Seiten',
    keywords: ['link', 'verweis', 'mention', '[['],
    icon: Link2,
    run: (editor, range) => block(editor, range).insertContent('[[').run(),
  },
  {
    id: 'lecture',
    title: 'Vorlesung mitschreiben',
    description: 'Live-Notizen per Mikrofon, Zusammenfassung am Ende',
    group: 'Seiten',
    keywords: ['vorlesung', 'aufnahme', 'mitschrift', 'mikrofon', 'meeting', 'transkript', 'lecture'],
    icon: Mic,
    hostOnly: true,
    run: (editor, range, ctx) => {
      editor.chain().focus().deleteRange(range).run();
      openLectureStart(ctx.pageId);
    },
  },
  {
    id: 'ai.bar',
    title: 'KI: Anweisung',
    description: 'Claude bearbeitet die Seite nach deiner Anweisung, auch mit PDF',
    group: 'KI',
    keywords: ['ki', 'ai', 'claude', 'bearbeiten', 'anweisung', 'pdf', 'import', 'umschreiben'],
    icon: Sparkles,
    hostOnly: true,
    ai: true,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      openAiBar();
    },
  },
  {
    id: 'ai.toBoard',
    title: 'KI: Seite als Board',
    description: 'Claude macht aus der Seite ein Board, eingebettet hier',
    group: 'KI',
    keywords: ['ki', 'ai', 'board', 'whiteboard', 'miro', 'mindmap', 'visualisieren', 'post-its'],
    icon: Shapes,
    hostOnly: true,
    ai: true,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      void convertToBoard(editor, 'page');
    },
  },
  {
    id: 'ai.continue',
    title: 'KI: Weiterschreiben',
    description: 'Claude schreibt an dieser Stelle weiter',
    group: 'KI',
    keywords: ['ki', 'ai', 'claude', 'weiter', 'schreiben', 'continue'],
    icon: PenLine,
    hostOnly: true,
    ai: true,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      startWrite(editor, 'continue');
    },
  },
  {
    id: 'ai.summarize',
    title: 'KI: Seite zusammenfassen',
    description: 'Stichpunkte oben auf der Seite',
    group: 'KI',
    keywords: ['ki', 'ai', 'claude', 'zusammenfassung', 'summary', 'tldr'],
    icon: Sparkles,
    hostOnly: true,
    ai: true,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      startWrite(editor, 'summarize');
    },
  },
  {
    id: 'ai.tasks',
    title: 'KI: Aufgaben herausziehen',
    description: 'To-dos aus der Seite als Liste',
    group: 'KI',
    keywords: ['ki', 'ai', 'claude', 'aufgaben', 'todo', 'tasks'],
    icon: ListTodo,
    hostOnly: true,
    ai: true,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      startWrite(editor, 'tasks');
    },
  },
];
