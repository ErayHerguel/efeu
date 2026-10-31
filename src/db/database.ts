import { db, type Statement } from './driver';

export type PropertyType =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'relation'
  | 'rollup'
  | 'formula';

/** Berechnete Typen speichern keine Werte. */
export const COMPUTED_TYPES: PropertyType[] = ['rollup', 'formula'];

export type RollupAggregate = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'show';

export interface PropertyConfig {
  /** relation: Ziel-Datenbank */
  targetDatabaseId?: string;
  /** rollup: Relation dieser Datenbank und Property der Ziel-Datenbank */
  relationPropertyId?: string;
  targetPropertyId?: string;
  aggregate?: RollupAggregate;
  /** formula */
  expression?: string;
  /** date: am fälligen Tag eine Mitteilung zeigen */
  remind?: boolean;
}

export const TAG_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export interface SelectOption {
  id: string;
  name: string;
  color: TagColor;
}

export interface Property {
  id: string;
  databaseId: string;
  name: string;
  type: PropertyType;
  options: SelectOption[];
  config: PropertyConfig;
  sortOrder: number;
}

/** Text/URL/Datum: String · Zahl: number · Checkbox: boolean · Auswahl: Options-ID · Mehrfachauswahl: IDs */
export type CellValue = string | number | boolean | string[] | null;

/** Pseudo-Property für den Titel eines Eintrags (in Filtern und Sortierungen). */
export const TITLE_PROPERTY = '__title';

export type FilterOperator =
  | 'contains'
  | 'not_contains'
  | 'is'
  | 'is_not'
  | 'is_empty'
  | 'is_not_empty'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'before'
  | 'after'
  | 'is_checked'
  | 'is_unchecked';

export interface Filter {
  id: string;
  propertyId: string;
  operator: FilterOperator;
  value: CellValue;
}

export interface Sort {
  propertyId: string;
  direction: 'asc' | 'desc';
}

export interface ViewConfig {
  filters: Filter[];
  /** Verknüpfung der Filter */
  filterMode: 'and' | 'or';
  /** Kalender: Datums-Property */
  dateBy: string | null;
  sorts: Sort[];
  widths: Record<string, number>;
  hidden: string[];
  groupBy: string | null;
  /** Board: ausgeblendete Spalten (Options-IDs, „__none__“ für „Ohne …“) */
  hiddenGroups?: string[];
}

export type ViewType = 'table' | 'board' | 'calendar' | 'gallery' | 'list';

export interface View {
  id: string;
  databaseId: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
  sortOrder: number;
}

export const emptyConfig = (): ViewConfig => ({ filters: [], filterMode: 'and', dateBy: null, sorts: [], widths: {}, hidden: [], groupBy: null });

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export async function loadSchema(databaseId: string): Promise<{ properties: Property[]; views: View[] }> {
  const [props, views] = await Promise.all([
    db().select<{ id: string; name: string; type: PropertyType; options: string; config: string; sort_order: number }>(
      'SELECT id, name, type, options, config, sort_order FROM db_properties WHERE database_id = ? ORDER BY sort_order, rowid',
      [databaseId],
    ),
    db().select<{ id: string; name: string; type: ViewType; config: string; sort_order: number }>(
      'SELECT id, name, type, config, sort_order FROM db_views WHERE database_id = ? ORDER BY sort_order, rowid',
      [databaseId],
    ),
  ]);
  return {
    properties: props.map((r) => ({
      id: r.id,
      databaseId,
      name: r.name,
      type: r.type,
      options: parseJson<SelectOption[]>(r.options, []),
      config: parseJson<PropertyConfig>(r.config, {}),
      sortOrder: Number(r.sort_order),
    })),
    views: views.map((r) => ({
      id: r.id,
      databaseId,
      name: r.name,
      type: r.type,
      config: { ...emptyConfig(), ...parseJson<Partial<ViewConfig>>(r.config, {}) },
      sortOrder: Number(r.sort_order),
    })),
  };
}

/** Alle Werte der Einträge einer Datenbank: Eintrag → Property → Wert. */
export async function loadValues(databaseId: string): Promise<Record<string, Record<string, CellValue>>> {
  const rows = await db().select<{ page_id: string; property_id: string; value: string }>(
    `SELECT v.page_id, v.property_id, v.value FROM db_values v
     JOIN pages p ON p.id = v.page_id WHERE p.parent_id = ?`,
    [databaseId],
  );
  const values: Record<string, Record<string, CellValue>> = {};
  for (const r of rows) (values[r.page_id] ??= {})[r.property_id] = parseJson<CellValue>(r.value, null);
  return values;
}

export function insertProperty(p: Property): Statement {
  return {
    sql: 'INSERT INTO db_properties (id, database_id, name, type, options, config, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: [p.id, p.databaseId, p.name, p.type, JSON.stringify(p.options), JSON.stringify(p.config), p.sortOrder],
  };
}

export function updateProperty(p: Property): Statement {
  return {
    sql: 'UPDATE db_properties SET name = ?, type = ?, options = ?, config = ?, sort_order = ? WHERE id = ?',
    params: [p.name, p.type, JSON.stringify(p.options), JSON.stringify(p.config), p.sortOrder, p.id],
  };
}

export function deleteProperty(id: string): Statement {
  return { sql: 'DELETE FROM db_properties WHERE id = ?', params: [id] };
}

export const isEmptyValue = (value: CellValue | undefined): boolean =>
  value === null || value === undefined || value === '' || value === false || (Array.isArray(value) && value.length === 0);

/** Leere Werte werden gelöscht statt gespeichert. Existiert Eintrag oder Property nicht mehr, passiert nichts. */
export function setValue(pageId: string, propertyId: string, value: CellValue): Statement {
  if (isEmptyValue(value)) {
    return { sql: 'DELETE FROM db_values WHERE page_id = ? AND property_id = ?', params: [pageId, propertyId] };
  }
  return {
    sql: `INSERT INTO db_values (page_id, property_id, value)
          SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM pages WHERE id = ?) AND EXISTS (SELECT 1 FROM db_properties WHERE id = ?)
          ON CONFLICT(page_id, property_id) DO UPDATE SET value = excluded.value`,
    params: [pageId, propertyId, JSON.stringify(value), pageId, propertyId],
  };
}

export function insertView(v: View): Statement {
  return {
    sql: 'INSERT INTO db_views (id, database_id, name, type, config, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    params: [v.id, v.databaseId, v.name, v.type, JSON.stringify(v.config), v.sortOrder],
  };
}

export function updateView(v: View): Statement {
  return {
    sql: 'UPDATE db_views SET name = ?, type = ?, config = ?, sort_order = ? WHERE id = ?',
    params: [v.name, v.type, JSON.stringify(v.config), v.sortOrder, v.id],
  };
}

export function deleteView(id: string): Statement {
  return { sql: 'DELETE FROM db_views WHERE id = ?', params: [id] };
}

/** Durchsuchbarer Text der Datenbank-Werte eines Eintrags (Spalte props der Volltextsuche). */
export function setSearchProps(pageId: string, text: string): Statement {
  return {
    sql: 'UPDATE pages_fts SET props = ? WHERE rowid = (SELECT rid FROM pages WHERE id = ?)',
    params: [text, pageId],
  };
}
