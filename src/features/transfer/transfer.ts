import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { APP_NAME } from '../../app.config';
import { loadBoard } from '../../db/boards';
import { loadDocs, saveContent } from '../../db/content';
import { loadFiles } from '../board/files';
import {
  emptyConfig,
  insertProperty,
  insertView,
  loadSchema,
  loadValues,
  setSearchProps,
  setValue,
  type CellValue,
  type Property,
  type View,
} from '../../db/database';
import type { Statement } from '../../db/driver';
import { insertPage, type PageMeta } from '../../db/pages';
import { commit, flush } from '../../db/saveQueue';
import { importImageFile } from '../../lib/assets';
import { collectLinkTargets, jsonText } from '../../lib/doc';
import { newId } from '../../lib/ids';
import { descendantIds } from '../../lib/tree';
import { usePages } from '../../store/pages';
import { reportError, toast } from '../../store/toast';
import { useUI } from '../../store/ui';
import { nextColor, rowSearchText } from '../../store/databases';
import { planExport, sanitizeName, type ExcalidrawFile, type ExportInput } from './exportPlan';
import { planImport, resolveImages, type InFile } from './importPlan';
import type { ColumnSpec } from './notion';

async function exportPages(rootIds: string[], targetDir: string): Promise<void> {
  await flush();
  const { pages, children } = usePages.getState();
  const ids = [...new Set(rootIds.flatMap((id) => [id, ...descendantIds(pages, id)]))].filter((id) => pages[id]?.deletedAt === null);
  const databases: ExportInput['databases'] = {};
  for (const id of ids.filter((pid) => pages[pid].type === 'database')) {
    const [schema, values] = await Promise.all([loadSchema(id), loadValues(id)]);
    databases[id] = { properties: schema.properties, values };
  }
  const boards: Record<string, ExcalidrawFile> = {};
  for (const id of ids.filter((pid) => pages[pid].type === 'board')) {
    const scene = await loadBoard(id);
    const files = await loadFiles(scene.files);
    boards[id] = {
      type: 'excalidraw',
      version: 2,
      source: 'efeu',
      elements: scene.elements.filter((e) => !e.isDeleted),
      appState: { viewBackgroundColor: scene.appState?.viewBackgroundColor ?? '#ffffff' },
      files: Object.fromEntries(files.map((f) => [f.id, { id: f.id, mimeType: f.mimeType, dataURL: f.dataURL, created: f.created }])),
    };
  }
  const plan = planExport(rootIds, { pages, children, docs: await loadDocs(ids), databases, boards });
  await invoke('export_write', { root: targetDir, files: plan.files, assets: plan.assets });
  toast(`${plan.files.length} ${plan.files.length === 1 ? 'Seite' : 'Seiten'} exportiert`);
  await invoke('reveal_path', { path: `${targetDir}/${plan.files[0]?.path ?? ''}` });
}

const pickFolder = (title: string) => open({ directory: true, multiple: false, title }) as Promise<string | null>;

export async function exportCurrentPage(): Promise<void> {
  const id = useUI.getState().currentId;
  if (!id) return;
  try {
    const dir = await pickFolder('Zielordner für den Export wählen');
    if (dir) await exportPages([id], dir);
  } catch (err) {
    reportError('Export fehlgeschlagen', err);
  }
}

export async function exportWorkspace(): Promise<void> {
  try {
    const dir = await pickFolder('Zielordner für den Workspace-Export wählen');
    if (!dir) return;
    const roots = usePages.getState().children.get(null) ?? [];
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    await exportPages(roots, `${dir}/${sanitizeName(`${APP_NAME} Export ${stamp}`)}`);
  } catch (err) {
    reportError('Export fehlgeschlagen', err);
  }
}

/**
 * Datenbank aus erkannten CSV-Spalten: Properties mit Auswahloptionen, eine Tabelle und – wenn es eine
 * Auswahl „Status“ gibt – ein Board. `resolve` übersetzt Werte (Optionsnamen) in Property- und Options-IDs.
 */
export function importedSchema(databaseId: string, columns: ColumnSpec[]) {
  const properties: Property[] = columns.map((column, sortOrder) => ({
    id: newId(),
    databaseId,
    name: column.name,
    type: column.type,
    options: column.options.map((name, i) => ({ id: newId(), name, color: nextColor(i) })),
    config: {},
    sortOrder,
  }));
  const status = properties.find((p) => p.type === 'select' && /^status$/i.test(p.name)) ?? properties.find((p) => p.type === 'select');
  const views: View[] = [{ id: newId(), databaseId, name: 'Tabelle', type: 'table', config: emptyConfig(), sortOrder: 0 }];
  if (status) views.push({ id: newId(), databaseId, name: 'Board', type: 'board', config: { ...emptyConfig(), groupBy: status.id }, sortOrder: 1 });
  const resolve = (values: Record<string, CellValue>) => {
    const out: Record<string, CellValue> = {};
    for (const property of properties) {
      const value = values[property.name];
      if (value === null || value === undefined) continue;
      const optionId = (name: string) => property.options.find((o) => o.name === name)?.id;
      if (property.type === 'select') out[property.id] = optionId(String(value)) ?? null;
      else if (property.type === 'multi_select' && Array.isArray(value)) out[property.id] = value.map(optionId).filter((id): id is string => Boolean(id));
      else out[property.id] = value;
    }
    return out;
  };
  return { properties, views, resolve };
}

/** Importiert Markdown-Dateien (und CSV-Datenbanken, z. B. aus Notion) als Seiten, alles in einer Transaktion. */
export async function importEntries(files: InFile[], containerTitle: string | null): Promise<void> {
  if (files.length === 0) {
    toast('Keine Markdown-Dateien gefunden');
    return;
  }
  await flush();
  const { pages, children } = usePages.getState();
  const existing = new Map<string, string>();
  for (const page of Object.values(pages)) if (page.deletedAt === null) existing.set(page.title.trim().toLowerCase(), page.id);

  const plan = planImport(files, newId, existing);
  // Bilder nacheinander importieren (schont die Platte bei großen Ordnern)
  const imported: (string | null)[] = [];
  for (const path of plan.images) imported.push(await importImageFile(path).catch(() => null));

  const now = Date.now();
  const containerId = containerTitle ? newId() : null;
  const rootSiblings = children.get(null)?.length ?? 0;
  const order = new Map<string | null, number>();
  const next = (parent: string | null) => {
    const value = order.get(parent) ?? 0;
    order.set(parent, value + 1);
    return value;
  };
  const meta = (id: string, parentId: string | null, title: string, sortOrder: number, type: PageMeta['type'] = 'page'): PageMeta => ({
    id,
    parentId,
    type,
    title,
    icon: null,
    cover: null,
    fullWidth: false,
    sortOrder,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });

  const inserts = containerId ? [insertPage(meta(containerId, null, containerTitle!, rootSiblings))] : [];
  const schemas: Statement[] = [];
  const contents: Statement[] = [];
  const idByKey = new Map(plan.nodes.map((n) => [n.key, n.id]));
  const databases = new Map<string, ReturnType<typeof importedSchema>>();
  for (const node of plan.nodes) {
    const parentId = node.parentKey ? idByKey.get(node.parentKey)! : containerId;
    const sortOrder = parentId === null ? rootSiblings + next(null) : next(parentId);
    inserts.push(insertPage(meta(node.id, parentId, node.title, sortOrder, node.columns ? 'database' : 'page')));
    if (node.columns) {
      const schema = importedSchema(node.id, node.columns);
      databases.set(node.id, schema);
      schemas.push(...schema.properties.map(insertProperty), ...schema.views.map(insertView));
    }
    const db = parentId ? databases.get(parentId) : undefined;
    if (db && node.values) {
      const values = db.resolve(node.values);
      for (const [propertyId, value] of Object.entries(values)) contents.push(setValue(node.id, propertyId, value));
      contents.push(setSearchProps(node.id, rowSearchText({ properties: db.properties, values: { [node.id]: values } }, node.id)));
    }
    if (node.doc) {
      const doc = resolveImages(node.doc, imported);
      contents.push(...saveContent(node.id, doc, jsonText(doc), collectLinkTargets(doc, node.id), now));
    }
  }
  // Erst alle Seiten und Datenbank-Schemas, dann Inhalte und Werte: Verweise finden ihr Ziel.
  await commit([...inserts, ...schemas, ...contents]);
  await usePages.getState().load();
  const first = containerId ?? plan.nodes.find((n) => n.parentKey === null)?.id;
  if (first) useUI.getState().open(first);
  const failed = imported.filter((name) => name === null).length;
  toast(`${plan.nodes.length} ${plan.nodes.length === 1 ? 'Seite' : 'Seiten'} importiert${failed ? `, ${failed} Bilder fehlten` : ''}`);
}

export async function importMarkdownFiles(): Promise<void> {
  try {
    const selected = await open({ multiple: true, directory: false, filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length === 0) return;
    await importEntries(await invoke<InFile[]>('import_read', { paths }), null);
  } catch (err) {
    reportError('Import fehlgeschlagen', err);
  }
}

export async function importFolder(): Promise<void> {
  try {
    const dir = await pickFolder('Ordner mit Markdown-Dateien wählen');
    if (!dir) return;
    const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? 'Import';
    await importEntries(await invoke<InFile[]>('import_read', { paths: [dir] }), name);
  } catch (err) {
    reportError('Import fehlgeschlagen', err);
  }
}

/** Notion: Export als „Markdown & CSV“, ZIP entpacken (Doppelklick), dann diesen Ordner wählen. */
export async function importNotion(): Promise<void> {
  try {
    const dir = await pickFolder('Entpackten Notion-Export wählen (Markdown & CSV)');
    if (!dir) return;
    await importEntries(await invoke<InFile[]>('import_read', { paths: [dir] }), 'Aus Notion');
  } catch (err) {
    reportError('Import aus Notion fehlgeschlagen', err);
  }
}

export async function backupNow(): Promise<void> {
  try {
    await flush();
    const path = await invoke<string>('backup_now');
    toast('Backup erstellt');
    await invoke('reveal_path', { path });
  } catch (err) {
    reportError('Backup fehlgeschlagen', err);
  }
}

