import { COMPUTED_TYPES, TAG_COLORS, type CellValue, type Property, type SelectOption } from '../../../db/database';
import { newId } from '../../../lib/ids';
import { valueText } from '../../database/query';

/**
 * Datenbanken mit KI: Claude sieht die Spalten und Einträge als Tabelle und liefert neue Einträge
 * und geänderte Werte als Text. efeu wandelt die Texte passend zum Spaltentyp um (Zahl, Datum,
 * Auswahl, …) und legt fehlende Auswahloptionen an.
 */

/** Spalten, die die KI befüllen darf */
export const writable = (p: Property) => !COMPUTED_TYPES.includes(p.type) && p.type !== 'relation';

const TYPE_HINT: Record<string, string> = {
  text: 'Text',
  number: 'Zahl',
  select: 'Auswahl',
  multi_select: 'Mehrfachauswahl, durch Komma getrennt',
  date: 'Datum JJJJ-MM-TT',
  checkbox: 'ja/nein',
  url: 'URL',
};

export interface DbSnapshot {
  properties: Property[];
  rows: { id: string; title: string; values: Record<string, CellValue> }[];
}

export interface DbRowValue {
  column: string;
  value: string;
}

export interface DbEditPlan {
  summary: string;
  add: { title: string; values: DbRowValue[] }[];
  update: { row: string; title: string; values: DbRowValue[] }[];
}

const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const values = { type: 'array', items: obj({ column: { type: 'string' }, value: { type: 'string' } }) };

export const DB_EDIT_SCHEMA = obj({
  summary: { type: 'string' },
  add: { type: 'array', items: obj({ title: { type: 'string' }, values }) },
  update: { type: 'array', items: obj({ row: { type: 'string' }, title: { type: 'string' }, values }) },
});

const cell = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');

/** Tabelle für Claude: Spalten mit Typ und Optionen, Einträge mit Kurz-ID (r1, r2, …). */
export function describeDatabase(db: DbSnapshot, titleOf: (id: string) => string, maxRows = 300): string {
  const cols = db.properties.filter((p) => p.type !== 'formula' && p.type !== 'rollup');
  const schema = cols
    .map((p) => {
      const hint = writable(p) ? TYPE_HINT[p.type] : 'nur lesen';
      const options = p.options.length ? `; Optionen: ${p.options.map((o) => o.name).join(', ')}` : '';
      return `- ${p.name} (${hint}${options})`;
    })
    .join('\n');
  const header = `| id | Titel | ${cols.map((p) => cell(p.name)).join(' | ')} |`;
  const rows = db.rows
    .slice(0, maxRows)
    .map((r, i) => `| r${i + 1} | ${cell(r.title)} | ${cols.map((p) => cell(valueText(p, r.values[p.id], titleOf))).join(' | ')} |`);
  const more = db.rows.length > maxRows ? `\n(… ${db.rows.length - maxRows} weitere Einträge nicht gezeigt)` : '';
  return `Spalten:\n${schema || '(nur Titel)'}\n\n${header}\n${rows.join('\n')}${more}`;
}

const TRUE = /^(ja|yes|true|wahr|x|✓|1|erledigt|done)$/i;

/** Wert als Text → Zellwert passend zum Typ; unbrauchbar → undefined. Neue Optionen werden gesammelt. */
export function toCellValue(property: Property, raw: string, newOptions: SelectOption[]): CellValue | undefined {
  const text = raw.trim();
  if (!text) return null;
  const option = (name: string) => {
    const all = [...property.options, ...newOptions];
    const found = all.find((o) => o.name.toLocaleLowerCase('de') === name.toLocaleLowerCase('de'));
    if (found) return found.id;
    const created: SelectOption = { id: newId(), name, color: TAG_COLORS[all.length % TAG_COLORS.length] };
    newOptions.push(created);
    return created.id;
  };
  switch (property.type) {
    case 'number': {
      const n = Number(text.replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'checkbox':
      return TRUE.test(text);
    case 'date': {
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
      if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
      const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text);
      return de ? `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}` : undefined;
    }
    case 'select':
      return option(text);
    case 'multi_select':
      return [...new Set(text.split(/[,;]/).map((s) => s.trim()).filter(Boolean).map(option))];
    case 'text':
    case 'url':
      return text;
    default:
      return undefined;
  }
}

export interface DbChange {
  kind: 'added' | 'changed';
  before: string;
  after: string;
}

export interface DbApply {
  /** Neue Einträge: Titel und Werte je Property-ID */
  add: { title: string; values: Record<string, CellValue> }[];
  /** Geänderte Einträge */
  update: { rowId: string; title: string | null; values: Record<string, CellValue> }[];
  /** Neue Auswahloptionen je Property-ID */
  options: Map<string, SelectOption[]>;
  changes: DbChange[];
}

/** Übersetzt Claudes Plan in konkrete Werte; unbekannte Spalten und Einträge werden ignoriert. */
export function planDatabase(plan: DbEditPlan, db: DbSnapshot, titleOf: (id: string) => string): DbApply {
  const byName = new Map(db.properties.filter(writable).map((p) => [p.name.toLocaleLowerCase('de'), p]));
  const options = new Map<string, SelectOption[]>();
  const convert = (vals: DbRowValue[]) => {
    const out: Record<string, CellValue> = {};
    for (const v of vals) {
      const p = byName.get(v.column.trim().toLocaleLowerCase('de'));
      if (!p) continue;
      const list = options.get(p.id) ?? [];
      const value = toCellValue(p, v.value, list);
      if (list.length) options.set(p.id, list);
      if (value !== undefined) out[p.id] = value;
    }
    return out;
  };
  const describe = (vals: DbRowValue[]) => vals.map((v) => `${v.column}: ${v.value}`).join(' · ');
  const result: DbApply = { add: [], update: [], options, changes: [] };
  for (const a of plan.add) {
    if (!a.title.trim() && !a.values.length) continue;
    result.add.push({ title: a.title.trim(), values: convert(a.values) });
    result.changes.push({ kind: 'added', before: '', after: [a.title.trim(), describe(a.values)].filter(Boolean).join(' — ') });
  }
  for (const u of plan.update) {
    const index = Number(/^r(\d+)$/.exec(u.row.trim())?.[1]) - 1;
    const row = db.rows[index];
    if (!row) continue;
    const vals = convert(u.values);
    const title = u.title.trim() && u.title.trim() !== row.title ? u.title.trim() : null;
    if (!title && !Object.keys(vals).length) continue;
    result.update.push({ rowId: row.id, title, values: vals });
    const before = db.properties
      .filter((p) => p.id in vals)
      .map((p) => `${p.name}: ${valueText(p, row.values[p.id], titleOf) || '–'}`)
      .join(' · ');
    result.changes.push({
      kind: 'changed',
      before: [row.title, before].filter(Boolean).join(' — '),
      after: [title ?? row.title, describe(u.values)].filter(Boolean).join(' — '),
    });
  }
  return result;
}
