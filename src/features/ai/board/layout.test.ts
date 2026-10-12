import { describe, expect, it } from 'vitest';
import { layoutBoard, layoutClusters, wrap } from './layout';
import { normalizePlan, type BoardPlan } from './plan';
import { repairClusters } from './request';

const base: BoardPlan = {
  title: 'Briefs',
  subtitle: '',
  layout: 'matrix',
  columns: [
    { label: 'Problem', color: 'yellow' },
    { label: 'Hebel', color: 'green' },
  ],
  rows: [
    { label: 'Automotive', sublabel: 'Pendeln', badge: '8,5', highlight: true, cells: [['a', 'b', 'c'], ['d']] },
    { label: 'Museum', sublabel: '', badge: '', highlight: false, cells: [['e'], []] },
  ],
  groups: [],
  steps: [],
  takeaways: ['x'],
};

const notes = (els: ReturnType<typeof layoutBoard>['elements']) =>
  els.filter((e) => e.type === 'rectangle' && e.label).map((e) => (e.type === 'rectangle' ? e.label?.text : ''));

describe('Board-Layout', () => {
  it('Matrix: ein Post-it pro Notiz, Erkenntnisse unten', () => {
    const { elements, height } = layoutBoard(base, { x: 100, y: 50 });
    expect(notes(elements)).toEqual(['a', 'b', 'c', 'd', 'e', 'x']);
    expect(height).toBeGreaterThan(400);
    expect(elements.every((e) => e.x >= 100 && e.y >= 50)).toBe(true);
  });

  it('Zeilen wachsen mit der Zahl der Post-its und überlappen nicht', () => {
    const { elements } = layoutBoard(base, { x: 0, y: 0 });
    const frames = elements.filter((e) => e.type === 'rectangle' && e.backgroundColor === '#f8f9fa');
    expect(frames).toHaveLength(2);
    const [a, b] = frames as { y: number; height: number }[];
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  });

  it('fällt auf Cluster oder Ablauf zurück, wenn die Matrix leer ist', () => {
    const plan = { ...base, layout: 'matrix' as const, columns: [], rows: [], groups: [{ label: 'G', color: 'pink' as const, notes: ['n1', 'n2'] }] };
    expect(notes(layoutBoard(plan, { x: 0, y: 0 }).elements)).toEqual(['n1', 'n2', 'x']);
    const flow = { ...base, layout: 'flow' as const, steps: ['eins', 'zwei'] };
    const els = layoutBoard(flow, { x: 0, y: 0 }).elements;
    expect(els.filter((e) => e.type === 'arrow')).toHaveLength(1);
  });

  it('normalisiert Zellen auf die Spaltenzahl', () => {
    const plan = normalizePlan({ ...base, rows: [{ ...base.rows[0], cells: [['a'], ['b'], ['zu viel']] }] });
    expect(plan.rows[0].cells).toEqual([['a'], ['b']]);
  });

  it('bricht an Wortgrenzen um', () => {
    expect(wrap('eins zwei drei vier', 9)).toBe('eins zwei\ndrei vier');
  });
});

describe('Clustern', () => {
  it('jede Notiz genau einmal, Rest in „Sonstiges“', () => {
    const plan = repairClusters({ groups: [{ label: 'A', color: 'blue', notes: [0, 2, 2, 9] }] }, 4);
    expect(plan.groups).toEqual([
      { label: 'A', color: 'blue', notes: [0, 2] },
      { label: 'Sonstiges', color: 'gray', notes: [1, 3] },
    ]);
  });

  it('ordnet Notizen in Gruppen-Rahmen an', () => {
    const { positions, headers } = layoutClusters([{ label: 'A', color: 'blue', notes: [0, 1, 2] }], { x: 0, y: 0 }, 200);
    expect(positions.size).toBe(3);
    expect(positions.get(1)!.x - positions.get(0)!.x).toBe(212);
    expect(headers).toHaveLength(2);
  });
});

describe('Vorlagen', () => {
  it('leere Gruppen mit Überschrift bleiben als Rahmen stehen', () => {
    const plan = normalizePlan({ ...base, layout: 'clusters', columns: [], rows: [], takeaways: [], groups: [{ label: 'Ziele', color: 'blue', notes: [] }] });
    expect(plan.groups).toHaveLength(1);
    const els = layoutBoard(plan, { x: 0, y: 0 }).elements;
    expect(els.some((e) => e.type === 'text' && e.text === 'Ziele')).toBe(true);
  });
});
