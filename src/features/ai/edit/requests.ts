import type { AiRequest, Content } from '../client';
import type { Block } from '../stream';
import { BOARD_EDIT_SCHEMA, type BoardEditPlan } from './boardModel';
import { DB_EDIT_SCHEMA, type DbEditPlan } from './dbModel';
import { PAGE_EDIT_SCHEMA, type PageEditPlan } from './pageModel';

/** Angehängte Quellen in der KI-Leiste */
export type Attachment =
  | { kind: 'pdf'; name: string; data: string; size: number }
  | { kind: 'page'; id: string; title: string; markdown: string };

const approxTokens = (text: string) => Math.ceil(text.length / 3.5);

function sources(attachments: Attachment[]): { blocks: Block[]; text: string; pdfs: number; tokens: number } {
  const blocks: Block[] = [];
  const parts: string[] = [];
  let pdfs = 0;
  let tokens = 0;
  for (const a of attachments) {
    if (a.kind === 'pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data }, title: a.name });
      pdfs++;
    } else {
      parts.push(`<quelle titel="${a.title.replace(/"/g, "'")}">\n${a.markdown}\n</quelle>`);
      tokens += approxTokens(a.markdown);
    }
  }
  return { blocks, text: parts.join('\n\n'), pdfs, tokens };
}

function content(attachments: Attachment[], body: string): Content {
  const s = sources(attachments);
  const text = [s.text, body].filter(Boolean).join('\n\n');
  return s.blocks.length ? [...s.blocks, { type: 'text', text }] : text;
}

const SYSTEM_PAGE = `Du bearbeitest Notizseiten in der App flou nach Anweisung.
Die Seite kommt als nummerierte Blöcke in Markdown. Antworte nur mit Änderungen (ops):
- replace: Block ersetzen. insert_after / insert_before: neue Blöcke neben einem Block. delete: Block löschen.
- markdown darf mehrere Blöcke enthalten: Überschriften (#, ##, ###), Absätze, Listen, Aufgaben "- [ ] …", Tabellen, Zitate, Code, Trennlinien "---", Callouts als "> 💡 Text", Fett, Kursiv, Links.
- Blöcke mit geschuetzt="…" (Bilder, Datenbanken, Boards, Unterseiten, Spalten, Blöcke mit Kommentaren) darfst du weder ersetzen noch löschen; davor oder danach einfügen ist erlaubt.
- Ändere nur, was die Anweisung verlangt. Unveränderte Blöcke tauchen in ops nicht auf. Bei einer leeren Seite füllst du Block 0 per replace.
- Seitenlinks [[Titel]] bleiben erhalten. Nimm Fakten nur aus Seite und Quellen, erfinde nichts.
- title: nur ausfüllen, wenn eine neue Seite entsteht, sonst "". summary: ein kurzer Satz, was du geändert hast.
- Schreib in der Sprache der Anweisung bzw. der Seite.`;

export function pageEditRequest(opts: {
  pageTitle: string;
  blocksText: string;
  instruction: string;
  attachments: Attachment[];
  newPage: boolean;
  previous?: PageEditPlan;
}): AiRequest {
  const { pageTitle, blocksText, instruction, attachments, newPage, previous } = opts;
  const page = newPage
    ? '<seite titel="(neue Seite)">\n<block id="0">\n\n</block>\n</seite>\nEs entsteht eine neue Seite. Fülle Block 0 per replace und gib einen passenden title an.'
    : `<seite titel="${pageTitle.replace(/"/g, "'")}">\n${blocksText}\n</seite>`;
  const refine = previous
    ? `\n\n<bisheriger_vorschlag>\n${JSON.stringify(previous)}\n</bisheriger_vorschlag>\nÜberarbeite diesen Vorschlag gemäß der neuen Anweisung. Gib die vollständige, neue Liste der Änderungen an (bezogen auf die Seite oben).`
    : '';
  const s = sources(attachments);
  const pageTokens = newPage ? 0 : approxTokens(blocksText);
  const sourceTokens = s.tokens + s.pdfs * 15_000;
  return {
    feature: 'page',
    title: newPage ? 'Neue Seite mit KI' : 'Seite mit KI bearbeiten',
    system: SYSTEM_PAGE,
    messages: [{ role: 'user', content: content(attachments, `${page}${refine}\n\n<anweisung>${instruction.trim()}</anweisung>`) }],
    maxTokens: 32_000,
    effort: 'medium',
    output: [400 + Math.round(pageTokens * 0.15 + sourceTokens * 0.05), 2_500 + Math.round(pageTokens * 1.3 + sourceTokens * 0.4)],
    schema: PAGE_EDIT_SCHEMA,
    mock: () =>
      JSON.stringify({
        title: newPage ? 'Simulierte Seite' : '',
        summary: 'Simuliert: eine Überschrift ergänzt',
        ops: [{ op: newPage ? 'replace' : 'insert_before', block: 0, markdown: `## ${instruction.trim().slice(0, 40)}\n\n- Simulierter Punkt` }],
      } satisfies PageEditPlan),
  };
}

const SYSTEM_BOARD = `Du bearbeitest ein digitales Whiteboard (Stil wie Miro) in der App flou nach Anweisung.
Das Board kommt als Liste: <gruppe> (Rahmen mit Überschrift) mit <postit>s, lose <postit>s und freie <text>e, jeweils mit kurzer id.
Antworte mit Änderungen (ops):
- edit: Text eines Post-its (n…), eines Texts (t…) oder die Überschrift einer Gruppe (g…) ersetzen.
- recolor: Farbe eines Post-its ändern.
- delete: Post-it, Text oder ganze Gruppe (samt Inhalt) löschen.
- add: neues Post-it; target = Gruppe (g…) oder Post-it (n…), neben das es gehört, oder "" für frei. color passend zur Gruppe oder "".
- Ein Post-it = ein Gedanke, höchstens etwa 60 Zeichen.
Soll ganz neuer Inhalt entstehen (z. B. "mach aus der PDF eine Matrix", oder das Board ist leer), setze create.enabled = true und fülle create wie ein neues Board: layout "matrix" (Zeilen = verglichene Dinge, Spalten = Kriterien, rows[].cells passend zu columns), "clusters" (Gruppen) oder "flow" (Schritte); nicht genutzte Felder leer. Sonst create.enabled = false und alle create-Felder leer.
Ist das Board leer, entsteht immer neuer Inhalt über create. Für Vorlagen (z. B. Research-Plan, Workshop, Persona) gibst du Gruppen bzw. Spalten mit Post-its, die kurze Leitfragen oder Platzhalter enthalten ("Ziel der Studie?", "Zielgruppe: …"), nie leere Post-its.
Ändere nur, was die Anweisung verlangt. Nimm Fakten nur aus Board und Quellen. summary: ein kurzer Satz. Sprache: wie Anweisung bzw. Board.`;

export function boardEditRequest(opts: {
  boardText: string;
  selectionOnly: boolean;
  instruction: string;
  attachments: Attachment[];
  previous?: BoardEditPlan;
}): AiRequest {
  const { boardText, selectionOnly, instruction, attachments, previous } = opts;
  const board = `<board${selectionOnly ? ' auswahl="nur die markierten Elemente"' : ''}>\n${boardText || '(leer)'}\n</board>`;
  const refine = previous
    ? `\n\n<bisheriger_vorschlag>\n${JSON.stringify(previous)}\n</bisheriger_vorschlag>\nÜberarbeite diesen Vorschlag gemäß der neuen Anweisung und gib die vollständige neue Fassung an.`
    : '';
  const s = sources(attachments);
  const sourceTokens = s.tokens + s.pdfs * 15_000;
  const boardTokens = approxTokens(boardText);
  return {
    feature: 'board',
    title: 'Board mit KI bearbeiten',
    system: SYSTEM_BOARD,
    messages: [{ role: 'user', content: content(attachments, `${board}${refine}\n\n<anweisung>${instruction.trim()}</anweisung>`) }],
    maxTokens: 32_000,
    effort: 'medium',
    output: [500 + Math.round(boardTokens * 0.2 + sourceTokens * 0.05), 3_000 + Math.round(boardTokens * 1.2 + sourceTokens * 0.35)],
    schema: BOARD_EDIT_SCHEMA,
    mock: () =>
      JSON.stringify({
        summary: 'Simuliert: ein Post-it ergänzt',
        ops: [{ op: 'add', target: '', text: `Simuliert: ${instruction.trim().slice(0, 40)}`, color: 'yellow' }],
        create: { enabled: false, title: '', subtitle: '', layout: 'clusters', columns: [], rows: [], groups: [], steps: [], takeaways: [] },
      } satisfies BoardEditPlan),
  };
}

const SYSTEM_DB = `Du bearbeitest eine Datenbank (Tabelle) in der App flou nach Anweisung.
Du bekommst die Spalten mit Typ und die Einträge mit kurzer id (r1, r2, …). Antworte mit:
- add: neue Einträge (title + values), z. B. aus angehängten Quellen.
- update: geänderte Einträge per id. title nur ausfüllen, wenn sich der Titel ändert, sonst "". values nur mit geänderten Spalten.
- values: column = Spaltenname genau wie angegeben, value = Text im angegebenen Format (Zahl, Datum JJJJ-MM-TT, ja/nein, Mehrfachauswahl mit Komma). Bei Auswahl vorhandene Optionen bevorzugen; neue nur, wenn keine passt.
- Spalten mit "nur lesen" nicht befüllen. Nimm Fakten nur aus Tabelle und Quellen; was sich nicht belegen lässt, bleibt leer.
- summary: ein kurzer Satz. Sprache wie die Datenbank.`;

export function databaseEditRequest(opts: { tableText: string; title: string; instruction: string; attachments: Attachment[]; previous?: DbEditPlan }): AiRequest {
  const { tableText, title, instruction, attachments, previous } = opts;
  const refine = previous
    ? `\n\n<bisheriger_vorschlag>\n${JSON.stringify(previous)}\n</bisheriger_vorschlag>\nÜberarbeite diesen Vorschlag gemäß der neuen Anweisung und gib die vollständige neue Fassung an.`
    : '';
  const s = sources(attachments);
  const sourceTokens = s.tokens + s.pdfs * 15_000;
  const tableTokens = approxTokens(tableText);
  return {
    feature: 'database',
    title: 'Datenbank mit KI',
    system: SYSTEM_DB,
    messages: [
      {
        role: 'user',
        content: content(attachments, `<datenbank titel="${title.replace(/"/g, "'")}">\n${tableText}\n</datenbank>${refine}\n\n<anweisung>${instruction.trim()}</anweisung>`),
      },
    ],
    maxTokens: 32_000,
    effort: 'medium',
    output: [400 + Math.round(tableTokens * 0.1 + sourceTokens * 0.05), 2_500 + Math.round(tableTokens * 0.8 + sourceTokens * 0.4)],
    schema: DB_EDIT_SCHEMA,
    mock: () =>
      JSON.stringify({
        summary: 'Simuliert: ein Eintrag ergänzt',
        add: [{ title: `Simuliert: ${instruction.trim().slice(0, 30)}`, values: [] }],
        update: [],
      } satisfies DbEditPlan),
  };
}
