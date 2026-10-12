import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { create } from 'zustand';
import { loadDoc, saveContent } from '../../../db/content';
import { getActiveEditor } from '../../../editor/active';
import { collectLinkTargets, jsonText } from '../../../lib/doc';
import { usePages } from '../../../store/pages';
import { toast } from '../../../store/toast';
import { useUI } from '../../../store/ui';
import { createBoard } from '../../board/create';
import { useActiveBoard, waitForBoard, type BoardBridge } from '../../board/active';
import { layoutBoard, type Skeleton } from '../board/layout';
import { normalizePlan } from '../board/plan';
import { AiCancelled, askAi, costNote, type AiResult } from '../client';
import { toAiMarkdown } from '../markdown';
import { applyPageOps } from './applyPage';
import { discardWrite } from '../writeSession';
import {
  buildModel,
  describeBoard,
  describeBoardChanges,
  planEdits,
  validBoardOps,
  type BoardChange,
  type BoardEditPlan,
  type BoardEl,
  type BoardModel,
  type BoardOp,
} from './boardModel';
import { clusterNotes, freeOrigin } from './cluster';
import { applyOps, describeChanges, pageBlocks, serializeBlocks, validOps, type PageChange, type PageEditPlan, type PageOp } from './pageModel';
import { boardEditRequest, databaseEditRequest, pageEditRequest, type Attachment } from './requests';
import { describeDatabase, planDatabase, type DbApply, type DbChange, type DbEditPlan, type DbSnapshot } from './dbModel';
import { useDatabases } from '../../../store/databases';

/**
 * Die KI-Leiste: eine Anweisung (plus angehängte PDF oder Seite) für die geöffnete Seite oder das
 * geöffnete Board. Claude liefert Änderungen, flou zeigt sie als Vorschau; übernommen wird erst auf Klick.
 */

export interface Preview {
  summary: string;
  changes: (PageChange | BoardChange | DbChange)[];
  /** Neuer Board-Inhalt, z. B. „Matrix mit 5 Zeilen“ */
  created: string | null;
  cost: number;
  note: string;
}

interface BarState {
  open: boolean;
  instruction: string;
  attachments: Attachment[];
  /** Notizen: Ergebnis als neue Unterseite statt in der aktuellen Seite */
  newPage: boolean;
  status: 'idle' | 'running' | 'preview' | 'error';
  /** Gestreamte Zeichen, als Lebenszeichen während Claude arbeitet */
  progress: number;
  error: string | null;
  preview: Preview | null;
}

export const useAiBar = create<BarState>(() => ({
  open: false,
  instruction: '',
  attachments: [],
  newPage: false,
  status: 'idle',
  progress: 0,
  error: null,
  preview: null,
}));

type Pending =
  | { kind: 'page'; pageId: string; snapshot: PMNode; ops: PageOp[]; plan: PageEditPlan; newPage: boolean }
  | { kind: 'board'; pageId: string; model: BoardModel; elements: BoardEl[]; ops: BoardOp[]; plan: BoardEditPlan; created: Skeleton[] }
  | { kind: 'database'; pageId: string; apply: DbApply; plan: DbEditPlan };

let pending: Pending | null = null;
let controller: AbortController | null = null;

export function openAiBar(preset: Partial<Pick<BarState, 'instruction' | 'attachments' | 'newPage'>> = {}): void {
  discardWrite();
  controller?.abort();
  pending = null;
  useAiBar.setState({ open: true, status: 'idle', error: null, preview: null, progress: 0, instruction: '', attachments: [], newPage: false, ...preset });
}

export function closeAiBar(): void {
  controller?.abort();
  pending = null;
  useAiBar.setState({ open: false, status: 'idle', preview: null, error: null, instruction: '', attachments: [] });
}

export function stopAiBar(): void {
  controller?.abort();
  useAiBar.setState({ status: pending ? 'preview' : 'idle' });
}

/** Seite als Anhang (Inhalt als Markdown) */
export async function pageAttachment(pageId: string): Promise<Attachment> {
  const page = usePages.getState().pages[pageId];
  const doc = await loadDoc(pageId);
  const markdown = doc ? toAiMarkdown(doc) : '';
  if (!markdown.trim()) throw new Error('Die Seite ist leer.');
  return { kind: 'page', id: pageId, title: page?.title || 'Ohne Titel', markdown };
}

const currentPage = () => {
  const id = useUI.getState().currentId;
  return id ? usePages.getState().pages[id] : undefined;
};

/** Standard-Anweisung, wenn nur eine Quelle angehängt ist */
function defaultInstruction(board: boolean, attachments: Attachment[]): string {
  if (!attachments.length) return '';
  return board ? 'Mach daraus ein übersichtliches Board.' : 'Übernimm den Inhalt als übersichtliche, gut gegliederte Notiz.';
}

/** Startet die Anweisung; mit vorhandener Vorschau wird diese verfeinert. */
export async function runAiBar(): Promise<void> {
  const page = currentPage();
  if (!page) return;
  const state = useAiBar.getState();
  const board = page.type === 'board';
  const database = page.type === 'database';
  const instruction =
    state.instruction.trim() ||
    (database && state.attachments.length ? 'Lege aus den Quellen passende Einträge an.' : defaultInstruction(board, state.attachments));
  if (!instruction) return;
  const previous = pending?.pageId === page.id ? pending : null;
  controller?.abort();
  const abort = new AbortController();
  controller = abort;
  useAiBar.setState({ status: 'running', error: null, progress: 0 });
  const onText = (_d: string, full: string) => useAiBar.setState({ progress: full.length });
  try {
    if (database) await runDatabase(page.id, instruction, state.attachments, previous?.kind === 'database' ? previous.plan : undefined, abort.signal, onText);
    else if (board) await runBoard(page.id, instruction, state.attachments, previous?.kind === 'board' ? previous.plan : undefined, abort.signal, onText);
    else await runPage(page.id, instruction, state.attachments, state.newPage, previous?.kind === 'page' ? previous.plan : undefined, abort.signal, onText);
  } catch (err) {
    if (err instanceof AiCancelled) return;
    useAiBar.setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

function parse<T>(result: AiResult): T {
  if (result.stopReason === 'max_tokens') throw new Error('Die Antwort war zu lang und wurde abgeschnitten. Teil die Aufgabe auf.');
  try {
    return JSON.parse(result.text) as T;
  } catch {
    throw new Error('Die Antwort war unvollständig. Versuch es noch einmal.');
  }
}

async function runPage(
  pageId: string,
  instruction: string,
  attachments: Attachment[],
  newPage: boolean,
  previous: PageEditPlan | undefined,
  signal: AbortSignal,
  onText: (d: string, full: string) => void,
): Promise<void> {
  const editor = getActiveEditor();
  if (!editor && !newPage) throw new Error('Die Seite ist nicht geöffnet.');
  if (editor && !newPage && !editor.isEditable) throw new Error('Diese Seite darfst du nicht bearbeiten.');
  // Für neue Seiten (auch vom Board aus) reicht ein leerer Stand.
  const snapshot = editor?.state.doc ?? (null as unknown as PMNode);
  const blocks = pageBlocks(newPage || !snapshot ? { type: 'doc', content: [] } : (snapshot.toJSON() as JSONContent));
  const blocksText = serializeBlocks(blocks);
  const request = pageEditRequest({
    pageTitle: usePages.getState().pages[pageId]?.title || 'Ohne Titel',
    blocksText,
    instruction,
    attachments,
    newPage,
    previous,
  });
  const result = await askAi(request, { signal, onText });
  if (!result) return void useAiBar.setState({ status: pending ? 'preview' : 'idle' });
  const plan = parse<PageEditPlan>(result);
  const ops = validOps(plan.ops, blocks);
  if (!ops.length) throw new Error(plan.summary ? `Keine Änderung: ${plan.summary}` : 'Claude hat nichts geändert. Formulier die Anweisung anders.');
  pending = { kind: 'page', pageId, snapshot, ops, plan: { ...plan, ops }, newPage };
  useAiBar.setState({
    status: 'preview',
    instruction: '',
    preview: {
      summary: plan.summary,
      changes: describeChanges(blocks, ops),
      created: newPage ? `Neue Unterseite „${plan.title || 'Ohne Titel'}“` : null,
      cost: result.cost,
      note: costNote(result),
    },
  });
}

/** Auswahl erweitern: ein markierter Rahmen bringt seine Post-its und die Überschrift mit. */
function focusFor(model: BoardModel, selected: string[]): Set<string> | null {
  if (!selected.length) return null;
  const focus = new Set(selected);
  for (const f of model.frames) {
    if (!focus.has(f.id)) continue;
    for (const n of model.notes) if (model.groupOf.get(n.id) === f.id) focus.add(n.id);
    const title = model.titleOf.get(f.id);
    if (title) focus.add(title.id);
  }
  return focus;
}

async function runBoard(
  pageId: string,
  instruction: string,
  attachments: Attachment[],
  previous: BoardEditPlan | undefined,
  signal: AbortSignal,
  onText: (d: string, full: string) => void,
): Promise<void> {
  const bridge = boardBridge(pageId);
  const snap = bridge.snapshot();
  const model = buildModel(snap.elements);
  const focus = focusFor(model, snap.selected);
  const boardText = describeBoard(model, focus);
  const request = boardEditRequest({
    boardText,
    selectionOnly: !!focus,
    instruction: boardText.trim() ? instruction : `${instruction}
(Das Board ist leer: erstelle den Inhalt über create.)`,
    attachments,
    previous,
  });
  const result = await askAi(request, { signal, onText });
  if (!result) return void useAiBar.setState({ status: pending ? 'preview' : 'idle' });
  const plan = parse<BoardEditPlan>(result);
  const ops = validBoardOps(plan.ops, model, focus);
  // Auch ohne gesetztes enabled übernehmen, wenn Claude Inhalt geliefert hat (oder das Board leer ist).
  const c0 = plan.create;
  const hasContent = c0.rows.length > 0 || c0.groups.length > 0 || c0.steps.length > 0 || c0.takeaways.length > 0;
  const created = plan.create.enabled || hasContent ? layoutBoard(normalizePlan(plan.create), freeOrigin(bridge.bounds())).elements : [];
  if (!ops.length && !created.length) throw new Error(plan.summary ? `Keine Änderung: ${plan.summary}` : 'Claude hat nichts geändert. Formulier die Anweisung anders.');
  pending = { kind: 'board', pageId, model, elements: snap.elements, ops, plan: { ...plan, ops }, created };
  const c = plan.create;
  const createdLabel = !created.length
    ? null
    : c.layout === 'matrix'
      ? `Neue Matrix: ${c.rows.length} Zeilen × ${c.columns.length} Spalten`
      : c.layout === 'flow'
        ? `Neuer Ablauf: ${c.steps.length} Schritte`
        : `Neue Gruppen: ${c.groups.length}`;
  useAiBar.setState({
    status: 'preview',
    instruction: '',
    preview: { summary: plan.summary, changes: describeBoardChanges(ops, model), created: createdLabel, cost: result.cost, note: costNote(result) },
  });
}

const titleOf = (id: string) => usePages.getState().pages[id]?.title ?? '';

function databaseSnapshot(databaseId: string): DbSnapshot {
  const data = useDatabases.getState().data[databaseId];
  if (!data) throw new Error('Die Datenbank ist noch nicht geladen.');
  const rowIds = (usePages.getState().children.get(databaseId) ?? []).filter((id) => usePages.getState().pages[id]?.deletedAt === null);
  return {
    properties: [...data.properties].sort((a, b) => a.sortOrder - b.sortOrder),
    rows: rowIds.map((id) => ({ id, title: titleOf(id), values: data.values[id] ?? {} })),
  };
}

async function runDatabase(
  pageId: string,
  instruction: string,
  attachments: Attachment[],
  previous: DbEditPlan | undefined,
  signal: AbortSignal,
  onText: (d: string, full: string) => void,
): Promise<void> {
  if (!useDatabases.getState().data[pageId]) await useDatabases.getState().load(pageId);
  const snapshot = databaseSnapshot(pageId);
  const request = databaseEditRequest({
    tableText: describeDatabase(snapshot, titleOf),
    title: titleOf(pageId) || 'Datenbank',
    instruction,
    attachments,
    previous,
  });
  const result = await askAi(request, { signal, onText });
  if (!result) return void useAiBar.setState({ status: pending ? 'preview' : 'idle' });
  const plan = parse<DbEditPlan>(result);
  const apply = planDatabase(plan, snapshot, titleOf);
  if (!apply.changes.length) throw new Error(plan.summary ? `Keine Änderung: ${plan.summary}` : 'Claude hat nichts geändert. Formulier die Anweisung anders.');
  pending = { kind: 'database', pageId, apply, plan };
  const added = apply.add.length;
  const changed = apply.update.length;
  useAiBar.setState({
    status: 'preview',
    instruction: '',
    preview: {
      summary: plan.summary,
      changes: apply.changes,
      created: [added ? `${added} neue Einträge` : '', changed ? `${changed} Einträge geändert` : ''].filter(Boolean).join(' · '),
      cost: result.cost,
      note: costNote(result),
    },
  });
}

async function applyDatabase(databaseId: string, apply: DbApply): Promise<void> {
  const store = useDatabases.getState();
  const data = store.data[databaseId];
  if (!data) throw new Error('Die Datenbank ist nicht geladen.');
  for (const [propertyId, options] of apply.options) {
    const property = useDatabases.getState().data[databaseId]?.properties.find((p) => p.id === propertyId);
    if (property) store.updateProperty({ ...property, options: [...property.options, ...options] });
  }
  for (const row of apply.add) {
    const id = await store.createRow(databaseId, row.values);
    if (row.title) usePages.getState().update(id, { title: row.title });
  }
  for (const row of apply.update) {
    if (row.title) usePages.getState().update(row.rowId, { title: row.title });
    for (const [propertyId, value] of Object.entries(row.values)) store.setValue(databaseId, row.rowId, propertyId, value);
  }
}

function boardBridge(pageId: string): BoardBridge {
  const bridge = useActiveBoard.getState().bridge;
  if (!bridge || bridge.pageId !== pageId) throw new Error('Das Board ist nicht bereit oder schreibgeschützt.');
  return bridge;
}

/** Übernimmt die Vorschau (ein Schritt, mit ⌘Z rückgängig). */
export async function acceptAiBar(): Promise<void> {
  const p = pending;
  if (!p) return;
  try {
    if (p.kind === 'database') {
      await applyDatabase(p.pageId, p.apply);
      closeAiBar();
      toast('Übernommen');
      return;
    }
    if (p.kind === 'board') {
      await boardBridge(p.pageId).applyEdits(planEdits(p.ops, p.model, p.elements), p.created);
    } else if (p.newPage) {
      const doc = applyOps({ type: 'doc', content: [{ type: 'paragraph' }] }, p.ops);
      // Boards haben keine Unterseiten: dann neben das Board.
      const source = usePages.getState().pages[p.pageId];
      const parentId = source?.type === 'page' ? p.pageId : (source?.parentId ?? null);
      const id = await usePages.getState().create({
        parentId,
        title: p.plan.title || 'Neue Seite',
        extra: (page) => saveContent(page.id, doc, jsonText(doc), collectLinkTargets(doc, page.id), Date.now()),
      });
      if (parentId) useUI.getState().setExpanded(parentId, true);
      useUI.getState().open(id);
    } else {
      const editor = getActiveEditor();
      if (!editor || !applyPageOps(editor, p.snapshot, p.ops)) {
        throw new Error('Die Seite wurde inzwischen verändert. Schick die Anweisung noch einmal ab.');
      }
    }
    closeAiBar();
    toast('Übernommen · mit ⌘Z rückgängig');
  } catch (err) {
    pending = null;
    useAiBar.setState({ status: 'error', error: err instanceof Error ? err.message : String(err), preview: null });
  }
}

export function discardPreview(): void {
  pending = null;
  useAiBar.setState({ status: 'idle', preview: null });
}

/** Board als neue Seite zusammenfassen (Schnellaktion der Leiste) */
export async function boardToPage(): Promise<void> {
  const page = currentPage();
  if (!page) return;
  const snap = boardBridge(page.id).snapshot();
  const text = describeBoard(buildModel(snap.elements), null);
  if (!text.trim()) return void useAiBar.setState({ status: 'error', error: 'Das Board ist leer.' });
  const attachment: Attachment = { kind: 'page', id: page.id, title: page.title || 'Board', markdown: text };
  controller?.abort();
  const abort = new AbortController();
  controller = abort;
  useAiBar.setState({ status: 'running', error: null, progress: 0 });
  try {
    await runPage(
      page.id,
      'Fasse das Board als übersichtliche Notiz zusammen: Überschriften je Gruppe, wichtigste Punkte, am Ende offene Fragen und nächste Schritte.',
      [attachment],
      true,
      undefined,
      abort.signal,
      (_d, full) => useAiBar.setState({ progress: full.length }),
    );
  } catch (err) {
    if (err instanceof AiCancelled) return;
    useAiBar.setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** Markierte Post-its clustern (Schnellaktion der Leiste) */
export async function clusterSelection(): Promise<void> {
  const page = currentPage();
  if (!page) return;
  const bridge = boardBridge(page.id);
  const notes = bridge.selectedNotes();
  controller?.abort();
  const abort = new AbortController();
  controller = abort;
  useAiBar.setState({ status: 'running', error: null, progress: 0 });
  try {
    const done = await clusterNotes(page.id, notes, useAiBar.getState().instruction, abort.signal, () => undefined);
    if (!done) return void useAiBar.setState({ status: 'idle' });
    closeAiBar();
    toast(`${done.groups} Gruppen · ${costNote(done.result)} · mit ⌘Z rückgängig`);
  } catch (err) {
    if (err instanceof AiCancelled) return;
    useAiBar.setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** Neues Board unter der aktuellen Seite, mit der Seite als Quelle. */
export async function pageToBoard(pageId: string): Promise<void> {
  const attachment = await pageAttachment(pageId);
  const boardId = await createBoard(pageId);
  useUI.getState().setExpanded(pageId, true);
  useUI.getState().open(boardId);
  await waitForBoard(boardId);
  openAiBar({ attachments: [attachment], instruction: 'Mach aus der Seite ein übersichtliches Board.' });
  await runAiBar();
}
