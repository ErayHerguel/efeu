// @vitest-environment jsdom
import type { Editor, JSONContent } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEditor } from '../../test/editor';
import { compareCells, gridOp, lineSelection } from './table';

let editor: Editor;
afterEach(() => editor?.destroy());

const cell = (text: string, type = 'tableCell', attrs: Record<string, unknown> = {}): JSONContent => ({
  type,
  attrs,
  content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
});
const table = (rows: string[][], header = true): JSONContent => ({
  type: 'doc',
  content: [
    {
      type: 'table',
      content: rows.map((r, i) => ({ type: 'tableRow', content: r.map((t) => cell(t, header && i === 0 ? 'tableHeader' : 'tableCell')) })),
    },
  ],
});
/** Tabelle als Text-Raster und Zellarten (h = Kopf, c = normal). */
const read = () => {
  const t = editor.state.doc.child(0);
  const rows: string[][] = [];
  const kinds: string[] = [];
  t.forEach((row) => {
    const r: string[] = [];
    let k = '';
    row.forEach((c) => {
      r.push(c.textContent);
      k += c.type.name === 'tableHeader' ? 'h' : 'c';
    });
    rows.push(r);
    kinds.push(k);
  });
  return { rows, kinds };
};
const run = (op: Parameters<typeof gridOp>[2]) => {
  const tr = gridOp(editor.state, 0, op);
  if (tr) editor.view.dispatch(tr);
  return tr !== null;
};

describe('Tabellen', () => {
  it('sortiert nach einer Spalte, Kopfzeile bleibt oben, leere Zellen ans Ende', () => {
    editor = createTestEditor(table([['Name', 'Preis'], ['Birne', '10'], ['', '2,50'], ['apfel', '1.000'], ['Zitrone', '']]));
    expect(run({ kind: 'sort', column: 0, descending: false })).toBe(true);
    expect(read().rows.map((r) => r[0])).toEqual(['Name', 'apfel', 'Birne', 'Zitrone', '']);
    run({ kind: 'sort', column: 1, descending: true });
    expect(read().rows.map((r) => r[1])).toEqual(['Preis', '1.000', '10', '2,50', '']);
    expect(read().kinds[0]).toBe('hh');
  });

  it('dupliziert und verschiebt Zeilen und Spalten, Kopfzeile bleibt an ihrer Stelle', () => {
    editor = createTestEditor(table([['A', 'B'], ['1', '2']]));
    run({ kind: 'duplicateRow', index: 0 });
    expect(read()).toEqual({ rows: [['A', 'B'], ['A', 'B'], ['1', '2']], kinds: ['hh', 'cc', 'cc'] });
    run({ kind: 'moveRow', index: 2, by: -1 });
    expect(read().rows).toEqual([['A', 'B'], ['1', '2'], ['A', 'B']]);
    run({ kind: 'duplicateColumn', index: 1 });
    expect(read().rows[0]).toEqual(['A', 'B', 'B']);
    run({ kind: 'moveColumn', index: 0, by: 1 });
    expect(read().rows[1]).toEqual(['2', '1', '2']);
    expect(run({ kind: 'moveColumn', index: 2, by: 1 })).toBe(false);
  });

  it('lehnt Umstellen bei verbundenen Zellen ab', () => {
    editor = createTestEditor({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [cell('A', 'tableCell', { colspan: 2 })] },
            { type: 'tableRow', content: [cell('1'), cell('2')] },
          ],
        },
      ],
    });
    expect(run({ kind: 'sort', column: 0, descending: false })).toBe(false);
  });

  it('wählt ganze Zeilen und Spalten aus und färbt Zellen', () => {
    editor = createTestEditor(table([['A', 'B'], ['1', '2']]));
    const sel = lineSelection(editor.state, 0, 'column', 1);
    expect(sel).toBeInstanceOf(CellSelection);
    editor.view.dispatch(editor.state.tr.setSelection(sel!));
    editor.chain().setCellAttribute('background', 'blue').setCellAttribute('align', 'right').run();
    const json = editor.getJSON() as JSONContent;
    const rows = json.content![0].content as JSONContent[];
    const cols = rows.map((r) => (r.content as JSONContent[])[1].attrs);
    expect(cols.every((a) => a?.background === 'blue' && a?.align === 'right')).toBe(true);
    expect((rows[0].content as JSONContent[])[0].attrs?.background).toBeNull();
    expect(editor.getHTML()).toContain('data-bg="blue"');
  });

  it('vergleicht Zahlen und Text sinnvoll', () => {
    expect(compareCells('2', '10')).toBeLessThan(0);
    expect(compareCells('1,5', '1.4')).toBeGreaterThan(0);
    expect(compareCells('Äpfel', 'Birnen')).toBeLessThan(0);
    expect(compareCells('', 'a')).toBeGreaterThan(0);
  });
});
