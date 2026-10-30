import { TableCell as BaseCell, TableHeader as BaseHeader } from '@tiptap/extension-table';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { colorName } from '../colors';

export type CellAlign = 'left' | 'center' | 'right';
const ALIGNS = new Set<string>(['left', 'center', 'right']);

/** Hintergrundfarbe und Ausrichtung je Zelle (gilt für normale und Kopfzellen). */
const cellAttributes = () => ({
  background: {
    default: null,
    parseHTML: (el: HTMLElement) => colorName(el.getAttribute('data-bg')),
    renderHTML: (attrs: Record<string, unknown>) => (colorName(attrs.background) ? { 'data-bg': attrs.background } : {}),
  },
  align: {
    default: null,
    parseHTML: (el: HTMLElement) => {
      const value = el.getAttribute('data-align') ?? el.style.textAlign;
      return ALIGNS.has(value) ? value : null;
    },
    renderHTML: (attrs: Record<string, unknown>) =>
      typeof attrs.align === 'string' && ALIGNS.has(attrs.align) ? { 'data-align': attrs.align } : {},
  },
});

export const TableCell = BaseCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellAttributes() };
  },
});

export const TableHeader = BaseHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellAttributes() };
  },
});

/** Tabelle, in der eine Position liegt: Startposition und Knoten. */
export function tableAt(state: EditorState, pos: number): { pos: number; node: PMNode } | null {
  const $pos = state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.spec.tableRole === 'table') return { pos: $pos.before(d), node };
  }
  return null;
}

/** Zellen als Raster (Zeilen × Spalten), nur wenn keine Zelle verbunden ist. */
export function toGrid(table: PMNode): PMNode[][] | null {
  const grid: PMNode[][] = [];
  let ok = true;
  table.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((cell) => {
      if (cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) ok = false;
      cells.push(cell);
    });
    grid.push(cells);
  });
  const width = grid[0]?.length ?? 0;
  return ok && width > 0 && grid.every((r) => r.length === width) ? grid : null;
}

/**
 * Baut die Tabelle aus einem umgestellten Raster neu. Kopfzeile und Kopfspalte bleiben, wo sie waren:
 * Jede Position übernimmt die Zellart (Kopf/normal) der alten Tabelle an dieser Stelle.
 */
export function fromGrid(table: PMNode, before: PMNode[][], grid: PMNode[][]): PMNode {
  const rowType = table.child(0).type;
  const rows = grid.map((cells, r) => {
    const original = before[Math.min(r, before.length - 1)];
    return rowType.create(
      null,
      Fragment.from(
        cells.map((cell, c) => {
          const type = original[Math.min(c, original.length - 1)].type;
          return cell.type === type ? cell : type.create(cell.attrs, cell.content, cell.marks);
        }),
      ),
    );
  });
  return table.type.create(table.attrs, Fragment.from(rows), table.marks);
}

/** Text einer Zelle zum Sortieren. */
const cellText = (cell: PMNode) => cell.textContent.trim();

/** Zahl in deutscher oder englischer Schreibweise, sonst null. */
function asNumber(text: string): number | null {
  const clean = text.replace(/[\s€$%]/g, '');
  if (!/^-?[\d.,]+$/.test(clean)) return null;
  const normalized = /,\d{1,2}$/.test(clean) || /\.\d{3}(,|$)/.test(clean) ? clean.replace(/\./g, '').replace(',', '.') : clean.replace(/,/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** Vergleich für die Sortierung: Zahlen als Zahlen, sonst alphabetisch; leere Zellen immer ans Ende. */
export function compareCells(a: string, b: string): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return collator.compare(a, b);
}

const isHeaderRow = (row: PMNode[]) => row.every((cell) => cell.type.spec.tableRole === 'header_cell');

export type GridOp =
  | { kind: 'duplicateRow' | 'duplicateColumn'; index: number }
  | { kind: 'moveRow' | 'moveColumn'; index: number; by: -1 | 1 }
  | { kind: 'sort'; column: number; descending: boolean };

/** Wendet eine Rasteroperation an; null, wenn sie nicht geht (verbundene Zellen oder Rand erreicht). */
export function applyGridOp(table: PMNode, op: GridOp): PMNode | null {
  const before = toGrid(table);
  if (!before) return null;
  const grid = before.map((row) => [...row]);
  const width = grid[0].length;
  switch (op.kind) {
    case 'duplicateRow':
      grid.splice(op.index + 1, 0, grid[op.index].map((cell) => cell.copy(cell.content)));
      break;
    case 'duplicateColumn':
      for (const row of grid) row.splice(op.index + 1, 0, row[op.index].copy(row[op.index].content));
      break;
    case 'moveRow': {
      const to = op.index + op.by;
      if (to < 0 || to >= grid.length) return null;
      [grid[op.index], grid[to]] = [grid[to], grid[op.index]];
      break;
    }
    case 'moveColumn': {
      const to = op.index + op.by;
      if (to < 0 || to >= width) return null;
      for (const row of grid) [row[op.index], row[to]] = [row[to], row[op.index]];
      break;
    }
    case 'sort': {
      let head = 0;
      while (head < grid.length && isHeaderRow(grid[head])) head++;
      const body = grid.slice(head);
      body.sort((a, b) => {
        const order = compareCells(cellText(a[op.column]), cellText(b[op.column]));
        // Leere Zellen bleiben auch absteigend am Ende.
        const emptyA = !cellText(a[op.column]);
        const emptyB = !cellText(b[op.column]);
        return op.descending && !emptyA && !emptyB ? -order : order;
      });
      grid.splice(head, body.length, ...body);
      break;
    }
  }
  return fromGrid(table, before, grid);
}

/** Ersetzt die Tabelle an `pos` durch das Ergebnis der Rasteroperation. */
export function gridOp(state: EditorState, tablePos: number, op: GridOp): Transaction | null {
  const table = state.doc.nodeAt(tablePos);
  if (!table) return null;
  const next = applyGridOp(table, op);
  if (!next) return null;
  return state.tr.replaceWith(tablePos, tablePos + table.nodeSize, next);
}

/** Wählt eine ganze Zeile oder Spalte als Zellauswahl aus. */
export function lineSelection(state: EditorState, tablePos: number, line: 'row' | 'column', index: number): CellSelection | null {
  const table = state.doc.nodeAt(tablePos);
  if (!table) return null;
  const map = TableMap.get(table);
  const start = tablePos + 1;
  if (line === 'row') {
    if (index >= map.height) return null;
    const $a = state.doc.resolve(start + map.map[index * map.width]);
    const $b = state.doc.resolve(start + map.map[index * map.width + map.width - 1]);
    return CellSelection.rowSelection($a, $b);
  }
  if (index >= map.width) return null;
  const $a = state.doc.resolve(start + map.map[index]);
  const $b = state.doc.resolve(start + map.map[(map.height - 1) * map.width + index]);
  return CellSelection.colSelection($a, $b);
}
