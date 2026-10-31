import { invoke } from '@tauri-apps/api/core';
import { getActiveEditor } from '../editor/active';
import { useDatabases } from '../store/databases';
import { createBoard } from './board/create';
import { duplicatePage } from './duplicate';
import { openTemplatePicker } from './templates/TemplatePicker';
import { openToday, saveAsTemplate } from './templates/templates';
import { reportError, toast } from '../store/toast';
import { copyPageMarkdown, printPage } from './share/share';
import { checkForUpdate, toggleAutoUpdate } from './update/updater';
import { backupNow, exportCurrentPage, exportWorkspace, importFolder, importMarkdownFiles, importNotion } from './transfer/transfer';
import { usePages, type Group } from '../store/pages';
import { startLearning } from './cards/learn';
import { generateCards } from './ai/cards';
import { toggleInk } from '../editor/ink/ink';
import { toggleDictation } from './dictate/dictate';
import { startExam } from './exam/ExamDialog';
import { useUI, type Theme } from '../store/ui';
import { quitApp } from './lifecycle';
import { GUEST } from '../lib/mode';
import { useAccess } from './collab/sources';
import { aiUsable } from './ai/store';
import { useSettingsSection } from './ai/client';
import { startWrite } from './ai/writeSession';
import { openAiBar } from './ai/edit/session';
import { convertToBoard } from './ai/edit/toBoard';
import { openAsk } from './ai/AskDialog';
import { openLectureStart } from './lecture/LectureUI';
import { isRecording, stopLecture } from './lecture/lecture';

export type MenuSection = 'app' | 'file' | 'edit' | 'view' | 'go' | 'help';

export interface AppAction {
  id: string;
  label: string;
  group: 'Allgemein' | 'Seite' | 'Navigation' | 'Ansicht' | 'Bearbeiten' | 'KI';
  /** Nur anbieten, wenn das zutrifft (z. B. KI eingerichtet) */
  when?: () => boolean;
  keys?: string;
  /** Kürzel nur über das native Menü auslösen (der Editor oder das System verarbeitet die Taste selbst). */
  menuOnly?: boolean;
  menu?: MenuSection;
  /** In der Befehlspalette ausblenden. */
  hideInPalette?: boolean;
  run(): unknown;
}

const currentPage = () => {
  const id = useUI.getState().currentId;
  return id ? (usePages.getState().pages[id] ?? null) : null;
};

export async function createPageAndOpen(parentId: string | null, group?: Group): Promise<void> {
  const id = await usePages.getState().create({ parentId, space: group?.space, categoryId: group?.categoryId });
  if (parentId) useUI.getState().setExpanded(parentId, true);
  useUI.getState().open(id);
  useUI.getState().requestFocus('title');
}

async function createDatabaseAndOpen(parentId: string | null): Promise<void> {
  const id = await useDatabases.getState().createDatabase(parentId);
  if (parentId) useUI.getState().setExpanded(parentId, true);
  useUI.getState().open(id);
  useUI.getState().requestFocus('title');
}

/** Kopie neben dem Original anlegen und öffnen. */
export async function duplicateAndOpen(id: string): Promise<void> {
  try {
    const copy = await duplicatePage(id);
    useUI.getState().open(copy);
    toast('Kopie angelegt');
  } catch (err) {
    reportError('Seite konnte nicht dupliziert werden', err);
  }
}

async function createBoardAndOpen(parentId: string | null): Promise<void> {
  const id = await createBoard(parentId);
  if (parentId) useUI.getState().setExpanded(parentId, true);
  useUI.getState().open(id);
}

function openAiSettings() {
  useSettingsSection.setState({ section: 'ai' });
  useUI.getState().setOverlay('settings');
}

function withEditor(run: (editor: NonNullable<ReturnType<typeof getActiveEditor>>) => void) {
  const editor = getActiveEditor();
  if (editor?.isEditable) run(editor);
  else toast('Öffne zuerst eine Seite');
}

function setTheme(theme: Theme) {
  useUI.getState().setTheme(theme);
}

/** Undo/Redo: im Editor über dessen Verlauf, in normalen Eingabefeldern über die WebView. */
function history(kind: 'undo' | 'redo') {
  const editor = getActiveEditor();
  if (editor && editor.view.hasFocus()) {
    editor.commands[kind]();
    return;
  }
  document.execCommand(kind);
}

export const actions: AppAction[] = [
  {
    id: 'palette.open',
    label: 'Befehlspalette',
    group: 'Allgemein',
    keys: 'Mod+K',
    menu: 'go',
    hideInPalette: true,
    run: () => useUI.getState().setOverlay('palette'),
  },
  {
    id: 'search.open',
    label: 'Volltextsuche',
    group: 'Allgemein',
    keys: 'Mod+Shift+F',
    menu: 'go',
    run: () => useUI.getState().setOverlay('search'),
  },
  {
    id: 'page.new',
    label: 'Neue Seite',
    group: 'Seite',
    keys: 'Mod+N',
    menu: 'file',
    run: () => createPageAndOpen(null),
  },
  {
    id: 'page.newSub',
    label: 'Neue Unterseite',
    group: 'Seite',
    keys: 'Mod+Shift+N',
    menu: 'file',
    run: () => {
      const page = currentPage();
      return createPageAndOpen(page && page.type === 'page' ? page.id : null);
    },
  },
  {
    id: 'page.newDatabase',
    label: 'Neue Datenbank',
    group: 'Seite',
    keys: 'Mod+Alt+N',
    menu: 'file',
    run: () => createDatabaseAndOpen(null),
  },
  {
    id: 'page.newBoard',
    label: 'Neues Board',
    group: 'Seite',
    keys: 'Mod+Alt+B',
    menu: 'file',
    run: () => createBoardAndOpen(null),
  },
  {
    id: 'daily.today',
    label: 'Heute (Tagesnotiz)',
    group: 'Seite',
    keys: 'Mod+Shift+D',
    menu: 'go',
    run: openToday,
  },
  {
    id: 'cards.learn',
    label: 'Karteikarten lernen',
    group: 'Seite',
    keys: 'Mod+Alt+L',
    menu: 'go',
    when: () => !GUEST,
    run: () => startLearning(null),
  },
  {
    id: 'quick.open',
    label: 'Schnellnotiz (⌃⌥N, auch von außerhalb)',
    group: 'Seite',
    menu: 'file',
    run: () => invoke('quick_note_open'),
  },
  {
    id: 'templates.new',
    label: 'Neu aus Vorlage …',
    group: 'Seite',
    menu: 'file',
    run: () => openTemplatePicker(),
  },
  {
    id: 'page.duplicate',
    label: 'Seite duplizieren',
    group: 'Seite',
    menu: 'file',
    run: () => {
      const page = currentPage();
      if (page) return duplicateAndOpen(page.id);
    },
  },
  {
    id: 'page.saveTemplate',
    label: 'Als Vorlage speichern',
    group: 'Seite',
    menu: 'file',
    run: () => {
      const page = currentPage();
      if (page) return saveAsTemplate(page.id);
    },
  },
  {
    id: 'page.rename',
    label: 'Seite umbenennen',
    group: 'Seite',
    keys: 'Mod+Shift+R',
    menu: 'file',
    run: () => useUI.getState().requestFocus('title'),
  },
  {
    id: 'page.fullWidth',
    label: 'Volle Breite umschalten',
    group: 'Ansicht',
    keys: 'Mod+Shift+\\',
    menu: 'view',
    run: () => {
      const page = currentPage();
      if (page) usePages.getState().update(page.id, { fullWidth: !page.fullWidth });
    },
  },
  {
    id: 'page.draw',
    label: 'Zeichnen (Stift, Textmarker, Pfeile)',
    group: 'Seite',
    keys: 'Mod+Alt+D',
    menu: 'edit',
    when: () => currentPage()?.type === 'page' && getActiveEditor()?.isEditable === true,
    run: () => toggleInk(),
  },
  {
    id: 'dictate.toggle',
    label: 'Diktieren (Taste halten oder drücken, sprechen)',
    group: 'Seite',
    keys: 'Mod+Alt+V',
    // Das Kürzel verarbeitet DictateUI selbst (Halten = Push-to-Talk); hier nur für Palette und Übersicht.
    menuOnly: true,
    when: () => !GUEST && getActiveEditor()?.isEditable === true,
    run: () => toggleDictation(),
  },
  {
    id: 'page.trash',
    label: 'Seite in den Papierkorb',
    group: 'Seite',
    keys: 'Mod+Shift+Backspace',
    menu: 'file',
    run: () => {
      const page = currentPage();
      if (page) return usePages.getState().trash(page.id);
    },
  },
  {
    id: 'export.page',
    label: 'Seite als Markdown exportieren …',
    group: 'Seite',
    keys: 'Mod+Shift+E',
    menu: 'file',
    run: exportCurrentPage,
  },
  {
    id: 'share.print',
    label: 'Drucken / Als PDF sichern …',
    group: 'Seite',
    keys: 'Mod+P',
    menu: 'file',
    run: printPage,
  },
  {
    id: 'share.copyMarkdown',
    label: 'Seite als Markdown kopieren',
    group: 'Seite',
    keys: 'Mod+Shift+C',
    menu: 'file',
    run: copyPageMarkdown,
  },
  {
    id: 'page.favorite',
    label: 'Favorit an/aus',
    group: 'Seite',
    keys: 'Mod+Alt+S',
    menu: 'file',
    run: () => {
      const page = currentPage();
      if (page) useUI.getState().toggleFavorite(page.id);
    },
  },
  {
    id: 'page.setHome',
    label: 'Als Startseite festlegen',
    group: 'Seite',
    menu: 'file',
    run: () => {
      const page = currentPage();
      if (page) useUI.getState().setHome(page.id);
    },
  },
  {
    id: 'page.versions',
    label: 'Versionsverlauf …',
    group: 'Seite',
    menu: 'file',
    run: () => useUI.getState().setOverlay('versions'),
  },
  {
    id: 'page.comments',
    label: 'Kommentare der Seite',
    group: 'Seite',
    menu: 'file',
    run: () => useUI.getState().setOverlay('comments'),
  },
  {
    id: 'export.workspace',
    label: 'Workspace als Markdown exportieren …',
    group: 'Allgemein',
    menu: 'file',
    run: exportWorkspace,
  },
  {
    id: 'import.files',
    label: 'Markdown-Dateien importieren …',
    group: 'Allgemein',
    menu: 'file',
    run: importMarkdownFiles,
  },
  {
    id: 'import.notion',
    label: 'Aus Notion importieren …',
    group: 'Allgemein',
    menu: 'file',
    run: importNotion,
  },
  {
    id: 'import.folder',
    label: 'Markdown-Ordner importieren …',
    group: 'Allgemein',
    menu: 'file',
    run: importFolder,
  },
  {
    id: 'trash.open',
    label: 'Papierkorb öffnen',
    group: 'Allgemein',
    menu: 'file',
    run: () => useUI.getState().setOverlay('trash'),
  },
  {
    id: 'edit.undo',
    label: 'Widerrufen',
    group: 'Bearbeiten',
    keys: 'Mod+Z',
    menuOnly: true,
    menu: 'edit',
    hideInPalette: true,
    run: () => history('undo'),
  },
  {
    id: 'edit.redo',
    label: 'Wiederholen',
    group: 'Bearbeiten',
    keys: 'Mod+Shift+Z',
    menuOnly: true,
    menu: 'edit',
    hideInPalette: true,
    run: () => history('redo'),
  },
  {
    id: 'view.sidebar',
    label: 'Seitenleiste ein-/ausblenden',
    group: 'Ansicht',
    keys: 'Mod+\\',
    menu: 'view',
    run: () => useUI.getState().toggleSidebar(),
  },
  {
    id: 'theme.light',
    label: 'Erscheinungsbild: Hell',
    group: 'Ansicht',
    menu: 'view',
    run: () => setTheme('light'),
  },
  {
    id: 'theme.dark',
    label: 'Erscheinungsbild: Dunkel',
    group: 'Ansicht',
    menu: 'view',
    run: () => setTheme('dark'),
  },
  {
    id: 'theme.system',
    label: 'Erscheinungsbild: System',
    group: 'Ansicht',
    menu: 'view',
    run: () => setTheme('system'),
  },
  {
    id: 'nav.home',
    label: 'Startseite öffnen',
    group: 'Navigation',
    keys: 'Mod+Shift+O',
    menu: 'go',
    run: () => {
      const { homeId, open } = useUI.getState();
      if (homeId) open(homeId);
    },
  },
  {
    id: 'nav.focusTree',
    label: 'Seitenbaum fokussieren',
    group: 'Navigation',
    keys: 'Mod+Shift+L',
    menu: 'go',
    run: focusTree,
  },
  {
    id: 'nav.back',
    label: 'Zurück',
    group: 'Navigation',
    keys: 'Mod+[',
    menu: 'go',
    run: () => useUI.getState().goBack(),
  },
  {
    id: 'nav.forward',
    label: 'Vorwärts',
    group: 'Navigation',
    keys: 'Mod+]',
    menu: 'go',
    run: () => useUI.getState().goForward(),
  },
  {
    id: 'shortcuts.open',
    label: 'Tastenkürzel anzeigen',
    group: 'Allgemein',
    keys: 'Mod+/',
    menu: 'help',
    run: () => useUI.getState().setOverlay('shortcuts'),
  },
  {
    id: 'share.open',
    label: 'Teilen und Zusammenarbeiten …',
    group: 'Allgemein',
    menu: 'file',
    run: () => useUI.getState().setOverlay('share'),
  },
  {
    id: 'share.join',
    label: 'Geteilten Workspace öffnen …',
    group: 'Allgemein',
    menu: 'file',
    run: () => useUI.getState().setOverlay('join'),
  },
  {
    id: 'backup.now',
    label: 'Backup jetzt erstellen',
    group: 'Allgemein',
    menu: 'help',
    run: backupNow,
  },
  {
    id: 'backup.reveal',
    label: 'Backup-Ordner im Finder zeigen',
    group: 'Allgemein',
    menu: 'help',
    run: () => invoke('reveal_dir', { which: 'backups' }),
  },
  {
    id: 'ai.bar',
    label: 'KI: Seite, Board oder Datenbank bearbeiten …',
    group: 'KI',
    keys: 'Mod+J',
    when: () => aiUsable() && !!currentPage(),
    run: () => openAiBar(),
  },
  {
    id: 'ai.ask',
    label: 'KI: Frag efeu …',
    group: 'KI',
    keys: 'Mod+Shift+J',
    when: aiUsable,
    run: () => (aiUsable() ? openAsk('ask') : openAiSettings()),
  },
  {
    id: 'ai.research',
    label: 'KI: Recherche im Web …',
    group: 'KI',
    when: aiUsable,
    run: () => openAsk('research'),
  },
  {
    id: 'lecture.start',
    label: 'Vorlesung mitschreiben …',
    group: 'Seite',
    when: () => currentPage()?.type === 'page',
    run: () => {
      const page = currentPage();
      if (page) openLectureStart(page.id);
    },
  },
  {
    id: 'lecture.stop',
    label: 'Mitschrift beenden',
    group: 'Seite',
    when: isRecording,
    run: () => void stopLecture(),
  },
  {
    id: 'ai.summarize',
    label: 'KI: Seite zusammenfassen',
    group: 'KI',
    when: () => aiUsable() && getActiveEditor() !== null,
    run: () => withEditor((editor) => startWrite(editor, 'summarize')),
  },
  {
    id: 'ai.tasks',
    label: 'KI: Aufgaben herausziehen',
    group: 'KI',
    when: () => aiUsable() && getActiveEditor() !== null,
    run: () => withEditor((editor) => startWrite(editor, 'tasks')),
  },
  {
    id: 'ai.cards',
    label: 'KI: Karteikarten aus dieser Seite erstellen',
    group: 'KI',
    when: () => aiUsable() && currentPage()?.type === 'page' && getActiveEditor()?.isEditable === true,
    run: () => {
      const page = currentPage();
      if (page) void generateCards(page.id);
    },
  },
  {
    id: 'ai.exam',
    label: 'KI: Probeklausur zu dieser Seite üben',
    group: 'KI',
    when: () => aiUsable() && currentPage()?.type === 'page',
    run: () => {
      const page = currentPage();
      if (page) startExam(page.id);
    },
  },
  {
    id: 'ai.pageToBoard',
    label: 'KI: Seite als Board darunter einfügen',
    group: 'KI',
    when: () => aiUsable() && currentPage()?.type === 'page',
    run: () => {
      const page = currentPage();
      if (page) withEditor((editor) => void convertToBoard(editor, 'page'));
    },
  },
  {
    id: 'ai.settings',
    label: 'KI: Einstellungen und Kosten …',
    group: 'KI',
    run: openAiSettings,
  },
  {
    id: 'settings.open',
    label: 'Einstellungen …',
    group: 'Allgemein',
    keys: 'Mod+,',
    menu: 'app',
    run: () => useUI.getState().setOverlay('settings'),
  },
  {
    id: 'update.check',
    label: 'Nach Updates suchen …',
    group: 'Allgemein',
    menu: 'app',
    run: () => checkForUpdate(true),
  },
  {
    id: 'update.toggleAuto',
    label: 'Automatische Update-Suche an/aus',
    group: 'Allgemein',
    menu: 'help',
    run: toggleAutoUpdate,
  },
  {
    id: 'app.dataFolder',
    label: 'Datenordner im Finder zeigen',
    group: 'Allgemein',
    menu: 'help',
    run: () => invoke('reveal_dir', { which: 'data' }),
  },
  {
    id: 'app.quit',
    label: 'Beenden',
    group: 'Allgemein',
    keys: 'Mod+Q',
    menu: 'app',
    hideInPalette: true,
    run: quitApp,
  },
];

/** Fokussiert die aktuelle Seite in der Seitenleiste (dann mit Pfeiltasten navigierbar). */
function focusTree() {
  const ui = useUI.getState();
  if (!ui.sidebarOpen) ui.toggleSidebar();
  requestAnimationFrame(() => {
    const row =
      document.querySelector<HTMLElement>(`[data-tree-id="${ui.currentId}"]`) ?? document.querySelector<HTMLElement>('[data-tree-id]');
    row?.focus();
  });
}

/** Was Gäste im geteilten Workspace ausführen können (alles andere betrifft den Computer des Gastgebers). */
const GUEST_ACTIONS = new Set([
  'palette.open',
  'search.open',
  'page.newSub',
  'page.rename',
  'page.fullWidth',
  'page.trash',
  'share.print',
  'page.favorite',
  'page.setHome',
  'page.comments',
  'edit.undo',
  'edit.redo',
  'view.sidebar',
  'theme.light',
  'theme.dark',
  'theme.system',
  'nav.home',
  'nav.focusTree',
  'nav.back',
  'nav.forward',
  'shortcuts.open',
]);

/** Eigene Geräte (z. B. das iPhone) dürfen zusätzlich Seiten auf oberster Ebene anlegen. */
const DEVICE_ACTIONS = new Set([...GUEST_ACTIONS, 'page.new', 'page.newDatabase', 'page.newBoard']);

/** Aktionen, die hier ausgeführt werden können (Gastmodus: abhängig vom Zugriff). */
export function availableActions(): AppAction[] {
  if (!GUEST) return actions.filter((a) => !a.when || a.when());
  const allowed = useAccess.getState().access === null ? DEVICE_ACTIONS : GUEST_ACTIONS;
  return actions.filter((a) => allowed.has(a.id));
}

export function actionById(id: string): AppAction {
  const action = actions.find((a) => a.id === id);
  if (!action) throw new Error(`Unbekannte Aktion ${id}`);
  return action;
}
