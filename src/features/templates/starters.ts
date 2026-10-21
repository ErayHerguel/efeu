import type { JSONContent } from '@tiptap/core';
import { saveContent } from '../../db/content';
import { emptyConfig, insertProperty, insertView, type Property, type SelectOption, type View, type ViewType } from '../../db/database';
import type { Statement } from '../../db/driver';
import { insertPage, type PageMeta } from '../../db/pages';
import { jsonText } from '../../lib/doc';
import { newId } from '../../lib/ids';

/* Bausteine für Inhalte (TipTap-JSON). */
const text = (value: string): JSONContent[] => (value ? [{ type: 'text', text: value }] : []);
const p = (value = ''): JSONContent => ({ type: 'paragraph', content: text(value) });
const h = (value: string): JSONContent => ({ type: 'heading', attrs: { level: 2 }, content: text(value) });
const item = (type: string, value: string, extra: Record<string, unknown> = {}): JSONContent => ({
  type,
  ...(Object.keys(extra).length ? { attrs: extra } : {}),
  content: [p(value)],
});
const bullets = (...values: string[]): JSONContent => ({ type: 'bulletList', content: values.map((v) => item('listItem', v)) });
const numbered = (...values: string[]): JSONContent => ({ type: 'orderedList', content: values.map((v) => item('listItem', v)) });
const tasks = (...values: string[]): JSONContent => ({ type: 'taskList', content: values.map((v) => item('taskItem', v, { checked: false })) });
const callout = (icon: string, value: string): JSONContent => ({ type: 'callout', attrs: { icon }, content: [p(value)] });
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

/** Inhalt einer neuen Tagesnotiz, wenn es keine eigene Vorlage „Tagesnotiz“ gibt. */
export const DAILY_DOC = doc(h('Heute wichtig'), tasks(''), h('Notizen'), p(), h('Dankbar für'), bullets(''));

interface PageTemplate {
  title: string;
  icon: string;
  doc: JSONContent;
}

const PAGE_TEMPLATES: PageTemplate[] = [
  {
    title: 'Meeting-Notizen',
    icon: '📝',
    doc: doc(
      callout('ℹ️', 'Datum, Ort und Ziel des Treffens'),
      h('Teilnehmer'),
      bullets(''),
      h('Agenda'),
      numbered('', ''),
      h('Notizen'),
      p(),
      h('Aufgaben'),
      tasks('Wer macht was bis wann'),
    ),
  },
  {
    title: 'Projekt',
    icon: '🚀',
    doc: doc(
      callout('💡', 'Worum geht es, und woran merken wir, dass es geschafft ist?'),
      h('Ziel'),
      p(),
      h('Meilensteine'),
      tasks('Start', 'Zwischenstand', 'Abschluss'),
      h('Risiken und offene Fragen'),
      bullets(''),
      h('Notizen'),
      p(),
    ),
  },
  {
    title: 'Wochenplan',
    icon: '🗓️',
    doc: doc(h('Ziele der Woche'), tasks(''), ...WEEKDAYS.flatMap((day) => [h(day), tasks('')])),
  },
  { title: 'Tagesnotiz', icon: '📅', doc: DAILY_DOC },
];

const option = (name: string, color: SelectOption['color']): SelectOption => ({ id: newId(), name, color });

interface DatabaseTemplate {
  title: string;
  icon: string;
  properties: (databaseId: string) => Property[];
  /** Ansichten; `groupBy`/`sortBy` verweisen per Name auf eine Property */
  views: { name: string; type: ViewType; groupBy?: string; sortBy?: string }[];
}

const property = (databaseId: string, sortOrder: number, name: string, type: Property['type'], options: SelectOption[] = []): Property => ({
  id: newId(),
  databaseId,
  name,
  type,
  options,
  config: {},
  sortOrder,
});

const DATABASE_TEMPLATES: DatabaseTemplate[] = [
  {
    title: 'Aufgaben',
    icon: '✅',
    properties: (id) => [
      property(id, 0, 'Status', 'select', [option('Offen', 'gray'), option('In Arbeit', 'blue'), option('Erledigt', 'green')]),
      property(id, 1, 'Priorität', 'select', [option('Hoch', 'red'), option('Mittel', 'orange'), option('Niedrig', 'gray')]),
      property(id, 2, 'Fällig', 'date'),
    ],
    views: [
      { name: 'Board', type: 'board', groupBy: 'Status' },
      { name: 'Tabelle', type: 'table', sortBy: 'Fällig' },
    ],
  },
  {
    title: 'Leseliste',
    icon: '📚',
    properties: (id) => [
      property(id, 0, 'Autor', 'text'),
      property(id, 1, 'Status', 'select', [option('Will ich lesen', 'gray'), option('Lese gerade', 'blue'), option('Gelesen', 'green')]),
      property(id, 2, 'Bewertung', 'select', [option('★★★★★', 'yellow'), option('★★★★', 'yellow'), option('★★★', 'yellow'), option('★★', 'yellow'), option('★', 'yellow')]),
      property(id, 3, 'Link', 'url'),
    ],
    views: [
      { name: 'Board', type: 'board', groupBy: 'Status' },
      { name: 'Tabelle', type: 'table' },
    ],
  },
];

/** Mitgelieferte Vorlagen als Unterseiten von `parentId`: Seiten und Datenbanken samt Ansichten. */
export function starterTemplates(parentId: string, now: number): { pages: PageMeta[]; statements: Statement[] } {
  const pages: PageMeta[] = [];
  const statements: Statement[] = [];
  const meta = (title: string, icon: string, type: PageMeta['type']): PageMeta => {
    const page: PageMeta = {
      id: newId(),
      parentId,
      type,
      title,
      icon,
      cover: null,
      fullWidth: false,
      sortOrder: pages.length,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      space: 'private',
      categoryId: null,
      updatedBy: null,
    };
    pages.push(page);
    statements.push(insertPage(page));
    return page;
  };
  for (const template of PAGE_TEMPLATES) {
    const page = meta(template.title, template.icon, 'page');
    statements.push(...saveContent(page.id, template.doc, jsonText(template.doc), [], now));
  }
  for (const template of DATABASE_TEMPLATES) {
    const page = meta(template.title, template.icon, 'database');
    const properties = template.properties(page.id);
    const byName = (name?: string) => properties.find((prop) => prop.name === name)?.id ?? null;
    const views: View[] = template.views.map((v, sortOrder) => {
      const sortBy = byName(v.sortBy);
      return {
        id: newId(),
        databaseId: page.id,
        name: v.name,
        type: v.type,
        config: { ...emptyConfig(), groupBy: byName(v.groupBy), sorts: sortBy ? [{ propertyId: sortBy, direction: 'asc' }] : [] },
        sortOrder,
      };
    });
    statements.push(...properties.map(insertProperty), ...views.map(insertView));
  }
  return { pages, statements };
}
