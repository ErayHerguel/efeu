import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { FileText, Plus } from 'lucide-react';
import { PageIcon, pageTitle } from '../../components/PageIcon';
import type { PageMeta } from '../../db/pages';
import { fuzzyFilter } from '../../lib/fuzzy';
import { usePages } from '../../store/pages';
import { reportError } from '../../store/toast';
import { listRenderer } from './renderer';
import { SLASH_ITEMS, type SlashItem } from './slashItems';
import { aiUsable } from '../../features/ai/store';
import { GUEST } from '../../lib/mode';
import { usePeople, type TeamPerson } from '../../features/team/people';

interface PageContextOptions {
  pageId: string;
}

/** Slash-Menü: "/" öffnet die Blockauswahl mit Fuzzy-Suche. */
export const SlashCommand = Extension.create<PageContextOptions>({
  name: 'slashCommand',
  addOptions: () => ({ pageId: '' }),
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey('slashCommand'),
        char: '/',
        allow: ({ editor }) => !editor.isActive('codeBlock'),
        items: ({ query }) =>
          fuzzyFilter(
            SLASH_ITEMS.filter((item) => !(GUEST && item.hostOnly) && !(item.ai && !aiUsable())),
            query,
            (item) => [item.title, ...item.keywords],
          ),
        command: ({ editor, range, props }) => props.run(editor, range, { pageId: this.options.pageId }),
        render: listRenderer<SlashItem>({
          itemKey: (item) => item.id,
          group: (item, query) => (query ? undefined : item.group),
          empty: 'Keine passenden Blöcke',
          renderItem: (item) => (
            <>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-bg text-muted">
                <item.icon size={18} strokeWidth={1.75} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-text">{item.title}</span>
                <span className="block truncate text-xs text-faint">{item.description}</span>
              </span>
            </>
          ),
        }),
      }),
    ];
  },
});

type LinkItem = { kind: 'page'; page: PageMeta } | { kind: 'create'; title: string };

/** [[ öffnet die Seitensuche; Auswahl fügt einen Seitenlink ein, alternativ wird die Seite angelegt. */
export const PageLinkSuggestion = Extension.create<PageContextOptions>({
  name: 'pageLinkSuggestion',
  addOptions: () => ({ pageId: '' }),
  addProseMirrorPlugins() {
    const insertLink = (editor: Editor, range: Range, pageId: string) =>
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: 'pageLink', attrs: { pageId } },
          { type: 'text', text: ' ' },
        ])
        .run();

    return [
      Suggestion<LinkItem, LinkItem>({
        editor: this.editor,
        pluginKey: new PluginKey('pageLinkSuggestion'),
        char: '[[',
        allowSpaces: true,
        allowedPrefixes: null,
        allow: ({ editor }) => !editor.isActive('codeBlock'),
        items: ({ query }) => {
          const q = query.replace(/\]+$/, '').trim();
          const live = Object.values(usePages.getState().pages).filter((p) => p.deletedAt === null && p.id !== this.options.pageId);
          const ordered = q ? fuzzyFilter(live, q, (p) => [p.title]) : live.sort((a, b) => b.updatedAt - a.updatedAt);
          const items: LinkItem[] = ordered.slice(0, 8).map((page) => ({ kind: 'page', page }));
          if (q && !live.some((p) => p.title.trim().toLowerCase() === q.toLowerCase())) items.push({ kind: 'create', title: q });
          return items;
        },
        command: ({ editor, range, props }) => {
          if (props.kind === 'page') {
            insertLink(editor, range, props.page.id);
            return;
          }
          usePages
            .getState()
            .create({ parentId: this.options.pageId || null, title: props.title })
            .then((id) => {
              if (!editor.isDestroyed) insertLink(editor, range, id);
            })
            .catch((err) => reportError('Seite konnte nicht angelegt werden', err));
        },
        render: listRenderer<LinkItem>({
          itemKey: (item) => (item.kind === 'page' ? item.page.id : `create:${item.title}`),
          empty: 'Keine Seiten gefunden',
          renderItem: (item) =>
            item.kind === 'page' ? (
              <>
                <PageIcon page={item.page} />
                <span className="truncate text-text">{pageTitle(item.page)}</span>
              </>
            ) : (
              <>
                <Plus size={16} className="shrink-0 text-muted" />
                <span className="truncate text-text">
                  Neue Unterseite „{item.title}“
                </span>
                <FileText size={14} className="ml-auto shrink-0 text-faint" />
              </>
            ),
        }),
      }),
    ];
  },
});

/** @ öffnet die Liste der Leute im Team; Auswahl fügt eine Erwähnung ein (die Person bekommt eine Mitteilung). */
export const MentionSuggestion = Extension.create({
  name: 'mentionSuggestion',
  addProseMirrorPlugins() {
    return [
      Suggestion<TeamPerson, TeamPerson>({
        editor: this.editor,
        pluginKey: new PluginKey('mentionSuggestion'),
        char: '@',
        allow: ({ editor }) => !editor.isActive('codeBlock') && usePeople.getState().people.length > 1,
        items: ({ query }) => {
          const { people, me } = usePeople.getState();
          const others = people.filter((p) => p.id !== me);
          return (query ? fuzzyFilter(others, query, (p) => [p.name]) : others).slice(0, 8);
        },
        command: ({ editor, range, props }) =>
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: 'mention', attrs: { id: props.id, label: props.name } },
              { type: 'text', text: ' ' },
            ])
            .run(),
        render: listRenderer<TeamPerson>({
          itemKey: (p) => p.id,
          empty: 'Niemand gefunden',
          renderItem: (p) => (
            <>
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white" style={{ background: p.color }}>
                {p.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="truncate text-text">{p.name}</span>
            </>
          ),
        }),
      }),
    ];
  },
});
