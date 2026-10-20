import type { JSONContent } from '@tiptap/core';
import type { CellValue } from '../../db/database';
import { fromMarkdown, stripFrontMatter } from '../../lib/markdown/parse';
import { cellValue, inferColumn, parseCsv, stripPropertyLines, type ColumnSpec } from './notion';

export interface InFile {
  /** Pfad relativ zum gewählten Ordner mit "/" */
  rel: string;
  abs: string;
  content: string;
}

export interface ImportNode {
  key: string;
  id: string;
  parentKey: string | null;
  title: string;
  doc: JSONContent | null;
  /** Datenbank (aus einer CSV-Datei, z. B. Notion-Export) mit erkannten Spalten */
  columns?: ColumnSpec[];
  /** Eintrag einer Datenbank: Werte nach Spaltenname */
  values?: Record<string, CellValue>;
}

export interface ImportPlan {
  /** Eltern stehen immer vor ihren Kindern */
  nodes: ImportNode[];
  /** Absolute Bildpfade; im Dokument steht "import:<index>" als Platzhalter */
  images: string[];
}

const IMAGE_PLACEHOLDER = 'import:';

const stripExt = (path: string) => path.replace(/\.(md|markdown)$/i, '');
/** "Aufgaben 1a2b…_all.csv" und "Aufgaben 1a2b….csv" gehören zum Ordner "Aufgaben 1a2b…". */
const csvKey = (path: string) => path.replace(/(_all)?\.csv$/i, '');
const isCsv = (path: string) => /\.csv$/i.test(path);
/** Notion hängt beim Export eine 32-stellige ID an Datei- und Ordnernamen. */
const cleanTitle = (segment: string) => segment.replace(/\s[0-9a-f]{32}$/i, '').trim() || 'Ohne Titel';
const parentOf = (key: string) => (key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : null);

function normalize(segments: string[]): string[] | null {
  const out: string[] = [];
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(s);
  }
  return out;
}

function joinAbs(dir: string, relative: string): string {
  return [...dir.split('/'), ...relative.split('/')].reduce<string[]>((acc, s) => {
    if (s === '..') acc.pop();
    else if (s !== '.') acc.push(s);
    return acc;
  }, []).join('/');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Entfernt eine führende H1, wenn sie dem Seitentitel entspricht (so exportiert efeu selbst). */
function takeTitle(doc: JSONContent, fallback: string): { title: string; doc: JSONContent } {
  const first = doc.content?.[0];
  if (first?.type === 'heading' && first.attrs?.level === 1) {
    const text = (first.content ?? []).map((c) => c.text ?? '').join('').trim();
    if (text) {
      const rest = doc.content!.slice(1);
      return { title: text, doc: { ...doc, content: rest.length ? rest : [{ type: 'paragraph' }] } };
    }
  }
  return { title: fallback, doc };
}

/**
 * Baut aus Markdown-Dateien einen Seitenbaum: "A.md" und Ordner "A/" werden zu einer Seite A
 * mit Unterseiten. Relative Links und [[Titel]] werden zu Seitenlinks, lokale Bilder zu Platzhaltern.
 */
export function planImport(files: InFile[], newId: () => string, existingTitles: Map<string, string>): ImportPlan {
  const nodes = new Map<string, ImportNode>();
  const ensure = (key: string) => {
    let node = nodes.get(key);
    if (!node) {
      node = { key, id: newId(), parentKey: parentOf(key), title: cleanTitle(key.split('/').pop()!), doc: null };
      nodes.set(key, node);
      if (node.parentKey) ensure(node.parentKey);
    }
    return node;
  };
  const sources = new Map<string, InFile>();
  for (const file of files) {
    if (isCsv(file.rel)) continue;
    const key = stripExt(file.rel);
    ensure(key);
    sources.set(key, file);
  }

  // Datenbanken: neuere Notion-Exporte legen zusätzlich "_all.csv" mit allen Einträgen ab; die gewinnt.
  const tables = new Map<string, InFile>();
  for (const file of files.filter((f) => isCsv(f.rel))) {
    const key = csvKey(file.rel);
    if (!tables.has(key) || /_all\.csv$/i.test(file.rel)) tables.set(key, file);
  }
  for (const [key, file] of tables) {
    const [header, ...records] = parseCsv(file.content);
    if (!header?.length) continue;
    const db = ensure(key);
    const columns = header.slice(1).map((name, i) => inferColumn(name.trim() || `Spalte ${i + 2}`, records.map((r) => r[i + 1] ?? '')));
    db.columns = columns;
    // Einträge mit eigener Seite (Markdown im Ordner der Datenbank) über den Titel zuordnen.
    const pagesOfDb = [...sources.keys()].filter((k) => parentOf(k) === key);
    const used = new Set<string>();
    records.forEach((record, index) => {
      const title = (record[0] ?? '').trim() || 'Ohne Titel';
      const match = pagesOfDb.find((k) => !used.has(k) && cleanTitle(k.split('/').pop()!) === title);
      const row = match ? nodes.get(match)! : ensure(`${key}/\u0000${index}`);
      if (match) {
        used.add(match);
        const file = sources.get(match)!;
        sources.set(match, { ...file, content: stripPropertyLines(file.content, header) });
      }
      row.title = title;
      row.values = Object.fromEntries(columns.map((c, i) => [c.name, cellValue(c, record[i + 1] ?? '')]));
    });
  }

  // Erster Durchgang: Titel aus führender H1, damit [[Titel]] dateiübergreifend auflösbar ist.
  for (const [key, file] of sources) {
    const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(stripFrontMatter(file.content).trimStart().split('\n')[0] ?? '');
    if (heading) nodes.get(key)!.title = heading[1].trim();
  }

  // Titel für [[Links]]: importierte Seiten haben Vorrang vor bestehenden.
  const titles = new Map(existingTitles);
  for (const node of nodes.values()) titles.set(node.title.toLowerCase(), node.id);

  const images: string[] = [];
  for (const [key, file] of sources) {
    const node = nodes.get(key)!;
    const dir = parentOf(file.rel) ?? '';
    const abs = file.abs.replace(/\\/g, '/');
    const absDir = abs.slice(0, abs.lastIndexOf('/'));
    const parsed = fromMarkdown(file.content, {
      resolvePage(target, kind) {
        if (kind === 'title') return titles.get(target.toLowerCase()) ?? null;
        const path = safeDecode(target.split('#')[0]);
        if (!/\.(md|markdown|csv)$/i.test(path)) return null;
        const segments = normalize([...(dir ? dir.split('/') : []), ...path.split('/')]);
        if (!segments) return null;
        const joined = segments.join('/');
        return nodes.get(isCsv(joined) ? csvKey(joined) : stripExt(joined))?.id ?? null;
      },
      image(src) {
        images.push(joinAbs(absDir, safeDecode(src)));
        return `${IMAGE_PLACEHOLDER}${images.length - 1}`;
      },
    });
    const { title, doc } = takeTitle(parsed, node.title);
    node.title = title;
    node.doc = doc;
  }

  // Eltern vor Kindern, Geschwister alphabetisch (natürliche Sortierung)
  const collator = new Intl.Collator('de', { numeric: true });
  const ordered = [...nodes.values()].sort((a, b) => {
    const depth = a.key.split('/').length - b.key.split('/').length;
    return depth || collator.compare(a.key, b.key);
  });
  return { nodes: ordered, images };
}

/** Ersetzt Bild-Platzhalter; nicht importierbare Bilder werden entfernt. */
export function resolveImages(doc: JSONContent, imported: (string | null)[]): JSONContent {
  const walk = (node: JSONContent): JSONContent | null => {
    if (node.type === 'image') {
      const src = String(node.attrs?.src ?? '');
      if (!src.startsWith(IMAGE_PLACEHOLDER)) return node;
      const name = imported[Number(src.slice(IMAGE_PLACEHOLDER.length))];
      return name ? { ...node, attrs: { ...node.attrs, src: name } } : null;
    }
    if (!node.content) return node;
    const content = node.content.map(walk).filter((n): n is JSONContent => n !== null);
    return { ...node, content: content.length || node.type !== 'doc' ? content : [{ type: 'paragraph' }] };
  };
  return walk(doc) ?? { type: 'doc', content: [{ type: 'paragraph' }] };
}
