import { beforeEach, describe, expect, it } from 'vitest';
import { loadDoc } from '../../db/content';
import { loadSchema, loadValues } from '../../db/database';
import { flush } from '../../db/saveQueue';
import { usePages } from '../../store/pages';
import { freshDatabase } from '../../test/setup';
import { cellValue, inferColumn, parseCsv, parseNotionDate, stripPropertyLines } from './notion';
import { importEntries } from './transfer';

describe('CSV aus Notion', () => {
  it('liest Anführungszeichen, Kommas und Zeilenumbrüche in Feldern', () => {
    expect(parseCsv('﻿Name,Notiz\r\n"Einkauf, groß","Zeile 1\nZeile 2"\r\nB,"Er sagte ""Hallo"""\r\n')).toEqual([
      ['Name', 'Notiz'],
      ['Einkauf, groß', 'Zeile 1\nZeile 2'],
      ['B', 'Er sagte "Hallo"'],
    ]);
  });

  it('versteht Notions Datumsformat', () => {
    expect(parseNotionDate('October 8, 2026')).toBe('2026-10-08');
    expect(parseNotionDate('March 3, 2026 2:30 PM → March 5, 2026')).toBe('2026-03-03');
    expect(parseNotionDate('2026-01-31')).toBe('2026-01-31');
    expect(parseNotionDate('demnächst')).toBeNull();
  });

  it('erkennt Spaltentypen', () => {
    expect(inferColumn('Erledigt', ['Yes', 'No', '']).type).toBe('checkbox');
    expect(inferColumn('Preis', ['12', '3.5', '1,200']).type).toBe('number');
    expect(inferColumn('Fällig', ['October 8, 2026', '']).type).toBe('date');
    expect(inferColumn('Link', ['https://efeu.app']).type).toBe('url');
    expect(inferColumn('Status', ['Offen', 'Erledigt', 'Offen'])).toEqual({ name: 'Status', type: 'select', options: ['Offen', 'Erledigt'] });
    expect(inferColumn('Tags', ['Arbeit, Privat', 'Arbeit'])).toEqual({ name: 'Tags', type: 'multi_select', options: ['Arbeit', 'Privat'] });
    const notes = ['Ganz eigener Text eins', 'Noch ein ganz anderer', 'Und ein dritter', 'Vierter', 'Fünfter', 'Sechster', 'Siebter'];
    expect(inferColumn('Notiz', notes).type).toBe('text');
    expect(cellValue({ name: 'Tags', type: 'multi_select', options: [] }, 'A, B')).toEqual(['A', 'B']);
  });

  it('entfernt die Eigenschaftszeilen unter dem Titel', () => {
    const md = '# Einkauf\n\nStatus: Offen\nFällig: October 8, 2026\n\nMilch und Brot\n';
    expect(stripPropertyLines(md, ['Name', 'Status', 'Fällig'])).toBe('# Einkauf\n\n\nMilch und Brot\n');
    expect(stripPropertyLines('# Titel\n\nNormaler Text: mit Doppelpunkt', ['Status'])).toBe('# Titel\n\nNormaler Text: mit Doppelpunkt');
  });
});

describe('Import eines Notion-Exports', () => {
  beforeEach(async () => {
    await freshDatabase();
  });

  it('macht aus CSV und Eintrags-Seiten eine Datenbank mit Werten und Inhalten', async () => {
    const id = '0123456789abcdef0123456789abcdef';
    const db = 'fedcba9876543210fedcba9876543210';
    const row = '11111111111111111111111111111111';
    await importEntries(
      [
        { rel: `Projekt ${id}.md`, abs: `/x/Projekt ${id}.md`, content: `# Projekt\n\nSiehe [Aufgaben](Projekt%20${id}/Aufgaben%20${db}.csv)\n` },
        {
          rel: `Projekt ${id}/Aufgaben ${db}.csv`,
          abs: `/x/Projekt ${id}/Aufgaben ${db}.csv`,
          content: 'Name,Status,Fällig,Tags\nEinkauf,Offen,"October 8, 2026","Privat, Wichtig"\nSteuer,Erledigt,,Arbeit\n',
        },
        {
          rel: `Projekt ${id}/Aufgaben ${db}/Einkauf ${row}.md`,
          abs: `/x/Projekt ${id}/Aufgaben ${db}/Einkauf ${row}.md`,
          content: '# Einkauf\n\nStatus: Offen\nFällig: October 8, 2026\nTags: Privat, Wichtig\n\nMilch und Brot\n',
        },
      ],
      'Notion',
    );
    await flush();
    const pages = Object.values(usePages.getState().pages);
    const database = pages.find((p) => p.type === 'database')!;
    expect(database.title).toBe('Aufgaben');
    expect(pages.find((p) => p.id === database.parentId)?.title).toBe('Projekt');

    const schema = await loadSchema(database.id);
    expect(schema.properties.map((p) => [p.name, p.type])).toEqual([
      ['Status', 'select'],
      ['Fällig', 'date'],
      ['Tags', 'multi_select'],
    ]);
    expect(schema.views.map((v) => v.type)).toEqual(['table', 'board']);

    const rows = pages.filter((p) => p.parentId === database.id);
    expect(rows.map((r) => r.title).sort()).toEqual(['Einkauf', 'Steuer']);
    const einkauf = rows.find((r) => r.title === 'Einkauf')!;
    const values = (await loadValues(database.id))[einkauf.id];
    const [status, due, tags] = schema.properties;
    expect(values[status.id]).toBe(status.options.find((o) => o.name === 'Offen')!.id);
    expect(values[due.id]).toBe('2026-10-08');
    expect((values[tags.id] as string[]).map((t) => tags.options.find((o) => o.id === t)!.name)).toEqual(['Privat', 'Wichtig']);

    const content = JSON.stringify(await loadDoc(einkauf.id));
    expect(content).toContain('Milch und Brot');
    expect(content).not.toContain('Status: Offen');
    // Der Link auf die CSV-Datei zeigt auf die importierte Datenbank.
    const projekt = pages.find((p) => p.title === 'Projekt')!;
    expect(JSON.stringify(await loadDoc(projekt.id))).toContain(database.id);
  });
});
